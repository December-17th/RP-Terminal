import { type AgentLabCase, type AgentLabRunResult } from '../../../../shared/agentRuntime'
import type { InvocationRuntime } from '../invocation'
import { invocationRuntime } from '../InvocationRuntimeService'
import { createProfileCatalogCache } from './profileCatalogs'

/**
 * Agent Lab LIVE run (plan §Main process).
 *
 * A live run is an ordinary Agent invocation of the case's stored `input` against a real committed
 * floor — the SAME production path the `agent-catalog-run` IPC handler uses
 * (`invocationRuntime().run`). It bills a real provider call, so the renderer gates it behind an
 * explicit spend confirmation (Slice B). The only Lab-specific step is that the caller appends the
 * resulting run reference to the case; that append is owned by the IPC handler alongside the store.
 *
 * Deliberately NOT gated by Memory Maintenance's due-check: a Lab live run is an explicit,
 * user-initiated experiment, not a cadence fire.
 */

export interface AgentLabLiveRunRequest {
  profileId: string
  chatId: string
  floor: number
  case: AgentLabCase
}

export interface AgentLabLiveRunDeps {
  runtime: () => InvocationRuntime
  /** Resolve the agent's profile-local API preset, mirroring the manual-run handler. */
  resolveApiPresetId: (profileId: string, agentId: string) => string | undefined
}

export const createAgentLabLiveRun = (
  deps: AgentLabLiveRunDeps
): ((request: AgentLabLiveRunRequest) => Promise<AgentLabRunResult>) => {
  return async (request) => {
    const apiPresetId = deps.resolveApiPresetId(
      request.profileId,
      request.case.agentId ?? request.case.agentName
    )
    try {
      const outcome = await deps.runtime().run({
        profileId: request.profileId,
        chatId: request.chatId,
        floor: request.floor,
        agent: request.case.agentId ?? request.case.agentName,
        options: {
          input: request.case.input,
          ...(apiPresetId ? { apiPresetId } : {})
        }
      })
      return { ok: true, invocationId: outcome.invocationId, status: outcome.status }
    } catch (error) {
      const runError = error as { code?: string }
      return { ok: false, code: runError.code ?? 'LAB_LIVE_RUN_FAILED' }
    }
  }
}

let production: ((request: AgentLabLiveRunRequest) => Promise<AgentLabRunResult>) | null = null

export const agentLabLiveRun = (): ((
  request: AgentLabLiveRunRequest
) => Promise<AgentLabRunResult>) => {
  if (!production) {
    const catalogFor = createProfileCatalogCache()
    production = createAgentLabLiveRun({
      runtime: invocationRuntime,
      resolveApiPresetId(profileId, agentId) {
        return catalogFor(profileId).get(agentId)?.invocationConfig.apiPresetId
      }
    })
  }
  return production
}
