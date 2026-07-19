import { BrowserWindow, type IpcMain } from 'electron'
import type {
  AgentRunCancelResult,
  AgentRunChatRequest,
  AgentRunInvocationRequest
} from '../../shared/agentRuntime'
import { agentRunStore } from '../services/agentRuntime/runs/AgentRunStore'
import { invocationRuntime } from '../services/agentRuntime/InvocationRuntimeService'
import { resolveProfileId } from '../services/sessionDbService'
import { gate } from './ipcGuards'

let broadcasting = false

export class AgentRunScopeRejectedError extends Error {
  readonly code = 'AGENT_RUN_SCOPE_REJECTED' as const

  constructor() {
    super('Agent Run request scope was rejected')
    this.name = 'AgentRunScopeRejectedError'
  }
}

const stringField = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const resolveChatScope = (request: unknown): AgentRunChatRequest | null => {
  if (!request || typeof request !== 'object') return null
  const profileId = stringField((request as { profileId?: unknown }).profileId)
  const chatId = stringField((request as { chatId?: unknown }).chatId)
  if (!profileId || !chatId || resolveProfileId(chatId) !== profileId) return null
  return { profileId, chatId }
}

const resolveInvocationScope = (request: unknown): AgentRunInvocationRequest | null => {
  const chat = resolveChatScope(request)
  const invocationId =
    request && typeof request === 'object'
      ? stringField((request as { invocationId?: unknown }).invocationId)
      : null
  return chat && invocationId ? { ...chat, invocationId } : null
}

const rejectScope = (): Promise<never> => Promise.reject(new AgentRunScopeRejectedError())

export const registerAgentRunIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    'agent-runs-list',
    gate('agent-runs-list', (_, request: unknown) => {
      const scope = resolveChatScope(request)
      if (!scope) return rejectScope()
      return agentRunStore
        .list(scope.chatId)
        .filter(
          (record) => record.chatId === scope.chatId && record.profileId === scope.profileId
        )
    })
  )
  ipcMain.handle(
    'agent-run-get',
    gate('agent-run-get', (_, request: unknown) => {
      const scope = resolveInvocationScope(request)
      if (!scope) return rejectScope()
      const record = agentRunStore.get(scope.chatId, scope.invocationId)
      return record?.chatId === scope.chatId && record.profileId === scope.profileId ? record : null
    })
  )
  ipcMain.handle(
    'agent-run-cancel',
    gate('agent-run-cancel', (_, request: unknown): AgentRunCancelResult | Promise<never> => {
      const scope = resolveInvocationScope(request)
      if (!scope) return rejectScope()
      const record = agentRunStore.get(scope.chatId, scope.invocationId)
      if (record?.chatId !== scope.chatId || record.profileId !== scope.profileId) {
        return { invocationId: scope.invocationId, cancelled: false }
      }
      return {
        invocationId: scope.invocationId,
        cancelled: invocationRuntime().cancelInvocation(scope.invocationId)
      }
    })
  )

  if (!broadcasting) {
    broadcasting = true
    agentRunStore.subscribe((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('agent-run-event', event)
      }
    })
  }
}
