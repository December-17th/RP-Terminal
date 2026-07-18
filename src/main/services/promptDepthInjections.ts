import type { AssemblyJournal, RecordSource } from '../../shared/executionRecord'
import type { ChatMessage } from './promptTypes'

export interface DepthItem {
  depth: number
  content: string
  role?: ChatMessage['role']
  order?: number
  extension?: boolean
  source?: RecordSource
}

export interface GroupedInjection {
  depth: number
  role: ChatMessage['role']
  content: string
  sources: RecordSource[]
}

const ROLE_SEQUENCE: ChatMessage['role'][] = ['system', 'user', 'assistant']

/** Group ST depth injections by depth, order, and role in their final wire order. */
export const groupDepthInjections = (items: DepthItem[]): GroupedInjection[] => {
  const byDepth = new Map<number, DepthItem[]>()
  for (const item of items) {
    if (!item.content) continue
    if (!byDepth.has(item.depth)) byDepth.set(item.depth, [])
    byDepth.get(item.depth)!.push(item)
  }

  const orderOf = (item: DepthItem): number => (item.extension ? 100 : (item.order ?? 100))
  const out: GroupedInjection[] = []
  for (const [depth, group] of byDepth) {
    const orders = [...new Set(group.map(orderOf))].sort((a, b) => a - b)
    for (const order of orders) {
      for (const role of [...ROLE_SEQUENCE].reverse()) {
        const matching = group.filter(
          (item) => orderOf(item) === order && (item.role ?? 'system') === role
        )
        if (!matching.length) continue
        const preset = matching
          .filter((item) => !item.extension)
          .map((item) => item.content)
          .join('\n')
        const extension = matching
          .filter((item) => item.extension)
          .map((item) => item.content)
          .join('\n')
        const content = [preset, extension]
          .filter(Boolean)
          .map((part) => part.trim())
          .join('\n')
        if (!content) continue
        const sources = [
          ...matching.filter((item) => !item.extension),
          ...matching.filter((item) => item.extension)
        ]
          .map((item) => item.source)
          .filter((source): source is RecordSource => !!source)
        out.push({ depth, role, content, sources })
      }
    }
  }
  return out
}

/** Splice grouped depth injections into the chat region and journal their lineage. */
export const applyDepthInjections = (
  messages: ChatMessage[],
  items: DepthItem[],
  conversationStart: number,
  hasTrailingUser: boolean,
  journal?: AssemblyJournal
): void => {
  const grouped = groupDepthInjections(items)
  if (!grouped.length) return
  const base = messages.length
  const maximumIndex = hasTrailingUser ? base - 1 : base
  const start = conversationStart === -1 ? base : conversationStart
  const plan = [...new Set(grouped.map((group) => group.depth))].map((depth) => ({
    depth,
    index: Math.max(start, Math.min(base - depth, maximumIndex)),
    messages: grouped.filter((group) => group.depth === depth)
  }))
  plan.sort((left, right) => right.index - left.index || left.depth - right.depth)

  for (const entry of plan) {
    messages.splice(
      entry.index,
      0,
      ...entry.messages.map((message) => ({ role: message.role, content: message.content }))
    )
    entry.messages.forEach((message, offset) => {
      const at = entry.index + offset
      const sources = message.sources.length
        ? message.sources
        : ([{ kind: 'pipeline', id: 'depth-inject' }] as RecordSource[])
      for (const source of sources) {
        journal?.depthInject(source, entry.depth, at, message.role, message.content)
      }
    })
  }
}
