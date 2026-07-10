// src/main/services/cardCodeService.ts
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import { getAppDir, ensureDir } from './storageService'
import { log } from './logService'

/**
 * Card-code cartridge extractor (WP0 / A1, import side). A POD split-mode cartridge is a PNG with a
 * ZIP appended after `IEND` (detected by `stPngParser.extractAppendedZip`); this service validates the
 * ZIP and extracts its `code/` subtree to a per-character directory on disk. Serving those bytes over
 * the `rpt-card://` protocol + the trust gate is A2 (a separate PR) — this file only lands files.
 *
 * Layout mirrors the world-assets layout (per-profile): `<appDir>/profiles/<profileId>/card-code/
 * <characterId>/` (WP0 spec D2). Keyed by the freshly-minted characterId, so re-importing the same PNG
 * into two profiles (or twice) yields independent trees — no collision.
 */

/** `<appDir>/profiles/<profileId>/card-code/<characterId>/` — the extracted card-code root (D2). */
export const cardCodeRoot = (profileId: string, characterId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'card-code', characterId)

// Import-side hard caps (WP0 spec §5 — reject on breach).
const MAX_ZIP_BYTES = 8 * 1024 * 1024 // appended ZIP ≤ 8 MB
const MAX_ENTRY_BYTES = 8 * 1024 * 1024 // single extracted entry ≤ 8 MB
const MAX_TOTAL_BYTES = 32 * 1024 * 1024 // total extracted ≤ 32 MB (decompression headroom + zip-bomb guard)
const MAX_ENTRIES = 2000 // ≤ 2000 entries

export interface CartridgeManifest {
  cartridge: number
  code?: { root?: string; entries?: string[] }
}

export interface InstallCartridgeResult {
  /** Number of code files written. */
  installed: number
  /** Set when the cartridge was rejected (nothing written); the card import itself still proceeds. */
  error?: string
}

/** Normalize a manifest `code.root` prefix to a trailing-slash, forward-slash form (default `code/`). */
const normalizeRootPrefix = (root: string | undefined): string => {
  let p = (root ?? 'code/').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!p.endsWith('/')) p += '/'
  return p
}

/**
 * Reject an entry name that is absolute / drive-lettered / contains a `..` segment (mirrors the
 * root-escape guard in `worldAssetService.resolveProtocolPath`). Applied to the raw (forward-slashed)
 * entry name, so a poisoned name is caught before any path is derived from it.
 */
const isUnsafeEntryName = (name: string): boolean => {
  if (!name) return false // empty/dir markers aren't unsafe, just not extracted
  if (path.isAbsolute(name)) return true
  if (/^[a-zA-Z]:/.test(name)) return true // drive letter (Windows)
  if (name.startsWith('/') || name.startsWith('\\')) return true
  return name.split('/').some((seg) => seg === '..')
}

/**
 * Validate + extract a cartridge ZIP's `code/` subtree to {@link cardCodeRoot}. Enforces the §5 size
 * caps and rejects any traversal-suspect entry name in the WHOLE archive (defense in depth — not just
 * the code subtree). On any breach nothing is written and `{ installed: 0, error }` is returned; on
 * success the target dir is replaced fresh (idempotent re-import). Never throws for a malformed ZIP —
 * returns an `error` instead.
 */
export const installCartridgeCode = (
  profileId: string,
  characterId: string,
  zipBytes: Buffer
): InstallCartridgeResult => {
  if (zipBytes.length > MAX_ZIP_BYTES) {
    return { installed: 0, error: `cartridge ZIP exceeds ${MAX_ZIP_BYTES} bytes (${zipBytes.length})` }
  }

  let entries: AdmZip.IZipEntry[]
  try {
    entries = new AdmZip(zipBytes).getEntries()
  } catch {
    return { installed: 0, error: 'invalid or unreadable cartridge ZIP' }
  }

  if (entries.length > MAX_ENTRIES) {
    return { installed: 0, error: `cartridge has too many entries (${entries.length} > ${MAX_ENTRIES})` }
  }

  // Reject any poisoned name across the whole archive before extracting anything.
  for (const entry of entries) {
    if (isUnsafeEntryName(entry.entryName.replace(/\\/g, '/'))) {
      return { installed: 0, error: `unsafe entry name: ${entry.entryName}` }
    }
  }

  const manifestEntry = entries.find((e) => e.entryName === 'rpt-cartridge.json')
  if (!manifestEntry) return { installed: 0, error: 'missing rpt-cartridge.json manifest' }
  let manifest: CartridgeManifest
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
  } catch {
    return { installed: 0, error: 'invalid rpt-cartridge.json' }
  }
  if (!manifest || manifest.cartridge !== 1) {
    return { installed: 0, error: 'unsupported cartridge manifest version' }
  }

  const rootPrefix = normalizeRootPrefix(manifest.code?.root)
  const root = cardCodeRoot(profileId, characterId)
  const base = path.resolve(root) + path.sep

  // Pass 1: select the code subtree + enforce the size caps against the DECLARED (header) sizes so a
  // classic zip bomb (small compressed / huge declared) is rejected before any getData() decompresses.
  const toWrite: Array<{ rel: string; entry: AdmZip.IZipEntry }> = []
  let declaredTotal = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (!name.startsWith(rootPrefix)) continue // only the code/ subtree
    const rel = name.slice(rootPrefix.length)
    if (!rel) continue

    if (entry.header.size > MAX_ENTRY_BYTES) {
      return { installed: 0, error: `entry exceeds ${MAX_ENTRY_BYTES} bytes: ${name}` }
    }
    declaredTotal += entry.header.size
    if (declaredTotal > MAX_TOTAL_BYTES) {
      return { installed: 0, error: `extracted total exceeds ${MAX_TOTAL_BYTES} bytes (zip-bomb guard)` }
    }

    const abs = path.resolve(root, rel)
    if (abs !== path.resolve(root) && !abs.startsWith(base)) {
      return { installed: 0, error: `unsafe path: ${name}` }
    }
    toWrite.push({ rel, entry })
  }

  // Replace any existing tree so a re-import is idempotent.
  try {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  } catch (e) {
    log('error', '[card-code] failed to clear existing dir', e)
    return { installed: 0, error: 'could not clear existing card-code dir' }
  }

  // Pass 2: extract, re-checking the ACTUAL decompressed sizes (defence against a lying header).
  let installed = 0
  let actualTotal = 0
  for (const { rel, entry } of toWrite) {
    const data = entry.getData()
    if (data.length > MAX_ENTRY_BYTES || (actualTotal += data.length) > MAX_TOTAL_BYTES) {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* best-effort rollback */
      }
      return { installed: 0, error: `decompressed size exceeded caps: ${rootPrefix}${rel}` }
    }
    const abs = path.resolve(root, rel)
    ensureDir(path.dirname(abs))
    fs.writeFileSync(abs, data)
    installed++
  }

  return { installed }
}

/** Remove a character's extracted card-code dir (called from the character-delete path). Best-effort. */
export const deleteCardCode = (profileId: string, characterId: string): void => {
  const dir = cardCodeRoot(profileId, characterId)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    log('error', '[card-code] delete failed', e)
  }
}
