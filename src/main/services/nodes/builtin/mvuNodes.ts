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
 *  bridge card panels use (applyVariableOps), so workflow writes fold in identically (spec §11).
 *  The wired `value` input wins over the config value; with NO value at all (input unwired,
 *  config value omitted) the write is skipped rather than storing `undefined`.
 *  NOTE like all direct floor writes, the value is NOT re-derivable from response text, so a
 *  later MVU re-evaluate (which replays model `<UpdateVariable>` blocks only) discards it.
 *  Intended for POST-response branches: pre-phase it would target the PREVIOUS turn's floor
 *  and be shadowed by the floor this turn is about to write. */
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
    if (value === undefined) return { outputs: {} }
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
