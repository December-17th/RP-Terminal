// Shared dot/bracket path + clone/merge helpers — the single source of truth for
// the MVU / template / plugin variable engines. Pure module: imported by main,
// preload, AND renderer, so it must not import from src/main or src/renderer.
//
// `toParts` is bracket-aware ("a[0].b" -> ["a", "0", "b"]) and drops empty
// segments. Callers that need plain split-on-dot semantics with no bracket
// expansion (shared/macros, preload/wcvPreload, renderer plugin/stscript)
// intentionally keep their own tiny helpers — don't fold those in here.

/** Split a dot/bracket path into parts: "a[0].b" -> ["a", "0", "b"]. */
export const toParts = (p: string): string[] =>
  String(p)
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)

/** Read a nested value by path. A null/empty path returns the root object. */
export const getPath = (obj: any, p: string | null | undefined): any => {
  if (p == null || p === '') return obj
  let cur = obj
  for (const part of toParts(p)) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

/** Write a nested value by path, creating plain-object intermediates as needed. */
export const setPath = (obj: any, p: string, val: any): void => {
  const parts = toParts(p)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = val
}

/** Delete a nested key by path (no-op if the parent path is missing). */
export const delPath = (obj: any, p: string): void => {
  const parts = toParts(p)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return
    cur = cur[parts[i]]
  }
  if (cur) delete cur[parts[parts.length - 1]]
}

/** Plain-object guard (excludes arrays and null). */
export const isPlainObject = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structured deep clone via JSON. `undefined` passes through unchanged. */
export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/**
 * Recursively merge `source` into `target`: plain objects merge in place,
 * everything else (including arrays) replaces. Merged-in values are deep-cloned
 * so the result shares no references with `source`.
 */
export const deepMerge = (target: Record<string, any>, source: Record<string, any>): void => {
  for (const k of Object.keys(source)) {
    const sv = source[k]
    if (isPlainObject(sv) && isPlainObject(target[k])) deepMerge(target[k], sv)
    else target[k] = clone(sv)
  }
}
