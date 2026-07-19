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

export interface ToolBinding {
  name: string
  inputSchema: JsonSchema
  transactionMode: ToolTransactionMode
  parallelSafe: boolean
  execute(input: JsonObject, context: ToolExecutionContext): Promise<JsonValue> | JsonValue
}

export interface ToolRegistry {
  resolve(definition: AgentToolDefinition): ToolBinding | undefined
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
