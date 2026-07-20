import { RunContext } from './runContext'
import { trimProcessedContext, exportTableEntries } from './classicStages'
import { sampleMainCall } from './mainSample'
import { buildGenContext } from './genContext'
import { matchWorldInfo, assemblePrompt } from './assemble'
import { parseResponse, computeMetrics } from './parseResponse'
import { foldState } from './foldState'
import { persistFloor } from './persistFloor'
import { runVnGate, mergeYuzuMvu } from '../yuzu/vnGate'
import { GenContext } from './types'
import { FloorFile } from '../../types/chat'

/**
 * THE DIRECT CLASSIC ORCHESTRATION (Classic Narrator first execution plan, Milestone 3; single-path as
 * of M5a; workflow-free as of M5c-1).
 *
 * A straight-line reproduction of the eight stages a Classic turn runs — proven, node by node and in this
 * exact order, by the (deleted-with-the-engine) classicTurnInventory characterization — calling the SAME
 * services the corresponding nodes called. No pipeline, graph, hook bus, scheduler, or registry dispatch
 * is involved: this is eight awaited calls. As of M5c-1 the RunResult/NodeTrace scaffolding is gone — the
 * turn no longer synthesizes a workflow run for the deleted trace/run-history chain — so this returns the
 * persisted floor directly (`null` on abort, a THROW on a fatal stage, which `generate()` surfaces as a
 * real error rather than a silent user-Stop).
 *
 * WHAT A PORT-ONLY REWRITE WOULD SILENTLY DROP, and is therefore preserved deliberately:
 *  · the ONE shared `GenContext` object threaded through every stage — three off-port channels ride it:
 *      – `gen.executionRecord`, stamped by assembly, persisted by `persistFloor`;
 *      – `gen.floorStateBaseline`, stamped by `foldState` on floor 0, consumed by `persistFloor`;
 *      – `gen.workingVars` BY REFERENCE — assemble.ts's documented "PARITY HAZARD": build-time
 *        `{{setvar}}` macros mutate that very object while the prompt is being built, and `foldState`
 *        folds this turn's events ON TOP of those mutations. Nothing carries the value between the two
 *        stages except the shared object. Copying instead of sharing still lets the turn SUCCEED while
 *        silently losing data, so `gen` is never cloned, spread, or re-derived below.
 *  · the two-signal abort split: the user's Stop aborts the STREAM (`ctx.modelSignal`); the graph signal
 *    (`ctx.signal`, aborted via `ctx.abortGraph`) fires only when there is nothing to persist. Abort-
 *    with-text therefore still persists a floor; abort-with-empty returns null.
 *  · a fatal stage THROWS (a give-up from `sampleMainCall`, an assembly error): the rejection propagates
 *    to `generate()`, which surfaces it as a real error. Abort returns null (a user Stop, never a banner).
 */

/** Sentinel returned by `stage` when the graph signal aborted before the stage could run. */
const ABORTED: unique symbol = Symbol('classic-turn-aborted')

/**
 * Run one Classic turn directly. Resolves to the persisted floor, `null` on abort (nothing to hand back),
 * or rejects on a fatal stage.
 */
