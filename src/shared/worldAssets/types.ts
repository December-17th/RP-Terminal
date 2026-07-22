export type AssetCategory = 'character' | 'location' | 'cg'
export const ASSET_CATEGORIES: AssetCategory[] = ['character', 'location', 'cg']

export type AssetType = '头像' | '立绘' | '立绘bg' | '相册' | '背景' | '全景' | 'CG'
/** Ordered so the parser matches the longest/most-specific token deterministically. */
export const ASSET_TYPES: AssetType[] = ['立绘bg', '头像', '立绘', '相册', '背景', '全景', 'CG']
export const DEFAULT_CHARACTER_ASSET_TYPE: AssetType = '立绘'

export const IMAGE_ASSET_EXTS = ['png', 'jpg', 'jpeg', 'jpe', 'webp', 'gif'] as const
export const VIDEO_ASSET_EXTS = ['mp4'] as const
export const ASSET_EXTS = [...IMAGE_ASSET_EXTS, ...VIDEO_ASSET_EXTS] as const
export type AssetExt = (typeof ASSET_EXTS)[number]
export type ImageAssetExt = (typeof IMAGE_ASSET_EXTS)[number]
export type VideoAssetExt = (typeof VIDEO_ASSET_EXTS)[number]
export type AssetMediaKind = 'image' | 'video'

/** MP4 has no compositing alpha in the supported path, so it is restricted to full-frame art. */
export const VIDEO_ASSET_TYPES: AssetType[] = ['立绘bg', '背景', '全景', 'CG']

export function isImageAssetExt(ext: string): ext is ImageAssetExt {
  return (IMAGE_ASSET_EXTS as readonly string[]).includes(ext.toLowerCase())
}

export function isVideoAssetExt(ext: string): ext is VideoAssetExt {
  return (VIDEO_ASSET_EXTS as readonly string[]).includes(ext.toLowerCase())
}

export function assetMediaKindForExt(ext: string): AssetMediaKind | null {
  if (isImageAssetExt(ext)) return 'image'
  if (isVideoAssetExt(ext)) return 'video'
  return null
}

export function isAssetMediaTypeAllowed(type: AssetType, ext: string): boolean {
  const mediaKind = assetMediaKindForExt(ext)
  return mediaKind === 'image' || (mediaKind === 'video' && VIDEO_ASSET_TYPES.includes(type))
}

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
 *  (头像/立绘/立绘bg/相册 → character, 背景/全景 → location, CG → cg). */
export const TYPES_BY_CATEGORY: Record<AssetCategory, AssetType[]> = {
  character: ['立绘', '立绘bg', '头像', '相册'],
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
