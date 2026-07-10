// src/renderer/src/theme.ts
//
// The app theme registry + applier. A theme is a set of CSS-variable token values; applyTheme() sets them
// on <html> so the whole UI re-colors. The DEFAULT (dark) values also live in assets/index.css :root for
// correct first paint before this runs.
//
// Contrast rule (docs/ui-rehaul-design.md §7): every fill token is paired with a text / on-* token. Keep
// new themes legible (WCAG AA) across the WHOLE set — a light theme flips the dark-on-dark assumptions.

export type ThemeTokens = Record<string, string>
export interface ThemeDef {
  id: string
  name: string
  tokens: ThemeTokens
}

const dark: ThemeTokens = {
  // Custom merged title-bar height. PAIRED VALUE — keep in sync with TITLEBAR_OVERLAY_HEIGHT
  // (src/main/windowChrome.ts), the main-process OS window-control overlay height. Every
  // titlebar-height-derived style (.tstrip / .lc-bar strips, workflow-editor header) consumes
  // this token; the two definitions can't share across the process boundary, so the test
  // test/titlebarHeight.test.ts asserts they match. Theme-independent — same value in all themes.
  '--rpt-titlebar-h': '44px',
  '--rpt-bg-primary': '#121212',
  '--rpt-bg-secondary': '#1e1e1e',
  '--rpt-bg-tertiary': '#2a2a2e',
  '--rpt-bg-elevated': '#1e1e24',
  '--rpt-text-primary': '#e0e0e0',
  '--rpt-text-secondary': '#aaaaaa',
  '--rpt-text-tertiary': '#6f6f78',
  '--rpt-accent': '#5b8def',
  // Soft accent wash — cue banners / subtle accent-tinted fills (ChatView combat-cue banner).
  '--rpt-accent-soft': 'rgba(91, 141, 239, 0.12)',
  '--rpt-on-accent': '#ffffff',
  '--rpt-border': '#333333',
  '--rpt-danger': '#e74c3c',
  '--rpt-success': '#4caf72',
  '--rpt-warning': '#e0a23c',
  // Agent Packs (agent-packs plan WP3.1): the pack card's derived domain tokens. gate-on = the
  // toggle's active fill (success-green: "this pack is live"); headless = the accent for a
  // "runs by itself" badge; write-* = the danger-tinted capability chip (a pack that MUTATES state).
  '--rpt-agent-gate-on': '#4caf72',
  '--rpt-agent-headless': '#3a2f14',
  '--rpt-agent-headless-text': '#e6b455',
  '--rpt-agent-write-bg': '#3a1c1a',
  '--rpt-agent-write-text': '#f0968c',
  // Effective-mode pack region (agent-packs plan WP3.6a; ADR 0010): the tinted hull a pack's grouped
  // nodes sit in, its border, and the header band the pack-name label + gate chip ride on. region-text
  // is the label color, chosen for WCAG-AA against region-header in every theme. detached is the
  // dimmer hull for a trigger-only (headless-only) pack rendered as a placeholder region.
  '--rpt-agent-region': 'rgba(91, 141, 239, 0.06)',
  '--rpt-agent-region-border': 'rgba(91, 141, 239, 0.45)',
  '--rpt-agent-region-header': 'rgba(91, 141, 239, 0.16)',
  '--rpt-agent-region-text': '#c9d8f7',
  '--rpt-agent-region-detached': 'rgba(230, 180, 85, 0.07)',
  // Agent & memory UX (2026-07-07 plan §0.6): the agent card's prose accent — `--rpt-agent` colors the
  // status sentence + Agents ▾ rows (AA on the card's bg-secondary surface); `--rpt-agent-dim` is the
  // muted variant for an OFF/mixed agent (still AA). Distinct from the older `--rpt-agent-*` pack family.
  '--rpt-agent': '#9cc0ff',
  '--rpt-agent-dim': '#9aa3b5'
}

