import type { JsonObject, JsonValue } from '../../../../shared/agentRuntime'

export type JsonNormalizationResult =
  | { ok: true; value: JsonValue }
  | { ok: false; message: string }

const normalize = (value: unknown, ancestors: Set<object>): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('numbers must be finite')
    return value
  }
  if (typeof value !== 'object') {
    throw new Error(`values of type "${typeof value}" are not JSON-compatible`)
  }
  if (ancestors.has(value)) throw new Error('cyclic values are not JSON-compatible')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const normalized: JsonValue[] = []
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error('sparse arrays are not JSON-compatible')
        }
        normalized.push(normalize(value[index], ancestors))
      }
      return normalized
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('only plain objects are JSON-compatible')
    }
    const normalized: JsonObject = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new Error('symbol keys are not JSON-compatible')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable) continue
      if (!('value' in descriptor)) throw new Error('accessor properties are not JSON-compatible')
      Object.defineProperty(normalized, key, {
        value: normalize(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
    return normalized
  } finally {
    ancestors.delete(value)
  }
}

export const normalizeJsonValue = (value: unknown): JsonNormalizationResult => {
  try {
    return { ok: true, value: normalize(value, new Set()) }
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : 'value is not JSON-compatible'
    }
  }
}

export const freezeJsonValue = (value: JsonValue): JsonValue => {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    for (const entry of value) freezeJsonValue(entry)
  } else {
    for (const entry of Object.values(value)) freezeJsonValue(entry)
  }
  return Object.freeze(value) as JsonValue
}

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
