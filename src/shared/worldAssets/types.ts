export type AssetCategory = 'character' | 'location' | 'cg'
export const ASSET_CATEGORIES: AssetCategory[] = ['character', 'location', 'cg']

export type AssetType = '头像' | '立绘' | '相册' | '背景' | '全景' | 'CG'
/** Ordered so the parser matches the longest/most-specific token deterministically. */
export const ASSET_TYPES: AssetType[] = ['头像', '立绘', '相册', '背景', '全景', 'CG']

export const ASSET_EXTS = ['png', 'jpg', 'jpeg', 'jpe', 'webp', 'gif'] as const
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

/** Which category each asset type belongs to
 *  (头像/立绘/相册 → character, 背景/全景 → location, CG → cg). */
export const TYPES_BY_CATEGORY: Record<AssetCategory, AssetType[]> = {
  character: ['头像', '立绘', '相册'],
  location: ['背景', '全景'],
  cg: ['CG']
}

/** Real lookup over {@link TYPES_BY_CATEGORY}: each of the six known types routes to its own
 *  category (a `CG` type resolves to `cg`, never the character fallback). Any UNKNOWN string —
 *  the old hardcoded default — still falls back to `character` so callers that carry no category
 *  (a card's `assetUrl(name, type)`) degrade safely. */
export function categoryForType(type: AssetType): AssetCategory {
  for (const category of ASSET_CATEGORIES) {
    if ((TYPES_BY_CATEGORY[category] as string[]).includes(type)) return category
  }
  return 'character'
}
