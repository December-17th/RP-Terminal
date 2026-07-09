import { describe, it, expect } from 'vitest'
import {
  deriveCardTheme,
  deriveMessageTheme,
  resolveRuntimeTheme,
  contrastRatio,
  parseHex
} from '../src/renderer/src/cardTheme'
import { THEMES } from '../src/renderer/src/theme'

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

describe('cardTheme runtime message theme (runtime-theme-api-design §3B/§4)', () => {
  const dark = THEMES.dark.tokens

  it('applies a message-scoped override as --rpt-msg-* tokens (aliases resolved)', () => {
    const out = deriveMessageTheme(
      { 'msg-bg': '#101018', 'msg-text': '#e8e8f0', 'msg-radius': '14px', 'chat-size': '18px' },
      dark['--rpt-bg-secondary']
    )
    expect(out).not.toBeNull()
    expect(out!['--rpt-msg-bg']).toBe('#101018')
    expect(out!['--rpt-msg-text']).toBe('#e8e8f0')
    expect(out!['--rpt-msg-radius']).toBe('14px')
    expect(out!['--rpt-chat-font']).toBe('18px')
  })

  it('ignores non-message keys under the message target (only the msg whitelist survives)', () => {
    const out = deriveMessageTheme({ 'msg-radius': '10px', accent: '#ff0000', 'bg-primary': '#000' }, dark['--rpt-bg-secondary'])
    expect(out).toEqual({ '--rpt-msg-radius': '10px' })
  })

  it('derives a readable prose color when the card sets msg-bg but no msg-text', () => {
    const out = deriveMessageTheme({ 'msg-bg': '#0b0b12' }, dark['--rpt-bg-secondary'])
    expect(out).not.toBeNull()
    const text = parseHex(out!['--rpt-msg-text'])!
    const bg = parseHex(out!['--rpt-msg-bg'])!
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it('rejects a message theme whose text fails AA against its box background (keeps prior)', () => {
    expect(deriveMessageTheme({ 'msg-bg': '#111111', 'msg-text': '#222222' }, dark['--rpt-bg-secondary'])).toBeNull()
  })

  it('resolveRuntimeTheme no-ops (null) when allow_card_themes is off', () => {
    const override = { 'msg-bg': '#101018', 'msg-text': '#e8e8f0' }
    // Same override applies when allowed…
    expect(resolveRuntimeTheme(true, 'message', override, dark)).not.toBeNull()
    // …but is rejected outright when the user opt-out is off.
    expect(resolveRuntimeTheme(false, 'message', override, dark)).toBeNull()
    expect(resolveRuntimeTheme(false, 'shell', { accent: '#c8102e' }, dark)).toBeNull()
  })

  it('resolveRuntimeTheme shell target layers over the current effective tokens', () => {
    const out = resolveRuntimeTheme(true, 'shell', { accent: '#22cc88' }, dark)
    expect(out).not.toBeNull()
    expect(out!['--rpt-accent']).toBe('#22cc88')
    // untouched shell tokens are preserved from the base
    expect(out!['--rpt-bg-primary']).toBe(dark['--rpt-bg-primary'])
  })

  it('rejects a msg-bg set via the SHELL target that clashes with the inherited message text (AA gate)', () => {
    // A `--rpt-msg-*` fill is accepted on the default shell path too; the message-box contrast guard must
    // still run there — a light msg-bg under the dark theme's inherited light text is illegible → rejected.
    expect(resolveRuntimeTheme(true, 'shell', { 'msg-bg': '#dddddd' }, dark)).toBeNull()
    // A dark msg-bg that keeps the inherited light text legible passes on the same shell path.
    const ok = resolveRuntimeTheme(true, 'shell', { 'msg-bg': '#050505' }, dark)
    expect(ok).not.toBeNull()
    expect(ok!['--rpt-msg-bg']).toBe('#050505')
  })

  it('does not gate a radius/font-only override on any inherited color pair', () => {
    const out = resolveRuntimeTheme(true, 'shell', { 'msg-radius': '12px' }, dark)
    expect(out).not.toBeNull()
    expect(out!['--rpt-msg-radius']).toBe('12px')
  })
})
