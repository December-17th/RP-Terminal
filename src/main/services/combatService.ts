// Combat — main-process service (Track Combat / P4).
//
// Bridges the pure engine (src/shared/combat) to the app: SQLite persistence of the
// ephemeral encounter, the card-override hook bridge backed by the quickjs sandbox,
// and turn orchestration (player action / enemy turn / end turn). The orchestration
// is kept in PURE functions over an in-memory EncounterRecord (createEncounter /
// playerAction / enemyTurn / summarizeOutcome / makeRunHook) so it's unit-testable
// without a database; the exported *Encounter functions are thin load→pure→save
// wrappers the IPC layer calls. See docs/combat-system-design.md §5/§7.

import { getDb } from './db'
import { runSandbox } from './sandboxService'
import { log } from './logService'
import {
  advanceTurn,
  applyAction,
  rollInitiative,
  type EngineCtx
} from '../../shared/combat/engine'
import { weightedPolicy } from '../../shared/combat/policy'
import type { HookName, HookResult, RunHook } from '../../shared/combat/hooks'
import type {
  AbilityDef,
  Action,
  Combatant,
  CombatEvent,
  CombatState,
  CombatStatus,
  GridSpec,
  Side
} from '../../shared/combat/types'

/** The serialized unit stored per chat: the live state plus the encounter's rules
 *  (ability catalog + card hook scripts), so a fight is self-contained / reproducible. */
export interface EncounterRecord {
  state: CombatState
  abilities: Record<string, AbilityDef>
  hooks: Partial<Record<HookName, string>>
}

/** What a caller supplies to begin a fight (assembled from the card bundle, P6/P7). */
export interface EncounterSetup {
  seed?: number
  grid: GridSpec
  combatants: Combatant[]
  abilities?: Record<string, AbilityDef>
  /** card-authored override scripts keyed by hook name (run sandboxed). */
  hooks?: Partial<Record<HookName, string>>
}

export interface OutcomeCombatant {
  id: string
  name: string
  side: Side
  hp: number
  maxHp: number
  alive: boolean
}

/** The structured result handed to the AI for narration + the stat_data fold-out (P6). */
export interface CombatOutcome {
  winner: CombatStatus
  rounds: number
  combatants: OutcomeCombatant[]
  log: CombatEvent[]
}

/** A pluggable enemy decision source (the `ai` controller, wired in P6); when absent
 *  the native weighted policy decides. */
export type ChooseEnemyAction = (state: CombatState, enemyId: string) => Promise<Action>

// --- pure orchestration (no DB) -------------------------------------------------

/** Build a `RunHook` that runs a card's override scripts in the quickjs sandbox.
 *  Returns null for any hook the card didn't define (→ native resolution). */
export const makeRunHook = (hooks: Partial<Record<HookName, string>>): RunHook => {
  return async (name, input, seed) => {
    const code = hooks[name]
    if (!code) return null
    const res = await runSandbox({ code, input, seed })
    if (!res.ok) {
      log('error', `combat hook "${name}" failed`, res.error ?? '')
      return null
    }
    const out = (res.result ?? {}) as HookResult
    const events = out.events ?? (res.events as CombatEvent[] | undefined) ?? []
    return { state: out.state, events }
  }
}

const ctxFor = (record: EncounterRecord): EngineCtx => ({
  abilities: record.abilities,
  runHook: Object.keys(record.hooks).length ? makeRunHook(record.hooks) : undefined
})

/** Seed a fresh encounter: instantiate the state, roll initiative, open the log. */
export const createEncounter = (setup: EncounterSetup): EncounterRecord => {
  const seed = (setup.seed ?? Date.now()) >>> 0
  const base: CombatState = {
    seed,
    rngCursor: 0,
    grid: setup.grid,
    combatants: setup.combatants,
    initiative: [],
    turnIndex: 0,
    round: 1,
    log: [],
    status: 'active'
  }
  const state = rollInitiative(base)
  state.log = [{ kind: 'info', text: 'Combat begins.', delta: { round: 1 } }]
  return { state, abilities: setup.abilities ?? {}, hooks: setup.hooks ?? {} }
}

