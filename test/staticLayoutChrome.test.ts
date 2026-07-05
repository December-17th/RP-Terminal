import { describe, it, expect } from 'vitest'
import {
  slotIsChromed,
  type StaticSlot
} from '../src/renderer/src/components/workspace/staticLayout'

const slot = (over: Partial<StaticSlot> = {}): StaticSlot => ({
  id: 's',
  view: 'wcv',
  rect: [0, 0, 3, 12],
  ...over
})

describe('slotIsChromed — the seam decision', () => {
  it('defaults to chromed in a normal (non-seamless) layout', () => {
    expect(slotIsChromed({}, slot())).toBe(true)
    expect(slotIsChromed({ seamless: false }, slot())).toBe(true)
  })

  it('defaults to bare in a seamless layout', () => {
    expect(slotIsChromed({ seamless: true }, slot())).toBe(false)
  })

  it('a per-slot chrome flag overrides the layout default either way', () => {
    // Force chrome back on inside a seamless layout (e.g. a boxed side panel).
    expect(slotIsChromed({ seamless: true }, slot({ chrome: true }))).toBe(true)
    // Force one slot bare inside a chromed layout.
    expect(slotIsChromed({ seamless: false }, slot({ chrome: false }))).toBe(false)
  })
})
