import { WorkflowDoc } from '../../../shared/workflow/types'
import { topoOrder } from '../../../shared/workflow/graph'
import { RunContext, NodeError, NodeRunFailure } from '../nodes/types'
import { NodeTrace, RunResult, computeExcluded, computePhases } from '../workflowEngine'
import { builtinRegistry } from '../nodes/builtin'
import { trimProcessedContext } from '../nodes/builtin/contextNodes'
import { exportTableEntries } from '../nodes/builtin/tableNodes'
import { sampleMainCall } from '../nodes/builtin/generationNodes'
import { assembledArtifact } from '../nodes/promptArtifact'
import { buildGenContext } from './genContext'
import { matchWorldInfo, assemblePrompt } from './assemble'
import { parseResponse, computeMetrics } from './parseResponse'
import { foldState } from './foldState'
import { persistFloor } from './persistFloor'
import { GenContext } from './types'

/**
 * THE DIRECT CLASSIC ORCHESTRATION (Classic Narrator first execution plan, Milestone 3).
 *
 * A straight-line reproduction of the eight stages a Classic turn actually runs — proven, node by node
 * and in this exact order, by test/workflow/classicTurnInventory.test.ts (Milestone 2's evidence) —
 * calling the SAME services the corresponding nodes call. No pipeline, graph, hook bus, scheduler, or
 * registry dispatch is introduced: this is eight awaited calls.
 *
 * It runs ONLY when `isClassicDirectShape` says the resolved doc's turn phase is structurally identical
 * to the seeded default and nothing was composed into it (see classicShape.ts for why that gate exists
 * and why removing `runWorkflow` unconditionally would be a capability regression). Because of that
 * gate the node ids below are guaranteed to be the seeded doc's, and doc validation is guaranteed to
 * pass — which is why neither is re-derived here.
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
 *  · `onResponseReady` fired at the same instant the pre phase completes — i.e. AFTER the floor is
 *    durably persisted, BEFORE the response is handed back (workflowEngine.ts's phase boundary).
 *  · the two-signal abort split (turnContext.ts): the user's Stop aborts the STREAM; the graph signal
 *    fires only when there is nothing to persist. Abort-with-text therefore still persists a floor.
 *  · hard failure surfaces as a fatal RESULT (narrator nodes are never fail-open), abort returns null.
 *  · run history + the live trace panel: a synthesized `RunResult` is returned, so generationService's
 *    existing summarizeRun / notifyWorkflowTrace / appendRun block is reached UNCHANGED and Classic run
 *    history keeps working on this path.
 */

/** The eight turn-phase node ids of the seeded default, in execution order. The shape predicate
 *  guarantees the resolved doc carries exactly these (ids included). */
const ORDER = ['ctx', 'trim', 'export', 'assemble', 'llm', 'parse', 'apply', 'write'] as const

/** Sentinel returned by `stage` when the graph signal aborted before the stage could run. */
const ABORTED: unique symbol = Symbol('classic-turn-aborted')

/*  Trace bookkeeping for the nodes this path does not execute. The ORDER matters, not just the set:
 *  the Runs timeline renders rows in trace order, so a synthesized trace that lists the same nodes in a
 *  different sequence shows the user a different-looking run for the same turn. The engine emits, in
 *  this order:
 *    1. `seedExcluded` — every excluded node (trigger root / disabled), 'skipped' in the PRE phase,
 *       in doc.nodes order, BEFORE anything runs;
 *    2. the pre-phase nodes in topological order (ran / skipped / failed);
 *    3. the post-phase nodes — and ONLY when the pre phase completed or aborted. A pre-phase FATAL
 *       returns from `runNodes` immediately, so neither the remaining pre nodes nor any post node is
 *       traced at all.
 *  The two helpers below reproduce 1 and 3; the stage loop produces 2. */

/** Step 1 — the excluded nodes, traced before any stage runs (workflowEngine.seedExcluded). */
const excludedTraces = (doc: WorkflowDoc): NodeTrace[] => {
  const excluded = computeExcluded(doc, builtinRegistry)
  return doc.nodes
    .filter((n) => excluded.has(n.id))
    .map((n): NodeTrace => ({ nodeId: n.id, status: 'skipped', phase: 'pre' }))
}

