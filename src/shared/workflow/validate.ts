import { WorkflowDoc, NodeDescriptor, NodeInstance, PortType, portCompatible } from './types'
import { topoOrder, GraphCycleError } from './graph'

export interface ValidationError {
  code: string
  message: string
  nodeId?: string
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] }

type PortLookup = { nodeMissing: true } | { nodeMissing: false; type?: PortType }

/** Validate a workflow document against a map of known node descriptors (spec §12 validation
 *  gate). Branches on `doc.kind` (sub-graph nodes v1 plan §2): a 'turn' doc (default, absent
 *  kind) must have exactly one main-output node and must NOT contain boundary nodes
 *  (`subgraph.input`/`subgraph.output` only mean something inside a sub-graph run — their
 *  seeds would be undefined in a normal turn); a 'subgraph' doc skips the main-output rule
 *  (it's invoked via `subgraph.call`, never run directly) but requires each boundary slot name
 *  to be used by at most one node per direction. */
export function validateWorkflow(
  doc: WorkflowDoc,
  descriptors: Map<string, NodeDescriptor>
): ValidationResult {
  const errors: ValidationError[] = []
  const nodeById = new Map<string, NodeInstance>(doc.nodes.map((n) => [n.id, n]))
  const isSubgraph = doc.kind === 'subgraph'

  const hasDupNodeIds = nodeById.size !== doc.nodes.length
  if (hasDupNodeIds) errors.push({ code: 'DUP_NODE_ID', message: 'duplicate node ids' })

  for (const n of doc.nodes) {
    if (!descriptors.has(n.type))
      errors.push({ code: 'UNKNOWN_TYPE', message: `unknown node type "${n.type}"`, nodeId: n.id })
  }

  const portOf = (nodeId: string, port: string, dir: 'inputs' | 'outputs'): PortLookup => {
    const n = nodeById.get(nodeId)
    if (!n) return { nodeMissing: true }
    const spec = descriptors.get(n.type)?.[dir].find((p) => p.name === port)
    return { nodeMissing: false, type: spec?.type }
  }

  const fanInCounts = new Map<string, { nodeId: string; port: string; count: number }>()
  for (const e of doc.edges) {
    const out = portOf(e.from.node, e.from.port, 'outputs')
    const inp = portOf(e.to.node, e.to.port, 'inputs')
    if (out.nodeMissing || inp.nodeMissing) {
      errors.push({ code: 'EDGE_NODE', message: 'edge references a missing node' })
      continue
    }
    if (out.type === undefined) {
      errors.push({
        code: 'EDGE_PORT',
        message: `no output port "${e.from.port}" on ${e.from.node}`
      })
      continue
    }
    if (inp.type === undefined) {
      errors.push({ code: 'EDGE_PORT', message: `no input port "${e.to.port}" on ${e.to.node}` })
      continue
    }
    if (!portCompatible(out.type, inp.type))
      errors.push({
        code: 'PORT_TYPE',
        message: `${out.type} → ${inp.type} incompatible`,
        nodeId: e.to.node
      })

    const fanInKey = JSON.stringify([e.to.node, e.to.port])
    const entry = fanInCounts.get(fanInKey)
    if (entry) entry.count++
    else fanInCounts.set(fanInKey, { nodeId: e.to.node, port: e.to.port, count: 1 })
  }

  for (const { nodeId, port, count } of fanInCounts.values()) {
    if (count < 2) continue
    errors.push({
      code: 'FANIN',
      message: `input port "${port}" on ${nodeId} has multiple incoming edges`,
      nodeId
    })
  }

  // A 'subgraph' doc is never run directly (it's invoked via subgraph.call) — it skips the
  // exactly-one-main-output rule entirely.
  if (!isSubgraph) {
    const mains = doc.nodes.filter((n) => n.isMainOutput)
    if (mains.length !== 1)
      errors.push({
        code: 'MAIN_OUTPUT',
        message: `expected exactly 1 main-output node, found ${mains.length}`
      })
  }

  if (!isSubgraph) {
    // Boundary nodes are meaningless in a turn graph — their seeds (ctx.subgraphSeeds) would be
    // undefined, since a turn is never invoked by subgraph.call.
    for (const n of doc.nodes) {
      if (n.type === 'subgraph.input' || n.type === 'subgraph.output')
        errors.push({
          code: 'BOUNDARY_IN_TURN',
          message: `${n.type} is only valid inside a sub-graph doc (kind: 'subgraph')`,
          nodeId: n.id
        })
    }
  } else {
    // Each boundary slot name must be claimed by at most one node per direction — two
    // subgraph.input nodes both mapped to slot 'in1' would both read the same seed with no way
    // for the caller to tell which is which.
    const seenIn = new Map<string, string>()
    const seenOut = new Map<string, string>()
    for (const n of doc.nodes) {
      const slot = (n.config as { slot?: unknown } | undefined)?.slot
      if (typeof slot !== 'string') continue
      if (n.type === 'subgraph.input') {
        const prior = seenIn.get(slot)
        if (prior)
          errors.push({
            code: 'DUP_BOUNDARY_SLOT',
            message: `input slot "${slot}" is claimed by both ${prior} and ${n.id}`,
            nodeId: n.id
          })
        else seenIn.set(slot, n.id)
      } else if (n.type === 'subgraph.output') {
        const prior = seenOut.get(slot)
        if (prior)
          errors.push({
            code: 'DUP_BOUNDARY_SLOT',
            message: `output slot "${slot}" is claimed by both ${prior} and ${n.id}`,
            nodeId: n.id
          })
        else seenOut.set(slot, n.id)
      }
    }
  }

  // topoOrder's node-id-keyed maps undercount indegree when ids collide, so the cycle check is
  // unreliable with duplicate ids — the doc is already invalid via DUP_NODE_ID, skip it.
  if (!hasDupNodeIds) {
    try {
      topoOrder(doc)
    } catch (err) {
      if (err instanceof GraphCycleError)
        errors.push({ code: 'CYCLE', message: 'graph has a cycle' })
      else throw err
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}
