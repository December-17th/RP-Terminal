// src/main/services/worldAssetService.ts
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { getAppDir, ensureDir, listFilesSync } from './storageService'
import { log } from './logService'
import { parseAssetFilename } from '../../shared/worldAssets/filename'
import { resolveAsset } from '../../shared/worldAssets/resolve'
import { computeCoverage, CharacterCoverage } from '../../shared/worldAssets/coverage'
import { AssetCategory, AssetIndex, AssetType, ASSET_CATEGORIES } from '../../shared/worldAssets/types'

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
