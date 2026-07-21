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
import { RunContext } from './generation/runContext'
import { runClassicTurnDirect } from './generation/classicTurn'
import { waitForNextTurnBarriers } from './agentRuntime/InvocationRuntimeService'
import { ABORTED_BY_SIGNAL, raceAbortSignal } from './generation/abortRace'

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

/** READ-ONLY: is a MAIN turn in flight for any chat? (Classic Narrator plan, Milestone 4 — one of
 *  the three sources unioned into `hasActiveBackgroundWork()`.) Synchronous, no mutation exposed. */
export const hasActiveTurns = (): boolean => activeTurns.size > 0

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
    // blocksNextTurn barrier (execution-plan M3, decision D5 = fail-open, warned). A required Agent that
    // declared blocksNextTurn holds the NEXT turn until it settles, so the turn's prompt reads the
    // Agent's committed writes. Awaited HERE — before `buildGenContext`/assembly reads variables, and on
    // the seam that covers normal generate, regenerate, and swipe (all funnel through generate()).
    // Policy is fail-open: a failed/cancelled required Agent releases the barrier and the turn proceeds;
    // a Stop cancels the invocation, which also releases it. The wait is RACED against this turn's own
    // abort (Finding 3) so a hung blocksNextTurn run can never pin the next turn with no escape — a Stop
    // during the barrier exits the turn down its normal abort path (return null, no floor).
    const barrier = await raceAbortSignal(waitForNextTurnBarriers(chatId), controller.signal)
    if (barrier === ABORTED_BY_SIGNAL) return null
    if (barrier.status === 'failed') {
      for (const failure of barrier.failures) {
        log(
          'error',
          `blocksNextTurn Agent failed for chat ${chatId} — proceeding fail-open (D5): ${failure.code}: ${failure.message}`
        )
      }
    }

    // SINGLE-PATH, WORKFLOW-FREE CLASSIC (execution-plan M5a single-path → M5c-1 workflow-free). Every
    // Classic turn takes the DIRECT orchestration (`runClassicTurnDirect` — eight awaited service calls,
    // no engine, no doc, no run-trace/run-history/trigger chain). The detached post-turn chain that fed
    // the deleted workflow trace / run-history / doc-and-pack trigger evaluation is gone; memory
    // maintenance now fires from the M3 floor-commit trigger runtime, not `evaluateDocTriggers`. The
    // turn's evidence is the byte-accurate request/response logs + `gen.executionRecord` persisted by the
    // stages themselves, unchanged.
    //
    // Two-signal abort split: the graph signal (`ctx.signal`, aborted only on abort-with-empty via
    // `abortGraph`) vs the user's Stop (`ctx.modelSignal` = `controller.signal`, aborts the stream). The
    // panel / node-state hooks are inert no-ops on this path. `runClassicTurnDirect` returns the persisted
    // floor, `null` on abort, or throws on a fatal stage (surfaced by the IPC caller as a real error).
    const graphController = new AbortController()
    const ctx: RunContext = {
      profileId,
      chatId,
      userAction,
      generationType: genType,
      signal: graphController.signal,
      modelSignal: controller.signal,
      abortGraph: () => graphController.abort(),
      streamMain: (delta) => onDelta(delta),
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }
    return await runClassicTurnDirect(ctx)
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
