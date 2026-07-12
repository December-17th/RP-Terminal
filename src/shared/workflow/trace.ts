// Wire model for the per-turn run trace (spec §13 "Run/trace panel"): what the engine did with
// each node, shaped for IPC + display. Pure and side-effect-free like the rest of shared/workflow —
// the engine's RunResult is accepted STRUCTURALLY (matching fields only) so this module never
// imports from main.

import { WorkflowDoc, NodeDescriptor, PortType } from './types'
import { TriggerAttachment } from './attachments'
import { CompositionMeta, PACK_PREFIX } from './compose'

/** One node's outcome in the trace (serializable; safe to send over IPC). */
export interface TraceNode {
  nodeId: string
  /** The node's registry type — lets the UI reuse the editor's localized node titles. */
  nodeType: string
  status: 'ran' | 'skipped' | 'failed'
  phase: 'pre' | 'post'
  ms?: number
  error?: { kind?: string; message: string }
  /** A2/A3 (plot-recall): the node RAN but fail-opened on an internal failure (status stays 'ran').
   *  Drives the run drawer's warning tint so a fail-open is not invisible behind a green row. */
  failedOpen?: boolean
  /** Truncated JSON previews of the node's output ports (debug display only). */
  outputs?: Record<string, string>
}

/** The whole turn's run trace, broadcast to the renderer after each generate(). */
export interface WorkflowRunTrace {
  chatId: string
  workflowId: string
  /** Epoch ms when the run started. */
  startedAt: number
  durationMs: number
  ok: boolean
  aborted: boolean
  /** The fatal pre-phase error, when the turn aborted on an unwired node failure (spec §10). */
  error?: { message: string; nodeId?: string }
  nodes: TraceNode[]
}

/** Structural mirror of the engine's per-node trace entry (workflowEngine.NodeTrace). */
interface RunNodeTrace {
  nodeId: string
  status: 'ran' | 'skipped' | 'failed'
  phase: 'pre' | 'post'
  error?: { kind?: string; message: string }
  ms?: number
  failedOpen?: boolean
}

/** Structural mirror of the engine's RunResult — only the fields the summary reads. */
interface RunResultLike {
  ok: boolean
  aborted: boolean
  traces: RunNodeTrace[]
  outputs: Map<string, Record<string, unknown>>
  /** Per-node debug detail (NodeResult.debug) — trace-only, never a graph port. Optional so pre-debug
   *  callers/tests still satisfy the shape. Folded into TraceNode.outputs below with a roomier cap. */
  debug?: Map<string, Record<string, unknown>>
  error?: { message: string; nodeId?: string }
}

/** Longest preview kept per output port — enough to see what flowed, not the whole prompt. */
export const OUTPUT_PREVIEW_MAX = 500

/** Longest preview kept per DEBUG entry (NodeResult.debug — e.g. agent.llm's composed prompt). Larger
 *  than OUTPUT_PREVIEW_MAX because the whole point of a debug entry is to READ what was sent (confirm
 *  the table block / history actually reached the model), while a port preview only needs to show what
 *  flowed. Still capped so a huge maintainer prompt doesn't bloat the persisted run record. */
export const DEBUG_PREVIEW_MAX = 4000

/** Display format for node timings: SECONDS with one decimal (owner preference), e.g. "1.2s". */
export const formatTraceSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const preview = (value: unknown, max = OUTPUT_PREVIEW_MAX): string => {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return '(unserializable)'
  }
  if (s === undefined) return '(undefined)'
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Shape one run into the serializable trace the renderer displays. Output previews are included
 * only for nodes that ran, capped per port, and `Context` ports are skipped entirely — the run
 * bundle is huge, non-serializable (functions), and useless in a debug row.
 */
