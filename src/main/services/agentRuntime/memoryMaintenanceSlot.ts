import type { PromptMessage } from '../../../shared/agentRuntime'

/**
 * Registration slot for the built-in "Memory Maintenance" Agent (execution-plan M4; parser-backed
 * design §6 — the one CONVERT candidate).
 *
 * `memory.maintain` used to run as a workflow node fired by `evaluateDocTriggers`. In M4 it runs as a
 * catalog Agent through the Invocation Runtime + Harness (execute path, with a Run Record). Its prompt
 * builder, due-gate, `<TableEdit>` parser, and `applyTableEdit` service all live in `nodes/` and
 * `generation/`, which `agentRuntime` must NOT import (it would close the `generation → agentRuntime`
 * cycle). So — exactly like `agentPresetAssembler.ts` — `agentRuntime` owns this empty slot and a
 * main-side bridge (`services/memoryMaintenanceAgentBridge.ts`, imported once from `main/index.ts`)
 * installs the real implementation at startup.
 *
 * The bridge is consulted at three points, all keyed by the Agent's NAME:
 *   · the floor-commit trigger dispatch (`triggerRuntime.ts`) calls `planDispatch` BEFORE `run()` so a
 *     "nothing due / mode off" pass never opens an empty Run Record, and `applyResult` AFTER a
 *     successful run to parse + apply;
 *   · the prompt planner (`agentPresetAssembler.ts`) calls `composePrompt` per attempt to substitute
 *     the assembled maintainer messages via `HarnessExecuteRequest.prompt`.
 */

/** The catalog Name the slot matches by (normalized). The built-in definition carries the same name. */
export const MEMORY_MAINTENANCE_AGENT_NAME = 'Memory Maintenance'

export interface MemoryMaintenanceScope {
  profileId: string
  chatId: string
  floor: number
}

export interface MemoryMaintenanceRuntimeBridge {
  /**
   * Pre-dispatch gate. `null` means there is nothing to do this cadence window — mode `off`, no bound
   * table template, no maintain config, or no DUE tables — so the dispatch is SKIPPED entirely and no
   * empty Run Record is created. Otherwise the invocation options to dispatch with (currently the live
   * API-preset choice, mapped onto `InvocationOptions.apiPresetId`).
   */
  planDispatch(scope: MemoryMaintenanceScope): { apiPresetId?: string } | null
  /**
   * Compose the maintainer prompt this attempt sends — the SAME `composeMaintainerMessages` the panel
   * preview IPC uses, byte-for-byte — and capture the transcript epoch internally for the staleness
   * fence. `undefined` falls open to the definition's own prompt (only reachable if state changed
   * between `planDispatch` and this call).
   */
  composePrompt(scope: MemoryMaintenanceScope): PromptMessage[] | undefined
  /**
   * After a SUCCESSFUL run, parse `<TableEdit>` and apply. Preserves the three-way discrimination
   * verbatim: no-tag → report only (no apply, no advance); empty-tag → advance the due pointers;
   * sql → `applyTableEdit`. Bracketed by the epoch fence captured in `composePrompt`.
   */
  applyResult(scope: MemoryMaintenanceScope, rawResult: unknown): void
}

let registered: MemoryMaintenanceRuntimeBridge | undefined

/** Install the production bridge. Called once, from the main-side bridge at startup. */
export const setMemoryMaintenanceBridge = (
  bridge: MemoryMaintenanceRuntimeBridge | undefined
): void => {
  registered = bridge
}

/** The installed bridge, or undefined in lightweight/test compositions. */
export const memoryMaintenanceBridge = (): MemoryMaintenanceRuntimeBridge | undefined => registered
