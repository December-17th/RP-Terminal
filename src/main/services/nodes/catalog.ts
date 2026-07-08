import { z } from 'zod'
import type { DynamicEnumHint } from '../../../shared/workflow/types'
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
  /** Agent & memory UX (WP-A; spec §1): this node type is a trigger root. Surfaced so the renderer's
   *  agent detection + on/off switch key off the catalog instead of a `trigger.*` name prefix. */
  isTrigger?: boolean
  /** Agent & memory UX (WP-A; spec §1): config field(s) holding an authored prompt → routed to the
   *  Prompt editor and used for the on-card excerpt. */
  promptFields?: string[]
  /** Agent & memory UX (WP-A; plan §0.5): an enum field whose options live in a sibling config array
   *  (the exposed-enum renderer resolves it against the node's current config). */
  dynamicEnum?: DynamicEnumHint
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
      ...(desc.isTrigger ? { isTrigger: true } : {}),
      ...(desc.promptFields ? { promptFields: desc.promptFields } : {}),
      ...(desc.dynamicEnum ? { dynamicEnum: desc.dynamicEnum } : {}),
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
