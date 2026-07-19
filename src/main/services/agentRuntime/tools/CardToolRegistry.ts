import { CARD_AGENT_CHANNELS } from '../../../../shared/agentRuntime'
import type {
  AgentToolDefinition,
  JsonObject,
  JsonSchema,
  JsonValue,
  ToolTransactionMode
} from '../../../../shared/agentRuntime'
import { canonicalJson, normalizeJsonValue } from '../internal/json'
import type { StagedToolOperation } from './AttemptTransaction'
import type { ToolBinding, ToolExecutionContext, ToolExecutionScope } from './ToolRegistry'

/** The only two main-to-WCV callback messages used by card-provided Agent tools. */
export const CARD_TOOL_CALLBACK_CHANNELS = {
  request: CARD_AGENT_CHANNELS.toolRequest,
  abort: CARD_AGENT_CHANNELS.toolAbort
} as const

/**
 * The authoritative identity of a mounted card implementation. It is derived from the WCV binding in
 * main; payloads sent by card JavaScript never supply or override these fields.
 */
export interface CardToolScope {
  profileId: string
  chatId: string
  characterId: string
  senderId: number
}

/** The executable half of an Agent Tool Definition that a card may implement. */
export interface CardToolBindingDeclaration {
  name: string
  inputSchema: JsonSchema
  transactionMode: ToolTransactionMode
  parallelSafe: boolean
}

export interface CardToolCallbackRequest {
  requestId: string
  sequence: number
  name: string
  input: JsonObject
  transactionMode: ToolTransactionMode
}

export interface CardToolCallbackResult {
  senderId: number
  scope?: Pick<CardToolScope, 'profileId' | 'chatId' | 'characterId'>
  requestId: string
  result: unknown
  operations?: unknown
  externalEffectBegan?: unknown
  error?: unknown
}

export type CardToolSender = (
  channel: (typeof CARD_TOOL_CALLBACK_CHANNELS)[keyof typeof CARD_TOOL_CALLBACK_CHANNELS],
  payload: CardToolCallbackRequest | { requestId: string }
) => void

export type CardToolRegistryErrorCode =
  | 'CARD_TOOL_DUPLICATE'
  | 'CARD_TOOL_SCOPE_REJECTED'
  | 'CARD_TOOL_UNAVAILABLE'
  | 'CARD_TOOL_ABORTED'
  | 'CARD_TOOL_UNMOUNTED'
  | 'CARD_TOOL_PAYLOAD_TOO_LARGE'
  | 'CARD_TOOL_RESULT_TOO_LARGE'
  | 'CARD_TOOL_INVALID_RESULT'
  | 'CARD_TOOL_INVALID_OPERATION'

export class CardToolRegistryError extends Error {
  constructor(
    readonly code: CardToolRegistryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CardToolRegistryError'
  }
}

export interface CardToolRegistryOptions {
  /** Maximum serialized model-to-card tool argument payload. */
  maxPayloadBytes?: number
  /** Maximum serialized card-to-model tool result payload. */
  maxResultBytes?: number
}

export interface CardToolRegistration {
  scope: CardToolScope
  binding: CardToolBindingDeclaration
  send: CardToolSender
}

interface RegisteredTool extends CardToolRegistration {
  scopeKey: string
}

interface PendingCallback {
  requestId: string
  senderId: number
  scopeKey: string
  name: string
  context: ToolExecutionContext
  disposeAbort(): void
  resolve(value: JsonValue): void
  reject(cause: CardToolRegistryError): void
}

