// Combat core — World-Card `combat` bundle → playable encounter (Track Combat / P7).
//
// Pure module. A card ships a `combat` bundle (templates, ability catalog, bestiary,
// maps, hook scripts); `buildEncounter` turns that bundle + the AI's <rpt-combat-start>
// cue into the EncounterSetup the engine/service consumes. Bundle STRUCTURE fields are
// snake_case (card JSON convention: enemy_controller / cell_ft / party_spawns); ability
// and stat-block internals are the engine's own camelCase shapes (toHit / maxHp), since
// they flow straight through. See docs/combat-system-design.md §10.

import type { AbilityDef, Combatant, Coord, GridSpec, Side, StatBlock } from './types'
import type { HookName } from './hooks'

export interface BundleStatBlock {
  hp: number
  maxHp?: number
  ac?: number
  speed?: number
  mods?: Record<string, number>
  abilities?: string[]
  resist?: string[]
  vulnerable?: string[]
}

export interface BestiaryEntry {
  id: string
  name?: string
  tier?: string
  block: BundleStatBlock
  abilities?: string[]
  controller?: 'weighted' | 'ai'
}

export interface PartyTemplate {
  id: string
  name?: string
  block: BundleStatBlock
  abilities?: string[]
}

export interface CombatMap {
  id: string
  w: number
  h: number
  cell_ft?: number
  party_spawns?: Coord[]
  enemy_spawns?: Coord[]
}

/** MVU-import config: where the player + party + per-character stat paths live in a card's
 *  `stat_data`. Consumed by buildEncounterFromMvu (the alternative to bundle `party` templates).
 *  Snake_case like the other card-authored bundle-structure fields; the domain VALUES
 *  (e.g. "主角", "关系列表", "属性") are the card's own, supplied here. */
export interface StatMap {
  /** stat_data key holding the player character, e.g. "主角". */
  player: string
  /** where companions live + how to filter who's present, e.g. { from:"关系列表", filter:{ 在场:true } }. */
  party?: { from: string; filter?: Record<string, unknown> }
  /** logical field → path inside a character object, e.g. { hp:"生命值", maxHp:"生命值上限", 属性:"属性" }. */
  paths?: Record<string, string>
}

/** Pure-DATA derivation tables for an MVU-imported encounter — no formulas/eval; the resolver
 *  code applies these. Record KEYS are the card's domain values (生命层级 "1".."7"; damage types
 *  物理/能量/精神/真实). See docs/combat-poem-of-destiny-expansion.md. */
export interface DeriveConfig {
  /** attribute key order, e.g. ['力量','敏捷','体质','智力','精神']. */
  attributes?: string[]
  /** 生命层级 → 战斗层级系数 (damage scaling). */
  tier_coefficient?: Record<string, number>
  /** 生命层级 → HP multiplier (资源推演). */
  hp_multiplier?: Record<string, number>
  /** 生命层级 → MP/SP multiplier. */
  mp_sp_multiplier?: Record<string, number>
  /** [threshold, multiplier] pairs, descending — the 评级 (hit-rating) table. */
  rating_tiers?: [number, number][]
  /** damage-type → per-point mitigation fraction (物理/能量/精神/真实). */
  attr_mitigation?: Record<string, number>
  /** 装备减免 constant in `防御/(防御+const)` (default 2000). */
  defense_constant?: number
}

export interface CombatBundle {
  ruleset?: string
  grid?: { type?: string; cell_ft?: number }
  enemy_controller?: 'weighted' | 'ai'
  abilities?: AbilityDef[]
  bestiary?: BestiaryEntry[]
  party?: PartyTemplate[]
  maps?: CombatMap[]
  scripts?: Partial<Record<HookName, string>>
  skin?: Record<string, unknown>
  /** MVU-import (BP2+): build the encounter party from `stat_data` instead of `party` templates. */
  stat_map?: StatMap
  derive?: DeriveConfig
}

