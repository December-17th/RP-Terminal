import { WorkflowDoc, NodeDescriptor, NodeInstance, PortType, portCompatible } from './types'
import { topoOrder, GraphCycleError } from './graph'

export interface ValidationError {
  code: string
  message: string
  nodeId?: string
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] }

type PortLookup = { nodeMissing: true } | { nodeMissing: false; type?: PortType }

/** Validate a workflow document against a map of known node descriptors (spec §12 validation gate). */
export function validateWorkflow(
  doc: WorkflowDoc,
  descriptors: Map<string, NodeDescriptor>
): ValidationResult {
  const errors: ValidationError[] = []
  const nodeById = new Map<string, NodeInstance>(doc.nodes.map((n) => [n.id, n]))

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
  }

  const mains = doc.nodes.filter((n) => n.isMainOutput)
  if (mains.length !== 1)
    errors.push({
      code: 'MAIN_OUTPUT',
      message: `expected exactly 1 main-output node, found ${mains.length}`
    })

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
