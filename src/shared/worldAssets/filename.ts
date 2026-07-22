import {
  ASSET_TYPES,
  ASSET_EXTS,
  AssetExt,
  AssetType,
  ParsedAssetName,
  isAssetMediaTypeAllowed
} from './types'

/** Parse `<name>_<type>[_<mood>].<ext>`. Anchors on the known type token so names may
 *  themselves contain underscores. Returns null if no type token or unknown extension. */
export function parseAssetFilename(filename: string): ParsedAssetName | null {
  const trimmed = filename.trim()
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = trimmed
    .slice(dot + 1)
    .trim()
    .toLowerCase()
  if (!(ASSET_EXTS as readonly string[]).includes(ext)) return null

  const stem = trimmed.slice(0, dot)
  const segments = stem
    .split('_')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  // Find the type token, scanning from the right so a trailing mood doesn't shadow it.
  let typeIdx = -1
  let type: AssetType | null = null
  for (let i = segments.length - 1; i >= 0; i--) {
    if ((ASSET_TYPES as string[]).includes(segments[i])) {
      typeIdx = i
      type = segments[i] as AssetType
      break
    }
  }
  if (typeIdx <= 0 || !type) return null // need at least one name segment before the type
  if (!isAssetMediaTypeAllowed(type, ext)) return null

  const name = segments.slice(0, typeIdx).join('_')
  const moodSegs = segments.slice(typeIdx + 1)
  const mood = moodSegs.length ? moodSegs.join('_') : undefined
  return { name, type, mood, ext: ext as AssetExt }
}

/** Inverse of parseAssetFilename (used by tests + future tooling). */
export function buildAssetFilename(p: ParsedAssetName): string {
  if (!isAssetMediaTypeAllowed(p.type, p.ext)) {
    throw new TypeError(`.${p.ext} is not supported for ${p.type}`)
  }
  const core = p.mood ? `${p.name}_${p.type}_${p.mood}` : `${p.name}_${p.type}`
  return `${core}.${p.ext}`
}
