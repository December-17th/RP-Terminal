export type AssetCategory = 'character' | 'location' | 'cg' | 'misc'
export const ASSET_CATEGORIES: AssetCategory[] = ['character', 'location', 'cg', 'misc']

export type AssetType = '头像' | '立绘' | '立绘bg' | '相册' | '背景' | '全景' | 'CG' | 'misc'
/** Ordered so the parser matches the longest/most-specific token deterministically.
 *  `misc` is appended last: {@link parseAssetFilename} compares WHOLE underscore segments, so no token
 *  can shadow another regardless of position, and appending leaves every existing type's relative
 *  order (notably `立绘bg` before `立绘`) byte-identical. */
export const ASSET_TYPES: AssetType[] = [
  '立绘bg',
  '头像',
  '立绘',
  '相册',
  '背景',
  '全景',
  'CG',
  'misc'
]
export const DEFAULT_CHARACTER_ASSET_TYPE: AssetType = '立绘'

export const IMAGE_ASSET_EXTS = ['png', 'jpg', 'jpeg', 'jpe', 'webp', 'gif'] as const
export const VIDEO_ASSET_EXTS = ['mp4'] as const
export const ASSET_EXTS = [...IMAGE_ASSET_EXTS, ...VIDEO_ASSET_EXTS] as const
export type AssetExt = (typeof ASSET_EXTS)[number]
export type ImageAssetExt = (typeof IMAGE_ASSET_EXTS)[number]
export type VideoAssetExt = (typeof VIDEO_ASSET_EXTS)[number]
export type AssetMediaKind = 'image' | 'video'

/** MP4 has no compositing alpha in the supported path, so it is restricted to full-frame art.
 *  `misc` is general-purpose card art placed by the card itself, so it counts as full-frame like CG. */
export const VIDEO_ASSET_TYPES: AssetType[] = ['立绘bg', '背景', '全景', 'CG', 'misc']

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

/** One `misc` asset as a card sees it through `miscAssets()` (M3). The app does NOT match on the card's
 *  behalf — it hands over the whole list and the card UI parses it. Local entries come from a world's
 *  `misc` category index (`<name>_misc[_<variant>].<ext>`); remote entries come from the newest persisted
 *  floor's `rpt_misc_assets` bag, which has no variant concept (`variant` is always null there). */
export interface MiscAssetItem {
  /** The asset name — the `<name>` segment of the filename, or the bag key for a remote entry. */
  name: string
  /** The mood/variant token; null for the base file (and for every remote entry). */
  variant: string | null
  /** `rptasset://…` for a local file, `rptremoteasset://misc/…` for a remote declaration. */
  url: string
  /** True when this entry came from the `rpt_misc_assets` floor bag rather than a local file. */
  remote: boolean
}

/** Which category each asset type belongs to
 *  (头像/立绘/立绘bg/相册 → character, 背景/全景 → location, CG → cg, misc → misc). */
export const TYPES_BY_CATEGORY: Record<AssetCategory, AssetType[]> = {
  character: ['立绘', '立绘bg', '头像', '相册'],
  location: ['背景', '全景'],
  cg: ['CG'],
  misc: ['misc']
}

/** Real lookup over {@link TYPES_BY_CATEGORY}: each known type routes to its own
 *  category (a `CG` type resolves to `cg`, never the character fallback). Any UNKNOWN string —
 *  the old hardcoded default — still falls back to `character` so callers that carry no category
 *  (a card's `assetUrl(name, type)`) degrade safely. */
export function categoryForType(type: AssetType): AssetCategory {
  for (const category of ASSET_CATEGORIES) {
    if ((TYPES_BY_CATEGORY[category] as string[]).includes(type)) return category
  }
  return 'character'
}
