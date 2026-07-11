import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyThemeForScheme, applyTheme, THEMES } from '../src/renderer/src/theme'

// Pins the shared-light/dark-axis fix: the EFFECTIVE scheme (card override ?? app theme) must drive the
// FULL app token set on <html> — including `--rpt-text-primary`, the fallback color of generated/story text
// (.message-content) — not just the `--rpt-app-*` chrome tokens. So a card that flips light/dark and the app
// theme picker recolor the body text together. (Before the fix, `--rpt-text-primary` tracked only the raw
// app theme, so story text stayed put when the card flipped the scheme.)
//
// The repo's vitest env is `node` (no DOM), so we stub a minimal documentElement that records setProperty.

function makeDoc(): { documentElement: { style: { setProperty: (k: string, v: string) => void }; dataset: Record<string, string> }; props: Map<string, string> } {
  const props = new Map<string, string>()
  return {
    documentElement: {
      style: { setProperty: (k: string, v: string) => void props.set(k, v) },
      dataset: {}
    },
    props
  }
}

describe('applyThemeForScheme — full palette follows the effective light/dark axis', () => {
  let doc: ReturnType<typeof makeDoc>
  beforeEach(() => {
    doc = makeDoc()
    ;(globalThis as unknown as { document: unknown }).document = { documentElement: doc.documentElement }
    ;(globalThis as unknown as { window: unknown }).window = {} // window.api undefined → overlay no-ops
  })
  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document
    delete (globalThis as unknown as { window?: unknown }).window
  })
  const tp = (): string | undefined => doc.props.get('--rpt-text-primary')

  it('keeps the chosen theme when the effective scheme matches its natural axis (carbon stays carbon)', () => {
    applyThemeForScheme('carbon', 'dark')
    expect(tp()).toBe(THEMES.carbon.tokens['--rpt-text-primary'])
    expect(doc.documentElement.dataset.rptTheme).toBe('carbon') // reflects the user's pick
  })

  it('flips --rpt-text-primary (generated text) AND chrome when a card forces the opposite axis', () => {
    // dark app theme forced LIGHT (rptHost.setColorScheme) → the light palette's dark text, so story text
    // recolors — this is the reported bug.
    applyThemeForScheme('dark', 'light')
    expect(tp()).toBe(THEMES.light.tokens['--rpt-text-primary'])
    expect(doc.props.get('--rpt-app-bg-secondary')).toBe(THEMES.light.tokens['--rpt-bg-secondary'])
    expect(doc.documentElement.dataset.rptTheme).toBe('dark') // user's pick preserved
  })

  it('light theme forced dark applies the dark palette text', () => {
    applyThemeForScheme('light', 'dark')
    expect(tp()).toBe(THEMES.dark.tokens['--rpt-text-primary'])
  })

  it('applyTheme(id) applies the theme on its natural axis', () => {
    applyTheme('light')
    expect(tp()).toBe(THEMES.light.tokens['--rpt-text-primary'])
    applyTheme('dark')
    expect(tp()).toBe(THEMES.dark.tokens['--rpt-text-primary'])
  })
})
