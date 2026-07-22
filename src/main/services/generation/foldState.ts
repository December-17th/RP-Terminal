import { parseContent, RPEvent } from '../../parsers/contentParser'
import { parseMvuCommands } from '../../parsers/mvuParser'
import { log } from '../logService'
import { getRpExt } from '../../types/character'
import { foldModelTurn } from '../floorFold'
import { GenContext } from './types'

/** Apply a single rpt-event to a mutable variables object (nested path set/add/remove). Moved
 *  verbatim out of generationService.ts (Phase 2b-1a); re-exported there so existing consumers
 *  (test/generationService.test.ts) keep resolving the same import.
 *
 *  NOT the fold's implementation any more — `foldModelTurn` (services/floorFold.ts) applies events
 *  itself, rooted at `variables.` and filtered through `isWritableVariablesPath`. Kept only for the
 *  existing `generationService` re-export. */
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
 * The live turn's entry into the model fold. The fold itself lives in `services/floorFold.ts`
 * (`foldModelTurn`) — the ONE implementation, shared with Forward Replay
 * (`agentRuntime/floorState/FloorState`) so the two can no longer drift.
 *
 * This wrapper keeps the turn-path contracts around it: the floor-0 `floorStateBaseline` capture,
 * the card-derived combat mode, the MVU log line, and the mutation target — the returned object IS
 * `ctx.workingVars` (folded in place, by reference).
 *
 * `parsed` and `mvu` are the caller's parse of `raw` (parseResponse); the fold re-derives both from
 * `raw` itself, so they are used here only for the events list and the log line.
 */
export const foldState = (
  ctx: GenContext,
  parsed: ReturnType<typeof parseContent>,
  mvu: ReturnType<typeof parseMvuCommands>,
  raw: string
): Record<string, any> => {
  // workingVars already holds any template setvar() mutations from this build;
  // apply this turn's rpt-events on top, then persist global vars.
  const variables = ctx.workingVars
  if (ctx.chat.floor_count === 0 && !ctx.floorStateBaseline) {
    ctx.floorStateBaseline = JSON.parse(JSON.stringify(variables)) as Record<string, unknown>
  }
  // Combat (Track Combat / P7): which system a `<rpt-combat-start>` cue opens is a property of the
  // card bundle, which only the live path can see — replay is handed the resolved mode instead.
  const bundleMode = (getRpExt(ctx.card)?.combat as { mode?: 'grid' | 'duel' } | undefined)?.mode
  foldModelTurn(variables, {
    response: raw,
    events: parsed.events,
    combatMode: bundleMode === 'duel' ? 'duel' : 'grid'
  })
  if (mvu.commands.length || mvu.patches.length) {
    const deltas = Array.isArray(variables.delta_data) ? variables.delta_data.length : 0
    log(
      'info',
      `MVU — ${mvu.commands.length} cmd + ${mvu.patches.length} patch → ${deltas} delta(s) on stat_data`
    )
  }
  return variables
}
