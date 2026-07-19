import { getLorebookById } from './lorebookService'
import { getChat, getChatLorebookIds, truncateFloors } from './chatService'
import { getCharacter } from './characterService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import { collectRenderMarkers } from './promptBuilder'
import { DeltaCallback } from './apiService'
import { parseMvuCommands, applyMvuCommands, applyJsonPatch, JsonPatchOp } from '../parsers/mvuParser'
import { stripThinking } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'
import { Lorebook } from '../types/character'
import { applyEvent } from './generation/foldState'
import { resetWriteLoopGuard } from './generation/varsWrite'
import { listVarsOps, VarsOpRow } from './varsOpsService'
import { floorStateForChat } from './agentRuntime/floorState'
import { buildTurnContext } from './nodes/turnContext'
import { builtinRegistry } from './nodes/builtin'
import { runWorkflow } from './workflowEngine'
import { isClassicDirectShape } from './generation/classicShape'
import { runClassicTurnDirect } from './generation/classicTurn'
import { resolveEffectiveDoc } from './workflowService'
import { summarizeRun, derivePackIds } from '../../shared/workflow/trace'
import { CompositionMeta } from '../../shared/workflow/compose'
import { notifyWorkflowTrace } from './workflowEvents'
import { appendRun } from './runHistoryStore'
import { evaluateTriggers, evaluateDocTriggers } from './headlessRunService'
import { randomUUID } from 'crypto'

// Re-exported so existing consumers/tests (test/generationService.test.ts) keep working; the
// implementation now lives in generation/assemble.ts (its only real call site).
export { composeAddendum } from './generation/assemble'

// Re-exported so existing consumers/tests (test/generationService.test.ts) keep working; the
// implementation now lives in generation/foldState.ts (folded alongside computeMetrics's data).
export { applyEvent }

// Re-exported so existing consumers/tests (test/generationService.test.ts, node tests) keep
// working; the implementation now lives in generation/varsWrite.ts (a leaf module — the
// mvu.set node needs applyVariableOps, and importing generationService back from a node would
// create an import cycle since generationService imports nodes/builtin).
export {
  resetWriteLoopGuard,
  registerWriteSignature,
  applyVariableOps,
  replaceVariablesFromCard
} from './generation/varsWrite'

// The abort surface + generateRaw live in generation/rawGenerate.ts (a LEAF — combat/duel
// narration imports it without pulling this orchestrator, which would cycle through the node
// registry's tool nodes). Re-exported so this module's public surface is unchanged.
export {
  abortGeneration,
  generateRaw,
  activeControllers,
  type RawGenConfig
} from './generation/rawGenerate'
import { activeControllers, abortGeneration } from './generation/rawGenerate'

/**
 * Run one full turn: assemble the prompt, call the model, post-process (regex →
 * tag parse), fold state events into the running variables, persist a new floor,
 * and return it. All orchestration lives here so the renderer just calls one IPC.
 */

/** Who initiated a main turn: the player's own send (or regenerate/swipe), or a programmatic
 *  caller — a card script's TH `generate` through the cardBridge/WCV compat surfaces. */
export type TurnSource = 'player' | 'script'

// Chats with a MAIN turn in flight (pre-phase — cleared when the floor is delivered). Deliberately
// SEPARATE from `activeControllers`: that map is shared with generateRaw (combat/duel narration,
// one-off TH generateRaw calls), which must stay allowed during a turn — only full-pipeline turns
// serialize. Each entry knows its SOURCE (so a player turn can preempt a script turn, never the
// reverse) and exposes a `settled` promise the preemptor awaits before taking the slot.
const activeTurns = new Map<string, { source: TurnSource; settled: Promise<void> }>()

