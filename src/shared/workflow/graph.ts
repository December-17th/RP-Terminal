import { WorkflowDoc } from './types'

export class GraphCycleError extends Error {
  constructor(message = 'workflow graph has a cycle') {
    super(message)
    this.name = 'GraphCycleError'
  }
}

/** Kahn's algorithm over NODE-level dependencies. Duplicate edges between the same pair of
 *  nodes count once. Throws GraphCycleError if the graph is not a DAG (spec §5). */
export function topoOrder(doc: WorkflowDoc): string[] {
  const ids = doc.nodes.map((n) => n.id)
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  const seenPair = new Set<string>()

  for (const e of doc.edges) {
    if (!indeg.has(e.from.node) || !indeg.has(e.to.node)) continue
    const key = `${e.from.node} ${e.to.node}`
    if (seenPair.has(key)) continue
    seenPair.add(key)
    adj.get(e.from.node)!.push(e.to.node)
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1)
  }

  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }

  if (order.length !== ids.length) throw new GraphCycleError()
  return order
}