export interface BuiltEncounter {
  seed?: number
  grid: GridSpec
  combatants: Combatant[]
  abilities: Record<string, AbilityDef>
  hooks: Partial<Record<HookName, string>>
}

const normalizeBlock = (b: BundleStatBlock, fallbackAbilities?: string[]): StatBlock => ({
  hp: b.hp,
  maxHp: b.maxHp ?? b.hp,
  ac: b.ac ?? 10,
  speed: b.speed ?? 6,
  mods: (b.mods ?? {}) as StatBlock['mods'],
  abilities: b.abilities ?? fallbackAbilities ?? [],
  conditions: [],
  resist: b.resist,
  vulnerable: b.vulnerable
})

/**
 * Parse the cue's freeform enemy list into `{ ref, count }` specs. Handles separators
 * `; , 、 ；`, an `xN`/`×N` count, and a parenthetical tier note that's stripped from
 * the ref. e.g. "哥布林 x3 (弱); 头目" → [{ref:'哥布林',count:3},{ref:'头目',count:1}].
 */
export const parseEnemyCue = (text: string): { ref: string; count: number }[] =>
  (text || '')
    .split(/[;,；、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const cm = part.match(/[x×]\s*(\d+)/i)
      const count = cm ? Math.max(1, parseInt(cm[1], 10)) : 1
      const ref = part
        .replace(/[x×]\s*\d+/i, '')
        .replace(/[(（][^)）]*[)）]/g, '')
        .trim()
      return { ref, count }
    })
    .filter((e) => e.ref)

const findBestiary = (bundle: CombatBundle, ref: string): BestiaryEntry | undefined => {
  const n = ref.toLowerCase()
  return bundle.bestiary?.find(
    (b) =>
      b.id === ref ||
      b.id.toLowerCase() === n ||
      (b.name ? b.name.toLowerCase() === n || b.name.toLowerCase().includes(n) : false)
  )
}

/**
 * Build a playable encounter from a card's combat bundle and the AI's combat-start cue.
 * Party members come from `bundle.party`; enemies are resolved from the cue against
 * `bundle.bestiary` (unknown refs are skipped). Spawns use the map's declared positions
 * or fall back to opposite edges. Returns the EncounterSetup-shaped object the service
 * stores; the seed is left to the caller unless provided.
 */
export const buildEncounter = (
  bundle: CombatBundle,
  cue?: { enemies?: string; map?: string } | null,
  opts: { seed?: number } = {}
): BuiltEncounter => {
  const mapDef = (cue?.map && bundle.maps?.find((m) => m.id === cue.map)) || bundle.maps?.[0]
  const grid: GridSpec = {
    w: mapDef?.w ?? 10,
    h: mapDef?.h ?? 8,
    cellFt: mapDef?.cell_ft ?? bundle.grid?.cell_ft ?? 5
  }

  const combatants: Combatant[] = []
  ;(bundle.party ?? []).forEach((p, i) => {
    combatants.push({
      id: p.id,
      side: 'party',
      name: p.name ?? p.id,
      pos: mapDef?.party_spawns?.[i] ?? [0, Math.min(i, grid.h - 1)],
      block: normalizeBlock(p.block, p.abilities)
    })
  })

  const ctrl = bundle.enemy_controller ?? 'weighted'
  let placed = 0
  for (const spec of parseEnemyCue(cue?.enemies ?? '')) {
    const ent = findBestiary(bundle, spec.ref)
    if (!ent) continue
    for (let n = 0; n < spec.count; n++) {
      combatants.push({
        id: spec.count > 1 ? `${ent.id}-${n + 1}` : ent.id,
        side: 'enemy',
        name: ent.name ?? ent.id,
        pos: mapDef?.enemy_spawns?.[placed] ?? [grid.w - 1, Math.min(placed, grid.h - 1)],
        block: normalizeBlock(ent.block, ent.abilities),
        controller: ent.controller ?? ctrl
      })
      placed++
    }
  }

  const abilities: Record<string, AbilityDef> = {}
  for (const a of bundle.abilities ?? []) abilities[a.id] = a

  return { seed: opts.seed, grid, combatants, abilities, hooks: bundle.scripts ?? {} }
}