export const generate = async (
  profileId: string,
  chatId: string,
  userAction: string,
  onDelta: DeltaCallback = () => {},
  source: TurnSource = 'player',
  // ST generation type (openai.js prepareOpenAIMessages `type`) driving preset injection_trigger
  // filtering. Explicit for re-rolls (regenerate/swipe); otherwise a card-script turn is ST's
  // background 'quiet' generation and a plain player send is 'normal'.
  generationType?: string
): Promise<FloorFile | null> => {
  const genType = generationType ?? (source === 'script' ? 'quiet' : 'normal')
  // ST-faithful serialization with PLAYER PRIORITY: one main turn per chat at a time. SillyTavern
  // refuses a Generate() while one is in flight, and card scripts calling TH `generate` mid-turn
  // rely on that refusal — without it, a script-triggered second turn runs a full concurrent
  // pipeline (two provider calls at once, two persisted floors racing, interleaved deltas). But a
  // blind first-wins refusal loses the RACE the wrong way when the script's call happens to land
  // first: the PLAYER'S real turn gets refused and the script's story takes over. So:
  //  - a PLAYER call finding a SCRIPT turn in flight PREEMPTS it — aborts the script turn, waits
  //    for it to release, and proceeds (the script's promise resolves null, harmless);
  //  - any other collision (script-during-anything, player-during-player) is refused like ST.
  // The guard covers the pre phase only (cleared at floor delivery); the detached post phase —
  // the table-maintenance side call — deliberately stays outside it.
  for (;;) {
    const existing = activeTurns.get(chatId)
    if (!existing) break
    if (source === 'player' && existing.source === 'script') {
      log(
        'info',
        'player turn preempts an in-flight script-initiated turn — aborting the script turn'
      )
      abortGeneration(chatId)
      await existing.settled
      continue // re-check: the slot should now be free (or hold a newer entry)
    }
    const head = userAction.length > 80 ? `${userAction.slice(0, 80)}…` : userAction
    log(
      'error',
      `✗ generate rejected — a ${existing.source} turn is already in flight for this chat. Second caller (${source}) action: "${head}" (likely a card script calling TH.generate mid-turn; SillyTavern refuses these too)`
    )
    throw new Error('Generation already in progress for this chat')
  }

  const chat = getChat(profileId, chatId)
  if (!chat) throw new Error('Chat session not found')

  const _card = getCharacter(profileId, chat.character_id)
  if (!_card) throw new Error('Character card not found')

  // A new model turn legitimately re-fires MVU events; clear the write-back loop streak so a path
  // re-written once per turn never builds a false runaway streak across turns (WS-3).
  resetWriteLoopGuard(chatId)

  let releaseTurn!: () => void
  const settled = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  activeTurns.set(chatId, { source, settled })
  const controller = new AbortController()
  activeControllers.set(chatId, controller)
  try {
    // Effective doc = the resolved narrator composed with every enabled agent pack (WP1.3). With no
    // packs enabled this is byte-identical to the narrator (compose's zero-fragments identity).
    const { id: workflowId, doc, warnings } = resolveEffectiveDoc(profileId, chatId)
    // Compose warnings are visible, never silent (ADR 0002) — log them via the existing log() sink
    // (no new UI here; the Agents workspace surfaces them later). Each names the pack + checkpoint.
    for (const w of warnings)
      log(
        'error',
        `agent-pack compose: pack "${w.packId}" attachment skipped — ${w.reason}${w.checkpoint ? ` at checkpoint "${w.checkpoint}"` : ''}`
      )
    // Panel headers for opt-in node output panels (spec D4): node id → its doc panel label.
    const panelLabels: Record<string, string> = {}
    for (const n of doc.nodes) if (n.panel?.show && n.panel.label) panelLabels[n.id] = n.panel.label
    const ctx = buildTurnContext({
      profileId,
      chatId,
      userAction,
      generationType: genType,
      workflowId,
      signal: controller.signal,
      onDelta,
      panelLabels
    })
    // The turn result comes off the doc's main-output node — by ID FROM THE DOC, not a
    // hardcoded 'write' (a hand-authored graph names its nodes differently). Validation
    // guarantees exactly one.
    const mainId = doc.nodes.find((n) => n.isMainOutput)!.id

    // Deliver at the phase boundary (spec §5/D6): the engine fires onResponseReady right after
    // the main-output node completes, handing over the outputs so far — the floor returns to the
    // renderer THEN, and the post-response phase (side jobs, compaction) continues detached,
    // fail-open. A §11-style background llm.sample can no longer hold the player's turn hostage.
    let earlyFloor: FloorFile | null = null
    let ready!: () => void
    const responseReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    ctx.onResponseReady = (outputs) => {
      earlyFloor = (outputs?.get(mainId)?.floor as FloorFile | undefined) ?? null
      ready()
    }

    const startedAt = Date.now()
    // Classic Narrator plan, Milestone 3 — the TWO-PATH split. When the resolved effective doc's turn
    // phase is structurally identical to the seeded default and no agent pack composed into it, the
    // turn runs the DIRECT orchestration (eight service calls, no engine); anything else — a user-
    // edited graph, a node hung off `write`, an open pack gate — keeps the unchanged `runWorkflow`
    // path. Milestone 3 as written asked for `runWorkflow` to be removed unconditionally; Milestone 2's
    // evidence showed that would silently drop real capability (see classicShape.ts's header), so the
    // two paths coexist until Milestone 6 decides the workflow surface's fate.
    //
    // Both resolve the SAME RunResult shape, so everything below this line — the detached trace /
    // run-history / trigger chain, the responseReady race, and the failure classification — is shared,
    // not duplicated, and Classic run history is recorded on both paths.
    const runPromise = isClassicDirectShape(doc)
      ? runClassicTurnDirect(doc, ctx)
      : runWorkflow(doc, builtinRegistry, ctx)
    // Broadcast the run trace when the FULL run settles (post phase included) — ok, aborted,
    // AND fatal — the trace panel is most useful when a turn just failed (spec §13).
    void runPromise
      .then((res) => {
        const trace = summarizeRun(doc, builtinRegistry.descriptors(), res, {
          chatId,
          workflowId,
          startedAt,
          durationMs: Date.now() - startedAt
        })
        // Live debug panel broadcast — UNCHANGED (WP2.3 does not touch this behavior).
        notifyWorkflowTrace(trace)
        // Persist the run to durable history for the phase-3 Runs timeline (WP2.3). SAME detached
        // promise — never the turn's critical path (the floor already returned via onResponseReady).
        // origin 'turn'; packIds derived from the effective doc's composition meta (which packs
        // spliced), no trigger (turns aren't triggered). A persistence failure must NEVER break the
        // run — swallow it (ADR 0003); the .catch below also covers it.
        try {
          const composition = (doc.meta?.composition as CompositionMeta | undefined) ?? undefined
          appendRun(profileId, {
            runId: randomUUID(),
            seq: 0, // assigned by the store
            origin: 'turn',
            packIds: derivePackIds(trace, composition),
            trace
          })
        } catch (err) {
          log('error', `run-history persist (turn) failed — ${(err as Error)?.message || String(err)}`)
        }
      })
      .catch((err) => log('error', `workflow trace failed — ${err?.message || String(err)}`))
      // Turn-boundary trigger evaluation (agent-packs plan WP2.2; ADR 0004: a turn commit is one of
      // the two evaluation moments). FIRE-AND-FORGET — chained on the DETACHED trace promise, never
      // on the turn's critical path (the floor already returned via the onResponseReady race above),
      // so a turn NEVER waits on headless work (ADR 0003). depth 0: a turn starts a fresh chain.
      // evaluateTriggers is internally guarded per chat against reentrancy (a turn landing mid-chain
      // skips — the chain re-evaluates on its own commit).
      .then(() => evaluateTriggers(profileId, chatId, 'turn', 0))
      .catch((err) => log('error', `headless trigger eval failed — ${err?.message || String(err)}`))
      // One-canvas rebuild (WP6.1; ADR 0011): the DOC-DRIVEN trigger evaluation runs at the SAME turn
      // commit boundary, alongside the pack path (both coexist until WP6.2/6.5). Also fire-and-forget,
      // guarded per chat, depth-capped. A doc with no trigger.* nodes evaluates nothing.
      .then(() => evaluateDocTriggers(profileId, chatId, 'turn', 0))
      .catch((err) => log('error', `headless doc-trigger eval failed — ${err?.message || String(err)}`))

    // Race: on the normal path onResponseReady fires first (before the post phase runs) and the
    // floor returns immediately. Fatal / aborted / validation-rejected runs never fire it — the
    // settled result arrives instead and is handled exactly as before.
    const settled = await Promise.race([
      responseReady.then(() => null),
      runPromise as Promise<Awaited<typeof runPromise> | null>
    ])
    if (settled) {
      // A pre-phase node failure (provider error, assembly throw, …) reaches us as a fatal
      // RESULT, not a rejection — re-surface it (spec §10: unwired + failed ⇒ the turn aborts
      // with the error surfaced). Without this a hard failure returns null and reads exactly
      // like a user Stop: no renderer error banner, the action text silently lost.
      if (settled.error) throw new Error(settled.error.message)
      if (!settled.ok || settled.aborted) return null
      return (settled.outputs.get(mainId)?.floor as FloorFile | undefined) ?? null
    }
    return earlyFloor
  } finally {
    activeTurns.delete(chatId)
    activeControllers.delete(chatId)
    releaseTurn() // LAST — a waiting preemptor resumes only after the slot is fully cleared
  }
}

