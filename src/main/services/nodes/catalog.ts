import { z } from 'zod'
import { builtinRegistry } from './builtin'

/** Serializable node-type catalog for the editor (spec §13/§14): the registry's pure
 *  descriptors, with each node's zod configSchema converted to JSON Schema so the renderer's
 *  config panel auto-renders from the SAME source the engine validates with. */
export interface NodeTypeInfo {
  type: string
  title: string
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
  isMainOutputCapable?: boolean
  configSchema?: Record<string, unknown>
}

export const listNodeTypes = (): NodeTypeInfo[] => {
  const out: NodeTypeInfo[] = []
  for (const [type, desc] of builtinRegistry.descriptors()) {
    const impl = builtinRegistry.get(type)!
    out.push({
      type,
      title: desc.title,
      inputs: desc.inputs.map((p) => ({ name: p.name, type: p.type })),
      outputs: desc.outputs.map((p) => ({ name: p.name, type: p.type })),
      ...(desc.isMainOutputCapable ? { isMainOutputCapable: true } : {}),
      ...(impl.configSchema
        ? {
            configSchema: z.toJSONSchema(impl.configSchema, {
              unrepresentable: 'any'
            }) as Record<string, unknown>
          }
        : {})
    })
  }
  return out
}