const carbon: ThemeTokens = {
  // See the dark set: paired with TITLEBAR_OVERLAY_HEIGHT (src/main/windowChrome.ts).
  '--rpt-titlebar-h': '44px',
  '--rpt-bg-primary': '#050506',
  '--rpt-bg-secondary': '#0f0f12',
  '--rpt-bg-tertiary': '#1a1a1f',
  '--rpt-bg-elevated': '#141418',
  '--rpt-text-primary': '#ededf0',
  '--rpt-text-secondary': '#9a9aa3',
  '--rpt-text-tertiary': '#6a6a73',
  '--rpt-accent': '#2dd4bf',
  // Soft accent wash — cue banners / subtle accent-tinted fills (ChatView combat-cue banner).
  '--rpt-accent-soft': 'rgba(45, 212, 191, 0.12)',
  '--rpt-on-accent': '#04221d',
  '--rpt-border': '#26262c',
  '--rpt-danger': '#f06a62',
  '--rpt-success': '#43c98b',
  '--rpt-warning': '#e2a93c',
  // Agent Packs (see the dark set above for what each token drives).
  '--rpt-agent-gate-on': '#43c98b',
  '--rpt-agent-headless': '#2b2410',
  '--rpt-agent-headless-text': '#e6b455',
  '--rpt-agent-write-bg': '#331715',
  '--rpt-agent-write-text': '#f5978d',
  // Effective-mode pack region (see the dark set above). Carbon leans teal to match its accent.
  '--rpt-agent-region': 'rgba(45, 212, 191, 0.06)',
  '--rpt-agent-region-border': 'rgba(45, 212, 191, 0.42)',
  '--rpt-agent-region-header': 'rgba(45, 212, 191, 0.16)',
  '--rpt-agent-region-text': '#bfeee5',
  '--rpt-agent-region-detached': 'rgba(226, 169, 60, 0.08)',
  // Agent & memory UX (see the dark set above). Carbon leans teal to match its accent.
  '--rpt-agent': '#6fe6d4',
  '--rpt-agent-dim': '#949bab'
}

const light: ThemeTokens = {
  // See the dark set: paired with TITLEBAR_OVERLAY_HEIGHT (src/main/windowChrome.ts).
  '--rpt-titlebar-h': '44px',
  '--rpt-bg-primary': '#f5f6f8',
  '--rpt-bg-secondary': '#ffffff',
  '--rpt-bg-tertiary': '#eceef2',
  '--rpt-bg-elevated': '#ffffff',
  '--rpt-text-primary': '#1c1e24',
  '--rpt-text-secondary': '#5b606b',
  '--rpt-text-tertiary': '#8a8f99',
  '--rpt-accent': '#2563eb',
  // Soft accent wash — cue banners / subtle accent-tinted fills (ChatView combat-cue banner).
  '--rpt-accent-soft': 'rgba(37, 99, 235, 0.10)',
  '--rpt-on-accent': '#ffffff',
  '--rpt-border': '#d9dce2',
  '--rpt-danger': '#d23b35',
  '--rpt-success': '#1f9e5e',
  '--rpt-warning': '#b8770a',
  // Agent Packs (see the dark set above). Light theme flips to light chip fills with dark-enough
  // text for AA; gate-on stays the success green (dark enough on the light toggle track).
  '--rpt-agent-gate-on': '#1f9e5e',
  '--rpt-agent-headless': '#f5ecd6',
  '--rpt-agent-headless-text': '#7a5405',
  '--rpt-agent-write-bg': '#fbe3e0',
  '--rpt-agent-write-text': '#a3241f',
  // Effective-mode pack region (see the dark set above). Light theme uses a dark-enough label for AA
  // on the pale header band.
  '--rpt-agent-region': 'rgba(37, 99, 235, 0.05)',
  '--rpt-agent-region-border': 'rgba(37, 99, 235, 0.38)',
  '--rpt-agent-region-header': 'rgba(37, 99, 235, 0.12)',
  '--rpt-agent-region-text': '#1c3d80',
  '--rpt-agent-region-detached': 'rgba(184, 119, 10, 0.10)',
  // Agent & memory UX (see the dark set above). Light theme uses a dark-enough blue for AA on white.
  '--rpt-agent': '#2456c8',
  '--rpt-agent-dim': '#5b606b'
}

export const THEMES: Record<string, ThemeDef> = {
  dark: { id: 'dark', name: 'Midnight (dark)', tokens: dark },
  carbon: { id: 'carbon', name: 'Carbon (OLED)', tokens: carbon },
  light: { id: 'light', name: 'Daylight (light)', tokens: light }
}