/** Active render-marker templates ([RENDER:*]) for a session — the renderer evals + wraps each message. */
export const getRenderMarkers = (
  profileId: string,
  chatId: string
): { before: string[]; after: string[] } => {
  const chat = getChat(profileId, chatId)
  if (!chat) return { before: [], after: [] }
  const ids = getChatLorebookIds(profileId, chatId) ?? [chat.character_id]
  const lorebooks = ids
    .map((id) => getLorebookById(profileId, id))
    .filter((b): b is Lorebook => !!b)
  return collectRenderMarkers(lorebooks)
}

/**
 * Re-derive every floor's MVU `stat_data` by replaying its stored `<UpdateVariable>` updates from
 * scratch — enabled by lossless storage. Lets the user re-apply variable updates after a parser
 * change WITHOUT a costly regeneration: no new API call, the narrative is untouched, only the
 * derived state is recomputed. Cumulative (floor N's stat_data = replay of floors 0..N). After each
 * floor's model fold, the floor's journaled CARD writes (`vars_ops` — JSON-Patch + whole-replace)
 * are REPLAYED in seq order, so card/panel writes that are not re-derivable from response text
 * survive re-evaluation (manual-pass issue 02). Returns the updated floors.
 *
 * `fromFloor` (audit P1-4): every stored floor's stat_data IS the replay of floors 0..N, so a
 * mutation at floor K only invalidates K and later — seed from K-1's stored state and replay just
 * the suffix instead of rewriting the whole transcript. Default 0 = the full from-scratch replay
 * (the Re-evaluate button / parser-change path).
 *
 * Real session databases delegate replay to FloorState, which includes general floor-scoped
 * model/card/user/Agent operations and publishes the whole suffix atomically. The legacy fold below
 * remains only for no-database unit seams.
 */
