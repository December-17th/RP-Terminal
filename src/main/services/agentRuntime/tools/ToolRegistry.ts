import type {
  AgentToolDefinition,
  JsonObject,
  JsonSchema,
  JsonValue,
  ToolTransactionMode
} from '../../../../shared/agentRuntime'
import type { AttemptTransaction, StagedToolOperation } from './AttemptTransaction'
import { canonicalJson } from '../internal/json'

export interface ToolExecutionContext {
  signal?: AbortSignal
  stage(operation: StagedToolOperation): void
  beginExternalEffect(): void
}

/**
 * The live card implementation scope carried with an invocation. Only privileged transports construct
 * it from their authoritative binding; Agent definitions and provider payloads cannot supply it.
 */
export interface ToolExecutionScope {
  profileId: string
  chatId: string
  characterId?: string
}

export interface ToolBinding {
  name: string
  inputSchema: JsonSchema
  transactionMode: ToolTransactionMode
  parallelSafe: boolean
  execute(input: JsonObject, context: ToolExecutionContext): Promise<JsonValue> | JsonValue
}

export interface ToolRegistry {
  resolve(definition: AgentToolDefinition, scope?: ToolExecutionScope): ToolBinding | undefined
}

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right)

export const createToolRegistry = (bindings: ToolBinding[] = []): ToolRegistry => {
  const byName = new Map(bindings.map((binding) => [binding.name, binding]))
  return {
    resolve(definition) {
      const binding = byName.get(definition.name)
      if (!binding) return undefined
      if (
        binding.transactionMode !== definition.transactionMode ||
        binding.parallelSafe !== definition.parallelSafe ||
        !sameJson(binding.inputSchema, definition.inputSchema)
      ) {
        return undefined
      }
      return binding
    }
  }
}

/** Resolve through ordered registries while preserving the invocation's authoritative card scope. */
export const createCompositeToolRegistry = (...registries: ToolRegistry[]): ToolRegistry => ({
  resolve(definition, scope) {
    for (const registry of registries) {
      const binding = registry.resolve(definition, scope)
      if (binding) return binding
    }
    return undefined
  }
})

export const executionContextFor = (
  transaction: AttemptTransaction,
  mode: ToolTransactionMode,
  signal?: AbortSignal,
  onExternalEffectBegan?: () => void
): ToolExecutionContext => {
  let externalEffectBegan = false
  return {
    signal,
    stage(operation) {
      if (mode !== 'transactional') {
        throw new Error(`Tool mode "${mode}" cannot stage transactional operations`)
      }
      transaction.stage(operation)
    },
    beginExternalEffect() {
      if (mode !== 'non-transactional') {
        throw new Error(`Tool mode "${mode}" has no external-effect boundary`)
      }
      transaction.markExternalEffectBegan()
      if (!externalEffectBegan) {
        externalEffectBegan = true
        onExternalEffectBegan?.()
      }
    }
  }
}
