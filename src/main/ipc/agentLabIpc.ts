import type { IpcMain } from 'electron'
import {
  AGENT_LAB_CHANNELS,
  type AgentLabCase,
  type AgentLabMutationResult,
  type AgentLabRunRef,
  type AgentLabRunResult,
  type JsonObject
} from '../../shared/agentRuntime'
import { AgentCatalog } from '../services/agentRuntime/catalog'
import { agentLabStore } from '../services/agentRuntime/lab/AgentLabStore'
import { agentLabReplay } from '../services/agentRuntime/lab/replay'
import { agentLabLiveRun } from '../services/agentRuntime/lab/liveRun'
import { agentRunStore } from '../services/agentRuntime/runs/AgentRunStore'
import { getLatestFloor } from '../services/floorService'
import { resolveProfileId } from '../services/sessionDbService'
import { gate } from './ipcGuards'

/**
 * Agent Lab IPC (plan §Main process). Every channel is gated for the same reason the Agent catalog
 * channels are: replaying or live-running a case decides what model work the app performs (a live run
 * bills a provider call), and cases expose captured prompts/evidence — a trusted card must never reach
 * these. Cases are profile-local; chat-scoped operations verify the chat belongs to the profile.
 */
const stringArg = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null

/** Resolve the latest committed floor for a chat, verifying profile ownership. */
const latestFloor = (profileId: string, chatId: string): number | null => {
  if (resolveProfileId(chatId) !== profileId) return null
  return getLatestFloor(profileId, chatId)?.floor ?? null
}

const runRefFor = (
  chatId: string,
  invocationId: string,
  mode: AgentLabRunRef['mode'],
  status: string
): AgentLabRunRef => {
  const record = agentRunStore.get(chatId, invocationId)
  return {
    invocationId,
    chatId,
    mode,
    startedAt: record?.startedAt ?? new Date().toISOString(),
    status: record?.status ?? status
  }
}

/** Load a case and resolve its chat's latest floor, or return a typed refusal shared by both run modes. */
const prepareRun = (
  profileId: string,
  chatId: string,
  caseId: string
): { ok: true; case: AgentLabCase; floor: number } | { ok: false; code: string } => {
  const record = agentLabStore.get(profileId, caseId)
  if (!record) return { ok: false, code: 'NOT_FOUND' }
  const floor = latestFloor(profileId, chatId)
  if (floor === null) return { ok: false, code: 'NO_COMMITTED_FLOOR' }
  return { ok: true, case: record, floor }
}

