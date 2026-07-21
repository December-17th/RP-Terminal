import { parseContent, parseCombatStart, RPEvent } from '../../parsers/contentParser'
import { parseMvuCommands, applyMvuCommands, applyJsonPatch } from '../../parsers/mvuParser'
import { log } from '../logService'
import { getRpExt } from '../../types/character'
import { GenContext } from './types'

/** Apply a single rpt-event to a mutable variables object (nested path set/add/remove). Moved
 *  verbatim out of generationService.ts (Phase 2b-1a); re-exported there so existing consumers
 *  (test/generationService.test.ts) keep resolving the same import. */
export const applyEvent = (vars: Record<string, any>, evt: RPEvent): void => {
  if (evt.type !== 'state') return
  const parts = evt.path.split('.')
  let obj = vars
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {}
    obj = obj[parts[i]]
  }
  const last = parts[parts.length - 1]
  if (evt.action === 'add') {
    obj[last] = (typeof obj[last] === 'number' ? obj[last] : 0) + Number(evt.value)
  } else if (evt.action === 'remove') {
    obj[last] = (typeof obj[last] === 'number' ? obj[last] : 0) - Number(evt.value)
  } else {
    obj[last] = evt.value
  }
}

/**
 * Fold this turn's parsed rpt-events + MVU commands/patches onto the running variables, plus
 * stash a combat-start cue if the model signalled a fight. Moved verbatim out of `generate()`
 * (Phase 2b-1a) — same order (events → MVU → combat cue), same mutation target
 * (`ctx.workingVars`). Returns the mutated `variables` object (`=== ctx.workingVars`).
 */
export const foldState = (
  ctx: GenContext,
  parsed: ReturnType<typeof parseContent>,
  mvu: ReturnType<typeof parseMvuCommands>,
  _raw: string
): Record<string, any> => {
  // workingVars already holds any template setvar() mutations from this build;
  // apply this turn's rpt-events on top, then persist global vars.
  const variables = ctx.workingVars
  if (ctx.chat.floor_count === 0 && !ctx.floorStateBaseline) {
    ctx.floorStateBaseline = JSON.parse(JSON.stringify(variables)) as Record<string, unknown>
  }
  for (const evt of parsed.events) applyEvent(variables, evt)
  if (mvu.commands.length || mvu.patches.length) {
    if (typeof variables.stat_data !== 'object' || variables.stat_data === null) {
      variables.stat_data = {}
    }
    const sd = variables.stat_data as Record<string, any>
    // Both MVU dialects target stat_data: classic `_.set(...)` and the `<JSONPatch>` form.
    const deltas = [
      ...(mvu.commands.length ? applyMvuCommands(sd, mvu.commands) : []),
      ...(mvu.patches.length ? applyJsonPatch(sd, mvu.patches) : [])
    ]
    variables.delta_data = deltas
    log(
      'info',
      `MVU — ${mvu.commands.length} cmd + ${mvu.patches.length} patch → ${deltas.length} delta(s) on stat_data`
    )
  }
  // Combat (Track Combat / P7): if the model signalled a fight, stash the cue on this
  // floor's vars so the chat can surface an "Enter Combat" affordance. The tag itself is
  // stripped at view time (responseView), never baked into storage.
  //
  // The cue is a PER-TURN signal, not carried state: `workingVars` is a deep clone of the previous
  // floor's vars (genContext), so a cue set on an earlier turn rides forward forever and the chat's
  // "Enter Combat/Duel" banner never clears once shown (owner report: kept chatting instead of
  // fighting → banner stuck). Drop any inherited cue first, then re-stash only if THIS turn emitted one.
  delete variables.combat_cue
  const combatCue = parseCombatStart(parsed.text).cue
  if (combatCue) {
    const bundleMode = (getRpExt(ctx.card)?.combat as { mode?: 'grid' | 'duel' } | undefined)?.mode
    combatCue.mode = bundleMode === 'duel' ? 'duel' : 'grid'
    variables.combat_cue = combatCue
  }
  return variables
}
