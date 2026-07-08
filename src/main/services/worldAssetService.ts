// src/main/services/worldAssetService.ts
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { getAppDir, ensureDir, listFilesSync } from './storageService'
import { log } from './logService'
import AdmZip from 'adm-zip'
import { parseAssetFilename, buildAssetFilename } from '../../shared/worldAssets/filename'
import { resolveAsset } from '../../shared/worldAssets/resolve'
import { computeCoverage, CharacterCoverage } from '../../shared/worldAssets/coverage'
import {
  AssetCategory,
  AssetExt,
  AssetIndex,
  AssetType,
  ASSET_CATEGORIES,
  ASSET_EXTS,
  ASSET_TYPES,
  categoryForType
} from '../../shared/worldAssets/types'

/** `<appDir>/profiles/<profileId>/lorebooks/<lorebookId>.assets` */
const worldAssetsRoot = (profileId: string, lorebookId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'lorebooks', `${lorebookId}.assets`)

export const assetsDir = (profileId: string, lorebookId: string, category: AssetCategory): string =>
  path.join(worldAssetsRoot(profileId, lorebookId), category)

/** Scan a `<lorebookId>.assets` dir into an AssetIndex. Skips `_index.json` + `.thumbs`. */
export function buildIndex(rootDir: string): AssetIndex {
  const index: AssetIndex = {}
  for (const category of ASSET_CATEGORIES) {
    const dir = path.join(rootDir, category)
    const names: AssetIndex[string] = {}
    for (const file of listFilesSync(dir)) {
      if (file === '_index.json' || file.startsWith('.')) continue
      const parsed = parseAssetFilename(file)
      if (!parsed) continue
      const entry = (names[parsed.name] ??= {})
      const typeEntry = (entry[parsed.type] ??= { moods: {} })
      if (parsed.mood) typeEntry.moods[parsed.mood] = file
      else typeEntry.base = file
    }
    if (Object.keys(names).length) index[category] = names
  }
  return index
}

// Cache keyed by `${profileId}/${lorebookId}`; invalidated on refresh or fs.watch event.
const cache = new Map<string, AssetIndex>()
const watchers = new Map<string, fs.FSWatcher>()
const cacheKey = (p: string, l: string): string => `${p}/${l}`

/** Persist the manifest next to the assets (best-effort; portability + a future fast path). */
const writeManifest = (root: string, index: AssetIndex): void => {
  try {
    ensureDir(root)
    fs.writeFileSync(path.join(root, '_index.json'), JSON.stringify(index, null, 2), 'utf-8')
  } catch (e) {
    log('error', '[world-assets] manifest write failed', e)
  }
}

export function getIndex(
  profileId: string,
  lorebookId: string,
  opts?: { refresh?: boolean }
): AssetIndex {
  const key = cacheKey(profileId, lorebookId)
  if (!opts?.refresh && cache.has(key)) return cache.get(key)!
  const root = worldAssetsRoot(profileId, lorebookId)
  const index = buildIndex(root)
  cache.set(key, index)
  // Only persist when there's art — don't create an empty `.assets` dir just to write `{}`.
  if (Object.keys(index).length) writeManifest(root, index)
  // Best-effort live invalidation. fs.watch is built-in; failures are non-fatal (manual refresh
  // remains the reliable path). One watcher per world, recursive where supported (Windows/macOS).
  if (!watchers.has(key) && fs.existsSync(root)) {
    try {
      const w = fs.watch(root, { recursive: true }, () => cache.delete(key))
      watchers.set(key, w)
    } catch {
      /* recursive watch unsupported here — rely on refresh */
    }
  }
  return index
}

/** Drop ONE world's cached index and close its watcher — call when its lorebook is deleted.
 *  For a full reset (tests / profile-wide clear) use {@link clearAssetCache}. */
export function invalidateWorldAssets(profileId: string, lorebookId: string): void {
  const key = cacheKey(profileId, lorebookId)
  const w = watchers.get(key)
  if (w) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
    watchers.delete(key)
  }
  cache.delete(key)
}

