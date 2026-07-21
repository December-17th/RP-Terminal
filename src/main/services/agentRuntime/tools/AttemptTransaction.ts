import type { JsonObject } from '../../../../shared/agentRuntime'
import { freezeJsonValue, normalizeJsonValue } from '../internal/json'

export interface StagedToolOperation {
  type: string
  payload: JsonObject
}

export type AttemptTransactionSnapshot = ReadonlyArray<Readonly<StagedToolOperation>>

export class AttemptTransaction {
  readonly #operations: StagedToolOperation[] = []
  #discarded = false
  #externalEffectBegan = false

  stage(operation: StagedToolOperation): void {
    if (this.#discarded) throw new Error('Attempt Transaction has been discarded')
    if (typeof operation.type !== 'string') {
      throw new Error('Attempt Transaction operation type must be a string')
    }
    const payload = normalizeJsonValue(operation.payload)
    if (
      !payload.ok ||
      typeof payload.value !== 'object' ||
      !payload.value ||
      Array.isArray(payload.value)
    ) {
      throw new Error(
        `Attempt Transaction operation payload is not JSON-compatible${payload.ok ? '' : `: ${payload.message}`}`
      )
    }
    this.#operations.push({ type: operation.type, payload: payload.value })
  }

  markExternalEffectBegan(): void {
    this.#externalEffectBegan = true
  }

  discard(): void {
    this.#discarded = true
    this.#operations.length = 0
  }

  get externalEffectBegan(): boolean {
    return this.#externalEffectBegan
  }

  stagedOperations(): StagedToolOperation[] {
    return this.#operations.map((operation) => structuredClone(operation))
  }

  snapshot(): AttemptTransactionSnapshot {
    return Object.freeze(
      this.#operations.map((operation) =>
        Object.freeze({
          type: operation.type,
          payload: freezeJsonValue(structuredClone(operation.payload)) as JsonObject
        })
      )
    )
  }

  static fromSnapshot(snapshot: AttemptTransactionSnapshot): AttemptTransaction {
    const transaction = new AttemptTransaction()
    for (const operation of snapshot) transaction.stage(operation)
    return transaction
  }
}