export interface CardToolRegistry {
  register(registration: CardToolRegistration): void
  resolve(definition: AgentToolDefinition, scope?: ToolExecutionScope): ToolBinding | undefined
  complete(result: CardToolCallbackResult): boolean
  unregister(
    senderId: number,
    name: string,
    scope?: Pick<CardToolScope, 'profileId' | 'chatId' | 'characterId'>
  ): boolean
  unregisterSender(senderId: number): number
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024

const scopeKeyFor = (scope: Pick<CardToolScope, 'profileId' | 'chatId' | 'characterId'>): string =>
  `${scope.profileId}\u0000${scope.chatId}\u0000${scope.characterId}`

const bytesOf = (value: JsonValue): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const jsonValue = (value: unknown, code: CardToolRegistryErrorCode, label: string): JsonValue => {
  const normalized = normalizeJsonValue(value)
  if (!normalized.ok) {
    throw new CardToolRegistryError(code, `${label} must be JSON-compatible: ${normalized.message}`)
  }
  return normalized.value
}

const inputMatches = (
  binding: CardToolBindingDeclaration,
  definition: AgentToolDefinition
): boolean =>
  binding.name === definition.name &&
  binding.transactionMode === definition.transactionMode &&
  binding.parallelSafe === definition.parallelSafe &&
  canonicalJson(binding.inputSchema) === canonicalJson(definition.inputSchema)

const operationsFrom = (value: unknown): StagedToolOperation[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new CardToolRegistryError(
      'CARD_TOOL_INVALID_OPERATION',
      'Card tool operations must be an array'
    )
  }
  return value.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new CardToolRegistryError(
        'CARD_TOOL_INVALID_OPERATION',
        'Card tool operation must be an object'
      )
    }
    const { type, payload } = operation as { type?: unknown; payload?: unknown }
    if (typeof type !== 'string') {
      throw new CardToolRegistryError(
        'CARD_TOOL_INVALID_OPERATION',
        'Card tool operation type must be a string'
      )
    }
    const normalized = jsonValue(
      payload,
      'CARD_TOOL_INVALID_OPERATION',
      'Card tool operation payload'
    )
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new CardToolRegistryError(
        'CARD_TOOL_INVALID_OPERATION',
        'Card tool operation payload must be a JSON object'
      )
    }
    return { type, payload: normalized }
  })
}

/**
 * A main-process ToolRegistry adapter for live WCV card implementations. It stores no card JavaScript
 * function references: execution is always a correlated IPC request to the currently mounted sender.
 */
