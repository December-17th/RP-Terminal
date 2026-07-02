import { z } from 'zod'
import { getPath, setPath, toParts } from '../../../../shared/objectPath'
import { getAllFloors, saveFloor } from '../../floorService'
import { getChatCardVars, setChatCardVars } from '../../chatCardVarsService'
import { GenContext } from '../../generation/types'
import { NodeImpl, NodeRunFailure } from '../types'

/**
 * Variable extractor/writer nodes (extractor-nodes plan §2.1/§2.2): read/write either the
 * per-chat KV store (`session`) or the latest floor's `variables` tree (`floor`, which includes
 * MVU's read-only `stat_data`), so a side branch can pull ONLY the slice of state it needs
 * (token-saving) instead of the whole `input.context` bundle, and persist results for future
 * turns via the existing `{{getvar}}`/EJS surface — no new injection mechanism.
 */

const varsConfig = z.object({
  scope: z.enum(['floor', 'session']).optional(),
  path: z.string().min(1)
})

/** Stringify a read value for the `text` output: '' for null/undefined, strings pass through,
 *  everything else pretty-printed JSON. */
const toText = (value: unknown): string =>
  value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)

/** Reads one path out of either store (spec §2.1). `floor` reads the LATEST floor's `variables`
 *  tree (including `stat_data`, read-only here — writes to it must go through `mvu.set`); with
 *  no floors yet it falls back to `gen.workingVars`, then `{}`. `session` reads the per-chat KV
 *  store (`chatCardVarsService`, the TavernHelper `getVariables({type:'chat'})` counterpart). */
export const varsGet: NodeImpl = {
  type: 'vars.get',
  title: 'Get Variable',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [
    { name: 'value', type: 'Any' },
    { name: 'text', type: 'Text' }
  ],
  configSchema: varsConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof varsConfig>
    const gen = inputs.gen as GenContext
    const scope = cfg.scope ?? 'floor'
    let tree: Record<string, unknown>
    if (scope === 'session') {
      tree = getChatCardVars(gen.profileId, gen.chatId)
    } else {
      const floors = getAllFloors(gen.profileId, gen.chatId)
      const last = floors[floors.length - 1]
      tree = last?.variables ?? gen.workingVars ?? {}
    }
    const value = getPath(tree, cfg.path)
    return { outputs: { value, text: toText(value) } }
  }
}

/** Writes one path into either store (spec §2.2). An unwired/pruned upstream `value` is a
 *  silent no-op (not an error). `session` round-trips whole-object (`setChatCardVars` is
 *  whole-object by design). `floor` writes onto a COPY of the latest floor's `variables`, then
 *  `saveFloor`s it — but REFUSES the `stat_data`/`delta_data` roots: `applyVariableOps`
 *  (the MVU write-back bridge with delta tracking + the runaway-loop guard) operates INSIDE
 *  `stat_data` only (verified: `generation/varsWrite.ts` builds `sd = f.variables.stat_data` and
 *  patches that), so a raw path-write here would silently desync stat_data from its own delta
 *  log — route those writes through `mvu.set` instead. The root check uses `toParts` (the SAME
 *  bracket-aware parser `getPath`/`setPath` use) so a bracket path like `["stat_data"].foo`
 *  can't bypass the guard.
 *  Custom floor variables written here SURVIVE MVU re-evaluate (`reevaluateVariables` rebuilds
 *  only `stat_data`/`delta_data`, spreading the rest of `f.variables` through unchanged) and are
 *  readable from presets/cards via EJS/`{{getvar}}` in future turns. */
export const varsSave: NodeImpl = {
  type: 'vars.save',
  title: 'Save Variable',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'value', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'error', type: 'Error' }],
  configSchema: varsConfig,
  run: (_ctx, inputs, node) => {
    if (inputs.value === undefined) return { outputs: {} }
    const cfg = node.config as z.infer<typeof varsConfig>
    const gen = inputs.gen as GenContext
    const scope = cfg.scope ?? 'floor'
    if (scope === 'session') {
      const kv = getChatCardVars(gen.profileId, gen.chatId)
      setPath(kv, cfg.path, inputs.value)
      setChatCardVars(gen.profileId, gen.chatId, kv)
      return { outputs: {} }
    }
    const root = toParts(cfg.path)[0]
    if (root === 'stat_data' || root === 'delta_data') {
      throw new NodeRunFailure(
        'B',
        `vars.save refuses to write "${cfg.path}" — stat_data/delta_data are MVU-managed; use mvu.set instead`,
        1,
        'reserved-path'
      )
    }
    const floors = getAllFloors(gen.profileId, gen.chatId)
    const last = floors[floors.length - 1]
    if (!last) return { outputs: {} }
    const variables = { ...last.variables }
    setPath(variables, cfg.path, inputs.value)
    last.variables = variables
    saveFloor(gen.profileId, gen.chatId, last)
    return { outputs: {} }
  }
}