/** Step 3 — the post-phase nodes, in the same topological order the engine walks them. On this path
 *  they are always 'skipped': the predicate admits only docs whose post phase is the seeded default's
 *  trigger-rooted memory group, which classicTurnInventory.test.ts pins as never reached by a turn. */
const postTraces = (doc: WorkflowDoc): NodeTrace[] => {
  const excluded = computeExcluded(doc, builtinRegistry)
  const { postIds } = computePhases(doc)
  return topoOrder(doc)
    .filter((id) => !excluded.has(id) && postIds.has(id))
    .map((id): NodeTrace => ({ nodeId: id, status: 'skipped', phase: 'post' }))
}

const errorOf = (err: unknown, nodeId: string): NodeError => {
  const f = err instanceof NodeRunFailure ? err : undefined
  return {
    kind: f?.kind ?? 'A',
    message: err instanceof Error ? err.message : String(err),
    ...(f?.code !== undefined ? { code: f.code } : {}),
    nodeId,
    attempts: f?.attempts ?? 1
  }
}

/** The aborted result: the engine marks everything not yet run as skipped and never fires
 *  onResponseReady, so `generate()` returns null (a user Stop, never an error banner). */
const abortedResult = (
  doc: WorkflowDoc,
  traces: NodeTrace[],
  outputs: Map<string, Record<string, unknown>>,
  debug: Map<string, Record<string, unknown>>,
  ran: Set<string>
): RunResult => {
  // The engine's abort path: the remaining PRE nodes are traced 'skipped' by the same loop that would
  // have run them, then the post nodes are marked skipped before bailing without onResponseReady.
  const remaining = ORDER.filter((id) => !ran.has(id)).map(
    (id): NodeTrace => ({ nodeId: id, status: 'skipped', phase: 'pre' })
  )
  return {
    ok: false,
    aborted: true,
    traces: [...traces, ...remaining, ...postTraces(doc)],
    outputs,
    debug
  }
}

/**
 * Run one Classic turn directly. Resolves to the same `RunResult` shape `runWorkflow` returns, so
 * `generate()` races, classifies, traces, and persists run history through its existing code.
 */
