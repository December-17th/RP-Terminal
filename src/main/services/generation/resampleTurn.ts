import { RunContext } from './runContext'
import { sampleMainCall } from './mainSample'
import { buildGenContext } from './genContext'
import { deriveSamplingParams } from './assemble'
import { parseResponse, computeMetrics } from './parseResponse'
import { foldState } from './foldState'
import { persistFloor } from './persistFloor'
import { GenContext } from './types'
import { ChatMessage } from '../promptBuilder'
import { FloorFile } from '../../types/chat'
import { variablesParentAt } from '../floorFold'
import { runYuzuSceneDirector } from '../yuzu/sceneDirector'
import { log } from '../logService'
import type { FloorStateOperation } from '../agentRuntime/floorState'

/**
 * THE RESAMPLE ORCHESTRATION (lore-runtime V8 WP-G1 / ADR 0023).
 *
 * A straight-line replay of the last floor's STORED prompt: regenerate / swipe on a chat whose Assembly
 * Epoch still matches the floor's stamp draw only a NEW model response — no memory recall, no context
 * trim, no table export, no lore match, no prompt assembly, no build-time EJS. The stored `request`
 * bytes are re-sent verbatim (a guaranteed provider-cache prefix hit) and the captured build-time
 * `'template'` writes are replayed onto the seed variables so the fold sees exactly what the live turn's
 * fold saw. The eligibility decision + capture-before-the-cut live in `generationService`; this function
 * assumes the cut already happened and the seed floor is the new latest.
 *
 * Mirrors `classicTurn.ts`'s stage skeleton — same ABORTED sentinel, same two-signal abort split (the
 * user's Stop aborts the STREAM via `ctx.modelSignal`; the graph signal `ctx.signal`, aborted through
 * `ctx.abortGraph`, fires only on abort-with-empty). The shared `gen.workingVars` is mutated IN PLACE by
 * `applyCapturedTemplateOps` and `foldState`, exactly as the live path mutates it — never cloned.
 *
 * Off-port `gen` channels vs. classicTurn: `gen.executionRecord` is DELIBERATELY left unset — assembly
 * did not run again, so `persistFloor` stores no new record and the floor keeps the record its original
 * assembly stamped. `gen.floorStateBaseline` still stamps on floor 0 (via `foldState`), unchanged.
 */

/** Everything the Resample path lifts from the target floor BEFORE the cut deletes it. */
export interface CapturedResample {
  /** The stored provider prompt (`persistFloor`'s `request`) — re-sent byte-for-byte. */
  sendMessages: ChatMessage[]
  /** The floor's `'template'`-source pre-fold journal ops — replayed onto the seed vars, then
   *  re-journaled against the replacement floor (so Forward Replay keeps reproducing them). */
  templateOps: FloorStateOperation[]
  /** The floor's display-only plot block, carried onto the replacement floor when present. */
  plotBlock?: string
}

/** Sentinel returned by `stage` when the graph signal aborted before the stage could run. */
const ABORTED: unique symbol = Symbol('resample-turn-aborted')

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Apply the captured `'template'` ops onto the seed variables IN PLACE, in journal (seq) order — the
 * live path's pre-fold order. This is the same set/delete/increment application `FloorState`'s replay
 * makes for a `'template'` operation (`variablesParentAt` + the identical arithmetic), so the folded
 * result matches Forward Replay. The op paths are rooted at `variables.` and `variablesParentAt` drops
 * that root, targeting `workingVars` (which IS the variables object) directly.
 */
const applyCapturedTemplateOps = (
  variables: Record<string, unknown>,
  operations: readonly FloorStateOperation[]
): void => {
  for (const operation of operations) {
    if (operation.kind === 'delete') {
      const target = variablesParentAt(variables, operation.path, false)
      if (target) delete target.parent[target.key]
      continue
    }
    const target = variablesParentAt(variables, operation.path, true)
    if (!target) continue
    if (operation.kind === 'increment') {
      const current = target.parent[target.key]
      target.parent[target.key] = (typeof current === 'number' ? current : 0) + operation.value
    } else {
      target.parent[target.key] = cloneJson(operation.value)
    }
  }
}

/**
 * Run one Resample turn directly. Resolves to the persisted floor, `null` on abort (nothing to hand
 * back), or rejects on a fatal stage — the same contract as `runClassicTurnDirect`.
 */
export const runResampleTurnDirect = async (
  ctx: RunContext,
  captured: CapturedResample
): Promise<FloorFile | null> => {
  const stage = async <T>(fn: () => T | Promise<T>): Promise<T | typeof ABORTED> => {
    if (ctx.signal.aborted) return ABORTED
    return fn()
  }

  // ── 1. input.context (cheap: chat/card/settings/preset/floors + workingVars seed, no model call) ──
  const seed = await stage(() =>
    buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction!, ctx.generationType)
  )
  if (seed === ABORTED) return null
  const gen: GenContext = seed

  // ── 2. replay the captured build-time template writes onto the seed vars (pre-fold order) ────────
  const applied = await stage(() => {
    applyCapturedTemplateOps(gen.workingVars, captured.templateOps)
    return true as const
  })
  if (applied === ABORTED) return null

  // ── 3. sample — the stored prompt, params freshly derived from the CURRENT preset ────────────────
  const sampled = await stage(() =>
    sampleMainCall(
      ctx,
      gen,
      { sendMessages: captured.sendMessages, params: deriveSamplingParams(gen.preset, gen.fsmEnabled, gen.modeConfig) },
      undefined,
      {}
    )
  )
  if (sampled === ABORTED) return null
  if (sampled === null) {
    // Abort-with-EMPTY: nothing to persist. Abort the graph signal and return null (a user Stop).
    ctx.abortGraph?.()
    return null
  }
  // Abort-with-TEXT lands here and runs on, so the partial floor is persisted (live-path behavior).

  // ── 4. parse.response ────────────────────────────────────────────────────────────────────────────
  const parsedOut = await stage(() => {
    const { parsed, mvu } = parseResponse(sampled.raw)
    return {
      parsed,
      mvu,
      metrics: computeMetrics(gen, captured.sendMessages, sampled.raw, sampled.rawUsage)
    }
  })
  if (parsedOut === ABORTED) return null

  // ── 5. apply.state (folds onto gen.workingVars IN PLACE, on top of the replayed template writes) ─
  const variables = await stage(() => foldState(gen, parsedOut.parsed, parsedOut.mvu, sampled.raw))
  if (variables === ABORTED) return null

  // ── 6. output.writeFloor — captured template ops re-journal against the replacement floor; the
  //       plot block is carried across. No execution record is stamped (assembly did not re-run). ──
  const floor = await stage(() =>
    persistFloor(gen, {
      userAction: gen.userAction,
      raw: sampled.raw,
      sendMessages: captured.sendMessages,
      events: parsedOut.parsed.events,
      variables,
      metrics: parsedOut.metrics,
      templateWrites: captured.templateOps,
      ...(captured.plotBlock ? { plot_block: captured.plotBlock } : {})
    })
  )
  if (floor === ABORTED) return null
  log(
    'info',
    `resample: floor ${floor.floor} redrawn from the stored prompt (${captured.sendMessages.length} msgs, ${captured.templateOps.length} template op(s))`
  )

  if (!gen.vnMode) return floor
  const directed = await stage(() => runYuzuSceneDirector(ctx, gen, floor))
  return directed === ABORTED ? floor : directed
}
