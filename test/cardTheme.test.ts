import { describe, it, expect } from 'vitest'
import { deriveCardTheme, contrastRatio, parseHex } from '../src/renderer/src/cardTheme'

describe('cardTheme.deriveCardTheme (§6a token path)', () => {
  it('applies an accent override and derives a readable on-accent, keeping base bg/text', () => {
    const out = deriveCardTheme({ accent: '#c8102e' }, 'dark')
    expect(out).not.toBeNull()
    expect(out!['--rpt-accent']).toBe('#c8102e')
    // base (dark) bg/text are retained when only the accent changed
    expect(out!['--rpt-bg-primary']).toBe('#121212')
    // on-accent must be AA-legible (≥3:1) on the new accent
    const accent = parseHex(out!['--rpt-accent'])!
    const onAccent = parseHex(out!['--rpt-on-accent'])!
    expect(contrastRatio(accent, onAccent)).toBeGreaterThanOrEqual(3)
  })

  it('derives a light text ramp when the card sets a light background', () => {
    const out = deriveCardTheme({ 'bg-primary': '#f5f0e6', accent: '#6a4cff' }, 'dark')
    expect(out).not.toBeNull()
    expect(out!['--rpt-bg-primary']).toBe('#f5f0e6')
    // text flipped to the dark ramp so it stays readable on the light bg
    const tp = parseHex(out!['--rpt-text-primary'])!
    const bp = parseHex(out!['--rpt-bg-primary'])!
    expect(contrastRatio(tp, bp)).toBeGreaterThanOrEqual(4.5)
  })

  it('rejects a theme whose text fails AA against its background (caller keeps user theme)', () => {
    // Card supplies its OWN low-contrast text — we do not trust it; the whole theme is rejected.
    expect(deriveCardTheme({ 'bg-primary': '#111111', 'text-primary': '#222222' }, 'dark')).toBeNull()
  })

  it('honours a declared base theme', () => {
    const out = deriveCardTheme({ base: 'light', accent: '#2563eb' }, 'dark')
    expect(out).not.toBeNull()
    expect(out!['--rpt-bg-primary']).toBe('#f5f6f8') // from the light base, not the user's dark
  })

  it('accepts the structured { tokens } shape and raw --rpt-* keys', () => {
    const out = deriveCardTheme({ base: 'dark', tokens: { '--rpt-accent': '#22cc88' } }, 'dark')
    expect(out).not.toBeNull()
    expect(out!['--rpt-accent']).toBe('#22cc88')
  })

  it('no-ops (null) for absent, empty, or unrecognised overrides', () => {
    expect(deriveCardTheme(undefined, 'dark')).toBeNull()
    expect(deriveCardTheme({}, 'dark')).toBeNull()
    expect(deriveCardTheme({ foo: 'bar', size: '12px' }, 'dark')).toBeNull()
  })

  it('passes a prose-font token through as --rpt-chat-font-family (the story serif register)', () => {
    // A font value is not a color: it bypasses the contrast guards and applies on its own.
    const out = deriveCardTheme({ 'prose-font': "'Noto Serif SC', serif" }, 'dark')
    expect(out).not.toBeNull()
    expect(out!['--rpt-chat-font-family']).toBe("'Noto Serif SC', serif")
    expect(deriveCardTheme({ 'chat-font': 'Georgia, serif' }, 'dark')!['--rpt-chat-font-family']).toBe(
      'Georgia, serif'
    )
  })

  it('carries the prose font alongside a full palette without disturbing contrast', () => {
    const out = deriveCardTheme(
      { 'bg-primary': '#14121b', accent: '#d9b56b', 'prose-font': "'Noto Serif SC', serif" },
      'dark'
    )
    expect(out).not.toBeNull()
    expect(out!['--rpt-chat-font-family']).toBe("'Noto Serif SC', serif")
    const tp = parseHex(out!['--rpt-text-primary'])!
    const bp = parseHex(out!['--rpt-bg-primary'])!
    expect(contrastRatio(tp, bp)).toBeGreaterThanOrEqual(4.5)
  })
})
