// Wire model for the per-turn run trace (spec §13 "Run/trace panel"): what the engine did with
// each node, shaped for IPC + display. Pure and side-effect-free like the rest of shared/workflow —
// the engine's RunResult is accepted STRUCTURALLY (matching fields only) so this module never
// imports from main.

import { WorkflowDoc, NodeDescriptor, PortType } from './types'

/** One node's outcome in the trace (serializable; safe to send over IPC). */
export interface TraceNode {
  nodeId: string
  /** The node's registry type — lets the UI reuse the editor's localized node titles. */
  nodeType: string
  status: 'ran' | 'skipped' | 'failed'
  phase: 'pre' | 'post'
  ms?: number
  error?: { kind?: string; message: string }
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
}

/** Structural mirror of the engine's RunResult — only the fields the summary reads. */
interface RunResultLike {
  ok: boolean
  aborted: boolean
  traces: RunNodeTrace[]
  outputs: Map<string, Record<string, unknown>>
  error?: { message: string; nodeId?: string }
}

/** Longest preview kept per output port — enough to see what flowed, not the whole prompt. */
export const OUTPUT_PREVIEW_MAX = 500

/** Display format for node timings: SECONDS with one decimal (owner preference), e.g. "1.2s". */
export const formatTraceSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const preview = (value: unknown): string => {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return '(unserializable)'
  }
  if (s === undefined) return '(undefined)'
  return s.length > OUTPUT_PREVIEW_MAX ? s.slice(0, OUTPUT_PREVIEW_MAX) + '…' : s
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
