export type AssetCategory = 'character' | 'location'
export const ASSET_CATEGORIES: AssetCategory[] = ['character', 'location']

export type AssetType = '头像' | '立绘' | '背景' | '全景'
/** Ordered so the parser matches the longest/most-specific token deterministically. */
export const ASSET_TYPES: AssetType[] = ['头像', '立绘', '背景', '全景']

export const ASSET_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export type AssetExt = (typeof ASSET_EXTS)[number]

export interface ParsedAssetName {
  name: string
  type: AssetType
  mood?: string
  ext: AssetExt
}

/** One asset-type's files for a character: an optional base + any mood variants. */
export interface AssetTypeEntry {
  base?: string // filename of the no-mood variant
  moods: Record<string, string> // mood token -> filename
}
export type AssetNameEntry = Partial<Record<AssetType, AssetTypeEntry>>
export type AssetCategoryIndex = Record<string, AssetNameEntry> // name -> entry
export type AssetIndex = Record<string, AssetCategoryIndex> // category -> name -> ...

/** Which category each asset type belongs to (头像/立绘 → character, 背景/全景 → location). */
export const TYPES_BY_CATEGORY: Record<AssetCategory, AssetType[]> = {
  character: ['头像', '立绘'],
  location: ['背景', '全景']
}

export function categoryForType(type: AssetType): AssetCategory {
  return TYPES_BY_CATEGORY.location.includes(type) ? 'location' : 'character'
}
