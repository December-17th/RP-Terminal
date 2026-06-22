/**
 * L1 "Frozen Core" transforms (see docs/prompt-cache-optimization-design.md §6.1).
 * The frontier (character/lore/etc.) is rendered against a FROZEN variable snapshot
 * so its bytes don't change between turns; the live state is shown separately in a
 * tail block. The two L1 sub-modes differ only in what the frozen snapshot shows for
 * state: 'partition' shows placeholders (no stale value), 'diff' shows the floor-0
 * seed values (stale, corrected by the tail block).
 */

export const STATE_PLACEHOLDER = '⟦state⟧'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null))

/** Replace every leaf with the placeholder, preserving object/array shape. */
const placeholderize = (v: any): any => {
  if (Array.isArray(v)) return v.map(placeholderize)
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {}
    for (const k of Object.keys(v)) o[k] = placeholderize(v[k])
    return o
  }
  return STATE_PLACEHOLDER
}

/**
 * The frozen variable snapshot used to render the frontier. Both modes freeze on the
 * floor-0 variables (constant across the session); 'partition' additionally replaces
 * the `stat_data` leaves with a stable placeholder so no real value is ever embedded
 * (and thus none can go stale) in the cached prefix.
 */
export const frozenVarsFor = (
  mode: 'partition' | 'diff',
  floor0Vars: Record<string, any>
): Record<string, any> => {
  const base = clone(floor0Vars || {}) || {}
  if (mode === 'partition' && base.stat_data && typeof base.stat_data === 'object') {
    base.stat_data = placeholderize(base.stat_data)
  }
  return base
}

/**
 * The ephemeral tail block carrying the CURRENT state, placed just before the user
 * action so it never enters the cached prefix. Null when there is no state to show.
 */
export const buildStateBlock = (liveVars: Record<string, any> | undefined): string | null => {
  const sd = liveVars?.stat_data
  if (!sd || typeof sd !== 'object') return null
  return `[Current State]\n${JSON.stringify(sd)}`
}
