// Combat — main-process service (Track Combat / P4).
//
// Bridges the pure engine (src/shared/combat) to the app: SQLite persistence of the
// ephemeral encounter, the card-override hook bridge backed by the quickjs sandbox,
// and turn orchestration (player action / enemy turn / end turn). The orchestration
// is kept in PURE functions over an in-memory EncounterRecord (createEncounter /
// playerAction / enemyTurn / summarizeOutcome / makeRunHook) so it's unit-testable
// without a database; the exported *Encounter functions are thin load→pure→save
// wrappers the IPC layer calls. See docs/combat-system-design.md §5/§7.

import { getSessionDbByChat } from './sessionDbService'
import { runSandbox } from './sandboxService'
import { generateRaw } from './generation/rawGenerate'
import { getCharacter } from './characterService'
import { getChat } from './chatService'
import { getAllFloors } from './floorService'
import { getSettings } from './settingsService'
import { log } from './logService'
import {
  narrationConfig,
  narrationSchemaPrompt,
  writeNarrationToChat,
  combatLogText
} from './narrationService'
import { getRpExt } from '../types/character'
import {
  buildEncounter,
  buildEncounterFromMvu,
  type CombatBundle
} from '../../shared/combat/bundle'
import type { DeriveConfig } from '../../shared/combat/bundle'
import { getSystem, poemD20System } from '../../shared/combat/systems'
import { makeRng } from '../../shared/combat/dice'
import { clone } from '../../shared/objectPath'
import {
  advanceTurn,
  applyAction,
  checkVictory,
  rollInitiative,
  type EngineCtx
} from '../../shared/combat/engine'
import { weightedPolicy } from '../../shared/combat/policy'
import {
  applyCombatResult,
  buildAdjudicationPrompt,
  buildEnemyPrompt,
  buildNarrationPrompt,
  parseCombatResult,
  parseEnemyAction
} from '../../shared/combat/serialize'
import type { HookName, HookResult, RunHook } from '../../shared/combat/hooks'
import type {
  AbilityDef,
  Action,
  Combatant,
  CombatEvent,
  CombatState,
  CombatStatus,
  Coord,
  GridSpec,
  Side,
  StatBlock,
  TileFlags
} from '../../shared/combat/types'

/** The serialized unit stored per chat: the live state plus the encounter's rules
 *  (ability catalog + card hook scripts), so a fight is self-contained / reproducible. */
export interface EncounterRecord {
  state: CombatState
  abilities: Record<string, AbilityDef>
  hooks: Partial<Record<HookName, string>>
  /** built-in combat system id (e.g. 'poemD20'); its resolver is injected as the RunHook. */
  system?: string
  /** the card's derivation tables, handed to the system resolver. */
  derive?: DeriveConfig
}