/** Reset the entire in-memory index cache and close all watchers. Use in test setup/teardown
 *  (the Maps are module-level) or for a profile-wide reset. For per-world invalidation on
 *  lorebook delete use {@link invalidateWorldAssets} instead. */
export function clearAssetCache(): void {
  for (const w of watchers.values()) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  watchers.clear()
  cache.clear()
}

/** Map a protocol request to a validated absolute path inside the world's assets root. */
export function resolveProtocolPath(
  profileId: string,
  lorebookId: string,
  category: string,
  file: string
): string | null {
  if (!(ASSET_CATEGORIES as readonly string[]).includes(category)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(file)
  } catch {
    return null
  }
  const root = worldAssetsRoot(profileId, lorebookId)
  const abs = path.resolve(root, category, decoded)
  const base = path.resolve(root) + path.sep
  if (!abs.startsWith(base)) return null // escaped the assets root
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return abs
}

export function resolveAssetFile(
  profileId: string,
  lorebookIds: string[],
  category: AssetCategory,
  name: string,
  type: AssetType,
  mood?: string
): { lorebookId: string; absPath: string; usedMood: string | null } | null {
  const indexes = lorebookIds.map((id) => getIndex(profileId, id))
  const hit = resolveAsset({ indexes, category, name, type, mood })
  if (!hit) return null
  const lorebookId = lorebookIds[hit.indexPos]
  return {
    lorebookId,
    absPath: path.join(assetsDir(profileId, lorebookId, category), hit.filename),
    usedMood: hit.usedMood
  }
}

/** Resolve an asset to an rptasset:// URL for one world's lorebook ids, or null. The category
 *  is inferred from the asset TYPE via {@link categoryForType} (头像/立绘 → character, 背景/全景 →
 *  location), so a card's `window.assetUrl(name, type, mood)` — which carries no category — can reach
 *  location art, not just character portraits. Unknown types fall back to `character`. */
export function assetUrlForWorld(
  profileId: string,
  lorebookIds: string[],
  name: string,
  type: AssetType,
  mood?: string
): string | null {
  const category: AssetCategory = categoryForType(type)
  const hit = resolveAssetFile(profileId, lorebookIds, category, name, type, mood)
  if (!hit) return null
  const file = hit.absPath.split(/[\\/]/).pop() as string
  return `rptasset://${profileId}/${hit.lorebookId}/${category}/${encodeURIComponent(file)}`
}

export function listCoverage(
  profileId: string,
  lorebookIds: string[],
  category: AssetCategory,
  rosterNames: string[]
): CharacterCoverage[] {
  // Merge the per-lorebook category indexes (earlier ids win on name collisions).
  const merged: AssetIndex[string] = {}
  for (const id of [...lorebookIds].reverse()) {
    const cat = getIndex(profileId, id)[category]
    if (cat) Object.assign(merged, cat)
  }
  return computeCoverage(merged, rosterNames)
}

export function openAssetsFolder(
  profileId: string,
  lorebookId: string,
  category: AssetCategory
): void {
  const dir = assetsDir(profileId, lorebookId, category)
  ensureDir(dir)
  void shell.openPath(dir)
}

export interface ImportAssetsResult {
  imported: number
  skipped: number
  byCategory: Record<string, number>
  skippedReasons: string[]
}

/** Extract a `.assets`-mirroring zip into one world's asset folders. Only `<category>/<file>`
 *  entries whose basename parses to the convention AND whose type matches the category are written
 *  (overwriting); everything else is skipped with a reason. Benign noise is skipped silently. Safe
 *  against path traversal. Invalidates the world's asset cache when anything was written. */
