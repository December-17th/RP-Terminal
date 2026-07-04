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
 *  NOTE the value is NOT re-derivable from response text, but the write goes through
 *  applyVariableOps, which journals it to `vars_ops`; a later MVU re-evaluate REPLAYS it after the
 *  floor's model fold, so it survives (manual-pass issue 02). Intended for POST-response branches:
 *  pre-phase it would target the PREVIOUS turn's floor and be shadowed by the floor this turn is
 *  about to write. */
export const mvuSet: NodeImpl = {
  type: 'mvu.set',
  title: 'Set Variable',
  inputs: [
    { name: 'value', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  // `done: Any` is an ordering-only output: wire it into a downstream `context.refresh`'s `after`
  // port so the fresh read is sequenced AFTER this write lands (context epochs). It is emitted only
  // on the path that COMPLETED the write — the no-value early return emits nothing (a dead `done`
  // edge is correct there: nothing was written). It's `Any`, not `Signal`, so a dead `done` edge
  // doesn't gate the refresh off (the refresh's live `gen` edge keeps it running).
  outputs: [{ name: 'done', type: 'Any' }],
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
      return { outputs: { done: true } }
    }
    return { outputs: {} }
  }
}
