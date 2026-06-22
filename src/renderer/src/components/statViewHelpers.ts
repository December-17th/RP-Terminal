/**
 * Pure classification helpers for the recursive RPG status view (Track R / R3).
 * Kept separate from the React shell (StatView.tsx) so the node-shape logic is
 * unit-testable under Vitest's node env. MVU `stat_data` is deeply nested with two
 * recurring conventions this understands: value/description tuples and value/max bars.
 */

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** MVU value-with-description: a `[value, "desc"]` tuple or `{ value, description }`. */
export const asValueDesc = (v: unknown): { value: unknown; description: string } | null => {
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[1] === 'string' &&
    (v[0] === null || typeof v[0] !== 'object')
  ) {
    return { value: v[0], description: v[1] }
  }
  if (isPlainObject(v) && 'value' in v && typeof v.description === 'string') {
    return { value: v.value, description: v.description }
  }
  return null
}

/** A `{ value|current, max }` pair, or a `"current/max"` string (a common MVU convention,
 * e.g. HP `"750/750"`) → rendered as a progress bar. */
export const asBar = (v: unknown): { value: number; max: number } | null => {
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v)
    if (m) {
      const value = Number(m[1])
      const max = Number(m[2])
      if (max > 0) return { value, max }
    }
    return null
  }
  if (!isPlainObject(v)) return null
  const cur = v.value ?? v.current
  const max = v.max
  if (typeof cur === 'number' && typeof max === 'number' && max > 0) return { value: cur, max }
  return null
}

export type NodeKind = 'bar' | 'valueDesc' | 'array' | 'object' | 'primitive'

/** Which renderer a value maps to (bar/valueDesc win over the generic containers). */
export const classify = (v: unknown): NodeKind => {
  if (asBar(v)) return 'bar'
  if (asValueDesc(v)) return 'valueDesc'
  if (Array.isArray(v)) return 'array'
  if (isPlainObject(v)) return 'object'
  return 'primitive'
}

export const formatPrimitive = (v: unknown): string => {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  return String(v)
}
