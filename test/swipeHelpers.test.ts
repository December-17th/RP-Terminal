import { describe, it, expect } from 'vitest'
import { normalizeSwipes, selectSwipe, appendSwipe } from '../src/main/services/swipeHelpers'

describe('normalizeSwipes', () => {
  it('defaults a missing swipe array to a single swipe == the response', () => {
    expect(normalizeSwipes(null, 'hi', null)).toEqual({ swipes: ['hi'], swipe_id: 0 })
    expect(normalizeSwipes(undefined, 'hi', undefined)).toEqual({ swipes: ['hi'], swipe_id: 0 })
    expect(normalizeSwipes([], 'hi', 5)).toEqual({ swipes: ['hi'], swipe_id: 0 })
  })

  it('clamps the active index into range', () => {
    expect(normalizeSwipes(['a', 'b', 'c'], 'c', 9).swipe_id).toBe(2)
    expect(normalizeSwipes(['a', 'b', 'c'], 'a', -3).swipe_id).toBe(0)
    expect(normalizeSwipes(['a', 'b', 'c'], 'b', 1).swipe_id).toBe(1)
  })

  it('copies the array (no aliasing of the stored value)', () => {
    const src = ['a', 'b']
    const out = normalizeSwipes(src, 'b', 1)
    out.swipes.push('c')
    expect(src).toEqual(['a', 'b'])
  })
})

describe('selectSwipe', () => {
  const state = { swipes: ['a', 'b', 'c'], swipe_id: 0 }
  it('selects a clamped index and returns its content', () => {
    expect(selectSwipe(state, 1)).toEqual({ swipe_id: 1, content: 'b' })
    expect(selectSwipe(state, 99)).toEqual({ swipe_id: 2, content: 'c' })
    expect(selectSwipe(state, -1)).toEqual({ swipe_id: 0, content: 'a' })
  })
})

describe('appendSwipe', () => {
  it('appends a new alternate and makes it active', () => {
    expect(appendSwipe({ swipes: ['a'], swipe_id: 0 }, 'b')).toEqual({
      swipes: ['a', 'b'],
      swipe_id: 1
    })
  })
})
