import { describe, it, expect } from 'vitest'
import { THEMES, colorSchemeOf, chromeTokensFor } from '../src/renderer/src/theme'

// The app-scoped chrome surface (title strip + message-box background fallback) tracks the EFFECTIVE
// light/dark scheme, resolved in App.tsx as `cardColorScheme ?? colorSchemeOf(app theme)`. These tests pin
// the two load-bearing pure pieces: the effective-scheme resolution and the chrome-token source selection.

describe('theme.colorSchemeOf — the light/dark axis of each built-in theme', () => {
  it('classifies by primary-bg luminance', () => {
    expect(colorSchemeOf('dark')).toBe('dark')
    expect(colorSchemeOf('carbon')).toBe('dark')
    expect(colorSchemeOf('light')).toBe('light')
    // Unknown / undefined id falls back to the default (dark) theme.
    expect(colorSchemeOf(undefined)).toBe('dark')
    expect(colorSchemeOf('nope')).toBe('dark')
  })
})

describe('effective scheme = cardOverride ?? colorSchemeOf(app theme)', () => {
  // Mirrors the resolution inlined in App.tsx (the single effective-scheme value driving chrome + WCV sync).
  const effective = (override: 'light' | 'dark' | null, themeId: string): 'light' | 'dark' =>
    override ?? colorSchemeOf(themeId)

  it('follows the app theme when a card sets no override', () => {
    expect(effective(null, 'dark')).toBe('dark')
    expect(effective(null, 'carbon')).toBe('dark')
    expect(effective(null, 'light')).toBe('light')
  })

  it('lets a card override win over the app theme (either direction)', () => {
    expect(effective('light', 'dark')).toBe('light')
    expect(effective('dark', 'light')).toBe('dark')
  })
})

describe('theme.chromeTokensFor — the app chrome surface for an effective scheme', () => {
  it("mirrors the theme's OWN surface when the effective scheme matches its natural axis", () => {
    // Preserves per-theme distinction: carbon vs midnight both dark, but distinct chrome colours.
    expect(chromeTokensFor('dark', 'dark').bg).toBe(THEMES.dark.tokens['--rpt-bg-secondary'])
    expect(chromeTokensFor('carbon', 'dark').bg).toBe(THEMES.carbon.tokens['--rpt-bg-secondary'])
    expect(chromeTokensFor('carbon', 'dark').bg).not.toBe(THEMES.dark.tokens['--rpt-bg-secondary'])
    expect(chromeTokensFor('light', 'light').bg).toBe(THEMES.light.tokens['--rpt-bg-secondary'])
  })

  it('falls to the canonical opposite-axis theme when a card FORCES the other scheme', () => {
    // Dark theme forced light → the built-in light surface (white), not the dark one.
    expect(chromeTokensFor('dark', 'light').bg).toBe(THEMES.light.tokens['--rpt-bg-secondary'])
    expect(chromeTokensFor('carbon', 'light').text).toBe(THEMES.light.tokens['--rpt-text-primary'])
    // Light theme forced dark → the built-in dark surface.
    expect(chromeTokensFor('light', 'dark').bg).toBe(THEMES.dark.tokens['--rpt-bg-secondary'])
  })

  it('returns app chrome surfaces and status colors from the selected source theme', () => {
    const c = chromeTokensFor('light', 'light')
    expect(c).toEqual({
      bg: THEMES.light.tokens['--rpt-bg-secondary'],
      bgPrimary: THEMES.light.tokens['--rpt-bg-primary'],
      text: THEMES.light.tokens['--rpt-text-primary'],
      border: THEMES.light.tokens['--rpt-border'],
      // App-scoped so a card palette shadowing play-root semantics cannot recolor strip indicators.
      danger: THEMES.light.tokens['--rpt-danger'],
      success: THEMES.light.tokens['--rpt-success'],
      warning: THEMES.light.tokens['--rpt-warning'],
      warningSoft: THEMES.light.tokens['--rpt-warning-soft']
    })
  })

  it('seeds bgPrimary from the deeper base surface (chat panel header mix)', () => {
    // `--rpt-app-bg-primary` (the chat panel header's mix base) tracks the source theme's PRIMARY bg,
    // distinct from `bg` (secondary). A card forcing the opposite axis falls to the canonical theme.
    expect(chromeTokensFor('dark', 'dark').bgPrimary).toBe(THEMES.dark.tokens['--rpt-bg-primary'])
    expect(chromeTokensFor('light', 'dark').bgPrimary).toBe(THEMES.dark.tokens['--rpt-bg-primary'])
  })
})