export function importAssetsZip(
  profileId: string,
  lorebookId: string,
  zipPath: string
): ImportAssetsResult {
  const result: ImportAssetsResult = { imported: 0, skipped: 0, byCategory: {}, skippedReasons: [] }
  let entries: AdmZip.IZipEntry[]
  try {
    entries = new AdmZip(zipPath).getEntries()
  } catch {
    result.skipped++
    result.skippedReasons.push('invalid or unreadable zip')
    return result
  }
  const base = path.resolve(worldAssetsRoot(profileId, lorebookId)) + path.sep
  const skip = (reason: string): void => {
    result.skipped++
    result.skippedReasons.push(reason)
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    const parts = name.split('/').filter(Boolean)
    // Benign archive noise — skip silently (not a user error).
    if (
      parts[0] === '__MACOSX' ||
      parts.some((p) => p.startsWith('.')) ||
      parts.includes('_index.json')
    )
      continue
    if (parts.length !== 2) {
      skip(`outside category folder: ${name}`)
      continue
    }
    const [category, file] = parts
    if (!(ASSET_CATEGORIES as readonly string[]).includes(category)) {
      skip(`unknown category: ${name}`)
      continue
    }
    const parsed = parseAssetFilename(file)
    if (!parsed) {
      skip(`unrecognized name: ${name}`)
      continue
    }
    if (categoryForType(parsed.type) !== category) {
      skip(`wrong category for type: ${name}`)
      continue
    }
    const destDir = assetsDir(profileId, lorebookId, category as AssetCategory)
    const dest = path.resolve(destDir, file)
    if (!dest.startsWith(base)) {
      skip(`unsafe path: ${name}`)
      continue
    }
    try {
      ensureDir(destDir)
      fs.writeFileSync(dest, entry.getData())
      result.imported++
      result.byCategory[category] = (result.byCategory[category] ?? 0) + 1
    } catch {
      skip(`write failed: ${name}`)
    }
  }
  if (result.imported > 0) invalidateWorldAssets(profileId, lorebookId)
  return result
}

// ── Manager surface (WA-2) ──────────────────────────────────────────────────────────────────────
// The `assets` workspace view's read + mutation API. Every write re-validates its destination inside
// the world's assets root (the same root-escape guard {@link resolveProtocolPath} uses) and
// invalidates the world's index cache, so the grid re-reads fresh state after any change.

/** Merged AssetIndex across a world's lorebook ids (all categories) — earlier ids win on a name
 *  collision, mirroring {@link listCoverage}'s merge rule. The `assets` grid's single data source. */
export function getMergedIndex(profileId: string, lorebookIds: string[]): AssetIndex {
  const merged: AssetIndex = {}
  // Reverse so the EARLIEST id is applied last and wins on a name collision (like listCoverage).
  for (const id of [...lorebookIds].reverse()) {
    const idx = getIndex(profileId, id)
    for (const category of ASSET_CATEGORIES) {
      const cat = idx[category]
      if (!cat) continue
      Object.assign((merged[category] ??= {}), cat)
    }
  }
  return merged
}

export interface ImportFileItem {
  srcPath: string
  name: string
  type: AssetType
  variant?: string
}
export interface ImportFilesResult {
  imported: number
  skipped: number
  skippedReasons: string[]
}

/** Copy picked source files into a world's asset folders under the naming convention. Each item is
 *  validated (known type, non-empty name, allowed extension) and its DEST is re-checked inside the
 *  assets root — a traversal-laden `name`/`variant` is rejected, not written. Overwrites an existing
 *  convention file (that IS replace). Invalidates the cache when anything landed. */
