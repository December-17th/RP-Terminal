// test/yuzu/vnPrompt.test.ts
//
// Project Yuzu WP-S1 — unit tests for the VN-mode prompt overlay builder (buildVnOverlay). The world-asset
// index is mocked directly (per-id) so the merge/order/fail-soft behavior is exercised without any fs.
import { describe, it, expect, vi } from 'vitest'

// getIndex(profileId, id) → the per-id fixture index. 'throw' simulates an unreadable index (fail-soft
// path); any other unknown id yields {} (an id with no assets), matching worldAssetService's real return.
const indexes = vi.hoisted(() => ({
  map: {} as Record<string, unknown>
}))
vi.mock('../../src/main/services/worldAssetService', () => ({
  getIndex: (_p: string, id: string) => {
    if (indexes.map[id] === 'throw') throw new Error('unreadable index')
    return indexes.map[id] ?? {}
  }
}))

import { buildVnOverlay, VN_MODE_FRAMING } from '../../src/main/services/yuzu/vnPrompt'

const bookA = {
  character: { kaede: { 立绘: { moods: { neutral: 'a.png', smile: 'b.png' } } } },
  location: { classroom: { 背景: { moods: {} } } }
}
const bookB = {
  character: { yuzu: { 立绘: { moods: { neutral: 'c.png', worried: 'd.png' } } } },
  location: { rooftop: { 背景: { moods: {} } } },
  cg: { cg_confession: { CG: { moods: {} } } }
}

describe('buildVnOverlay', () => {
  it('always emits the framing + grammar, even with zero assets', () => {
    indexes.map = { empty: {} }
    const overlay = buildVnOverlay('p', ['empty'])
    expect(overlay).toContain(VN_MODE_FRAMING)
    expect(overlay).toContain('Yuzu Scene Script')
    // The grammar (post-Y1) teaches the raw MVU effect form.
    expect(overlay).toContain('<| effect <mvu-command> |>')
    // Vocabulary block is present but its id lists are empty (label present, no ids after it).
    const actorsLine = overlay.split('\n').find((l) => l.includes('actors (dialogue')) ?? ''
    expect(actorsLine.trim()).toBe('- actors (dialogue speaker / sprite / who is present):')
  })

  it('merges the vocabulary across multiple books, sorted + deduped', () => {
    indexes.map = { a: bookA, b: bookB }
    const overlay = buildVnOverlay('p', ['a', 'b'])
    expect(overlay).toContain('kaede, yuzu') // actors union, sorted
    expect(overlay).toContain('neutral, smile, worried') // moods union across books, sorted
    expect(overlay).toContain('classroom, rooftop') // locations union, sorted
    expect(overlay).toContain('cg_confession')
  })

  it('is deterministic regardless of lorebook-id order', () => {
    indexes.map = { a: bookA, b: bookB }
    expect(buildVnOverlay('p', ['b', 'a'])).toBe(buildVnOverlay('p', ['a', 'b']))
  })

  it('is fail-soft: an unreadable index contributes nothing (no throw)', () => {
    indexes.map = { a: bookA, bad: 'throw' }
    const overlay = buildVnOverlay('p', ['a', 'bad'])
    // Still a valid overlay carrying book a's vocab; the bad id simply adds nothing.
    expect(overlay).toContain('kaede')
    expect(overlay).toContain('classroom')
  })

  it('dedupes an id repeated across the list', () => {
    indexes.map = { a: bookA }
    const overlay = buildVnOverlay('p', ['a', 'a'])
    // kaede appears once in the actors line, not twice.
    const actorsLine = overlay.split('\n').find((l) => l.includes('actors (dialogue')) ?? ''
    expect(actorsLine.match(/kaede/g)?.length).toBe(1)
  })
})