/** Apply one player-issued action (does not advance the turn — the caller ends it). */
export const playerAction = async (
  record: EncounterRecord,
  action: Action
): Promise<{ record: EncounterRecord; events: CombatEvent[] }> => {
  const { state, events } = await applyAction(record.state, action, ctxFor(record))
  return { record: { ...record, state }, events }
}

/** Advance to the next living combatant's turn. */
export const nextTurn = (record: EncounterRecord): EncounterRecord => ({
  ...record,
  state: advanceTurn(record.state)
})

/**
 * Resolve the current (automated) combatant's turn: pick an action via the injected
 * chooser or the native weighted policy, apply it, then advance the turn. Lean v1 is
 * one action per turn (attack OR move OR end), not move-then-attack.
 */
export const enemyTurn = async (
  record: EncounterRecord,
  choose?: ChooseEnemyAction
): Promise<{ record: EncounterRecord; events: CombatEvent[] }> => {
  const actorId = record.state.initiative[record.state.turnIndex]
  const actor = record.state.combatants.find((c) => c.id === actorId)
  if (!actor) return { record, events: [] }
  const action = choose
    ? await choose(record.state, actorId)
    : weightedPolicy(record.state, actorId, record.abilities)
  const res = await applyAction(record.state, action, ctxFor(record))
  return { record: { ...record, state: advanceTurn(res.state) }, events: res.events }
}

/** Summarize a (possibly mid-) fight into the outcome the AI narrates + folds out. */
export const summarizeOutcome = (state: CombatState): CombatOutcome => ({
  winner: state.status,
  rounds: state.round,
  combatants: state.combatants.map((c) => ({
    id: c.id,
    name: c.name,
    side: c.side,
    hp: c.block.hp,
    maxHp: c.block.maxHp,
    alive: c.block.hp > 0
  })),
  log: state.log
})

// --- DB-backed wrappers (called by combatIpc) -----------------------------------

const readRecord = (chatId: string): EncounterRecord | null => {
  const row = getDb()
    .prepare('SELECT data FROM combat_encounters WHERE chat_id = ?')
    .get(chatId) as { data: string } | undefined
  return row ? (JSON.parse(row.data) as EncounterRecord) : null
}

const writeRecord = (chatId: string, record: EncounterRecord): void => {
  getDb()
    .prepare(
      `INSERT INTO combat_encounters (chat_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
    .run(chatId, JSON.stringify(record), new Date().toISOString())
}

const requireRecord = (chatId: string): EncounterRecord => {
  const record = readRecord(chatId)
  if (!record) throw new Error('No active combat encounter for this chat')
  return record
}

export const startEncounter = (chatId: string, setup: EncounterSetup): CombatState => {
  const record = createEncounter(setup)
  writeRecord(chatId, record)
  return record.state
}

/** The renderer view-model: the live state + the ability catalog (to render the
 *  action bar / ranges). Hook scripts are intentionally NOT exposed to the renderer. */
export const getEncounter = (
  chatId: string
): { state: CombatState; abilities: Record<string, AbilityDef> } | null => {
  const record = readRecord(chatId)
  return record ? { state: record.state, abilities: record.abilities } : null
}

export const applyPlayerAction = async (
  chatId: string,
  action: Action
): Promise<{ state: CombatState; events: CombatEvent[] }> => {
  const res = await playerAction(requireRecord(chatId), action)
  writeRecord(chatId, res.record)
  return { state: res.record.state, events: res.events }
}

export const endTurn = (chatId: string): CombatState => {
  const next = nextTurn(requireRecord(chatId))
  writeRecord(chatId, next)
  return next.state
}

export const runEnemyTurn = async (
  chatId: string,
  choose?: ChooseEnemyAction
): Promise<{ state: CombatState; events: CombatEvent[] }> => {
  const res = await enemyTurn(requireRecord(chatId), choose)
  writeRecord(chatId, res.record)
  return { state: res.record.state, events: res.events }
}

export const endEncounter = (chatId: string): CombatOutcome | null => {
  const record = readRecord(chatId)
  if (!record) return null
  const outcome = summarizeOutcome(record.state)
  getDb().prepare('DELETE FROM combat_encounters WHERE chat_id = ?').run(chatId)
  return outcome
}

export const clearEncounter = (chatId: string): void => {
  getDb().prepare('DELETE FROM combat_encounters WHERE chat_id = ?').run(chatId)
}
