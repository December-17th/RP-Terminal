import type { AgentRunRecord } from './runs'
import type { JsonObject } from './types'

/**
 * Agent Lab (design: `.scratch/agent-lab/plan.md`).
 *
 * A **case** is a saved fixture belonging to an Agent. It is either CAPTURED from an existing run
 * (carries the run's full `AgentRunRecord` snapshot as `sourceRecord`, so it is replay- and
 * diff-capable) or AUTHORED from a manual-run input (input only, live-only). Running a case — in
 * either mode — produces an ordinary `AgentRunRecord` in the per-chat run store; the case keeps only
 * a slim, capped list of run references for inspection/diff.
 *
 * This module is PURE shared contract: it imports shared types only (never main/renderer/preload/
 * Electron), so both the main store and the renderer Lab tab code against the same shapes.
 */

/** A slim pointer from a case to a run it produced. The Lab tab fetches the full record by reference. */
export interface AgentLabRunRef {
  invocationId: string
  chatId: string
  mode: 'replay' | 'live'
  startedAt: string
  status: string
}

/** The list projection of a case — everything the Lab tab shows WITHOUT the heavy `input`/`sourceRecord`. */
export interface AgentLabCaseSummary {
  id: string
  agentId: string
  agentName: string
  name: string
  createdAt: string
  /** The Agent version the case was captured against (`sourceRecord.agentHash`). Absent for authored cases. */
  agentHash?: string
  sourceInvocationId?: string
  /** True => the case carries a `sourceRecord`, so replay + diff-vs-capture are available. */
  hasSource: boolean
  /** Most recent LAST; capped at {@link AGENT_LAB_RUN_REF_CAP} (oldest dropped). */
  runs: AgentLabRunRef[]
}

/** The full stored case, including the fixture payload. */
export interface AgentLabCase extends AgentLabCaseSummary {
  input: JsonObject
  sourceRecord?: AgentRunRecord
}

/** Rolling cap on a case's retained run references (plan §Concept). */
export const AGENT_LAB_RUN_REF_CAP = 20

export const AGENT_LAB_CHANNELS = {
  list: 'agent-lab-list',
  get: 'agent-lab-get',
  captureFromRun: 'agent-lab-capture-from-run',
  createFromInput: 'agent-lab-create-from-input',
  rename: 'agent-lab-rename',
  remove: 'agent-lab-remove',
  replay: 'agent-lab-replay',
  runLive: 'agent-lab-run-live',
  getRun: 'agent-lab-get-run'
} as const

export type AgentLabChannel = (typeof AGENT_LAB_CHANNELS)[keyof typeof AGENT_LAB_CHANNELS]

/** Outcome of a mutation that returns the refreshed summary, or a typed failure. */
export type AgentLabMutationResult =
  | { ok: true; case: AgentLabCaseSummary }
  | { ok: false; code: string }

/** Outcome of dispatching a case (replay or live). `ok:true` means the run STARTED and produced a
 *  record — its own status may still be `failed`; the caller inspects the record. `ok:false` is a
 *  Lab-level refusal (e.g. `LAB_NO_SOURCE`, `LAB_TOOL_DIVERGENCE`, `AGENT_NOT_FOUND`). */
export type AgentLabRunResult =
  | { ok: true; invocationId: string; status: string }
  | { ok: false; code: string; invocationId?: string }
