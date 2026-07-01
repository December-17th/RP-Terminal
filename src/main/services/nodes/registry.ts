import { NodeDescriptor } from '../../../shared/workflow/types'
import { NodeImpl } from './types'

export interface NodeRegistry {
  get(type: string): NodeImpl | undefined
  has(type: string): boolean
  /** The pure descriptors (no run()) for validateWorkflow. */
  descriptors(): Map<string, NodeDescriptor>
}

/** Build a node registry from a list of impls. Adding a node type = pass another impl here;
 *  the executor is generic over the registry (spec §14 extensibility). Throws on duplicate types. */
export function createRegistry(impls: NodeImpl[]): NodeRegistry {
  const byType = new Map<string, NodeImpl>()
  for (const impl of impls) {
    if (byType.has(impl.type)) throw new Error(`duplicate node type "${impl.type}"`)
    byType.set(impl.type, impl)
  }
  return {
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    descriptors: () => {
      const out = new Map<string, NodeDescriptor>()
      for (const [type, impl] of byType) {
        const { run: _run, ...descriptor } = impl
        out.set(type, descriptor)
      }
      return out
    }
  }
}
