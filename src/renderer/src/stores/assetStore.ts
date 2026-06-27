import { create } from 'zustand'
import type { CharacterCoverage } from '../../../shared/worldAssets/coverage'

/** The active world's lorebook ids: the chat's session ids, else the character's own book. */
export function lorebookIdsForWorld(
  activeCharacterId: string | null,
  sessionIds: string[] | null
): string[] {
  if (sessionIds && sessionIds.length) return sessionIds
  return activeCharacterId ? [activeCharacterId] : []
}

interface AssetState {
  rows: CharacterCoverage[]
  loading: boolean
  load: (profileId: string, lorebookIds: string[], roster: string[]) => Promise<void>
  refresh: (profileId: string, lorebookIds: string[], roster: string[]) => Promise<void>
}

export const useAssetStore = create<AssetState>((set) => ({
  rows: [],
  loading: false,
  load: async (profileId, lorebookIds, roster) => {
    if (!lorebookIds.length) {
      set({ rows: [] })
      return
    }
    set({ loading: true })
    try {
      const rows = await window.api.assetCoverage(profileId, lorebookIds, 'character', roster)
      set({ rows, loading: false })
    } catch {
      set({ loading: false })
    }
  },
  refresh: async (profileId, lorebookIds, roster) => {
    await window.api.assetRefresh(profileId, lorebookIds)
    await useAssetStore.getState().load(profileId, lorebookIds, roster)
  }
}))