export function importAssetFiles(
  profileId: string,
  lorebookId: string,
  items: ImportFileItem[]
): ImportFilesResult {
  const result: ImportFilesResult = { imported: 0, skipped: 0, skippedReasons: [] }
  const base = path.resolve(worldAssetsRoot(profileId, lorebookId)) + path.sep
  const skip = (reason: string): void => {
    result.skipped++
    result.skippedReasons.push(reason)
  }
  for (const item of items) {
    const name = (item.name ?? '').trim()
    if (!name) {
      skip('empty name')
      continue
    }
    if (!(ASSET_TYPES as string[]).includes(item.type)) {
      skip(`unknown type: ${item.type}`)
      continue
    }
    const dot = item.srcPath.lastIndexOf('.')
    const ext = dot >= 0 ? item.srcPath.slice(dot + 1).toLowerCase() : ''
    if (!(ASSET_EXTS as readonly string[]).includes(ext)) {
      skip(`unsupported extension: ${item.srcPath}`)
      continue
    }
    const category = categoryForType(item.type)
    const variant = item.variant?.trim() || undefined
    const file = buildAssetFilename({ name, type: item.type, mood: variant, ext: ext as AssetExt })
    const destDir = assetsDir(profileId, lorebookId, category)
    const dest = path.resolve(destDir, file)
    if (!dest.startsWith(base)) {
      skip(`unsafe destination: ${file}`)
      continue
    }
    try {
      ensureDir(destDir)
      fs.copyFileSync(item.srcPath, dest)
      result.imported++
    } catch {
      skip(`copy failed: ${item.srcPath}`)
    }
  }
  if (result.imported > 0) invalidateWorldAssets(profileId, lorebookId)
  return result
}

/** Delete one asset file (path re-validated inside the assets root). Returns false when the target
 *  can't be resolved/removed. Invalidates the cache on success. */
export function deleteAssetFile(
  profileId: string,
  lorebookId: string,
  category: string,
  file: string
): boolean {
  const abs = resolveProtocolPath(profileId, lorebookId, category, file)
  if (!abs) return false
  try {
    fs.unlinkSync(abs)
    invalidateWorldAssets(profileId, lorebookId)
    return true
  } catch {
    return false
  }
}

export type RenameVariantResult =
  | { ok: true; file: string }
  | { ok: false; error: 'not-found' | 'invalid' | 'collision' | 'failed' }

/** Rename an asset by re-tokenizing its variant (mood/slot) segment ONLY — name + type stay locked to
 *  the entry. Rebuilds the filename with the new variant and renames; rejects a collision with an
 *  existing file. Invalidates the cache on success. */
export function renameAssetVariant(
  profileId: string,
  lorebookId: string,
  category: string,
  file: string,
  newVariant: string
): RenameVariantResult {
  const abs = resolveProtocolPath(profileId, lorebookId, category, file)
  if (!abs) return { ok: false, error: 'not-found' }
  const parsed = parseAssetFilename(file)
  if (!parsed) return { ok: false, error: 'invalid' }
  const variant = newVariant?.trim() || undefined
  const newFile = buildAssetFilename({
    name: parsed.name,
    type: parsed.type,
    mood: variant,
    ext: parsed.ext
  })
  if (newFile === file) return { ok: true, file }
  const base = path.resolve(worldAssetsRoot(profileId, lorebookId)) + path.sep
  const dest = path.resolve(assetsDir(profileId, lorebookId, category as AssetCategory), newFile)
  if (!dest.startsWith(base)) return { ok: false, error: 'invalid' }
  if (fs.existsSync(dest)) return { ok: false, error: 'collision' }
  try {
    fs.renameSync(abs, dest)
    invalidateWorldAssets(profileId, lorebookId)
    return { ok: true, file: newFile }
  } catch {
    return { ok: false, error: 'failed' }
  }
}

/** Write a `.assets`-mirroring zip (`<category>/<file>`) of a world's assets — the inverse of
 *  {@link importAssetsZip}. Only convention-parsing files are included; `_index.json`/dotfiles skip. */
export function exportAssetsZip(
  profileId: string,
  lorebookId: string,
  destPath: string
): { ok: boolean; entries: number } {
  const root = worldAssetsRoot(profileId, lorebookId)
  const zip = new AdmZip()
  let entries = 0
  for (const category of ASSET_CATEGORIES) {
    const dir = path.join(root, category)
    for (const file of listFilesSync(dir)) {
      if (file === '_index.json' || file.startsWith('.')) continue
      if (!parseAssetFilename(file)) continue
      zip.addLocalFile(path.join(dir, file), category)
      entries++
    }
  }
  try {
    zip.writeZip(destPath)
    return { ok: true, entries }
  } catch (e) {
    log('error', '[world-assets] export zip failed', e)
    return { ok: false, entries: 0 }
  }
}
