import { describe, it, expect } from 'vitest'
import { categoryForType, TYPES_BY_CATEGORY } from '../src/shared/worldAssets/types'

describe('categoryForType', () => {
  it('maps character types', () => {
    expect(categoryForType('头像')).toBe('character')
    expect(categoryForType('立绘')).toBe('character')
  })
  it('maps location types', () => {
    expect(categoryForType('背景')).toBe('location')
    expect(categoryForType('全景')).toBe('location')
  })
  it('TYPES_BY_CATEGORY lists each category\'s types', () => {
    expect(TYPES_BY_CATEGORY.character).toEqual(['头像', '立绘'])
    expect(TYPES_BY_CATEGORY.location).toEqual(['背景', '全景'])
  })
})