export function summarizeRun(
  doc: WorkflowDoc,
  descriptors: Map<string, NodeDescriptor>,
  run: RunResultLike,
  meta: { chatId: string; workflowId: string; startedAt: number; durationMs: number }
): WorkflowRunTrace {
  const typeById = new Map(doc.nodes.map((n) => [n.id, n.type]))

  const nodes: TraceNode[] = run.traces.map((t) => {
    const nodeType = typeById.get(t.nodeId) ?? 'unknown'
    const out: TraceNode = { nodeId: t.nodeId, nodeType, status: t.status, phase: t.phase }
    if (t.ms !== undefined) out.ms = t.ms
    if (t.error) out.error = { kind: t.error.kind, message: t.error.message }
    if (t.failedOpen) out.failedOpen = true

    if (t.status === 'ran') {
      const produced = run.outputs.get(t.nodeId)
      const ports = descriptors.get(nodeType)?.outputs ?? []
      const portType = new Map<string, PortType>(ports.map((p) => [p.name, p.type]))
      const previews: Record<string, string> = {}
      for (const [port, value] of Object.entries(produced ?? {})) {
        if (portType.get(port) === 'Context') continue
        if (value === undefined) continue
        previews[port] = preview(value)
      }
      // Fold this node's debug detail (NodeResult.debug) in alongside the port previews — same display
      // row in the Runs tab — but with the roomier DEBUG cap. A debug key that collides with a port
      // name would overwrite it; node authors avoid that by labeling debug entries distinctly (e.g.
      // agent.llm uses "prompt (sent)", not the "text" output port).
      for (const [label, value] of Object.entries(run.debug?.get(t.nodeId) ?? {})) {
        if (value === undefined) continue
        previews[label] = preview(value, DEBUG_PREVIEW_MAX)
      }
      if (Object.keys(previews).length) out.outputs = previews
    }
    return out
  })

  return {
    chatId: meta.chatId,
    workflowId: meta.workflowId,
    startedAt: meta.startedAt,
    durationMs: meta.durationMs,
    ok: run.ok,
    aborted: run.aborted,
    ...(run.error ? { error: { message: run.error.message, nodeId: run.error.nodeId } } : {}),
    nodes
  }
}

// ── Persisted run history (WP2.3): the annotated run record ───────────────────────────────────────
//
// A WorkflowRunTrace is the raw per-node outcome of ONE run (broadcast live to the debug panel). For
// the phase-3 Runs timeline we persist each trace WRAPPED with the annotations the timeline needs but
// the raw trace does not carry: what kind of run it was (turn/headless/manual), which packs actually
// contributed nodes to it, and — for headless runs — a human-readable description of the trigger(s)
// that fired. This wrapper is pure + JSON-serializable (it crosses IPC to the renderer); the store
// (main/services/runHistoryStore.ts) owns persistence, this owns the SHAPE and the derivation.

/** How a run was started (ADR 0003 — the timeline interleaves all three, attributed to pack+trigger).
 *  - `turn`: a player turn's effective-graph run (generationService).
 *  - `headless`: a trigger fired at a commit boundary and the pack ran on its own (headlessRunService).
 *  - `manual`: a user explicitly ran a pack (runManual) — same run path as headless, different origin. */
export type RunOrigin = 'turn' | 'headless' | 'manual'

/** One WorkflowRunTrace annotated for the Runs timeline + cursor paging. Pure, JSON-serializable
 *  (crosses IPC). `trace` is the FAITHFUL trace as broadcast (synthetic headless seed nodes and all —
 *  display-time filtering of `__headless_seed_*` nodes is WP3.3's job, storage stays complete). */
