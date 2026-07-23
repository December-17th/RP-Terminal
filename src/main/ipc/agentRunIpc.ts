import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  AgentRunCancelResult,
  AgentRunChatRequest,
  AgentRunInvocationRequest,
  CardAgentRunOptions,
  CardAgentToolBinding
} from '../../shared/agentRuntime'
import { CARD_AGENT_CHANNELS } from '../../shared/agentRuntime'
import * as chatService from '../services/chatService'
import * as floorService from '../services/floorService'
import { onCardFloorCommitted } from '../services/agentRuntime/cardAgentEvents'
import { agentRunStore } from '../services/agentRuntime/runs/AgentRunStore'
import {
  invocationRuntime,
  liveCardToolRegistry
} from '../services/agentRuntime/InvocationRuntimeService'
import { AgentHostSession, agentToolRequestSender } from '../services/agentRuntime/AgentHostSession'
import { AgentCatalog } from '../services/agentRuntime/catalog'
import { resolveProfileId } from '../services/sessionDbService'
import { gate } from './ipcGuards'

let broadcasting = false
let floorBroadcasting = false

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

interface CardScope extends AgentRunChatRequest {
  characterId: string
}

const resolveCardScope = (request: unknown): CardScope | null => {
  const chat = resolveChatScope(request)
  if (!chat || !request || typeof request !== 'object') return null
  const requestedCharacter = stringField((request as { characterId?: unknown }).characterId)
  const authoritativeCharacter = chatService.getChat(chat.profileId, chat.chatId)?.character_id
  if (
    !requestedCharacter ||
    !authoritativeCharacter ||
    requestedCharacter !== authoritativeCharacter
  ) {
    return null
  }
  return { ...chat, characterId: authoritativeCharacter }
}

const rejectScope = (): Promise<never> => Promise.reject(new AgentRunScopeRejectedError())

const agentSessions = new Map<string, { senderId: number; session: AgentHostSession }>()
const agentSenderCleanup = new Map<number, () => void>()
const agentSessionKey = (senderId: number, scope: CardScope): string =>
  `${senderId}\u0000${scope.profileId}\u0000${scope.chatId}\u0000${scope.characterId}`

const ensureAgentSenderLifecycle = (sender: IpcMainInvokeEvent['sender']): void => {
  if (agentSenderCleanup.has(sender.id)) return
  const cleanup = (): void => {
    agentSenderCleanup.delete(sender.id)
    for (const [key, state] of agentSessions) {
      if (state.senderId !== sender.id) continue
      state.session.close()
      agentSessions.delete(key)
    }
    sender.removeListener?.('destroyed', cleanup)
  }
  agentSenderCleanup.set(sender.id, cleanup)
  sender.once?.('destroyed', cleanup)
}

const ensureAgentSession = (
  sender: IpcMainInvokeEvent['sender'],
  scope: CardScope
): AgentHostSession => {
  const key = agentSessionKey(sender.id, scope)
  const current = agentSessions.get(key)
  if (current) return current.session
  // Per-Agent binding source: the SAME catalog the manual Workspace / trigger paths read, so a
  // card-invoked run honors the user's chosen API preset. Constructed lazily (only when a run resolves
  // a binding) and reused across this session's runs.
  let catalog: AgentCatalog | null = null
  const session = new AgentHostSession({
    scope,
    senderId: sender.id,
    runtime: invocationRuntime(),
    tools: liveCardToolRegistry(),
    latestFloor: () => floorService.getLatestFloor(scope.profileId, scope.chatId)?.floor,
    sendTool: agentToolRequestSender(
      (channel, payload) => sender.send(channel, payload),
      (payload) => ({ ...(payload as object), scope })
    ),
    toolAuthority: 'completion-capability',
    cancelInvocationsOnClose: false,
    resolveInvocationConfig: (agentName) => {
      catalog ??= new AgentCatalog(scope.profileId)
      return catalog.get(agentName)?.invocationConfig
    }
  })
  agentSessions.set(key, { senderId: sender.id, session })
  ensureAgentSenderLifecycle(sender)
  return session
}

