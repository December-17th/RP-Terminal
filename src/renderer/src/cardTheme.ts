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
  'text-tertiary': '--rpt-text-tertiary',
  // Message-box namespace (runtime-theme-api-design §3A): the chat message box's OWN tokens, distinct
  // from the shell-wide bg/border. Each falls back in CSS to today's shell token, so an unset one is
  // visually unchanged. `msg-radius` is a length (passes through untouched); the color tokens run the
  // message-scoped contrast guard in deriveMessageTheme.
  'msg-bg': '--rpt-msg-bg',
  'msg-border': '--rpt-msg-border',
  'msg-radius': '--rpt-msg-radius',
  'msg-text': '--rpt-msg-text',
  'msg-user': '--rpt-msg-user',
  // Typography: the AI-message prose font (the story's serif register) + size. Font values, not
  // colors, so they bypass the contrast machinery below and simply pass through.
  'chat-font': '--rpt-chat-font-family',
  'prose-font': '--rpt-chat-font-family',
  'chat-size': '--rpt-chat-font'
}

/** The message-box token whitelist — the only keys that survive a `target:'message'` override
 *  (runtime-theme-api-design §3B). Other keys are ignored when the runtime target is 'message'. */
export const MSG_VARS: ReadonlySet<string> = new Set([
  '--rpt-msg-bg',
  '--rpt-msg-border',
  '--rpt-msg-radius',
  '--rpt-msg-text',
  '--rpt-msg-user',
  '--rpt-chat-font',
  '--rpt-chat-font-family'
])

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
  return deriveThemeOverTokens(THEMES[baseId].tokens, unwrapOverride(cardTheme))
}

/** Unwrap an override that may be `{ base?, tokens: {…} }` (documented shape) or a bare map. Returns
 *  the flat token map (the `tokens` object when present, else the object itself). */
export function unwrapOverride(o: Record<string, unknown>): Record<string, unknown> {
  return o.tokens && typeof o.tokens === 'object' ? (o.tokens as Record<string, unknown>) : o
}

/**
 * The derivation + trust core: layer `rawTokens` (a flat, already-unwrapped map) over a BASE token
 * map (an app-theme set OR the current effective play tokens, for the runtime layer). Derives readable
 * text / on-accent, enforces WCAG-AA on the load-bearing pairs, and returns the full token map — or
 * NULL when nothing understood was overridden or a load-bearing pair fails AA (caller keeps prior).
 */
export function deriveThemeOverTokens(
  base: ThemeTokens,
  rawTokens: Record<string, unknown>
): ThemeTokens | null {
  const out: ThemeTokens = { ...base }

  let overrodeBg = false
  let overrodeText = false
  let overrodeAccent = false
  let overrodeOnAccent = false
  let overrodeOther = false // a non-color token the app understands (e.g. the prose font)
  for (const [key, value] of Object.entries(rawTokens)) {
    if (key === 'base' || key === 'tokens' || key === 'css') continue
    if (typeof value !== 'string') continue
    const varName = toVar(key)
    if (!varName) continue
    out[varName] = value
    if (varName === '--rpt-bg-primary') overrodeBg = true
    else if (varName.startsWith('--rpt-text')) overrodeText = true
    else if (varName === '--rpt-accent') overrodeAccent = true
    else if (varName === '--rpt-on-accent') overrodeOnAccent = true
    else overrodeOther = true
  }

  // Nothing the app understands was overridden → treat as "no card theme" so the caller no-ops.
  if (!overrodeBg && !overrodeText && !overrodeAccent && !overrodeOnAccent && !overrodeOther)
    return null

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

/**
 * Derive the message-box token PATCH from a `target:'message'` override (runtime-theme-api-design §3B/§4).
 * Only the `--rpt-msg-*` / `--rpt-chat-*` whitelist (MSG_VARS) survives; other keys are ignored. Untrusted
 * like the shell path: when the card sets `msg-bg` but no `msg-text`/`msg-user`, we DERIVE readable ones
 * from that bg (never trust card text on a new bg); every card-supplied color is CHECKED against the
 * effective message bg — `--rpt-msg-bg` if set, else the shell's `--rpt-bg-secondary` — and the whole
 * patch is REJECTED (null) if a load-bearing pair fails AA (caller keeps prior). Returns the patch to
 * layer over the shell tokens, or null (nothing understood, or a contrast failure).
 */
export function deriveMessageTheme(
  override: Record<string, unknown>,
  baseBgSecondary: string
): ThemeTokens | null {
  const raw = unwrapOverride(override)
  const out: ThemeTokens = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const varName = toVar(key)
    if (!varName || !MSG_VARS.has(varName)) continue // message whitelist
    out[varName] = value
  }
  if (Object.keys(out).length === 0) return null

  // Effective message background: the card's msg-bg if set, else the shell's bg-secondary (the CSS fallback).
  const bg = parseHex(out['--rpt-msg-bg'] ?? baseBgSecondary)
  // Card changed the box fill but left the text/user colors → derive readable ones off the new fill
  // (a dark fill gets the light ramp, and vice-versa), rather than trusting a stale shell text color.
  if (out['--rpt-msg-bg'] && bg) {
    const ramp = relLuminance(bg) < 0.4 ? DARK_TEXT : LIGHT_TEXT
    if (!out['--rpt-msg-text']) out['--rpt-msg-text'] = ramp.primary
    if (!out['--rpt-msg-user']) out['--rpt-msg-user'] = ramp.secondary
  }

  // Contrast guard: prose (`msg-text`) at the body-text bar; the bold user-action line (`msg-user`) at
  // the 3:1 large/bold bar. A failure rejects the WHOLE message patch (caller keeps prior tokens).
  const text = out['--rpt-msg-text'] ? parseHex(out['--rpt-msg-text']) : null
  if (text && bg && contrastRatio(text, bg) < AA_TEXT) return null
  const user = out['--rpt-msg-user'] ? parseHex(out['--rpt-msg-user']) : null
  if (user && bg && contrastRatio(user, bg) < AA_ON_ACCENT) return null

  return out
}

/**
 * Pure resolver for a runtime theme override (runtime-theme-api-design §3B/§4). Returns the token map to
 * layer over the current effective play tokens, or NULL when the override is rejected or empty:
 *  - `allow` false (settings.ui.allow_card_themes) ⇒ null (the user opt-out).
 *  - `target:'message'` ⇒ deriveMessageTheme (the `--rpt-msg-*` patch, msg-scoped contrast check).
 *  - `target:'shell'`   ⇒ deriveThemeOverTokens over `base` (full derivation + AA on the shell pairs).
 * A caller distinguishes a REJECT (null on a non-empty override) from a CLEAR (empty/undefined override).
 */
export function resolveRuntimeTheme(
  allow: boolean,
  target: 'shell' | 'message',
  override: Record<string, unknown> | null | undefined,
  base: ThemeTokens
): ThemeTokens | null {
  if (!allow) return null
  if (!override || typeof override !== 'object') return null
  if (target === 'message')
    return deriveMessageTheme(override, base['--rpt-bg-secondary'] ?? '#1e1e1e')
  return deriveThemeOverTokens(base, unwrapOverride(override))
}
