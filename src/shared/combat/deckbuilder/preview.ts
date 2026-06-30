//
// The generic, card-agnostic duel build-preview contract returned by the RPT host API
// getDuelPreview(). Neutral field names — the card's ruleset supplies values + display strings,
// the card UI applies labels/theming. See docs/superpowers/specs/2026-06-30-duel-build-preview-tab-design.md §2.

export interface DuelPreview {
  config: { energyPerTurn: number; handSize: number }
  lead: CombatantPreview
  party: CombatantPreview[]
}

export interface CombatantPreview {
  id: string
  name: string
  tier: number
  level: number
  resources: { hp: number; maxHp: number; mp: number; maxMp: number; sp: number; maxSp: number }
  /** aggregated relic/gear/passive modifiers; `label` is the ruleset's display text. */
  modifiers: { key: string; label: string; value: number }[]
  conditions: { id: string; label: string; stacks?: number; turns?: number; kind: 'buff' | 'debuff' }[]
  deck: CardPreview[]
}

export interface CardPreview {
  id: string
  name: string
  /** stable rarity id the card UI maps to a theme quality token (e.g. 'epic'). */
  rarityKey: string
  /** the ruleset's display label for the rarity (e.g. '史诗'). */
  rarityLabel: string
  kind: 'attack' | 'defend' | 'skill' | 'heal' | 'power'
  energyCost: number
  resourceCost: { hp?: number; mp?: number; sp?: number }
  scalingAttr?: string
  power?: number
  /** pre-formatted, display-ready effect lines. */
  effectLines: string[]
  ratingEstimate?: number
  copies: number
  /** World Assets '卡面' key; null today (rarity frame), real art when card-import (D6) lands. */
  artKey?: string
}
