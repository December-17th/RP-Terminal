import { describe, it, expect } from 'vitest'
import { resolveScriptedHtmlRoute } from '../src/renderer/src/components/messageCardRouting'
import type { CardRenderMode } from '../src/shared/cardRenderMode'

// Trust-gated routing for scripted-HTML message blocks (card-trust-boundary issue 01). The pure
// decision function keyed off the owning card's persisted trust grant × the render-mode setting.
// Fail-closed contract: only an explicit `trusted: true` on a present card may run same-origin.

const route = (over: {
  hasCard?: boolean
  trusted?: boolean
  decided?: boolean
  mode?: CardRenderMode
  globalMode?: CardRenderMode
}): string =>
  resolveScriptedHtmlRoute({
    hasCard: over.hasCard ?? true,
    trusted: over.trusted,
    decided: over.decided,
    mode: over.mode,
    globalMode: over.globalMode ?? 'inline'
  })

describe('resolveScriptedHtmlRoute — no active card', () => {
  it('bare model HTML with no provenance renders static, whatever the mode/grants', () => {
    expect(route({ hasCard: false, globalMode: 'inline' })).toBe('static')
    expect(route({ hasCard: false, globalMode: 'isolated' })).toBe('static')
    // A grant can never be attributed without a card, but even if one leaked in, static wins.
    expect(route({ hasCard: false, trusted: true, globalMode: 'inline' })).toBe('static')
  })
})

describe('resolveScriptedHtmlRoute — trusted card (current behavior)', () => {
  it('inline global mode → inline (pins the pre-change behavior)', () => {
    expect(route({ trusted: true, decided: true, globalMode: 'inline' })).toBe('inline')
  })
  it('isolated global mode → isolated', () => {
    expect(route({ trusted: true, decided: true, globalMode: 'isolated' })).toBe('isolated')
  })
  it('panel global mode routes like non-isolated → inline (parity with prior === isolated check)', () => {
    expect(route({ trusted: true, decided: true, globalMode: 'panel' })).toBe('inline')
  })
  it('per-card override beats the global default (isolated over inline)', () => {
    expect(route({ trusted: true, decided: true, mode: 'isolated', globalMode: 'inline' })).toBe(
      'isolated'
    )
  })
  it('per-card override beats the global default (inline over isolated)', () => {
    expect(route({ trusted: true, decided: true, mode: 'inline', globalMode: 'isolated' })).toBe(
      'inline'
    )
  })
  it('trusted resolves by mode even before `decided` loads (no WCV flash)', () => {
    expect(route({ trusted: true, decided: undefined, globalMode: 'inline' })).toBe('inline')
  })
})

describe('resolveScriptedHtmlRoute — decided-denied card (not trusted)', () => {
  it('renders static regardless of render mode — a denial keeps scripts off', () => {
    expect(route({ trusted: false, decided: true, globalMode: 'inline' })).toBe('static')
    expect(route({ trusted: false, decided: true, globalMode: 'isolated' })).toBe('static')
    expect(route({ trusted: false, decided: true, mode: 'inline', globalMode: 'isolated' })).toBe(
      'static'
    )
  })
})

describe('resolveScriptedHtmlRoute — undecided / unknown card (fail-closed)', () => {
  it('undecided card is forced isolated (WCV) regardless of render-mode setting', () => {
    expect(route({ trusted: false, decided: false, globalMode: 'inline' })).toBe('isolated')
    expect(route({ trusted: false, decided: false, globalMode: 'isolated' })).toBe('isolated')
    // A per-card `inline` override must NOT let an undecided card go same-origin.
    expect(route({ trusted: false, decided: false, mode: 'inline', globalMode: 'inline' })).toBe(
      'isolated'
    )
  })
  it('grants not yet resolved (both undefined) fail closed to isolated, never inline', () => {
    expect(route({ trusted: undefined, decided: undefined, globalMode: 'inline' })).toBe('isolated')
  })
})