// --- MVU-driven encounter import (BP2). The card's combat numbers already live in its
// stat_data; a `CombatSystem` adapter (e.g. systems/poemD20) interprets a character object
// into a combatant, and this generic plumbing walks `stat_map` to find the party + place them. ---

export type ItemKind = 'skill' | 'equip'

/** Context handed to a CombatSystem when it builds one combatant from a stat_data character. */
export interface MvuCharCtx {
  id: string
  name: string
  side: Side
  /** stat_map.paths — logical field (SDK) → path inside the character object (card). */
  paths: Record<string, string>
  derive?: DeriveConfig
}

/** What a CombatSystem returns for one character: a native StatBlock, the card-specific `ext`
 *  bag, and the abilities (catalog entries) that character contributes. */
export interface BuiltCombatant {
  block: StatBlock
  ext: Record<string, unknown>
  abilities: AbilityDef[]
}

/** The card-side combat adapter. The generic engine owns traversal/placement/resolution flow;
 *  the system owns interpretation of the card's own stat grammar (and, from BP3, resolution). */
export interface CombatSystem {
  /** Parse one 技能/装备 MVU object → opaque combat data for `AbilityDef.ext`. */
  parseItem(item: unknown, kind: ItemKind): Record<string, unknown>
  /** Turn a character object from stat_data into a combatant + its abilities. */
  buildCombatant(char: unknown, ctx: MvuCharCtx): BuiltCombatant
}

const matchesFilter = (ch: unknown, filter?: Record<string, unknown>): boolean => {
  if (!filter) return true
  if (!ch || typeof ch !== 'object') return false
  const rec = ch as Record<string, unknown>
  return Object.entries(filter).every(([k, v]) => rec[k] === v)
}

/**
 * Build a playable encounter's **party** from MVU `stat_data` via a `stat_map` + a `CombatSystem`.
 * The player is `stat_data[stat_map.player]`; companions come from `stat_map.party.from`
 * (a record keyed by name) filtered by `stat_map.party.filter` (e.g. `{ 在场: true }`). Each
 * character is interpreted by `system.buildCombatant`. Enemies are NOT built here — they're
 * generated by the AI at combat entry (BP4) and added separately. Party spawns down the left edge.
 */
export const buildEncounterFromMvu = (
  statData: Record<string, unknown>,
  statMap: StatMap,
  system: CombatSystem,
  opts: { derive?: DeriveConfig; grid?: GridSpec; seed?: number } = {}
): BuiltEncounter => {
  const paths = statMap.paths ?? {}
  const grid: GridSpec = opts.grid ?? { w: 10, h: 8, cellFt: 5 }
  const combatants: Combatant[] = []
  const abilities: Record<string, AbilityDef> = {}
  let idx = 0

  const place = (char: unknown, id: string, name: string): void => {
    const built = system.buildCombatant(char, {
      id,
      name,
      side: 'party',
      paths,
      derive: opts.derive
    })
    combatants.push({
      id,
      side: 'party',
      name,
      pos: [0, Math.min(idx, grid.h - 1)],
      block: built.block,
      ext: built.ext
    })
    for (const a of built.abilities) abilities[a.id] = a
    idx++
  }

  const player = statData[statMap.player]
  if (player && typeof player === 'object') {
    const nm = (player as Record<string, unknown>).姓名
    place(player, statMap.player, typeof nm === 'string' && nm ? nm : statMap.player)
  }

  if (statMap.party) {
    const rec = statData[statMap.party.from]
    if (rec && typeof rec === 'object') {
      for (const [name, ch] of Object.entries(rec as Record<string, unknown>)) {
        if (!matchesFilter(ch, statMap.party.filter)) continue
        place(ch, name, name)
      }
    }
  }

  return { seed: opts.seed, grid, combatants, abilities, hooks: {} }
}
