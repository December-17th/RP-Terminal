import { describe, it, expect } from 'vitest'
import {
  categoryForType,
  DEFAULT_CHARACTER_ASSET_TYPE,
  TYPES_BY_CATEGORY
} from '../src/shared/worldAssets/types'

describe('categoryForType', () => {
  it('uses transparent 立绘 as the default character asset type', () => {
    expect(DEFAULT_CHARACTER_ASSET_TYPE).toBe('立绘')
  })
  it('maps character types (incl. 相册 gallery)', () => {
    expect(categoryForType('头像')).toBe('character')
    expect(categoryForType('立绘')).toBe('character')
    expect(categoryForType('立绘bg')).toBe('character')
    expect(categoryForType('相册')).toBe('character')
  })
  it('maps location types', () => {
    expect(categoryForType('背景')).toBe('location')
    expect(categoryForType('全景')).toBe('location')
  })
  it('maps CG to its own cg category (not the character fallback)', () => {
    expect(categoryForType('CG')).toBe('cg')
  })
  it('is exhaustive over all seven known types', () => {
    const routed = (['头像', '立绘', '立绘bg', '相册', '背景', '全景', 'CG'] as const).map((t) =>
      categoryForType(t)
    )
    expect(routed).toEqual([
      'character',
      'character',
      'character',
      'character',
      'location',
      'location',
      'cg'
    ])
  })
  it("TYPES_BY_CATEGORY lists each category's types", () => {
    expect(TYPES_BY_CATEGORY.character).toEqual(['立绘', '立绘bg', '头像', '相册'])
    expect(TYPES_BY_CATEGORY.location).toEqual(['背景', '全景'])
    expect(TYPES_BY_CATEGORY.cg).toEqual(['CG'])
  })

  // PM-A6: both card transports' `assetUrl(name, type, mood)` fill-in points infer the category
  // from the TYPE via THIS one function (WCV: worldAssetService.assetUrlForWorld; inline:
  // cardBridge/host.ts createInlineHost). Pin the two properties they rely on so the transports
  // stay at parity through the single shared definition:
  //  - location types resolve under `location`, so 背景/全景 can hit the location index; and
  //  - any non-location string falls back to `character`, preserving the old hardcoded behavior.
  it('is the single category-inference seam both transports flow through', () => {
    expect(categoryForType('全景')).toBe('location')
    expect(categoryForType('背景')).toBe('location')
    expect(categoryForType('头像')).toBe('character')
    expect(categoryForType('立绘')).toBe('character')
    expect(categoryForType('立绘bg')).toBe('character')
    // Unknown/garbage type ⇒ character (old hardcoded default preserved).
    expect(categoryForType('nonsense' as never)).toBe('character')
  })
})
