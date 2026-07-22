import { parseCombatStart, parseContent, stripThinking, RPEvent } from '../parsers/contentParser'
import { applyJsonPatch, applyMvuCommands, parseMvuCommands } from '../parsers/mvuParser'
import { isWritableVariablesPath } from '../../shared/agentRuntime/paths'

/**
 * The model fold — everything ONE model turn writes onto the running variables.
 *
 * There is exactly one implementation, deliberately: the live turn (`generation/foldState`) and
 * Forward Replay (`agentRuntime/floorState/FloorState`) used to carry separate copies that had
 * silently drifted (replay never cleared `combat_cue`, so a replayed floor resurrected an
 * "Enter Combat" banner that could never clear again). Both call this now.
 *
 * Kept a LEAF on purpose — it may only import the parsers and the shared path guard, never
 * `GenContext`, `floorService`, `FloorState`, or anything under `generation/`, so no cycle forms.
 */
export interface ModelFoldInput {
  /** Raw floor response. The fold strips thinking (and rpt-event tags) itself. */
  response: string
  /** This turn's parsed rpt-events (persisted on the floor; replay re-reads them from there). */
  events: RPEvent[]
  /** Which combat system a `<rpt-combat-start>` cue opens; stamped from the card bundle. */
  combatMode?: 'grid' | 'duel'
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Resolve `{ parent, key }` for a FULL `variables.…` dot path (the `variables` root segment is
 * dropped — the object passed in IS `variables`). With `create`, missing/non-object intermediates
 * are replaced by fresh objects; without it, a missing intermediate yields `undefined`.
 */
export const variablesParentAt = (
  variables: Record<string, unknown>,
  path: string,
  create: boolean
): { parent: Record<string, unknown>; key: string } | undefined => {
  const segments = path.split('.').slice(1)
  let parent = variables
  for (const segment of segments.slice(0, -1)) {
    const next = parent[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      if (!create) return undefined
      parent[segment] = {}
    }
    parent = parent[segment] as Record<string, unknown>
  }
  return { parent, key: segments[segments.length - 1] }
}

/**
 * Fold this turn's rpt-events + MVU commands/patches onto `variables`, then re-derive the
 * combat-start cue. Mutates `variables` IN PLACE (the live path folds onto `ctx.workingVars` by
 * reference). Order — events → MVU → combat cue — is the live path's and is load-bearing.
 *
 * `combat_cue` is a PER-TURN signal, never carried state: both callers seed `variables` from the
 * previous floor, so an inherited cue is dropped first and re-stashed only if THIS floor's
 * response emitted one.
 */
export const foldModelTurn = (variables: Record<string, unknown>, input: ModelFoldInput): void => {
  for (const event of input.events) {
    if (event.type !== 'state' || !event.path) continue
    const rootedPath = event.path.startsWith('variables.') ? event.path : `variables.${event.path}`
    if (!isWritableVariablesPath(rootedPath)) continue
    const target = variablesParentAt(variables, rootedPath, true)!
    const current = target.parent[target.key]
    if (event.action === 'add') {
      target.parent[target.key] = (typeof current === 'number' ? current : 0) + Number(event.value)
    } else if (event.action === 'remove') {
      target.parent[target.key] = (typeof current === 'number' ? current : 0) - Number(event.value)
    } else {
      target.parent[target.key] = cloneJson(event.value)
    }
  }

  // The narrative with reasoning and rpt-event tags removed — what both MVU extraction and the
  // combat-cue scan read (the FULL response is what gets stored, never this).
  const text = parseContent(stripThinking(input.response)).text

  const mvu = parseMvuCommands(text)
  if (mvu.commands.length || mvu.patches.length) {
    const stat =
      variables.stat_data && typeof variables.stat_data === 'object'
        ? (variables.stat_data as Record<string, unknown>)
        : {}
    variables.stat_data = stat
    // Both MVU dialects target stat_data: classic `_.set(...)` and the `<JSONPatch>` form.
    variables.delta_data = [
      ...(mvu.commands.length ? applyMvuCommands(stat, mvu.commands) : []),
      ...(mvu.patches.length ? applyJsonPatch(stat, mvu.patches) : [])
    ]
  }

  delete variables.combat_cue
  const cue = parseCombatStart(text).cue
  if (cue) {
    cue.mode = input.combatMode === 'duel' ? 'duel' : 'grid'
    variables.combat_cue = cue
  }
}