/** What a caller supplies to begin a fight (assembled from the card bundle, P6/P7). */
export interface EncounterSetup {
  seed?: number
  grid: GridSpec
  combatants: Combatant[]
  abilities?: Record<string, AbilityDef>
  /** card-authored override scripts keyed by hook name (run sandboxed). */
  hooks?: Partial<Record<HookName, string>>
  /** built-in combat system id whose resolver runs this fight (BP4). */
  system?: string
  derive?: DeriveConfig
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

/** Build the engine's RunHook for an encounter. When the encounter uses a built-in system with a
 *  resolver, its `resolveAction` runs first (deterministic, trusted); a `null` from it (move / end /
 *  improvise / out-of-range) falls through to the card's sandboxed scripts, then native resolution. */
const runHookFor = (record: EncounterRecord): RunHook | undefined => {
  const system = getSystem(record.system)
  const sandbox = Object.keys(record.hooks).length ? makeRunHook(record.hooks) : undefined
  if (!system?.resolveAction) return sandbox
  const resolve = system.resolveAction
  return async (name, input, seed) => {
    if (name === 'resolveAction' && input.action) {
      const res = resolve({
        state: input.state,
        action: input.action,
        abilities: record.abilities,
        rng: makeRng(seed),
        derive: record.derive
      })
      if (res) return res
    }
    return sandbox ? sandbox(name, input, seed) : null
  }
}

const ctxFor = (record: EncounterRecord): EngineCtx => ({
  abilities: record.abilities,
  runHook: runHookFor(record)
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
  return {
    state,
    abilities: setup.abilities ?? {},
    hooks: setup.hooks ?? {},
    system: setup.system,
    derive: setup.derive
  }
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
  const db = getSessionDbByChat(chatId)
  if (!db) return null
  const row = db.prepare('SELECT data FROM combat_encounters WHERE chat_id = ?').get(chatId) as
    | { data: string }
    | undefined
  return row ? (JSON.parse(row.data) as EncounterRecord) : null
}

const writeRecord = (chatId: string, record: EncounterRecord): void => {
  const db = getSessionDbByChat(chatId)
  if (!db) return
  db.prepare(
    `INSERT INTO combat_encounters (chat_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(chatId, JSON.stringify(record), new Date().toISOString())
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

/** The current floor's MVU `stat_data` (where the party's stats live), or {} if none. */
const currentStatData = (profileId: string, chatId: string): Record<string, unknown> => {
  const floors = getAllFloors(profileId, chatId)
  const vars = (floors[floors.length - 1]?.variables ?? {}) as Record<string, unknown>
  return (vars.stat_data as Record<string, unknown>) ?? {}
}

/**
 * Start a fight from the active world's `combat` bundle + the AI's combat-start cue
 * (the "Enter Combat" path): resolve the chat's card, build the encounter, and persist it.
 *
 * If the bundle carries a `stat_map`, the PARTY is imported from the current floor's MVU
 * `stat_data` via the 命定之诗 system (its 战斗协议 resolver runs the fight) and ENEMIES come from
 * the cue resolved against the bundle's `enemies` templates; otherwise the party/enemies come from
 * the bundle's `party`/`bestiary` templates. (Dynamic AI-generated enemy char_info is a future
 * enhancement.) Throws if the world ships no combat bundle.
 */
export const startFromCard = (
  profileId: string,
  chatId: string,
  cue?: { enemies?: string; map?: string; roster?: Array<Record<string, unknown>> } | null,
  seed?: number
): CombatState => {
  const chat = getChat(profileId, chatId)
  const card = chat ? getCharacter(profileId, chat.character_id) : null
  const bundle = (card ? getRpExt(card)?.combat : null) as CombatBundle | null | undefined
  if (!bundle) throw new Error('This world has no combat bundle')

  if (bundle.stat_map) {
    const built = buildEncounterFromMvu(
      currentStatData(profileId, chatId),
      bundle.stat_map,
      poemD20System,
      {
        derive: bundle.derive,
        seed,
        enemies: bundle.enemies,
        enemiesCue: cue?.enemies,
        roster: cue?.roster
      }
    )
    return startEncounter(chatId, {
      seed: built.seed,
      grid: built.grid,
      combatants: built.combatants,
      abilities: built.abilities,
      hooks: built.hooks,
      system: 'poemD20',
      derive: bundle.derive
    })
  }

  return startEncounter(chatId, buildEncounter(bundle, cue ?? null, { seed }))
}

/**
 * A hardcoded debug encounter (no card/AI needed): a 2-member party with melee/ranged/AoE
 * abilities vs 3 weighted goblins on a 10×8 map with a wall + difficult terrain. Lets the whole
 * combat loop be played in-app before the lorebook/AI side lands. See combat-system-design.md §15.
 */
export const mockEncounterSetup = (): EncounterSetup => {
  const abilities: Record<string, AbilityDef> = {
    strike: {
      id: 'strike',
      name: 'Strike',
      range: 1,
      shape: { kind: 'self' },
      toHit: 'STR',
      damage: '1d8+STR',
      damageType: 'slashing'
    },
    bolt: {
      id: 'bolt',
      name: 'Bolt',
      range: 6,
      shape: { kind: 'self' },
      toHit: 'DEX',
      damage: '1d8+DEX',
      damageType: 'piercing',
      requiresLoS: true
    },
    fireball: {
      id: 'fireball',
      name: 'Fireball',
      range: 8,
      shape: { kind: 'burst', r: 1 },
      toHit: null,
      save: { ability: 'DEX', dc: 13, onSuccess: 0.5 },
      damage: '3d6',
      damageType: 'fire',
      effects: [{ id: 'burning', duration: 2 }]
    }
  }
  const block = (over: Partial<StatBlock>): StatBlock => ({
    hp: 12,
    maxHp: 12,
    ac: 12,
    speed: 6,
    mods: {},
    abilities: [],
    conditions: [],
    ...over
  })
  const combatants: Combatant[] = [
    {
      id: 'maeve',
      side: 'party',
      name: 'Maeve',
      pos: [1, 2],
      block: block({
        hp: 20,
        maxHp: 20,
        ac: 15,
        mods: { STR: 3, DEX: 1 },
        abilities: ['strike', 'fireball']
      })
    },
    {
      id: 'kai',
      side: 'party',
      name: 'Kai',
      pos: [1, 5],
      block: block({ hp: 16, maxHp: 16, ac: 14, mods: { DEX: 3 }, abilities: ['bolt'] })
    },
    {
      id: 'gob1',
      side: 'enemy',
      name: 'Goblin',
      pos: [8, 1],
      block: block({ ac: 13, mods: { STR: 1 }, abilities: ['strike'] }),
      controller: 'weighted'
    },
    {
      id: 'gob2',
      side: 'enemy',
      name: 'Goblin',
      pos: [8, 3],
      block: block({ ac: 13, mods: { STR: 1 }, abilities: ['strike'] }),
      controller: 'weighted'
    },
    {
      id: 'gob3',
      side: 'enemy',
      name: 'Goblin',
      pos: [9, 5],
      block: block({ ac: 13, mods: { STR: 1 }, abilities: ['strike'] }),
      controller: 'weighted'
    }
  ]
  const tiles: TileFlags[] = Array.from({ length: 10 * 8 }, () => ({
    passable: true,
    blocksLoS: false,
    difficult: false,
    hazard: false
  }))
  for (const [x, y] of [
    [5, 3],
    [5, 4],
    [5, 5]
  ] as Coord[]) {
    tiles[y * 10 + x].passable = false
    tiles[y * 10 + x].blocksLoS = true
  }
  for (const [x, y] of [
    [4, 2],
    [6, 2]
  ] as Coord[])
    tiles[y * 10 + x].difficult = true
  const grid: GridSpec = { w: 10, h: 8, cellFt: 5, tiles }
  return { seed: 12345, grid, combatants, abilities }
}

export const startMockEncounter = (chatId: string): CombatState =>
  startEncounter(chatId, mockEncounterSetup())

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

/** Enemy decider backed by the model (the `ai` controller): ask for an `<rpt-action>`,
 *  falling back to the native weighted policy if the reply is unusable. Batches nothing
 *  yet — one call per automated combatant whose `controller` is `'ai'`. */
const aiChooser = (
  profileId: string,
  chatId: string,
  abilities: Record<string, AbilityDef>
): ChooseEnemyAction => {
  return async (state, enemyId) => {
    try {
      const reply = await generateRaw(profileId, chatId, {
        userInput: buildEnemyPrompt(state, enemyId)
      })
      return parseEnemyAction(reply, enemyId) ?? weightedPolicy(state, enemyId, abilities)
    } catch (err: any) {
      log(
        'error',
        'combat ai enemy decision failed; using weighted policy',
        err?.message || String(err)
      )
      return weightedPolicy(state, enemyId, abilities)
    }
  }
}

export const runEnemyTurn = async (
  profileId: string,
  chatId: string
): Promise<{ state: CombatState; events: CombatEvent[] }> => {
  const record = requireRecord(chatId)
  const actor = record.state.combatants.find(
    (c) => c.id === record.state.initiative[record.state.turnIndex]
  )
  const choose =
    actor?.controller === 'ai' ? aiChooser(profileId, chatId, record.abilities) : undefined
  const res = await enemyTurn(record, choose)
  writeRecord(chatId, res.record)
  return { state: res.record.state, events: res.events }
}

/**
 * The mid-fight referee (the Improvise path): build the adjudication prompt for the
 * current actor's freeform action, ask the model for `<rpt-combat-result>` ops, fold
 * them into the state, and persist. Degrades gracefully — an empty/unparseable reply
 * just logs the attempt and leaves the state otherwise unchanged.
 */
export const adjudicate = async (
  profileId: string,
  chatId: string,
  prose: string
): Promise<{ state: CombatState; events: CombatEvent[]; narration: string; ended: boolean }> => {
  const record = requireRecord(chatId)
  const actorId = record.state.initiative[record.state.turnIndex]
  const actor = record.state.combatants.find((c) => c.id === actorId)
  const reply = await generateRaw(profileId, chatId, {
    userInput: buildAdjudicationPrompt(
      record.state,
      actorId,
      prose,
      improviseSteer(profileId, chatId)
    ),
    maxChatHistory: 6
  })
  const { narration, ops, end } = parseCombatResult(reply)
  const next = clone(record.state)
  const logAdds: CombatEvent[] = [
    {
      kind: 'info',
      text: `${actor?.name ?? actorId} improvises: ${prose}`,
      delta: { actor: actorId, prose }
    },
    ...applyCombatResult(next, ops)
  ]
  if (narration) logAdds.push({ kind: 'info', text: narration })
  next.log = [...next.log, ...logAdds]
  next.status = checkVictory(next)

  // The freeform action concludes/escapes the fight → send the prose to the chat and exit combat.
  if (end) {
    writeNarrationToChat(profileId, chatId, narration || prose, combatLogText(next.log))
    clearEncounter(chatId)
    return { state: next, events: logAdds, narration, ended: true }
  }
  writeRecord(chatId, { ...record, state: next })
  return { state: next, events: logAdds, narration, ended: false }
}

/** The improvise/adjudication steering prompt: card `combat.improvise_prompt` > the user's
 *  `settings.combat.improvisePrompt` > none. Lets a world/user shape how freeform actions resolve. */
const improviseSteer = (profileId: string, chatId: string): string => {
  const chat = getChat(profileId, chatId)
  const card = chat ? getCharacter(profileId, chat.character_id) : null
  const bundle = (card ? getRpExt(card)?.combat : null) as
    | (CombatBundle & { improvise_prompt?: string })
    | null
    | undefined
  return (bundle?.improvise_prompt || getSettings(profileId).combat?.improvisePrompt || '').trim()
}

/**
 * End-of-combat narration (the "describe the fight fully" path): ask the model to narrate
 * the recorded log (steered by the card/user prompt) and land the prose in the chat as a new
 * floor (its user-side input is the fight log) — folding any `<UpdateVariable>` consequences into
 * that floor's `stat_data`. The renderer reloads floors after this resolves.
 */
export const narrate = async (
  profileId: string,
  chatId: string
): Promise<{ narration: string }> => {
  const record = requireRecord(chatId)
  const { extra } = narrationConfig(profileId, chatId)
  const prose = (
    await generateRaw(profileId, chatId, {
      userInput: buildNarrationPrompt(record.state, extra),
      systemPrompt: narrationSchemaPrompt(profileId, chatId),
      maxChatHistory: 6
    })
  ).trim()
  writeNarrationToChat(profileId, chatId, prose, combatLogText(record.state.log))
  return { narration: prose }
}

/** The narration prompt for the current encounter (steered by the card/user prompt), for a
 *  caller that prefers to feed it to the normal `generate` flow instead of `narrate`. */
export const narrationPrompt = (profileId: string, chatId: string): string | null => {
  const record = readRecord(chatId)
  if (!record) return null
  return buildNarrationPrompt(record.state, narrationConfig(profileId, chatId).extra)
}

export const endEncounter = (chatId: string): CombatOutcome | null => {
  const record = readRecord(chatId)
  if (!record) return null
  const outcome = summarizeOutcome(record.state)
  getSessionDbByChat(chatId)?.prepare('DELETE FROM combat_encounters WHERE chat_id = ?').run(chatId)
  return outcome
}

export const clearEncounter = (chatId: string): void => {
  getSessionDbByChat(chatId)?.prepare('DELETE FROM combat_encounters WHERE chat_id = ?').run(chatId)
}
