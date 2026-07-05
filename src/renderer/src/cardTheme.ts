// Card-bundled themes (docs/ui-rehaul-design.md §6a). A World Card may ship its own look under
// `data.extensions.rp_terminal.theme` so the SHELL reskins to its aesthetic while that world is in
// play. This is the safe TOKEN path (the `css` escape hatch is a separate, sanitized follow-on).
//
// Trust model: a card theme is UNTRUSTED design input. The card supplies FILL colors; we DERIVE the
// readable text / on-* tokens ourselves by luminance and enforce WCAG-AA, rather than trusting
// card-supplied text colors. A theme whose core pair fails contrast is REJECTED (deriveCardTheme
// returns null) and the caller keeps the user's app theme — a broken card can never make play
// unreadable. Scope is play mode only (applied to a wrapper, not <html>), so the launcher and the
// settings popup always stay on the user's chosen theme.

import { THEMES, DEFAULT_THEME_ID, type ThemeTokens } from './theme'

/** Friendly card token names → the app's CSS custom properties. A card may also key overrides by the
 *  raw `--rpt-*` name directly (see toVar). Unknown keys are ignored (forward-compatible). */
const ALIAS: Record<string, string> = {
  accent: '--rpt-accent',
  'on-accent': '--rpt-on-accent',
  'bg-0': '--rpt-bg-primary',
  'bg-primary': '--rpt-bg-primary',
  'bg-1': '--rpt-bg-secondary',
  'bg-secondary': '--rpt-bg-secondary',
  'bg-2': '--rpt-bg-tertiary',
  'bg-tertiary': '--rpt-bg-tertiary',
  'bg-elevated': '--rpt-bg-elevated',
  elevated: '--rpt-bg-elevated',
  border: '--rpt-border',
  danger: '--rpt-danger',
  success: '--rpt-success',
  warning: '--rpt-warning',
  'text-primary': '--rpt-text-primary',
  'text-secondary': '--rpt-text-secondary',
  'text-tertiary': '--rpt-text-tertiary'
}

const toVar = (key: string): string | null =>
  key.startsWith('--rpt-') ? key : (ALIAS[key] ?? null)

interface Rgb {
  r: number
  g: number
  b: number
}

/** Parse a #rgb / #rrggbb color. Returns null for anything else (color-mix(), rgb(), named) — those
 *  fills pass through unchanged and simply aren't used as a derivation/contrast basis. */
export function parseHex(s: string): Rgb | null {
  const t = s.trim()
  const six = /^#?([0-9a-f]{6})$/i.exec(t)
  if (six) {
    const h = six[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  const three = /^#?([0-9a-f]{3})$/i.exec(t)
  if (three) {
    const h = three[1]
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) }
  }
  return null
}

const channel = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const relLuminance = (c: Rgb): number => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relLuminance(a)
  const l2 = relLuminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 13, g: 13, b: 15 }

/** The readable foreground (near-black or white) for a fill, whichever has more contrast. */
const readableOn = (fill: Rgb): string =>
  contrastRatio(fill, WHITE) >= contrastRatio(fill, BLACK) ? '#ffffff' : '#0d0d0f'

// Text ramps derived when a card changes the background but supplies no text colors of its own.
const DARK_TEXT = { primary: '#eaeaef', secondary: '#a9adb8', tertiary: '#71757f' }
const LIGHT_TEXT = { primary: '#1a1c22', secondary: '#4a4f5a', tertiary: '#767b86' }

/** AA threshold for body text; on-accent uses the 3:1 large/graphical bar (it labels buttons/badges). */
const AA_TEXT = 4.5
const AA_ON_ACCENT = 3

/**
 * Derive the effective play-mode token set from a card's `theme` override map, layered over a base
 * app theme (the card's declared `base`, else the user's current theme). Returns the full token map
 * to apply on the play wrapper, or NULL when the result fails contrast (caller keeps the user theme).
 *
 * `cardTheme` accepts either `{ base?, tokens: {…}, css? }` (the documented shape) or a bare override
 * map. Overrides may be keyed by friendly names (`accent`, `bg-1`) or raw `--rpt-*` vars.
 */
export function deriveCardTheme(
  cardTheme: Record<string, unknown> | undefined,
  userThemeId: string | undefined
): ThemeTokens | null {
  if (!cardTheme || typeof cardTheme !== 'object') return null

  const baseId =
    typeof cardTheme.base === 'string' && THEMES[cardTheme.base]
      ? cardTheme.base
      : userThemeId && THEMES[userThemeId]
        ? userThemeId
        : DEFAULT_THEME_ID
  const out: ThemeTokens = { ...THEMES[baseId].tokens }

  const rawTokens =
    cardTheme.tokens && typeof cardTheme.tokens === 'object'
      ? (cardTheme.tokens as Record<string, unknown>)
      : cardTheme

  let overrodeBg = false
  let overrodeText = false
  let overrodeAccent = false
  let overrodeOnAccent = false
  for (const [key, value] of Object.entries(rawTokens)) {
    if (key === 'base' || key === 'tokens' || key === 'css') continue
    if (typeof value !== 'string') continue
    const varName = toVar(key)
    if (!varName) continue
    out[varName] = value
    if (varName === '--rpt-bg-primary') overrodeBg = true
    if (varName.startsWith('--rpt-text')) overrodeText = true
    if (varName === '--rpt-accent') overrodeAccent = true
    if (varName === '--rpt-on-accent') overrodeOnAccent = true
  }

  // Nothing the app understands was overridden → treat as "no card theme" so the caller no-ops.
  if (!overrodeBg && !overrodeText && !overrodeAccent && !overrodeOnAccent) return null

  // Derive on-accent from the (possibly new) accent unless the card set it explicitly.
  const accent = parseHex(out['--rpt-accent'])
  if (overrodeAccent && !overrodeOnAccent && accent) out['--rpt-on-accent'] = readableOn(accent)

  // Derive the text ramp from the new background unless the card set text colors itself.
  const bg = parseHex(out['--rpt-bg-primary'])
  if (overrodeBg && !overrodeText && bg) {
    const ramp = relLuminance(bg) < 0.4 ? DARK_TEXT : LIGHT_TEXT
    out['--rpt-text-primary'] = ramp.primary
    out['--rpt-text-secondary'] = ramp.secondary
    out['--rpt-text-tertiary'] = ramp.tertiary
  }

  // Contrast guard — reject the whole theme if the load-bearing pairs fail AA (caller falls back).
  const tp = parseHex(out['--rpt-text-primary'])
  const bp = parseHex(out['--rpt-bg-primary'])
  if (tp && bp && contrastRatio(tp, bp) < AA_TEXT) return null
  const oa = parseHex(out['--rpt-on-accent'])
  if (accent && oa && contrastRatio(accent, oa) < AA_ON_ACCENT) return null

  return out
}
