/**
 * ONE `hasActiveBackgroundWork` signal (Classic Narrator plan, Milestone 4 — active-work exit warning).
 *
 * The plan asks for one signal derived from the authoritative live-run registry. There is no single
 * authoritative registry: each source below owns a DIFFERENT kind of in-flight work, and any one of
 * them alone silently reports "idle" while real work is running. So the signal is the UNION of the
 * six, read through a trivial read-only accessor on each owner (no reaching into internals):
 *
 *   - InvocationRuntime   — Agent invocations queued or running, and plans still stepping.
 *   - generationService   — a MAIN Classic turn in flight (pre phase) for any chat.
 *   - rawGenerate         — a `generateRaw` call in flight: combat adjudication, enemy turns, duel
 *     narration, a card script's TH generateRaw. These run from their own IPC handlers, outside the
 *     turn guard, and write to the chat. This covers the `activeControllers` map ONLY — it is NOT
 *     "any provider call": `callModel` deliberately leaves the controller lifecycle to `generate()`
 *     and never registers there, so every `callModelResilient` caller is invisible to this source.
 *   - tableBackfillService — a manual multi-batch table backfill mid-job.
 *   - tableRefillService   — a manual multi-batch table refill mid-job.
 *
 * (M5c-2 removed the sixth source, `headlessRunService.hasActiveTriggerEvaluation`, together with the
 * deleted workflow surface. It was never the coverage for the floor-commit trigger runtime — a triggered
 * Agent dispatches through `invocationRuntime().run`, the identity path, so its in-flight work is already
 * counted by `hasActiveAgentWork()`; no union member was lost.)
 *
 * `activeControllers` and `activeTurns` OVERLAP rather than nest, so both are needed: a turn sets an
 * entry in the shared per-chat `activeControllers` map, but so does a raw call, which overwrites the
 * turn's entry and then deletes the shared key in its `finally` — the raw map can therefore go empty
 * while a turn is still running, and is non-empty for raw work the turn map never sees.
 *
 * The remaining direct provider callers are covered transitively rather than by their own accessor.
 * The model-backed nodes (`llm.sample`, `agent.llm`, `memory.recall`, `memory.maintain`,
 * `notes.maintain` — all five reach the provider through `runLlmCall`) execute either under
 * `runWorkflow`/`runSubgraph`, entered from a turn or from headless trigger evaluation, or under
 * Milestone 3's direct Classic path, which reaches `runLlmCall` without the engine. All three entries
 * are already sources. `tableMaintainerLoop` is not an entry point — its only callers are the backfill
 * and refill services above.
 *
 * The prompt-preview path (`previewService`) is the one direct provider caller left UNCOVERED, and
 * that is a judgement call rather than a coverage gap, so it is stated precisely. Preview does NOT
 * avoid the provider: `buildPreviewRegistry` stubs only `llm.sample` plus the eight
 * `SIDE_EFFECT_TYPES`, and none of the other four `runLlmCall` node types is in either set, so they
 * run for real. `memory.recall` in particular feeds `prompt.assemble`'s `block` input, so it executes
 * BEFORE the `llm.sample` stub's `abortGraph()` fires — previewing a chat whose effective doc carries
 * a recall node makes a real, untracked provider call. It is left uncovered because quitting mid-
 * preview discards nothing DURABLE: recall writes no state, and the post-phase writers
 * (`memory.maintain`, `notes.maintain`) really are skipped by the abort. The cost is a wasted API
 * call, categorically unlike the backfill/refill hole, which lost memory-table writes. Re-evaluate
 * this if preview ever gains a durable writer upstream of the stub.
 *
 * Deliberately NOT used as a source: AgentRunStore's persisted `status = 'running'` rows. Those are
 * durable per-chat records that outlive the process, so after a crash they still read "running" for
 * work that is long dead; they answer "what was interrupted", not "what is in flight now".
 *
 * Synchronous and side-effect free by construction: this is read from a `before-quit` / window-close
 * handler, which cannot await before deciding whether to preventDefault().
 */

import { hasActiveAgentWork } from './agentRuntime/InvocationRuntimeService'
import { hasActiveRawGeneration } from './generation/rawGenerate'
import { hasActiveTurns } from './generationService'
import { hasActiveBackfill } from './tableBackfillService'
import { hasActiveRefill } from './tableRefillService'

export const hasActiveBackgroundWork = (): boolean =>
  hasActiveAgentWork() ||
  hasActiveTurns() ||
  hasActiveRawGeneration() ||
  hasActiveBackfill() ||
  hasActiveRefill()