export const registerAgentRunIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    'agent-runs-list',
    gate('agent-runs-list', (_, request: unknown) => {
      const scope = resolveChatScope(request)
      if (!scope) return rejectScope()
      return agentRunStore
        .list(scope.chatId)
        .filter((record) => record.chatId === scope.chatId && record.profileId === scope.profileId)
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

  ipcMain.handle(
    CARD_AGENT_CHANNELS.run,
    gate(CARD_AGENT_CHANNELS.run, async (_, request: unknown) => {
      const scope = resolveCardScope(request)
      if (!scope || !request || typeof request !== 'object') return rejectScope()
      const name = stringField((request as { name?: unknown }).name)
      const requestId = stringField((request as { requestId?: unknown }).requestId)
      if (!name || !requestId) return rejectScope()
      const options = (request as { options?: CardAgentRunOptions }).options
      return ensureAgentSession(_.sender, scope).run({ requestId, name, options })
    })
  )

  ipcMain.handle(
    CARD_AGENT_CHANNELS.runPlan,
    gate(CARD_AGENT_CHANNELS.runPlan, async (_, request: unknown) => {
      const scope = resolveCardScope(request)
      if (!scope || !request || typeof request !== 'object') return rejectScope()
      const requestId = stringField((request as { requestId?: unknown }).requestId)
      if (!requestId) return rejectScope()
      const plan = (request as { plan?: unknown }).plan
      return ensureAgentSession(_.sender, scope).runPlan({ requestId, plan })
    })
  )

  ipcMain.handle(
    CARD_AGENT_CHANNELS.cancel,
    gate(CARD_AGENT_CHANNELS.cancel, (event, requestId: unknown) => {
      const id = stringField(requestId)
      if (!id) return false
      for (const state of agentSessions.values()) {
        if (state.senderId === event.sender.id && state.session.cancel(id)) return true
      }
      return false
    })
  )

  ipcMain.handle(
    CARD_AGENT_CHANNELS.registerTool,
    gate(CARD_AGENT_CHANNELS.registerTool, (event, request: unknown) => {
      const scope = resolveCardScope(request)
      if (!scope || !request || typeof request !== 'object') return rejectScope()
      const binding = (request as { binding?: CardAgentToolBinding }).binding
      if (!binding || !stringField(binding.name)) return rejectScope()
      return ensureAgentSession(event.sender, scope).registerTool(binding)
    })
  )

  ipcMain.handle(
    CARD_AGENT_CHANNELS.unregisterTool,
    gate(CARD_AGENT_CHANNELS.unregisterTool, (event, request: unknown) => {
      const scope = resolveCardScope(request)
      const toolName =
        request && typeof request === 'object'
          ? stringField((request as { name?: unknown }).name)
          : null
      return scope && toolName
        ? (agentSessions
            .get(agentSessionKey(event.sender.id, scope))
            ?.session.unregisterTool(toolName) ?? false)
        : false
    })
  )

  ipcMain.on(CARD_AGENT_CHANNELS.toolResult, (event, result: unknown) => {
    if (!result || typeof result !== 'object') return
    const scope = resolveCardScope(result)
    if (!scope) return
    const session = agentSessions.get(agentSessionKey(event.sender.id, scope))?.session
    if (!session) return
    try {
      session.completeTool(result as any)
    } catch (cause) {
      console.error(
        '[card agent tool result]',
        cause instanceof Error ? cause.message : String(cause)
      )
    }
  })

  if (!broadcasting) {
    broadcasting = true
    agentRunStore.subscribe((event) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('agent-run-event', event)
    })
  }
  if (!floorBroadcasting) {
    floorBroadcasting = true
    onCardFloorCommitted((profileId, chatId, event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(CARD_AGENT_CHANNELS.floorCommitted, { profileId, chatId, event })
      }
    })
  }
}
