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

interface LiveToolRegistration {
  scope: CardScope
  binding: CardAgentToolBinding
  sender: IpcMainInvokeEvent['sender']
  completionCapability: string
}

const toolRegistrations = new Map<number, Map<string, LiveToolRegistration>>()
const toolCompletionCapabilities = new Map<string, LiveToolRegistration>()
const pendingTransportRuns = new Map<string, { kind: 'run' | 'plan'; id: string }>()

const toolSenderCleanup = new Map<number, () => void>()
const ensureToolSenderLifecycle = (sender: IpcMainInvokeEvent['sender']): void => {
  if (toolSenderCleanup.has(sender.id)) return
  const cleanup = (): void => {
    toolSenderCleanup.delete(sender.id)
    for (const registration of toolRegistrations.get(sender.id)?.values() ?? [])
      toolCompletionCapabilities.delete(registration.completionCapability)
    toolRegistrations.delete(sender.id)
    liveCardToolRegistry().unregisterSender(sender.id)
    sender.removeListener?.('destroyed', cleanup)
  }
  toolSenderCleanup.set(sender.id, cleanup)
  sender.once?.('destroyed', cleanup)
}

const registerLiveTool = (registration: LiveToolRegistration): void => {
  liveCardToolRegistry().register({
    scope: { ...registration.scope, senderId: registration.sender.id },
    binding: registration.binding,
    send: (channel, payload) =>
      registration.sender.send(channel, { ...payload, scope: registration.scope })
  })
}

const toolRegistrationKey = (scope: CardScope, name: string): string =>
  `${scope.profileId}\u0000${scope.chatId}\u0000${scope.characterId}\u0000${name}`

const unregisterLiveTool = (senderId: number, scope: CardScope, name: string): boolean => {
  const senderTools = toolRegistrations.get(senderId)
  if (!senderTools) return false
  const key = toolRegistrationKey(scope, name)
  const registration = senderTools.get(key)
  if (!registration) return false
  senderTools.delete(key)
  toolCompletionCapabilities.delete(registration.completionCapability)
  liveCardToolRegistry().unregister(senderId, name, scope)
  if (senderTools.size === 0) toolRegistrations.delete(senderId)
  return true
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
      const rawOptions = (request as { options?: CardAgentRunOptions }).options
      const { signal: _signal, ...options } = rawOptions ?? {}
      const latest = floorService.getAllFloors(scope.profileId, scope.chatId).at(-1)?.floor
      const floor = options.floor ?? latest
      if (floor === undefined) throw new Error('No committed Invocation Floor exists')
      const running = invocationRuntime().run({
        ...scope,
        floor,
        agent: name,
        options,
        toolScope: scope
      })
      pendingTransportRuns.set(requestId, { kind: 'run', id: running.invocationId })
      try {
        return await running
      } finally {
        pendingTransportRuns.delete(requestId)
      }
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
      const planFloor =
        plan && typeof plan === 'object' ? (plan as { floor?: unknown }).floor : undefined
      const latest = floorService.getAllFloors(scope.profileId, scope.chatId).at(-1)?.floor
      const floor = typeof planFloor === 'number' ? planFloor : latest
      if (floor === undefined) throw new Error('No committed Invocation Floor exists')
      const running = invocationRuntime().runPlan({
        ...scope,
        floor,
        plan,
        toolScope: scope
      })
      pendingTransportRuns.set(requestId, { kind: 'plan', id: running.planId })
      try {
        return await running
      } finally {
        pendingTransportRuns.delete(requestId)
      }
    })
  )

  ipcMain.handle(
    CARD_AGENT_CHANNELS.cancel,
    gate(CARD_AGENT_CHANNELS.cancel, (_, requestId: unknown) => {
      const id = stringField(requestId)
      const pending = id ? pendingTransportRuns.get(id) : undefined
      if (!pending) return false
      return pending.kind === 'run'
        ? invocationRuntime().cancelInvocation(pending.id)
        : invocationRuntime().cancelPlan(pending.id)
    })
  )

  ipcMain.handle(
    CARD_AGENT_CHANNELS.registerTool,
    gate(CARD_AGENT_CHANNELS.registerTool, (event, request: unknown) => {
      const scope = resolveCardScope(request)
      if (!scope || !request || typeof request !== 'object') return rejectScope()
      const binding = (request as { binding?: CardAgentToolBinding }).binding
      if (!binding || !stringField(binding.name)) return rejectScope()
      const senderTools = toolRegistrations.get(event.sender.id) ?? new Map()
      const registration = {
        scope,
        binding,
        sender: event.sender,
        completionCapability: crypto.randomUUID()
      }
      registerLiveTool(registration)
      senderTools.set(toolRegistrationKey(scope, binding.name), registration)
      toolCompletionCapabilities.set(registration.completionCapability, registration)
      toolRegistrations.set(event.sender.id, senderTools)
      ensureToolSenderLifecycle(event.sender)
      return { completionCapability: registration.completionCapability }
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
      return scope && toolName ? unregisterLiveTool(event.sender.id, scope, toolName) : false
    })
  )

  ipcMain.on(CARD_AGENT_CHANNELS.toolResult, (event, result: unknown) => {
    if (!result || typeof result !== 'object') return
    const scope = resolveCardScope(result)
    const completionCapability = stringField(
      (result as { completionCapability?: unknown }).completionCapability
    )
    const registration = completionCapability
      ? toolCompletionCapabilities.get(completionCapability)
      : undefined
    if (
      !scope ||
      !registration ||
      registration.sender.id !== event.sender.id ||
      registration.scope.profileId !== scope.profileId ||
      registration.scope.chatId !== scope.chatId ||
      registration.scope.characterId !== scope.characterId
    )
      return
    try {
      liveCardToolRegistry().complete({
        ...(result as any),
        senderId: event.sender.id,
        scope
      })
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
