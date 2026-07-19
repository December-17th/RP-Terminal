import { create } from 'zustand'
import type {
  AgentCatalogSummary,
  AgentDefinition,
  AgentFolderSync,
  AgentRole,
  AgentUpgradeResolution
} from '../../../shared/agentRuntime'

/**
 * Agent Workspace store (Session 10).
 *
 * Every field here is either a primitive or a reference that only changes when the data changes.
 * Nothing derived is computed inside a selector: a selector that builds a fresh array or object on
 * each call makes useSyncExternalStore's snapshot unstable, which re-renders forever and tears the
 * React tree down. Derive in `useMemo` at the component instead.
 */
interface AgentCatalogState {
  agents: AgentCatalogSummary[]
  bindings: Partial<Record<AgentRole, string>>
  /** Full definitions, fetched one at a time — the list deliberately carries only summaries. */
  definitions: Record<string, AgentDefinition>
  sync: AgentFolderSync | null
  loading: boolean
  error: string | null
  load: (profileId: string) => Promise<void>
  loadDefinition: (profileId: string, id: string) => Promise<AgentDefinition | null>
  scanFolder: (profileId: string, conflicts?: AgentUpgradeResolution) => Promise<void>
  save: (profileId: string, id: string, definition: unknown) => Promise<string | null>
  createAgent: (profileId: string, definition: unknown) => Promise<string | null>
  restore: (profileId: string, id: string) => Promise<string | null>
  upgrade: (
    profileId: string,
    id: string,
    conflicts?: AgentUpgradeResolution
  ) => Promise<string | null>
  setEnabled: (profileId: string, id: string, enabled: boolean) => Promise<string | null>
  remove: (profileId: string, id: string) => Promise<string | null>
  bindRole: (profileId: string, role: AgentRole, id: string) => Promise<string | null>
  setError: (error: string | null) => void
}

const failure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error')

export const useAgentCatalogStore = create<AgentCatalogState>((set, get) => {
  /** Run a mutation, refresh the list, and return an error string (or null on success). */
  const mutate = async (
    profileId: string,
    action: () => Promise<{ ok: boolean; error?: string }>
  ): Promise<string | null> => {
    try {
      const result = await action()
      await get().load(profileId)
      if (result.ok) return null
      const error = result.error ?? 'Action failed'
      set({ error })
      return error
    } catch (caught) {
      const error = failure(caught)
      set({ error })
      return error
    }
  }

  return {
    agents: [],
    bindings: {},
    definitions: {},
    sync: null,
    loading: false,
    error: null,
    setError: (error) => set({ error }),

    async load(profileId) {
      set({ loading: true })
      try {
        const [agents, bindings] = await Promise.all([
          window.api.listAgentCatalog(profileId),
          window.api.getAgentRoleBindings(profileId)
        ])
        set({ agents, bindings: bindings ?? {}, loading: false })
      } catch (caught) {
        set({ loading: false, error: failure(caught) })
      }
    },

    async loadDefinition(profileId, id) {
      const cached = get().definitions[id]
      if (cached) return cached
      try {
        const definition = await window.api.getAgentDefinition(profileId, id)
        if (definition) set({ definitions: { ...get().definitions, [id]: definition } })
        return definition
      } catch (caught) {
        set({ error: failure(caught) })
        return null
      }
    },

    async scanFolder(profileId, conflicts) {
      set({ loading: true })
      try {
        const sync = await window.api.syncAgentFolder(profileId, conflicts)
        set({ sync, loading: false })
        await get().load(profileId)
      } catch (caught) {
        set({ loading: false, error: failure(caught) })
      }
    },

    async save(profileId, id, definition) {
      // Drop the cached definition first so a failed save cannot leave a stale one behind.
      const { [id]: _dropped, ...rest } = get().definitions
      set({ definitions: rest })
      return mutate(profileId, () => window.api.editAgent(profileId, id, definition))
    },

    async createAgent(profileId, definition) {
      return mutate(profileId, () => window.api.createAgent(profileId, definition))
    },

    async restore(profileId, id) {
      const { [id]: _dropped, ...rest } = get().definitions
      set({ definitions: rest })
      return mutate(profileId, () => window.api.restoreAgent(profileId, id))
    },

    async upgrade(profileId, id, conflicts) {
      const { [id]: _dropped, ...rest } = get().definitions
      set({ definitions: rest })
      return mutate(profileId, () => window.api.upgradeAgent(profileId, id, conflicts))
    },

    async setEnabled(profileId, id, enabled) {
      return mutate(profileId, () => window.api.setAgentEnabled(profileId, id, enabled))
    },

    async remove(profileId, id) {
      return mutate(profileId, () => window.api.deleteAgent(profileId, id))
    },

    async bindRole(profileId, role, id) {
      return mutate(profileId, () => window.api.bindAgentRole(profileId, role, id))
    }
  }
})