export const createCardToolRegistry = ({
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES
}: CardToolRegistryOptions = {}): CardToolRegistry => {
  const toolsByScope = new Map<string, Map<string, RegisteredTool>>()
  const pending = new Map<string, PendingCallback>()
  let sequence = 0

  const settle = (
    callback: PendingCallback,
    outcome: { value: JsonValue } | { error: CardToolRegistryError }
  ): void => {
    pending.delete(callback.requestId)
    callback.disposeAbort()
    if ('error' in outcome) callback.reject(outcome.error)
    else callback.resolve(outcome.value)
  }

  const rejectScope = (message: string): never => {
    throw new CardToolRegistryError('CARD_TOOL_SCOPE_REJECTED', message)
  }

  const execute = (
    tool: RegisteredTool,
    input: JsonObject,
    context: ToolExecutionContext
  ): Promise<JsonValue> => {
    const normalizedInput = jsonValue(input, 'CARD_TOOL_PAYLOAD_TOO_LARGE', 'Card tool input')
    if (!normalizedInput || typeof normalizedInput !== 'object' || Array.isArray(normalizedInput)) {
      return Promise.reject(
        new CardToolRegistryError(
          'CARD_TOOL_PAYLOAD_TOO_LARGE',
          'Card tool input must be a JSON object'
        )
      )
    }
    if (bytesOf(normalizedInput) > maxPayloadBytes) {
      return Promise.reject(
        new CardToolRegistryError(
          'CARD_TOOL_PAYLOAD_TOO_LARGE',
          `Card tool input exceeds the ${maxPayloadBytes}-byte limit`
        )
      )
    }
    const requestId = crypto.randomUUID()
    const callbackSequence = ++sequence
    return new Promise<JsonValue>((resolve, reject) => {
      const rejectAs = (code: CardToolRegistryErrorCode, message: string): void =>
        reject(new CardToolRegistryError(code, message))
      const abort = (): void => {
        const callback = pending.get(requestId)
        if (!callback) return
        try {
          tool.send(CARD_TOOL_CALLBACK_CHANNELS.abort, { requestId })
        } catch {
          // Teardown may already have destroyed the guest. The callback still settles below.
        }
        settle(callback, {
          error: new CardToolRegistryError('CARD_TOOL_ABORTED', 'Card tool callback was aborted')
        })
      }
      const disposeAbort = (): void => context.signal?.removeEventListener('abort', abort)
      if (context.signal?.aborted) {
        rejectAs('CARD_TOOL_ABORTED', 'Card tool callback was aborted')
        return
      }
      pending.set(requestId, {
        requestId,
        senderId: tool.scope.senderId,
        scopeKey: tool.scopeKey,
        name: tool.binding.name,
        context,
        disposeAbort,
        resolve,
        reject
      })
      context.signal?.addEventListener('abort', abort, { once: true })
      try {
        if (tool.binding.transactionMode === 'non-transactional') {
          context.beginExternalEffect()
        }
        tool.send(CARD_TOOL_CALLBACK_CHANNELS.request, {
          requestId,
          sequence: callbackSequence,
          name: tool.binding.name,
          input: normalizedInput,
          transactionMode: tool.binding.transactionMode
        })
      } catch {
        const callback = pending.get(requestId)
        if (callback) {
          settle(callback, {
            error: new CardToolRegistryError(
              'CARD_TOOL_UNMOUNTED',
              'Card tool implementation is no longer mounted'
            )
          })
        }
      }
    })
  }

  return {
    register(registration) {
      const scopeKey = scopeKeyFor(registration.scope)
      const scoped = toolsByScope.get(scopeKey) ?? new Map<string, RegisteredTool>()
      if (scoped.has(registration.binding.name)) {
        throw new CardToolRegistryError(
          'CARD_TOOL_DUPLICATE',
          `Card tool "${registration.binding.name}" is already registered for this card scope`
        )
      }
      scoped.set(registration.binding.name, { ...registration, scopeKey })
      toolsByScope.set(scopeKey, scoped)
    },

    resolve(definition, scope) {
      if (!scope?.characterId) return undefined
      const tool = toolsByScope
        .get(
          scopeKeyFor({
            profileId: scope.profileId,
            chatId: scope.chatId,
            characterId: scope.characterId
          })
        )
        ?.get(definition.name)
      if (!tool || !inputMatches(tool.binding, definition)) return undefined
      return {
        name: tool.binding.name,
        inputSchema: tool.binding.inputSchema,
        transactionMode: tool.binding.transactionMode,
        parallelSafe: tool.binding.parallelSafe,
        execute: (input, context) => execute(tool, input, context)
      }
    },

    complete(result) {
      const callback = pending.get(result.requestId)
      if (!callback) return false
      if (callback.senderId !== result.senderId) {
        return rejectScope('Card tool callback sender does not own this request')
      }
      if (result.scope && callback.scopeKey !== scopeKeyFor(result.scope)) {
        return rejectScope('Card tool callback scope does not own this request')
      }
      try {
        if (typeof result.error === 'string' && result.error) {
          settle(callback, {
            error: new CardToolRegistryError('CARD_TOOL_INVALID_RESULT', result.error)
          })
          return true
        }
        const value = jsonValue(result.result, 'CARD_TOOL_INVALID_RESULT', 'Card tool result')
        if (bytesOf(value) > maxResultBytes) {
          throw new CardToolRegistryError(
            'CARD_TOOL_RESULT_TOO_LARGE',
            `Card tool result exceeds the ${maxResultBytes}-byte limit`
          )
        }
        const operations = operationsFrom(result.operations)
        if (result.externalEffectBegan === true) callback.context.beginExternalEffect()
        for (const operation of operations) callback.context.stage(operation)
        settle(callback, { value })
        return true
      } catch (cause) {
        const error =
          cause instanceof CardToolRegistryError
            ? cause
            : new CardToolRegistryError(
                'CARD_TOOL_INVALID_RESULT',
                cause instanceof Error ? cause.message : 'Card tool callback failed'
              )
        settle(callback, { error })
        throw error
      }
    },

    unregister(senderId, name, scope) {
      const requestedScopeKey = scope ? scopeKeyFor(scope) : undefined
      for (const [scopeKey, tools] of toolsByScope) {
        if (requestedScopeKey && requestedScopeKey !== scopeKey) continue
        const tool = tools.get(name)
        if (!tool || tool.scope.senderId !== senderId) continue
        tools.delete(name)
        if (tools.size === 0) toolsByScope.delete(scopeKey)
        for (const callback of [...pending.values()]) {
          if (
            callback.senderId !== senderId ||
            callback.scopeKey !== scopeKey ||
            callback.name !== name
          )
            continue
          settle(callback, {
            error: new CardToolRegistryError(
              'CARD_TOOL_UNMOUNTED',
              'Card tool implementation was unmounted before it replied'
            )
          })
        }
        return true
      }
      return false
    },

    unregisterSender(senderId) {
      let removed = 0
      for (const [scopeKey, tools] of toolsByScope) {
        for (const [name, tool] of tools) {
          if (tool.scope.senderId !== senderId) continue
          tools.delete(name)
          removed += 1
        }
        if (tools.size === 0) toolsByScope.delete(scopeKey)
      }
      for (const callback of [...pending.values()]) {
        if (callback.senderId !== senderId) continue
        settle(callback, {
          error: new CardToolRegistryError(
            'CARD_TOOL_UNMOUNTED',
            'Card tool implementation was unmounted before it replied'
          )
        })
      }
      return removed
    }
  }
}
