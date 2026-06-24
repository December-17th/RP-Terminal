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
  '--rpt-bg-primary': '#121212',
  '--rpt-bg-secondary': '#1e1e1e',
  '--rpt-bg-tertiary': '#2a2a2e',
  '--rpt-bg-elevated': '#1e1e24',
  '--rpt-text-primary': '#e0e0e0',
  '--rpt-text-secondary': '#aaaaaa',
  '--rpt-text-tertiary': '#6f6f78',
  '--rpt-accent': '#5b8def',
  '--rpt-on-accent': '#ffffff',
  '--rpt-border': '#333333',
  '--rpt-danger': '#e74c3c',
  '--rpt-success': '#4caf72',
  '--rpt-warning': '#e0a23c'
}

const carbon: ThemeTokens = {
  '--rpt-bg-primary': '#050506',
  '--rpt-bg-secondary': '#0f0f12',
  '--rpt-bg-tertiary': '#1a1a1f',
  '--rpt-bg-elevated': '#141418',
  '--rpt-text-primary': '#ededf0',
  '--rpt-text-secondary': '#9a9aa3',
  '--rpt-text-tertiary': '#6a6a73',
  '--rpt-accent': '#2dd4bf',
  '--rpt-on-accent': '#04221d',
  '--rpt-border': '#26262c',
  '--rpt-danger': '#f06a62',
  '--rpt-success': '#43c98b',
  '--rpt-warning': '#e2a93c'
}

const light: ThemeTokens = {
  '--rpt-bg-primary': '#f5f6f8',
  '--rpt-bg-secondary': '#ffffff',
  '--rpt-bg-tertiary': '#eceef2',
  '--rpt-bg-elevated': '#ffffff',
  '--rpt-text-primary': '#1c1e24',
  '--rpt-text-secondary': '#5b606b',
  '--rpt-text-tertiary': '#8a8f99',
  '--rpt-accent': '#2563eb',
  '--rpt-on-accent': '#ffffff',
  '--rpt-border': '#d9dce2',
  '--rpt-danger': '#d23b35',
  '--rpt-success': '#1f9e5e',
  '--rpt-warning': '#b8770a'
}

export const THEMES: Record<string, ThemeDef> = {
  dark: { id: 'dark', name: 'Midnight (dark)', tokens: dark },
  carbon: { id: 'carbon', name: 'Carbon (OLED)', tokens: carbon },
  light: { id: 'light', name: 'Daylight (light)', tokens: light }
}

export const THEME_LIST: ThemeDef[] = [THEMES.dark, THEMES.carbon, THEMES.light]
export const DEFAULT_THEME_ID = 'dark'

/** Apply a theme by id: set its token vars on <html>. Unknown/undefined id falls back to the default. */
export function applyTheme(id: string | undefined): void {
  if (typeof document === 'undefined') return
  const theme = (id && THEMES[id]) || THEMES[DEFAULT_THEME_ID]
  const root = document.documentElement
  for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(k, v)
  root.dataset.rptTheme = theme.id
}
