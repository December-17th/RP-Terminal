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
  '--rpt-agent-region-detached': 'rgba(230, 180, 85, 0.07)'
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
  '--rpt-agent-region-detached': 'rgba(226, 169, 60, 0.08)'
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
  '--rpt-agent-region-detached': 'rgba(184, 119, 10, 0.10)'
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
