import { z } from 'zod'
import { toParts } from '../../../../shared/objectPath'
import { getAllFloors } from '../../floorService'
import { applyVariableOps } from '../../generation/varsWrite'
import { NodeImpl } from '../types'

/** Convert a dot/bracket stat_data path ("a.b[0]") to the RFC-6901 JSON Pointer
 *  applyVariableOps expects ("/a/b/0"), escaping ~ and / per the spec. */
export const toPointer = (path: string): string =>
  '/' +
  toParts(path)
    .map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')

const setConfig = z.object({
  path: z.string().min(1),
  value: z.unknown().optional()
})

/** Writes a value to a stat_data path on the LATEST floor via the same JSON-patch write-back
 *  bridge card panels use (applyVariableOps), so workflow writes fold in identically and
 *  survive a re-evaluate (spec §11). The wired `value` input wins over the config value. */
export const mvuSet: NodeImpl = {
  type: 'mvu.set',
  title: 'Set Variable',
  inputs: [
    { name: 'value', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [],
  configSchema: setConfig,
  run: (ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof setConfig>
    const value = inputs.value !== undefined ? inputs.value : cfg.value
    const floors = getAllFloors(ctx.profileId!, ctx.chatId!)
    const last = floors[floors.length - 1]
    if (last) {
      applyVariableOps(ctx.profileId!, ctx.chatId!, last.floor, [
        { op: 'replace', path: toPointer(cfg.path), value }
      ])
    }
    return { outputs: {} }
  }
}