export const runClassicTurnDirect = async (
  doc: WorkflowDoc,
  ctx: RunContext
): Promise<RunResult> => {
  const outputs = new Map<string, Record<string, unknown>>()
  const debug = new Map<string, Record<string, unknown>>()
  // Seeded FIRST, exactly like the engine — the excluded trigger nodes head the trace, they do not
  // trail it (see the ordering note above `excludedTraces`).
  const traces: NodeTrace[] = excludedTraces(doc)
  const ran = new Set<string>()

  /** One stage: the engine's per-node envelope (abort check → run → timed trace), minus the wiring,
   *  prune, and config-parse machinery a fixed straight line does not need. */
  const stage = async <T>(id: string, fn: () => T | Promise<T>): Promise<T | typeof ABORTED> => {
    // The engine checks the GRAPH signal before every node (workflowEngine.runNodes) — the same check
    // is what makes abort-with-empty skip parse/apply/write here.
    if (ctx.signal.aborted) return ABORTED
    const started = Date.now()
    const value = await fn()
    traces.push({ nodeId: id, status: 'ran', phase: 'pre', ms: Date.now() - started })
    ran.add(id)
    return value
  }

  let current: string = ORDER[0]
  try {
    // ── 1. input.context ───────────────────────────────────────────────────────────────────────────
    const seed = await stage('ctx', () =>
      buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction!, ctx.generationType)
    )
    if (seed === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    outputs.set('ctx', { gen: seed })

    // ── 2. context.trimProcessed (identity when no progress pointer — returns the SAME object) ─────
    current = 'trim'
    const trimmed = await stage('trim', () => trimProcessedContext(seed))
    if (trimmed === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    // From here on `gen` is THE shared object for the rest of the turn (see the header's channel list).
    const gen: GenContext = trimmed
    outputs.set('trim', { gen })

    // ── 3. table.export (silent empty projection when no table template is bound) ──────────────────
    current = 'export'
    const exported = await stage('export', () => exportTableEntries(gen, {}))
    if (exported === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    outputs.set('export', exported)

    // ── 4. prompt.assemble ─────────────────────────────────────────────────────────────────────────
    current = 'assemble'
    const assembled = await stage('assemble', () => {
      const matched = matchWorldInfo(gen)
      const extra = exported.entries
      const result = assemblePrompt(
        gen,
        extra.length ? [...matched, ...extra] : matched,
        // The seeded doc leaves assemble's `block` input UNWIRED (export feeds `entries`), so the
        // memory block is `undefined` here exactly as it is on the workflow path.
        undefined as unknown as string
      )
      // OFF-PORT CHANNEL: stamp the forensic record onto the shared `gen` so persistFloor stores it.
      if (result.record) gen.executionRecord = result.record
      return result
    })
    if (assembled === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    const { sendMessages, params } = assembled
    outputs.set('assemble', {
      sendMessages,
      params,
      prompt: assembledArtifact(sendMessages, params, assembled.record, assembled.authored)
    })

    // ── 5. llm.sample — the ONE provider call, through the Milestone 1 Harness seam ────────────────
    current = 'llm'
    const sampled = await stage('llm', () =>
      sampleMainCall(ctx, gen, { sendMessages, params }, undefined, {})
    )
    if (sampled === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    if (sampled === null) {
      // Abort-with-EMPTY: nothing to persist. Abort the graph signal exactly as `llm.sample` does, so
      // the remaining stages are skipped and generate() returns null.
      outputs.set('llm', {})
      ctx.abortGraph?.()
      return abortedResult(doc, traces, outputs, debug, ran)
    }
    // Abort-with-TEXT lands here and runs on, so the partial floor is persisted (pre-workflow behavior).
    outputs.set('llm', { raw: sampled.raw, rawUsage: sampled.rawUsage })

    // ── 6. parse.response ─────────────────────────────────────────────────────────────────────────
    current = 'parse'
    const parsedOut = await stage('parse', () => {
      const { parsed, mvu } = parseResponse(sampled.raw)
      return {
        parsed,
        mvu,
        metrics: computeMetrics(gen, sendMessages, sampled.raw, sampled.rawUsage)
      }
    })
    if (parsedOut === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    outputs.set('parse', parsedOut)

    // ── 7. apply.state (folds onto gen.workingVars IN PLACE — the by-reference channel) ────────────
    current = 'apply'
    const variables = await stage('apply', () =>
      foldState(gen, parsedOut.parsed, parsedOut.mvu, sampled.raw)
    )
    if (variables === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    outputs.set('apply', { variables })

    // ── 8. output.writeFloor — the durable write, BEFORE the response is handed over ───────────────
    current = 'write'
    const floor = await stage('write', () =>
      persistFloor(gen, {
        userAction: gen.userAction,
        raw: sampled.raw,
        sendMessages,
        events: parsedOut.parsed.events,
        variables,
        metrics: parsedOut.metrics
      })
    )
    if (floor === ABORTED) return abortedResult(doc, traces, outputs, debug, ran)
    outputs.set('write', { floor })
  } catch (err) {
    // A narrator stage is never fail-open (workflowEngine: an unwired pre-phase failure is fatal), and
    // the seeded doc wires no `error` port — so any throw is the turn's fatal error, surfaced by
    // generate() as a real error rather than reading like a user Stop.
    // No further traces: a pre-phase fatal returns from the engine's node loop immediately, so the
    // remaining pre nodes and the whole post phase go untraced there too.
    const error = errorOf(err, current)
    traces.push({ nodeId: current, status: 'failed', phase: 'pre', error })
    ran.add(current)
    return { ok: false, aborted: false, traces, outputs, debug, error }
  }

  // The phase boundary: everything synchronous — persistence included — is complete here, and the
  // floor returns to the renderer from this callback (generationService's responseReady race).
  ctx.onResponseReady?.(outputs)

  return { ok: true, aborted: false, traces: [...traces, ...postTraces(doc)], outputs, debug }
}
