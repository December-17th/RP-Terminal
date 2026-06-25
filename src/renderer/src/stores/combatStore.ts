import { create } from 'zustand'
import type {
  AbilityDef,
  Action,
  Combatant,
  CombatState,
  Coord
} from '../../../shared/combat/types'

/**
 * Renderer mirror of the active encounter (Track Combat / P5). Holds the CombatState
 * + ability catalog fetched over `window.api.combat*`, plus the current targeting
 * selection. After the player ends a turn it auto-runs automated (enemy) turns until
 * it's a player's turn again or the fight ends. The engine is authoritative — this
 * store only reflects what the main process returns.
 */

export type Selection = { mode: 'idle' } | { mode: 'move' } | { mode: 'ability'; abilityId: string }

const api = (): any => (window as unknown as { api: any }).api

export const currentCombatant = (s: CombatState): Combatant | undefined =>
  s.combatants.find((c) => c.id === s.initiative[s.turnIndex])

export const isAutomated = (c?: Combatant): boolean =>
  !!c && (c.controller === 'weighted' || c.controller === 'ai')

interface CombatStore {
  chatId: string | null
  state: CombatState | null
  abilities: Record<string, AbilityDef>
  selection: Selection
  busy: boolean
  load: (profileId: string, chatId: string) => Promise<void>
  startMock: (profileId: string, chatId: string) => Promise<void>
  reset: () => void
  setSelection: (selection: Selection) => void
  move: (profileId: string, to: Coord) => Promise<void>
  useAbility: (profileId: string, targetCell: Coord) => Promise<void>
  improvise: (profileId: string, prose: string) => Promise<void>
  narrate: (profileId: string) => Promise<void>
  endTurn: (profileId: string) => Promise<void>
  endCombat: (profileId: string) => Promise<void>
}

export const useCombatStore = create<CombatStore>((set, get) => {
  // Drive automated combatants (enemies) until control returns to a player or the
  // fight resolves. The guard caps runaway loops (e.g. all-automated rosters).
  const runAutomated = async (profileId: string, chatId: string): Promise<void> => {
    let st = get().state
    let guard = 0
    while (st && st.status === 'active' && isAutomated(currentCombatant(st)) && guard++ < 100) {
      const { state } = await api().combatEnemyTurn(profileId, chatId)
      set({ state })
      st = state
    }
  }

  const actorId = (): string | undefined => {
    const s = get().state
    return s ? currentCombatant(s)?.id : undefined
  }

  const dispatch = async (profileId: string, action: Action): Promise<void> => {
    const { chatId } = get()
    if (!chatId) return
    set({ busy: true })
    try {
      const { state } = await api().combatAction(profileId, chatId, action)
      set({ state, selection: { mode: 'idle' } })
    } finally {
      set({ busy: false })
    }
  }

  return {
    chatId: null,
    state: null,
    abilities: {},
    selection: { mode: 'idle' },
    busy: false,

    load: async (profileId, chatId) => {
      const res = await api().combatGet(profileId, chatId)
      set({
        chatId,
        state: res?.state ?? null,
        abilities: res?.abilities ?? {},
        selection: { mode: 'idle' }
      })
    },

    startMock: async (profileId, chatId) => {
      await api().combatStartMock(profileId, chatId)
      await get().load(profileId, chatId)
    },

    reset: () => set({ chatId: null, state: null, abilities: {}, selection: { mode: 'idle' } }),

    setSelection: (selection) => set({ selection }),

    move: async (profileId, to) => {
      const actor = actorId()
      if (actor) await dispatch(profileId, { kind: 'move', actor, to })
    },

    useAbility: async (profileId, targetCell) => {
      const { selection } = get()
      const actor = actorId()
      if (actor && selection.mode === 'ability')
        await dispatch(profileId, {
          kind: 'ability',
          actor,
          abilityId: selection.abilityId,
          targetCell
        })
    },

    // Improvise routes through the AI referee (combat-adjudicate), not a plain action.
    improvise: async (profileId, prose) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        const { state } = await api().combatAdjudicate(profileId, chatId, prose)
        set({ state, selection: { mode: 'idle' } })
      } finally {
        set({ busy: false })
      }
    },

    // Ask the AI to narrate the resolved fight; the prose is appended to the log.
    narrate: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        const { state } = await api().combatNarrate(profileId, chatId)
        set({ state })
      } finally {
        set({ busy: false })
      }
    },

    endTurn: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        const state = await api().combatEndTurn(profileId, chatId)
        set({ state, selection: { mode: 'idle' } })
        await runAutomated(profileId, chatId)
      } finally {
        set({ busy: false })
      }
    },

    endCombat: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      await api().combatEnd(profileId, chatId)
      get().reset()
    }
  }
})