export const reevaluateVariables = (
  profileId: string,
  chatId: string,
  fromFloor = 0
): FloorFile[] => {
  const floors = getAllFloors(profileId, chatId)
  const start = Math.min(Math.max(0, fromFloor), floors.length)
  const floorState = floorStateForChat(chatId)
  if (floorState && start < floors.length) {
    floorState.replay(chatId, floors[start].floor)
    return getAllFloors(profileId, chatId)
  }
  const stat: Record<string, unknown> =
    start > 0
      ? JSON.parse(
          JSON.stringify(
            (floors[start - 1].variables as Record<string, unknown>)?.stat_data ?? {}
          )
        )
      : {}
  const opsByFloor = new Map<number, VarsOpRow[]>()
  for (const op of listVarsOps(chatId)) {
    const list = opsByFloor.get(op.floor)
    if (list) list.push(op)
    else opsByFloor.set(op.floor, [op])
  }
  let cardWrites = 0
  for (const f of floors.slice(start)) {
    const mvu = parseMvuCommands(stripThinking(f.response.content))
    let deltas = [
      ...(mvu.commands.length ? applyMvuCommands(stat, mvu.commands) : []),
      ...(mvu.patches.length ? applyJsonPatch(stat, mvu.patches) : [])
    ]
    // Replay journaled card writes after the model fold, in seq order (opsByFloor is (floor, seq)-
    // ordered from listVarsOps). Mirrors live write behavior: a patch overwrites delta_data with its
    // own deltas (varsWrite.ts); a replace swaps stat_data whole and leaves delta_data untouched.
    for (const entry of opsByFloor.get(f.floor) ?? []) {
      cardWrites++
      if (entry.kind === 'patch') {
        const d = applyJsonPatch(stat, entry.payload as JsonPatchOp[])
        if (d.length) deltas = d
      } else {
        const p = entry.payload
        for (const k of Object.keys(stat)) delete stat[k]
        if (p && typeof p === 'object') Object.assign(stat, JSON.parse(JSON.stringify(p)))
      }
    }
    f.variables = {
      ...f.variables,
      stat_data: JSON.parse(JSON.stringify(stat)),
      delta_data: deltas
    }
    saveFloor(profileId, chatId, f)
  }
  log(
    'info',
    `MVU re-evaluate — replayed ${floors.length - start} floor(s)` +
      (start > 0 ? ` (from floor ${start})` : '') +
      `; rebuilt stat_data` +
      (cardWrites > 0 ? `; replayed ${cardWrites} card write(s)` : '')
  )
  return floors
}

