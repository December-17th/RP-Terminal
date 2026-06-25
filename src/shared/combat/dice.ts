// Combat core — seeded dice (Track Combat / P1).
//
// Pure module (no main/renderer imports). All combat randomness flows through an
// injectable `Rng` so a fight is deterministic for a given seed and so tests can
// feed exact rolls. `makeRng` is the SAME mulberry32 as the sandbox runner
// (src/main/services/sandboxRunner.ts) so a native resolution and a sandboxed
// card-override with the same seed agree — keep the two implementations identical.

import { ABILITIES, type Ability } from './types'

export type Rng = () => number

/** Deterministic PRNG in [0, 1) — mulberry32. Same seed ⇒ same sequence. */
export const makeRng = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Roll one die: an integer in [1, sides]. */
export const rollDie = (rng: Rng, sides: number): number => Math.floor(rng() * sides) + 1

export interface D20Roll {
  /** kept die value + modifier. */
  total: number
  /** the natural d20 that was kept (before the modifier; the value crit/fumble key off). */
  natural: number
  /** every d20 rolled (two when adv/dis). */
  dice: number[]
  crit: boolean
  fumble: boolean
}

export interface D20Opts {
  mod?: number
  adv?: boolean
  dis?: boolean
}

/**
 * d20 + modifier. With advantage or disadvantage, roll two and keep the
 * higher / lower. A natural 20 is a crit, a natural 1 is a fumble (keyed off the
 * kept die). If both `adv` and `dis` are set they cancel to a straight roll.
 */
export const rollD20 = (rng: Rng, opts: D20Opts = {}): D20Roll => {
  const mod = opts.mod ?? 0
  const a = rollDie(rng, 20)
  const dice = [a]
  let natural = a
  const adv = !!opts.adv && !opts.dis
  const dis = !!opts.dis && !opts.adv
  if (adv || dis) {
    const b = rollDie(rng, 20)
    dice.push(b)
    natural = adv ? Math.max(a, b) : Math.min(a, b)
  }
  return { total: natural + mod, natural, dice, crit: natural === 20, fumble: natural === 1 }
}

export interface ExprResult {
  /** dice + modifiers summed. */
  total: number
  /** the individual die results, in roll order. */
  rolls: number[]
  /** the static + ability portion (no dice). */
  modifier: number
}

/**
 * Roll a dice expression. Terms are separated by `+` / `-`:
 *   - `NdM` dice terms (e.g. `2d6`),
 *   - integer constants (e.g. `3`, `-1`),
 *   - ability tokens (STR/DEX/CON/INT/WIS/CHA), resolved from `mods`.
 * Whitespace tolerant; unknown tokens are ignored. Examples: `2d6+3`, `1d8+STR`,
 * `6d6`, `1d4-1`, `STR`. `critDice` (default 1) multiplies the number of dice
 * rolled per dice term — pass 2 to double dice on a crit (modifiers are not doubled).
 */
export const rollExpr = (
  rng: Rng,
  expr: string,
  mods: Partial<Record<Ability, number>> = {},
  critDice = 1
): ExprResult => {
  const rolls: number[] = []
  let total = 0
  let modifier = 0
  const cleaned = String(expr ?? '').replace(/\s+/g, '')
  if (!cleaned) return { total: 0, rolls, modifier: 0 }

  const terms = cleaned.match(/[+-]?[^+-]+/g) ?? []
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1
    const body = term.replace(/^[+-]/, '')
    const dice = body.match(/^(\d+)d(\d+)$/i)
    if (dice) {
      const count = parseInt(dice[1], 10) * critDice
      const sides = parseInt(dice[2], 10)
      for (let i = 0; i < count; i++) {
        const r = rollDie(rng, sides)
        rolls.push(r)
        total += sign * r
      }
      continue
    }
    const upper = body.toUpperCase() as Ability
    if (ABILITIES.includes(upper)) {
      const v = mods[upper] ?? 0
      modifier += sign * v
      total += sign * v
      continue
    }
    const num = Number(body)
    if (!Number.isNaN(num)) {
      modifier += sign * num
      total += sign * num
    }
  }
  return { total, rolls, modifier }
}