export interface StoredRunRecord {
  /** A stable id for this run (dedupe / expand-key on the timeline). */
  runId: string
  /** Per-chat monotonic sequence, assigned by the store on append — the cursor for `beforeSeq` paging.
   *  Newest run has the largest seq; the timeline pages backward from a cursor toward smaller seqs. */
  seq: number
  origin: RunOrigin
  /** Packs that actually CONTRIBUTED nodes to this run (see derivePackIds): for a composed turn, the
   *  packs whose fragments survived composition; for a headless/manual run, the single pack that ran;
   *  for a plain narrator turn with no packs, []. */
  packIds: string[]
  /** Human-readable description of what fired this run (headless/manual only; absent for turns). For
   *  a headless run OR-dedupe may have fired several triggers on one pack — they are joined (see the
   *  headless persist point). e.g. "state: stat_data.世界.时间 changedBy 30", "cadence: every 3 floors". */
  trigger?: string
  /** Agent & memory UX (WP-D; spec §1 run attribution): the DOC node ids of the trigger(s) that fired
   *  this run (headless/manual doc-path only). The agent card maps these through group membership to
   *  find "this agent's runs". Additive — records persisted before WP-D lack it and simply don't
   *  attribute (fail-soft). */
  triggerNodeIds?: string[]
  /** The full raw run trace (WorkflowRunTrace) — carries chatId, timing, ok/aborted, per-node detail. */
  trace: WorkflowRunTrace
}

/** Describe a trigger attachment in one stable, human-readable line for the Runs timeline caption.
 *  Pure (reads the existing TriggerAttachment shapes only). Format is deliberately compact + stable
 *  (the timeline shows it verbatim as a caption); it is NOT localized here — WP3.3 may localize the
 *  leading kind word if desired, but the source/op/value tail is data, shown as-is.
 *
 *  Examples:
 *    state (vars):   "state: stat_data.世界.时间 changedBy 30"
 *    state (table):  "state: table log.unprocessed gte 10"
 *    cadence:        "cadence: every 3 floors"
 *    manual:         "manual" */
export function describeTrigger(t: TriggerAttachment): string {
  if (t.trigger === 'manual') return 'manual'
  if (t.trigger === 'cadence') return `cadence: every ${t.everyNFloors} floors`
  // state trigger: describe its source, op, and comparison value.
  const src =
    t.source.scope === 'vars'
      ? t.source.path
      : `table ${t.source.table}.${t.source.stat}`
  return `state: ${src} ${t.op} ${String(t.value)}`
}

/** Derive the packs that CONTRIBUTED nodes to a run. Prefers the composition meta (authoritative:
 *  compose.ts records exactly which packs' fragments survived splicing under `meta.composition`), and
 *  falls back to scanning the trace node ids for the `pack:<packId>:` prefix when no composition meta
 *  is available (e.g. a trace whose doc.meta was not threaded through). Both are stable because
 *  compose.ts stamps EVERY spliced fragment node id with that exact prefix (PACK_PREFIX contract).
 *
 *  WHY prefer composition meta when BOTH exist: the meta is the source of truth for which packs
 *  actually spliced (a pack can be gated open but contribute ZERO surviving nodes after denial/
 *  reachability — it would then have a `packs[id]` entry with an empty nodeIds array, which the meta
 *  path still reports faithfully, whereas a prefix scan of the trace would simply not see it). The
 *  prefix scan is the best-effort fallback for traces lacking meta; it can only find packs that DID
 *  place at least one node in the trace. Result is sorted + de-duplicated for a stable order. */
export function derivePackIds(
  trace: WorkflowRunTrace,
  composition?: CompositionMeta
): string[] {
  if (composition) return Object.keys(composition.packs).sort()

  const ids = new Set<string>()
  for (const n of trace.nodes) {
    if (!n.nodeId.startsWith(PACK_PREFIX)) continue
    // packNodeId(packId, nodeId) === `pack:<packId>:<nodeId>` — the packId is the segment between the
    // leading `pack:` and the NEXT colon. (Pack ids are opaque strings; the first colon after the
    // prefix delimits the id from the original node id.)
    const rest = n.nodeId.slice(PACK_PREFIX.length)
    const colon = rest.indexOf(':')
    if (colon > 0) ids.add(rest.slice(0, colon))
  }
  return [...ids].sort()
}