/** Pure: return a copy of the floor with stat_data replaced and delta_data cleared (a manual whole-doc
 *  edit has no AI-turn delta). Other variables + floor fields are preserved. */
export const withStatData = (floor: FloorFile, statData: unknown): FloorFile => ({
  ...floor,
  variables: { ...floor.variables, stat_data: statData, delta_data: [] }
})

/** Replace a floor's stat_data wholesale (the Variables-view editor's write path). Real sessions
 * journal the edit as a user operation and replay later floors atomically; the direct save is the
 * no-database unit-seam fallback. */
export const setFloorStatData = (
  profileId: string,
  chatId: string,
  floor: number,
  statData: unknown
): FloorFile | null => {
  const f = getFloor(profileId, chatId, floor)
  if (!f) return null
  const floorState = floorStateForChat(chatId)
  if (floorState) {
    floorState.append(chatId, floor, 'user', [
      { kind: 'set', path: 'variables.stat_data', value: statData }
    ])
    return getFloor(profileId, chatId, floor)
  }
  const updated = withStatData(f, statData)
  saveFloor(profileId, chatId, updated)
  return updated
}

/**
 * Image-generation hook (TH-4). No image provider is wired yet, so this is a logged
 * stub that returns null; the API surface exists so scripts/cards can call it and
 * degrade gracefully until a provider is configured.
 */
export const generateImage = async (_profileId: string, prompt: string): Promise<string | null> => {
  log('info', `image generation requested (no provider configured): ${String(prompt).slice(0, 80)}`)
  return null
}

/**
 * Re-roll the latest turn: drop the last floor and generate again from the same
 * user action. Refuses to regenerate the opening greeting (it has no action).
 */
export const regenerate = async (
  profileId: string,
  chatId: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile | null> => {
  const chat = getChat(profileId, chatId)
  if (!chat || chat.floor_count === 0) throw new Error('Nothing to regenerate')

  const lastIndex = chat.floor_count - 1
  const last = getFloor(profileId, chatId, lastIndex)
  if (!last) throw new Error('Last floor missing')
  if (!last.user_message.content) throw new Error('Cannot regenerate the opening greeting')

  truncateFloors(profileId, chatId, lastIndex)
  // ST generation type 'regenerate' (openai.js `type`) — a preset block gated to specific types via
  // injection_trigger fires here only when it lists 'regenerate'.
  return generate(profileId, chatId, last.user_message.content, onDelta, 'player', 'regenerate')
}

/**
 * Generate an additional response for the latest turn and store it as a NEW swipe
 * (alternate) on that floor, without discarding the existing alternates (TH-2). Like
 * regenerate, but the prior responses are preserved and the new one becomes active.
 */
export const generateSwipe = async (
  profileId: string,
  chatId: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile | null> => {
  const chat = getChat(profileId, chatId)
  if (!chat || chat.floor_count === 0) throw new Error('Nothing to swipe')

  const lastIndex = chat.floor_count - 1
  const last = getFloor(profileId, chatId, lastIndex)
  if (!last) throw new Error('Last floor missing')
  if (!last.user_message.content) throw new Error('Cannot swipe the opening greeting')

  // Capture the existing alternates before the re-roll drops the floor.
  const prior = normalizeSwipes(last.swipes, last.response.content, last.swipe_id).swipes

  truncateFloors(profileId, chatId, lastIndex)
  // ST generation type 'swipe' — same as regenerate but the prior alternates are preserved below.
  const fresh = await generate(profileId, chatId, last.user_message.content, onDelta, 'player', 'swipe')
  if (!fresh) {
    // Aborted / empty — restore the original floor so the swipe attempt loses nothing.
    saveFloor(profileId, chatId, last)
    return getFloor(profileId, chatId, lastIndex)
  }

  // Append the new response to the prior alternates and make it the active swipe.
  const swipes = [...prior, fresh.response.content]
  fresh.swipes = swipes
  fresh.swipe_id = swipes.length - 1
  saveFloor(profileId, chatId, fresh)
  return fresh
}
