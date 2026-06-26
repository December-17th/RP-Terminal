import { create } from 'zustand'
import type {
  AbilityDef,
  Action,
  Combatant,
  CombatEvent,
  CombatState,
  Coord
} from '../../../shared/combat/types'

/**
 * Renderer mirror of the active encounter (Track Combat / P5 + UI pass). Holds the
 * CombatState + ability catalog fetched over `window.api.combat*`, the targeting
 * selection, and the most-recent resolved events (`lastEvents` + a bumped `eventSeq`)
 * that drive the CombatView's floating damage/miss numbers. After the player ends a
 * turn it auto-runs automated (enemy) turns, pacing them so each is visible.
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
  /** events from the most recent resolved action (for floating-number feedback). */
  lastEvents: CombatEvent[]
  /** bumped on every `lastEvents` update so the view can react even to identical events. */
  eventSeq: number
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const useCombatStore = create<CombatStore>((set, get) => {
  const pushEvents = (state: CombatState, events: CombatEvent[] = []): void =>
    set({ state, lastEvents: events, eventSeq: get().eventSeq + 1 })

  // Drive automated combatants (enemies) until control returns to a player or the fight
  // resolves, pacing each turn so the player sees it. The guard caps runaway loops.
  const runAutomated = async (profileId: string, chatId: string): Promise<void> => {
    let st = get().state
    let guard = 0
    while (st && st.status === 'active' && isAutomated(currentCombatant(st)) && guard++ < 100) {
      const { state, events } = await api().combatEnemyTurn(profileId, chatId)
      pushEvents(state, events)
      st = state
      await delay(380)
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
      const { state, events } = await api().combatAction(profileId, chatId, action)
      set({ selection: { mode: 'idle' } })
      pushEvents(state, events)
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
    lastEvents: [],
    eventSeq: 0,

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
        const { state, events } = await api().combatAdjudicate(profileId, chatId, prose)
        set({ selection: { mode: 'idle' } })
        pushEvents(state, events)
      } finally {
        set({ busy: false })
      }
    },

    // Ask the AI to narrate the resolved fight; it lands in the chat (append / new floor
    // per the user/card setting), so there's no combat-state change to apply here.
    narrate: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        await api().combatNarrate(profileId, chatId)
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