export const runClassicTurnDirect = async (ctx: RunContext): Promise<FloorFile | null> => {
  /** One stage: the graph-signal abort check before running. The engine checked the GRAPH signal before
   *  every node — the same check is what makes abort-with-empty skip parse/apply/write here. */
  const stage = async <T>(fn: () => T | Promise<T>): Promise<T | typeof ABORTED> => {
    if (ctx.signal.aborted) return ABORTED
    return fn()
  }

  // ── 1. input.context ───────────────────────────────────────────────────────────────────────────
  const seed = await stage(() =>
    buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction!, ctx.generationType)
  )
  if (seed === ABORTED) return null

  // ── 2. context.trimProcessed (identity when no progress pointer — returns the SAME object) ─────
  const trimmed = await stage(() => trimProcessedContext(seed))
  if (trimmed === ABORTED) return null
  // From here on `gen` is THE shared object for the rest of the turn (see the header's channel list).
  const gen: GenContext = trimmed

  // ── 3. table.export (silent empty projection when no table template is bound) ──────────────────
  const exported = await stage(() => exportTableEntries(gen, {}))
  if (exported === ABORTED) return null

  // ── 4. prompt.assemble ─────────────────────────────────────────────────────────────────────────
  const assembled = await stage(() => {
    const matched = matchWorldInfo(gen)
    const extra = exported.entries
    const result = assemblePrompt(
      gen,
      extra.length ? [...matched, ...extra] : matched,
      // The seeded doc leaves assemble's `block` input UNWIRED (export feeds `entries`), so the
      // memory block is `undefined` here exactly as it was on the workflow path.
      undefined as unknown as string
    )
    // OFF-PORT CHANNEL: stamp the forensic record onto the shared `gen` so persistFloor stores it.
    if (result.record) gen.executionRecord = result.record
    return result
  })
  if (assembled === ABORTED) return null
  const { sendMessages, params } = assembled

  // ── 5. llm.sample — the ONE provider call, through the Milestone 1 Harness seam ────────────────
  const sampled = await stage(() => sampleMainCall(ctx, gen, { sendMessages, params }, undefined, {}))
  if (sampled === ABORTED) return null
  if (sampled === null) {
    // Abort-with-EMPTY: nothing to persist. Abort the graph signal so a caller inspecting it sees the
    // turn as aborted, and return null (a user Stop).
    ctx.abortGraph?.()
    return null
  }
  // Abort-with-TEXT lands here and runs on, so the partial floor is persisted (pre-workflow behavior).

  // ── 6. parse.response ─────────────────────────────────────────────────────────────────────────
  const parsedOut = await stage(async () => {
    // Project Yuzu WP-S2 (ADR 0009 §1): the mode-gated acceptance-gate seam. In VN mode the raw reply
    // runs the WP-B ladder BEFORE anything downstream sees it; the validated/fallback scene text
    // (finalRaw) is what parse/apply/write consume, its `<| effect |>` beat effects fold into canon, and
    // the gate result is stashed on the SHARED `gen` for the terminal write stage. Classic turns
    // (vnMode off) skip this and stay byte-identical.
    if (gen.vnMode) {
      const gate = await runVnGate(ctx, gen, sampled.raw)
      gen.yuzuGate = { finalRaw: gate.finalRaw, scene: gate.scene, trace: gate.trace }
      const { parsed, mvu: classicMvu } = parseResponse(gate.finalRaw)
      return {
        parsed,
        mvu: mergeYuzuMvu(gate.mvu, classicMvu),
        metrics: computeMetrics(gen, sendMessages, gate.finalRaw, sampled.rawUsage)
      }
    }
    const { parsed, mvu } = parseResponse(sampled.raw)
    return {
      parsed,
      mvu,
      metrics: computeMetrics(gen, sendMessages, sampled.raw, sampled.rawUsage)
    }
  })
  if (parsedOut === ABORTED) return null

  // ── 7. apply.state (folds onto gen.workingVars IN PLACE — the by-reference channel) ────────────
  const variables = await stage(() => foldState(gen, parsedOut.parsed, parsedOut.mvu, sampled.raw))
  if (variables === ABORTED) return null

  // ── 8. output.writeFloor — the durable write, BEFORE the response is handed over ───────────────
  const floor = await stage(() =>
    persistFloor(gen, {
      userAction: gen.userAction,
      // Project Yuzu WP-S2 (ADR 0009 §3): a VN floor stores the gate's validated/fallback scene text as
      // its response (not the pre-gate raw) and carries the gate trace; classic floors pass the raw
      // through and write no `yuzu_trace` (byte-identical).
      raw: gen.yuzuGate ? gen.yuzuGate.finalRaw : sampled.raw,
      sendMessages,
      events: parsedOut.parsed.events,
      variables,
      metrics: parsedOut.metrics,
      ...(gen.yuzuGate?.trace ? { yuzu_trace: gen.yuzuGate.trace } : {})
    })
  )
  if (floor === ABORTED) return null

  return floor
}
