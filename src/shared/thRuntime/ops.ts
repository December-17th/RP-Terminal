// src/shared/thRuntime/ops.ts
//
// Build RFC-6902 JSON Patch ops for the variable write path. The main applier
// (generationService.applyVariableOps → applyJsonPatch) operates on the floor's `stat_data`, expects
// JSON Pointer paths, and SKIPS empty/zero-segment paths — so wholesale replaces go per top-level key.
export type VarOp = { op: string; path: string; value?: unknown; from?: string }

const esc = (s: string): string => String(s).replace(/~/g, '~0').replace(/\//g, '~1')

/** Dot/bracket card path ("a.b.c") → JSON Pointer ("/a/b/c"), each segment escaped. */
export function toPointer(dotPath: string): string {
  return '/' + String(dotPath).split('.').filter(Boolean).map(esc).join('/')
}

/** A single key → JSON Pointer ("/key"), WITHOUT dot-splitting (the key may legitimately contain a dot). */
export function keyPointer(key: string): string {
  return '/' + esc(key)
}

/** One "set" op at a dot path (e.g. from Mvu.setMvuVariable). */
export function setVarOps(dotPath: string, value: unknown): VarOp[] {
  return [{ op: 'set', path: toPointer(dotPath), value }]
}

/** "set" ops for each TOP-LEVEL key of `obj` (a shallow whole-key replace — keys are not paths). */
export function assignVarOps(obj: Record<string, unknown>): VarOp[] {
  return Object.entries(obj || {}).map(([k, v]) => ({ op: 'set', path: keyPointer(k), value: v }))
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Resolve a JSON Pointer against a root, returning `undefined` if any segment is missing. */
function getAtPointer(root: unknown, pointer: string): unknown {
  const segs = pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur: any = root
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[s]
  }
  return cur
}

/**
 * Build DEEP leaf-path set ops for the TavernHelper `insertOrAssignVariables` (merge) and
 * `insertVariables` (insert-if-absent) helpers, given the CURRENT state. Real TavernHelper merges a
 * nested object into the variables recursively (like `_.merge` / `_.defaultsDeep`), preserving sibling
 * keys — NOT a shallow whole-top-level-key replace. Emitting a `set` op per LEAF path lets the applier
 * (`applyJsonPatch`, which auto-vivifies intermediate objects and touches only the addressed leaf) do
 * the deep merge. A non-empty plain object recurses; a primitive / array / null / EMPTY object is a leaf.
 *
 * `insertOnly` (insertVariables): mirror TavernHelper's `_.mergeWith({}, defaults, existing, ...)`.
 * Existing values win, including scalar/null/array parents, so defaults below an existing non-plain parent
 * are skipped. Otherwise (insertOrAssignVariables): overwrite leaves, but treat an empty-object value as
 * "create only if absent" so `{npcs:{}}` can't wipe an existing map.
 */
export function deepVarOps(
  current: Record<string, unknown> | undefined,
  obj: Record<string, unknown>,
  insertOnly: boolean,
  base = ''
): VarOp[] {
  const cur = current || {}
  const ops: VarOp[] = []
  for (const [k, v] of Object.entries(obj || {})) {
    const path = base + '/' + esc(k)
    if (isPlainObj(v) && Object.keys(v).length > 0) {
      if (insertOnly) {
        const existing = getAtPointer(cur, path)
        if (existing !== undefined && !isPlainObj(existing)) continue
      }
      ops.push(...deepVarOps(cur, v, insertOnly, path))
      continue
    }
    const exists = getAtPointer(cur, path) !== undefined
    // insertOnly: only fill missing paths. merge + empty-object: only create if absent (don't wipe an
    // existing object). merge + primitive/array/null: always overwrite the leaf.
    if (insertOnly || isPlainObj(v)) {
      if (!exists) ops.push({ op: 'set', path, value: v })
    } else {
      ops.push({ op: 'set', path, value: v })
    }
  }
  return ops
}

/** Apply `set` ops (from deepVarOps / setVarOps) onto `root` in place, auto-vivifying intermediate
 *  objects — mirrors the main-side `applyJsonPatch` so the runtime's optimistic stat cache stays in
 *  sync with what gets persisted. Ignores non-`set` ops. Returns `root`. */
export function applySetOps(root: Record<string, unknown>, ops: VarOp[]): Record<string, unknown> {
  for (const op of ops) {
    if (op.op !== 'set') continue
    const segs = op.path
      .split('/')
      .slice(1)
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (!segs.length) continue
    let cur: any = root
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]
      if (cur[s] == null || typeof cur[s] !== 'object' || Array.isArray(cur[s])) cur[s] = {}
      cur = cur[s]
    }
    cur[segs[segs.length - 1]] = op.value
  }
  return root
}

/** Ops that make stat_data equal `next`: remove top-level keys absent from `next`, then set all of
 *  `next`. (A whole-root replace path is skipped by the applier, so replace is expressed per key.) */
export function replaceStatDataOps(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): VarOp[] {
  const cur = current && typeof current === 'object' ? current : {}
  const safeNext = next && typeof next === 'object' ? next : {}
  const ops: VarOp[] = []
  for (const k of Object.keys(cur))
    if (!(k in safeNext)) ops.push({ op: 'remove', path: keyPointer(k) })
  for (const [k, v] of Object.entries(safeNext))
    ops.push({ op: 'set', path: keyPointer(k), value: v })
  return ops
}
