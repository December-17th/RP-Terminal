// Pure tree-edit helper for the Variables editor: given the root value, the JSON-Pointer segments to
// an edit site, an action, and a payload, return the immutably-updated root AND the RFC-6902 op that
// describes the change. The op feeds applyVariableOps (stat_data); `next` feeds chatCardVarsSet (KV).

export type EditOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }
export type EditAction = 'replace' | 'insertKey' | 'appendItem' | 'delete'

const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1')

/** JSON Pointer (RFC-6901) from path segments; [] → '' (whole document root). */
export const toPointer = (segs: Array<string | number>): string =>
  segs.map((s) => '/' + esc(String(s))).join('')

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

const containerAt = (root: any, segs: Array<string | number>): any => {
  let cur = root
  for (const s of segs) cur = cur[s]
  return cur
}

export const applyEdit = (
  root: unknown,
  segs: Array<string | number>,
  action: EditAction,
  payload: { key?: string; value?: unknown } = {}
): { next: unknown; op: EditOp } => {
  const next = clone(root) as any

  if (action === 'insertKey') {
    const key = String(payload.key)
    containerAt(next, segs)[key] = payload.value
    return { next, op: { op: 'add', path: toPointer([...segs, key]), value: payload.value } }
  }
  if (action === 'appendItem') {
    ;(containerAt(next, segs) as unknown[]).push(payload.value)
    return { next, op: { op: 'add', path: toPointer([...segs, '-']), value: payload.value } }
  }

  // replace / delete operate on the node AT segs (parent = segs[0..-1], last = segs[-1]).
  const parent = containerAt(next, segs.slice(0, -1))
  const last = segs[segs.length - 1]
  if (action === 'replace') {
    parent[last] = payload.value
    return { next, op: { op: 'replace', path: toPointer(segs), value: payload.value } }
  }
  // delete
  if (Array.isArray(parent)) parent.splice(Number(last), 1)
  else delete parent[last]
  return { next, op: { op: 'remove', path: toPointer(segs) } }
}
