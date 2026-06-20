import { describe, it, expect } from 'vitest'
import {
  classify,
  asValueDesc,
  asBar,
  formatPrimitive,
  isPlainObject
} from '../src/renderer/src/components/statViewHelpers'

describe('statView helpers', () => {
  it('detects value/description tuples and {value, description} objects', () => {
    expect(asValueDesc([80, 'current hp'])).toEqual({ value: 80, description: 'current hp' })
    expect(asValueDesc({ value: 'sword', description: 'rusty' })).toEqual({
      value: 'sword',
      description: 'rusty'
    })
    expect(asValueDesc([1, 2])).toBeNull() // 2nd element not a string
    expect(asValueDesc('plain')).toBeNull()
  })

  it('detects value/max (or current/max) bars', () => {
    expect(asBar({ value: 30, max: 100 })).toEqual({ value: 30, max: 100 })
    expect(asBar({ current: 5, max: 10 })).toEqual({ value: 5, max: 10 })
    expect(asBar({ value: 30 })).toBeNull() // no max
    expect(asBar({ value: 'x', max: 100 })).toBeNull() // non-numeric value
  })

  it('classifies nodes (bar > valueDesc > array > object > primitive)', () => {
    expect(classify({ value: 30, max: 100 })).toBe('bar')
    expect(classify([80, 'hp'])).toBe('valueDesc')
    expect(classify([1, 2, 3])).toBe('array')
    expect(classify({ a: 1 })).toBe('object')
    expect(classify(42)).toBe('primitive')
    expect(classify('s')).toBe('primitive')
  })

  it('formats primitives', () => {
    expect(formatPrimitive(true)).toBe('✓')
    expect(formatPrimitive(false)).toBe('✗')
    expect(formatPrimitive(null)).toBe('—')
    expect(formatPrimitive(undefined)).toBe('—')
    expect(formatPrimitive(7)).toBe('7')
  })

  it('isPlainObject is true only for non-array objects', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})