export const registerAgentLabIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    AGENT_LAB_CHANNELS.list,
    gate(AGENT_LAB_CHANNELS.list, async (_event, rawProfileId: unknown, rawAgentId: unknown) => {
      const profileId = stringArg(rawProfileId)
      const agentId = stringArg(rawAgentId)
      if (!profileId || !agentId) return []
      return agentLabStore.list(profileId, agentId)
    })
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.get,
    gate(AGENT_LAB_CHANNELS.get, async (_event, rawProfileId: unknown, rawCaseId: unknown) => {
      const profileId = stringArg(rawProfileId)
      const caseId = stringArg(rawCaseId)
      if (!profileId || !caseId) return null
      return agentLabStore.get(profileId, caseId)
    })
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.captureFromRun,
    gate(
      AGENT_LAB_CHANNELS.captureFromRun,
      async (
        _event,
        rawProfileId: unknown,
        rawChatId: unknown,
        rawInvocationId: unknown,
        rawName: unknown
      ): Promise<AgentLabMutationResult> => {
        const profileId = stringArg(rawProfileId)
        const chatId = stringArg(rawChatId)
        const invocationId = stringArg(rawInvocationId)
        const name = stringArg(rawName)
        if (!profileId || !chatId || !invocationId || !name) {
          return { ok: false, code: 'INVALID_REQUEST' }
        }
        if (resolveProfileId(chatId) !== profileId) return { ok: false, code: 'INVALID_REQUEST' }
        const record = agentRunStore.get(chatId, invocationId)
        if (!record) return { ok: false, code: 'NOT_FOUND' }
        const agentId = new AgentCatalog(profileId).get(record.agentName)?.id ?? record.agentName
        return {
          ok: true,
          case: agentLabStore.captureFromRun(profileId, {
            agentId,
            agentName: record.agentName,
            name,
            sourceRecord: record
          })
        }
      }
    )
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.createFromInput,
    gate(
      AGENT_LAB_CHANNELS.createFromInput,
      async (
        _event,
        rawProfileId: unknown,
        rawAgentId: unknown,
        rawName: unknown,
        rawInput: unknown
      ): Promise<AgentLabMutationResult> => {
        const profileId = stringArg(rawProfileId)
        const agentId = stringArg(rawAgentId)
        const name = stringArg(rawName)
        if (!profileId || !agentId || !name) return { ok: false, code: 'INVALID_REQUEST' }
        const agentName = new AgentCatalog(profileId).get(agentId)?.name ?? agentId
        const input = rawInput && typeof rawInput === 'object' ? (rawInput as JsonObject) : {}
        return {
          ok: true,
          case: agentLabStore.createFromInput(profileId, { agentId, agentName, name, input })
        }
      }
    )
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.rename,
    gate(
      AGENT_LAB_CHANNELS.rename,
      async (
        _event,
        rawProfileId: unknown,
        rawCaseId: unknown,
        rawName: unknown
      ): Promise<AgentLabMutationResult> => {
        const profileId = stringArg(rawProfileId)
        const caseId = stringArg(rawCaseId)
        const name = stringArg(rawName)
        if (!profileId || !caseId || !name) return { ok: false, code: 'INVALID_REQUEST' }
        const summary = agentLabStore.rename(profileId, caseId, name)
        return summary ? { ok: true, case: summary } : { ok: false, code: 'NOT_FOUND' }
      }
    )
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.remove,
    gate(
      AGENT_LAB_CHANNELS.remove,
      async (_event, rawProfileId: unknown, rawCaseId: unknown) => {
        const profileId = stringArg(rawProfileId)
        const caseId = stringArg(rawCaseId)
        if (!profileId || !caseId) return { ok: false, code: 'INVALID_REQUEST' }
        return agentLabStore.remove(profileId, caseId)
          ? { ok: true }
          : { ok: false, code: 'NOT_FOUND' }
      }
    )
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.replay,
    gate(
      AGENT_LAB_CHANNELS.replay,
      async (
        _event,
        rawProfileId: unknown,
        rawChatId: unknown,
        rawCaseId: unknown
      ): Promise<AgentLabRunResult> => {
        const profileId = stringArg(rawProfileId)
        const chatId = stringArg(rawChatId)
        const caseId = stringArg(rawCaseId)
        if (!profileId || !chatId || !caseId) return { ok: false, code: 'INVALID_REQUEST' }
        const prepared = prepareRun(profileId, chatId, caseId)
        if (!prepared.ok) return prepared
        const result = await agentLabReplay()({ profileId, chatId, floor: prepared.floor, case: prepared.case })
        // A replay produces a real run record whenever it carries an invocationId — including the
        // mid-run divergence path, whose record resolves to failed. Append the ref in both cases so the
        // divergent run is inspectable/diffable; only a pre-run refusal (no invocationId) is skipped.
        if (result.ok) {
          agentLabStore.appendRun(
            profileId,
            caseId,
            runRefFor(chatId, result.invocationId, 'replay', result.status)
          )
        } else if (result.invocationId) {
          agentLabStore.appendRun(
            profileId,
            caseId,
            runRefFor(chatId, result.invocationId, 'replay', 'failed')
          )
        }
        return result
      }
    )
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.runLive,
    gate(
      AGENT_LAB_CHANNELS.runLive,
      async (
        _event,
        rawProfileId: unknown,
        rawChatId: unknown,
        rawCaseId: unknown
      ): Promise<AgentLabRunResult> => {
        const profileId = stringArg(rawProfileId)
        const chatId = stringArg(rawChatId)
        const caseId = stringArg(rawCaseId)
        if (!profileId || !chatId || !caseId) return { ok: false, code: 'INVALID_REQUEST' }
        const prepared = prepareRun(profileId, chatId, caseId)
        if (!prepared.ok) return prepared
        const result = await agentLabLiveRun()({ profileId, chatId, floor: prepared.floor, case: prepared.case })
        if (result.ok) {
          agentLabStore.appendRun(
            profileId,
            caseId,
            runRefFor(chatId, result.invocationId, 'live', result.status)
          )
        }
        return result
      }
    )
  )

  ipcMain.handle(
    AGENT_LAB_CHANNELS.getRun,
    gate(
      AGENT_LAB_CHANNELS.getRun,
      async (
        _event,
        rawProfileId: unknown,
        rawChatId: unknown,
        rawInvocationId: unknown
      ) => {
        const profileId = stringArg(rawProfileId)
        const chatId = stringArg(rawChatId)
        const invocationId = stringArg(rawInvocationId)
        if (!profileId || !chatId || !invocationId) return null
        if (resolveProfileId(chatId) !== profileId) return null
        return agentRunStore.get(chatId, invocationId)
      }
    )
  )
}
