import { create } from 'zustand'
import type { CharacterCoverage } from '../../../shared/worldAssets/coverage'
import type { RemoteAssetListItem } from '../../../shared/worldAssets/remote'
import type { AssetIndex, AssetType } from '../../../shared/worldAssets/types'
import { ASSET_EXTS, isAssetMediaTypeAllowed } from '../../../shared/worldAssets/types'
import { buildAssetFilename, parseAssetFilename } from '../../../shared/worldAssets/filename'

/** The active world's lorebook ids: the chat's session ids, else the character's own book. */
export function lorebookIdsForWorld(
  activeCharacterId: string | null,
  sessionIds: string[] | null
): string[] {
  if (sessionIds && sessionIds.length) return sessionIds
  return activeCharacterId ? [activeCharacterId] : []
}

// ── Pure helpers (unit-tested; no store/IPC) ─────────────────────────────────────────────────────

/** A single row in the import wizard: one dropped/picked file bound to a name/type/variant. */
export interface WizardRow {
  id: string
  srcPath: string
  name: string
  type: AssetType
  variant: string
  ext: string
}

/** Lowercased extension of a path/basename, or '' when there's no recognizable one. */
export function extOf(pathOrName: string): string {
  const dot = pathOrName.lastIndexOf('.')
  return dot >= 0 ? pathOrName.slice(dot + 1).toLowerCase() : ''
}

/** basename of an OS path (handles both separators). */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/** Per-row validity for the wizard: name must be non-empty, extension must be supported. */
export function validateWizardRow(row: { name: string; type: AssetType; ext: string }): {
  valid: boolean
  error?: 'name' | 'ext' | 'type'
} {
  if (!row.name.trim()) return { valid: false, error: 'name' }
  if (!(ASSET_EXTS as readonly string[]).includes(row.ext.toLowerCase()))
    return { valid: false, error: 'ext' }
  if (!isAssetMediaTypeAllowed(row.type, row.ext)) return { valid: false, error: 'type' }
  return { valid: true }
}

/** The final on-disk filename a wizard row will produce, or '' when the row is invalid. */
export function filenamePreview(row: {
  name: string
  type: AssetType
  variant: string
  ext: string
}): string {
  const check = validateWizardRow(row)
  if (!check.valid) return ''
  const variant = row.variant.trim() || undefined
  return buildAssetFilename({
    name: row.name.trim(),
    type: row.type,
    mood: variant,
    ext: row.ext.toLowerCase() as (typeof ASSET_EXTS)[number]
  })
}

/** Classify a dropped file: does its basename already parse to the convention (and, if so, what)?
 *  The view uses this to decide direct-import vs. sending the file to the naming wizard. */
