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
  it("TYPES_BY_CATEGORY lists each category's types", () => {
    expect(TYPES_BY_CATEGORY.character).toEqual(['头像', '立绘'])
    expect(TYPES_BY_CATEGORY.location).toEqual(['背景', '全景'])
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
    // Unknown/garbage type ⇒ character (old hardcoded default preserved).
    expect(categoryForType('nonsense' as never)).toBe('character')
  })
})
