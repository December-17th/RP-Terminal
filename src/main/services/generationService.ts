import { getLorebookById } from './lorebookService'
import { getChat, getChatLorebookIds, truncateFloors } from './chatService'
import { getCharacter } from './characterService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import { collectRenderMarkers } from './promptBuilder'
import { DeltaCallback } from './apiService'
import { parseMvuCommands, applyMvuCommands, applyJsonPatch } from '../parsers/mvuParser'
import { stripThinking } from '../parsers/contentParser'
import { log } from './logService'
import { FloorFile } from '../types/chat'
import { Lorebook } from '../types/character'
import { applyEvent } from './generation/foldState'
import { resetWriteLoopGuard } from './generation/varsWrite'
import { buildTurnContext } from './nodes/turnContext'
import { builtinRegistry } from './nodes/builtin'
import { runWorkflow } from './workflowEngine'
import { resolveWorkflowDoc } from './workflowService'
import { summarizeRun } from '../../shared/workflow/trace'
import { notifyWorkflowTrace } from './workflowEvents'

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
  applyVariableOps
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
import { activeControllers } from './generation/rawGenerate'

/**
 * Run one full turn: assemble the prompt, call the model, post-process (regex →
 * tag parse), fold state events into the running variables, persist a new floor,
 * and return it. All orchestration lives here so the renderer just calls one IPC.
 */

export const generate = async (
  profileId: string,
  chatId: string,
  userAction: string,
  onDelta: DeltaCallback = () => {}
): Promise<FloorFile | null> => {
  const chat = getChat(profileId, chatId)
  if (!chat) throw new Error('Chat session not found')

  const _card = getCharacter(profileId, chat.character_id)
  if (!_card) throw new Error('Character card not found')

  // A new model turn legitimately re-fires MVU events; clear the write-back loop streak so a path
  // re-written once per turn never builds a false runaway streak across turns (WS-3).
  resetWriteLoopGuard(chatId)

  const controller = new AbortController()
  activeControllers.set(chatId, controller)
  try {
    const { id: workflowId, doc } = resolveWorkflowDoc(profileId, chatId)
    // Panel headers for opt-in node output panels (spec D4): node id → its doc panel label.
    const panelLabels: Record<string, string> = {}
    for (const n of doc.nodes) if (n.panel?.show && n.panel.label) panelLabels[n.id] = n.panel.label
    const ctx = buildTurnContext({
      profileId,
      chatId,
      userAction,
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
    const runPromise = runWorkflow(doc, builtinRegistry, ctx)
    // Broadcast the run trace when the FULL run settles (post phase included) — ok, aborted,
    // AND fatal — the trace panel is most useful when a turn just failed (spec §13).
    void runPromise
      .then((res) =>
        notifyWorkflowTrace(
          summarizeRun(doc, builtinRegistry.descriptors(), res, {
            chatId,
            workflowId,
            startedAt,
            durationMs: Date.now() - startedAt
          })
        )
      )
      .catch((err) => log('error', `workflow trace failed — ${err?.message || String(err)}`))

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
    activeControllers.delete(chatId)
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
 * derived state is recomputed. Cumulative (floor N's stat_data = replay of floors 0..N). Returns
 * the updated floors.
 */
export const reevaluateVariables = (profileId: string, chatId: string): FloorFile[] => {
  const floors = getAllFloors(profileId, chatId)
  const stat: Record<string, unknown> = {}
  for (const f of floors) {
    const mvu = parseMvuCommands(stripThinking(f.response.content))
    const deltas = [
      ...(mvu.commands.length ? applyMvuCommands(stat, mvu.commands) : []),
      ...(mvu.patches.length ? applyJsonPatch(stat, mvu.patches) : [])
    ]
    f.variables = {
      ...f.variables,
      stat_data: JSON.parse(JSON.stringify(stat)),
      delta_data: deltas
    }
    saveFloor(profileId, chatId, f)
  }
  log('info', `MVU re-evaluate — replayed ${floors.length} floor(s); rebuilt stat_data`)
  return floors
}

/** Pure: return a copy of the floor with stat_data replaced and delta_data cleared (a manual whole-doc
 *  edit has no AI-turn delta). Other variables + floor fields are preserved. */
export const withStatData = (floor: FloorFile, statData: unknown): FloorFile => ({
  ...floor,
  variables: { ...floor.variables, stat_data: statData, delta_data: [] }
})

/** Replace a floor's stat_data wholesale (the Variables-view editor's write path) and persist. */
export const setFloorStatData = (
  profileId: string,
  chatId: string,
  floor: number,
  statData: unknown
): FloorFile | null => {
  const f = getFloor(profileId, chatId, floor)
  if (!f) return null
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
  return generate(profileId, chatId, last.user_message.content, onDelta)
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
  const fresh = await generate(profileId, chatId, last.user_message.content, onDelta)
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
