// Combat core — shared data model (Track Combat / P1).
//
// Pure module: imported by main, preload, AND renderer, so it must NOT import
// from src/main or src/renderer (no electron/window/fs/sqlite). It is the single
// source of truth for the combat state shape that the engine mutates and the
// CombatView renders. See docs/combat-system-design.md §2 (STATE/LOGIC/VIEW).

/** The six d20 ability scores; modifiers are stored on a combatant's StatBlock. */
export type Ability = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'

export const ABILITIES: readonly Ability[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

/** Which roster a combatant belongs to. Party is player-commanded by default. */
export type Side = 'party' | 'enemy'

/** [x, y] grid cell. Origin top-left; x increases right, y increases down. */
export type Coord = [number, number]

/** Per-cell terrain. Absent tiles default to fully open (see `tileAt`). */
export interface TileFlags {
  passable: boolean
  /** blocks line-of-sight (used by the deferred LoS/cover phase). */
  blocksLoS: boolean
  /** entering this cell costs 2 movement instead of 1. */
  difficult: boolean
  /** standing here triggers a hazard effect (engine/card-defined). */
  hazard: boolean
}

/** The battlefield. `tiles` is row-major (`tiles[y * w + x]`); omit for all-open. */
export interface GridSpec {
  w: number
  h: number
  /** in-world feet per cell (display/flavor only; movement is in cells). */
  cellFt: number
  tiles?: TileFlags[]
}

/** A status effect with a remaining duration in rounds (-1 = until removed). */
export interface Condition {
  id: string
  duration: number
}

/** A combatant's combat-only stats. Built fresh at encounter start (design §7) —
 *  never the persistent world stats. */
export interface StatBlock {
  hp: number
  maxHp: number
  ac: number
  /** movement allowance in cells per turn. */
  speed: number
  /** ability modifiers, e.g. { STR: 3, DEX: 1 }; missing = 0. */
  mods: Partial<Record<Ability, number>>
  /** ability ids into the encounter's ability catalog. */
  abilities: string[]
  conditions: Condition[]
  /** damage types taken at half / double. */
  resist?: string[]
  vulnerable?: string[]
}

/** How a combatant's turn is decided. `player` = manual; the rest are automated. */
export type Controller = 'player' | 'weighted' | 'ai'

export interface Combatant {
  id: string
  side: Side
  name: string
  pos: Coord
  /** N×N footprint in cells (1 = single cell). Occupancy beyond 1 is a later phase. */
  size?: number
  block: StatBlock
  /** rolled initiative (set by the engine's rollInitiative). */
  initiative?: number
  controller?: Controller
  /** Card-system extension bag (e.g. the 命定之诗 parsed 五维 + CardCombat). Opaque to the
   *  native engine; only a card's resolver reads it. See docs/combat-poem-of-destiny-expansion.md. */
  ext?: Record<string, unknown>
}

/** Area-of-effect footprint an ability projects onto the grid. */
export type AoeShape =
  | { kind: 'self' }
  | { kind: 'burst'; r: number }
  | { kind: 'aura'; r: number }
  | { kind: 'line'; len: number; width?: number }
  | { kind: 'cone'; len: number }

/** A saving throw the target rolls against an ability-based DC. */
export interface SaveSpec {
  ability: Ability
  dc: number
  /** fraction of damage taken on a successful save (0.5 = half, 0 = none). */
  onSuccess?: number
}

/** A usable ability/attack. Resolved natively unless a card overrides the hook. */
export interface AbilityDef {
  id: string
  name: string
  /** max distance (cells) from the actor to the template origin. */
  range: number
  shape: AoeShape
  /** ability for the attack roll; null = no attack roll (e.g. save-based or auto-hit). */
  toHit: Ability | null
  /** save the target rolls, if any. */
  save?: SaveSpec | null
  /** damage dice expression, e.g. '2d6+STR'. Empty/absent = no damage. */
  damage?: string
  damageType?: string
  /** conditions applied to targets on hit / failed save. */
  effects?: Condition[]
  /** which per-turn slot this consumes (action economy). Default: `toHit ? 'attack' : 'action'`. */
  cost?: 'attack' | 'action'
  /** require clear line-of-sight from the actor to the target (e.g. ranged shots). Lobbed
   *  AoE (fireball over a wall) leaves this false. Default false. */
  requiresLoS?: boolean
  /** Card-system extension bag (e.g. parsed 威力/攻击/防御/关联属性 for the 命定之诗 resolver).
   *  Opaque to the native resolver; only a card's resolver reads it. */
  ext?: Record<string, unknown>
}

export type ActionKind = 'move' | 'ability' | 'end' | 'improvise'

/** A single requested action. The engine validates legality before applying it. */
export interface Action {
  kind: ActionKind
  /** acting combatant id. */
  actor: string
  /** move: destination cell. */
  to?: Coord
  /** ability: which ability + where it is aimed. */
  abilityId?: string
  targetCell?: Coord
  /** explicit target ids (else derived from the template's covered cells). */
  targetIds?: string[]
  /** improvise: the player's free-text action for AI adjudication. */
  prose?: string
}

/** A resolved fact appended to the combat log; `delta` is the machine-readable form. */
export interface CombatEvent {
  text: string
  kind:
    | 'attack'
    | 'miss'
    | 'damage'
    | 'heal'
    | 'save'
    | 'move'
    | 'condition'
    | 'death'
    | 'turn'
    | 'info'
  delta?: Record<string, unknown>
}

/** 'active' while the fight is ongoing; otherwise the side that won. */
export type CombatStatus = 'active' | 'party' | 'enemy'

/** The entire ephemeral encounter. Persisted as one JSON blob per chat (the engine
 *  is pure over this whole object). `seed` is stored so a replay reproduces the fight. */
export interface CombatState {
  seed: number
  /** monotonic counter of randomness-consuming steps. The per-action RNG is seeded
   *  from (seed, rngCursor), so replay is reproducible AND a fight resumes
   *  deterministically after an app restart without persisting live RNG state. */
  rngCursor: number
  grid: GridSpec
  combatants: Combatant[]
  /** combatant ids in initiative order. */
  initiative: string[]
  /** index into `initiative` of the active combatant. */
  turnIndex: number
  round: number
  log: CombatEvent[]
  status: CombatStatus
  /** The active combatant's per-turn action economy: one movement, one attack, one action.
   *  Reset at the start of each turn. Optional so older/foreign states default to all-fresh. */
  turnUsed?: TurnBudget
}

/** Per-turn allowance: each combatant gets one movement, one attack, and one action. */
export interface TurnBudget {
  moved: boolean
  attack: boolean
  action: boolean
}
