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

/** "set" ops for each TOP-LEVEL key of `obj` (TavernHelper insert/assign semantics — keys are not paths). */
export function assignVarOps(obj: Record<string, unknown>): VarOp[] {
  return Object.entries(obj || {}).map(([k, v]) => ({ op: 'set', path: keyPointer(k), value: v }))
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