export function classifyDropped(
  srcPath: string
): { name: string; type: AssetType; variant: string; ext: string } | null {
  const parsed = parseAssetFilename(baseName(srcPath))
  if (!parsed) return null
  return { name: parsed.name, type: parsed.type, variant: parsed.mood ?? '', ext: parsed.ext }
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────

interface ImportResult {
  imported: number
  skipped: number
  skippedReasons?: string[]
}

export type RemoteAssetEntry = RemoteAssetListItem

interface AssetState {
  /** Merged AssetIndex across the world's lorebook ids (all categories) — the grid's data source. */
  index: AssetIndex
  /** Character-category coverage rows (roster union): the 人物 grid + the coverage meter. */
  coverage: CharacterCoverage[]
  /** Legacy char_info_visuals entries for the active chat. Read-only and fetched on demand. */
  remoteAssets: RemoteAssetEntry[]
  loading: boolean
  remoteLoading: boolean
  remoteError: boolean
  load: (profileId: string, lorebookIds: string[], roster: string[]) => Promise<void>
  loadRemote: (profileId: string, chatId: string | null) => Promise<void>
  refresh: (profileId: string, lorebookIds: string[], roster: string[]) => Promise<void>
  importFiles: (
    profileId: string,
    lorebookId: string,
    lorebookIds: string[],
    roster: string[],
    items: { srcPath: string; name: string; type: AssetType; variant?: string }[]
  ) => Promise<ImportResult | null>
  deleteFile: (
    profileId: string,
    lorebookId: string,
    lorebookIds: string[],
    roster: string[],
    category: string,
    file: string
  ) => Promise<boolean>
  renameVariant: (
    profileId: string,
    lorebookId: string,
    lorebookIds: string[],
    roster: string[],
    category: string,
    file: string,
    newVariant: string
  ) => Promise<
    { ok: true; file: string } | { ok: false; error: 'not-found' | 'invalid' | 'collision' | 'failed' }
  >
  exportZip: (profileId: string, lorebookId: string) => Promise<{ entries: number } | null>
}

export const useAssetStore = create<AssetState>((set) => {
  let remoteLoadSeq = 0
  let remoteChatKey: string | null = null
  const reload = async (
    profileId: string,
    lorebookIds: string[],
    roster: string[]
  ): Promise<void> => {
    if (!lorebookIds.length) {
      set({ index: {}, coverage: [], loading: false })
      return
    }
    try {
      const [index, coverage] = await Promise.all([
        window.api.assetListIndex(profileId, lorebookIds) as Promise<AssetIndex>,
        window.api.assetCoverage(profileId, lorebookIds, 'character', roster) as Promise<
          CharacterCoverage[]
        >
      ])
      set({ index: index ?? {}, coverage: coverage ?? [], loading: false })
    } catch {
      set({ loading: false })
    }
  }

  return {
    index: {},
    coverage: [],
    remoteAssets: [],
    loading: false,
    remoteLoading: false,
    remoteError: false,
    load: async (profileId, lorebookIds, roster) => {
      set({ loading: true })
      await reload(profileId, lorebookIds, roster)
    },
    loadRemote: async (profileId, chatId) => {
      const request = ++remoteLoadSeq
      if (!chatId) {
        remoteChatKey = null
        set({ remoteAssets: [], remoteLoading: false, remoteError: false })
        return
      }
      const key = profileId + ' ' + chatId
      if (key !== remoteChatKey) {
        // Chat/profile switch: drop the stale list right away.
        remoteChatKey = key
        set({ remoteAssets: [], remoteLoading: true, remoteError: false })
      } else {
        // Same chat refresh: keep the current list visible until the fetch resolves.
        set({ remoteLoading: true, remoteError: false })
      }
      try {
        const remoteAssets = (await window.api.remoteAssetList(
          profileId,
          chatId
        )) as RemoteAssetEntry[]
        if (request !== remoteLoadSeq) return
        set({ remoteAssets: remoteAssets ?? [], remoteLoading: false, remoteError: false })
      } catch {
        if (request !== remoteLoadSeq) return
        // Keep whatever list is currently shown; only flag the error.
        set({ remoteLoading: false, remoteError: true })
      }
    },
    refresh: async (profileId, lorebookIds, roster) => {
      await window.api.assetRefresh(profileId, lorebookIds)
      set({ loading: true })
      await reload(profileId, lorebookIds, roster)
    },
    importFiles: async (profileId, lorebookId, lorebookIds, roster, items) => {
      if (!lorebookId || !items.length) return null
      const res = (await window.api.assetImportFiles(profileId, lorebookId, items)) as ImportResult
      await reload(profileId, lorebookIds, roster)
      return res
    },
    deleteFile: async (profileId, lorebookId, lorebookIds, roster, category, file) => {
      if (!lorebookId) return false
      const ok = (await window.api.assetDeleteFile(profileId, lorebookId, category, file)) as boolean
      if (ok) await reload(profileId, lorebookIds, roster)
      return ok
    },
    renameVariant: async (profileId, lorebookId, lorebookIds, roster, category, file, newVariant) => {
      const res = (await window.api.assetRenameVariant(
        profileId,
        lorebookId,
        category,
        file,
        newVariant
      )) as
        | { ok: true; file: string }
        | { ok: false; error: 'not-found' | 'invalid' | 'collision' | 'failed' }
      if (res.ok) await reload(profileId, lorebookIds, roster)
      return res
    },
    exportZip: async (profileId, lorebookId) => {
      if (!lorebookId) return null
      const res = (await window.api.assetExportZipDialog(profileId, lorebookId)) as {
        entries: number
      } | null
      return res
    }
  }
})
