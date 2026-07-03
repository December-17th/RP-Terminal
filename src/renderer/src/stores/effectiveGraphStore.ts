import { create } from 'zustand'
import type { WorkflowDoc } from '../../../shared/workflow/types'
import type { ComposeWarning } from '../../../shared/workflow/compose'

// Store for the Workflow view's EFFECTIVE mode (agent-packs plan WP3.6a; ADR 0010). Holds the LIVE
// projection (the narrator composed with every gate-open pack) for the active chat, fetched via the
// getEffectiveGraph IPC. Kept SEPARATE from useWorkflowEditorStore so Normal-mode editing is
// pixel-identical + untouched — Effective mode is additive (task hard constraint). The projection is
// NEVER saved as a doc (ADR 0001/0010); only narrator write-through (WP3.6a) and pack forks (WP3.6b)
// mutate anything, each re-fetching the projection afterward.

/** One pack's presence in the projection (mirrors main's EffectivePackInfo — the IPC payload). */
export interface EffectivePackInfo {
  packId: string
  name: string
  gateOpen: boolean
  nodeIds: string[]
  triggerOnly: boolean
}

interface EffectiveGraphState {
  loading: boolean
  error: boolean
  doc: WorkflowDoc | null
  warnings: ComposeWarning[]
  packs: EffectivePackInfo[]
  /** The chat/world the current projection was fetched for (so a stale projection is not shown). */
  chatId: string | null
  worldId: string | null
  fetch(profileId: string, chatId: string, worldId: string | null): Promise<void>
  /** Flip a pack's gate at WORLD scope for the current world, then re-fetch (live recompose). */
  toggleGate(profileId: string, packId: string, open: boolean): Promise<void>
  clear(): void
}

const api = (): any => (window as unknown as { api: any }).api

export const useEffectiveGraphStore = create<EffectiveGraphState>((set, get) => ({
  loading: false,
  error: false,
  doc: null,
  warnings: [],
  packs: [],
  chatId: null,
  worldId: null,

  fetch: async (profileId, chatId, worldId) => {
    set({ loading: true, error: false, chatId, worldId })
    try {
      const result = await api().getEffectiveGraph(profileId, chatId)
      // Guard against a stale response (the active chat changed while the request was in flight).
      if (get().chatId !== chatId) return
      set({
        loading: false,
        doc: result.doc,
        warnings: result.warnings ?? [],
        packs: result.packs ?? []
      })
    } catch {
      if (get().chatId !== chatId) return
      set({ loading: false, error: true, doc: null, warnings: [], packs: [] })
    }
  },

  toggleGate: async (profileId, packId, open) => {
    const { worldId, chatId } = get()
    if (!worldId || !chatId) return
    try {
      await api().setAgentPackGate(packId, worldId, null, open)
    } catch {
      // Non-fatal — the re-fetch below reflects the true persisted state either way.
    }
    await get().fetch(profileId, chatId, worldId)
  },

  clear: () => set({ doc: null, warnings: [], packs: [], chatId: null, worldId: null, error: false })
}))