export const THEME_LIST: ThemeDef[] = [THEMES.dark, THEMES.carbon, THEMES.light]
export const DEFAULT_THEME_ID = 'dark'

/** The light/dark axis a theme sits on, derived from its primary background luminance (so a future
 *  theme classifies itself with no extra bookkeeping). This is the app's IN-APP mode — WCV card
 *  surfaces follow THIS (relayed to main → the WCV `data-rpt-mode`), not the OS `prefers-color-scheme`.
 *  Unknown/undefined id falls back to the default theme. */
export function colorSchemeOf(id: string | undefined): 'light' | 'dark' {
  const theme = (id && THEMES[id]) || THEMES[DEFAULT_THEME_ID]
  const m = /^#?([0-9a-f]{6})$/i.exec((theme.tokens['--rpt-bg-primary'] || '').trim())
  if (!m) return 'dark'
  const h = m[1]
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  // Perceived luminance (0..255); a bright background ⇒ a light theme.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128 ? 'light' : 'dark'
}

/**
 * The APP-scoped chrome surface (title strip, message box, chat panel body + header) for an effective
 * light/dark scheme. Distinct from the card token map: a card's `.play-root` inline tokens can shadow
 * every `--rpt-*` it understands, so the chrome must read from tokens the card CANNOT set — these
 * `--rpt-app-*` vars, written on <html> (below). When the effective scheme matches the current theme's
 * own axis we mirror that theme's surface (so Carbon vs Midnight stay distinct); when a card FORCES the
 * opposite axis (rptHost.setColorScheme) we fall to the canonical built-in theme for that axis.
 */
export function chromeTokensFor(
  themeId: string | undefined,
  scheme: 'light' | 'dark'
): { bg: string; bgPrimary: string; text: string; border: string } {
  const theme = (themeId && THEMES[themeId]) || THEMES[DEFAULT_THEME_ID]
  const src = colorSchemeOf(theme.id) === scheme ? theme.tokens : THEMES[scheme].tokens
  return {
    // `bg` is the SECONDARY surface (title strip, message box, chat panel body); `bgPrimary` is the
    // deeper base the chat panel HEADER mixes over so it stays distinct from the body.
    bg: src['--rpt-bg-secondary'],
    bgPrimary: src['--rpt-bg-primary'],
    text: src['--rpt-text-primary'],
    border: src['--rpt-border']
  }
}

/** Write the app-scoped chrome tokens (`--rpt-app-*`) on <html> for a given effective scheme. Called by
 *  applyTheme with the theme's natural axis, and re-applied by App.tsx with the EFFECTIVE axis whenever a
 *  card override is active. Because these live on <html> (not the card's `.play-root`), the title strip,
 *  message box, and chat panel background follow the app's light/dark by default and can't be shadowed by
 *  a card. */
export function applyChromeScheme(themeId: string | undefined, scheme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return
  const c = chromeTokensFor(themeId, scheme)
  const root = document.documentElement
  root.style.setProperty('--rpt-app-bg-secondary', c.bg)
  root.style.setProperty('--rpt-app-bg-primary', c.bgPrimary)
  root.style.setProperty('--rpt-app-text-primary', c.text)
  root.style.setProperty('--rpt-app-border', c.border)
}

/** Apply a theme by id: set its token vars on <html>. Unknown/undefined id falls back to the default. */
export function applyTheme(id: string | undefined): void {
  if (typeof document === 'undefined') return
  const theme = (id && THEMES[id]) || THEMES[DEFAULT_THEME_ID]
  const root = document.documentElement
  for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(k, v)
  root.dataset.rptTheme = theme.id
  // Seed the app-scoped chrome tokens to this theme's natural axis. App.tsx re-applies them with the
  // EFFECTIVE axis (card override ?? natural) so a card that flips the scheme repaints the chrome too.
  applyChromeScheme(theme.id, colorSchemeOf(theme.id))
  // Keep the Windows window-control overlay (custom title bar) in step with the theme.
  try {
    window.api?.setTitlebarOverlay?.({
      color: theme.tokens['--rpt-bg-secondary'],
      symbolColor: theme.tokens['--rpt-text-primary']
    })
  } catch {
    /* no titlebar overlay (non-Windows) */
  }
}
