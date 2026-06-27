import { describe, it, expect } from 'vitest'
import { lorebookIdsForWorld } from '../src/renderer/src/stores/assetStore'

describe('lorebookIdsForWorld', () => {
  it('uses the session lorebook ids when present', () => {
    expect(lorebookIdsForWorld('charA', ['lbX', 'lbY'])).toEqual(['lbX', 'lbY'])
  })
  it('falls back to the character id when there are no session ids', () => {
    expect(lorebookIdsForWorld('charA', null)).toEqual(['charA'])
    expect(lorebookIdsForWorld('charA', [])).toEqual(['charA'])
  })
  it('returns empty when there is no world at all', () => {
    expect(lorebookIdsForWorld(null, null)).toEqual([])
  })
})
