import { create } from 'zustand'
import type { DuelState } from '../../../shared/combat/deckbuilder'
import type { AbilityDef, CombatEvent } from '../../../shared/combat/types'

const api = (): any => (window as unknown as { api: any }).api

export type DuelSelection = { mode: 'idle' } | { mode: 'card'; cardId: string }

interface DuelStore {
  chatId: string | null
  state: DuelState | null
  catalog: Record<string, AbilityDef>
  selection: DuelSelection
  busy: boolean
  lastEvents: CombatEvent[]
  eventSeq: number
  load: (profileId: string, chatId: string) => Promise<void>
  startMock: (profileId: string, chatId: string) => Promise<void>
  startFromBuild: (profileId: string, chatId: string, characterId: string) => Promise<void>
  startFromCue: (profileId: string, chatId: string, cue: unknown) => Promise<void>
  pickCard: (cardId: string) => void
  clearSelection: () => void
  play: (profileId: string, targetIds: string[]) => Promise<void>
  endTurn: (profileId: string) => Promise<void>
  end: (profileId: string) => Promise<void>
  narrate: (profileId: string) => Promise<void>
}

export const useDuelStore = create<DuelStore>((set, get) => {
  const apply = (res: { state: DuelState; events?: CombatEvent[] } | null): void => {
    if (!res) return
    set((s) => ({
      state: res.state,
      selection: { mode: 'idle' },
      lastEvents: res.events ?? [],
      eventSeq: s.eventSeq + 1
    }))
  }
  return {
    chatId: null,
    state: null,
    catalog: {},
    selection: { mode: 'idle' },
    busy: false,
    lastEvents: [],
    eventSeq: 0,

    load: async (profileId, chatId) => {
      const res = await api().duelGet(profileId, chatId)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    startMock: async (profileId, chatId) => {
      const res = await api().duelStartMock(profileId, chatId)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    startFromBuild: async (profileId, chatId, characterId) => {
      const res = await api().duelStart(profileId, chatId, characterId)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    startFromCue: async (profileId, chatId, cue) => {
      const res = await api().duelStartFromCue(profileId, chatId, cue)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    pickCard: (cardId) => set({ selection: { mode: 'card', cardId } }),
    clearSelection: () => set({ selection: { mode: 'idle' } }),

    play: async (profileId, targetIds) => {
      const { chatId, selection } = get()
      if (!chatId || selection.mode !== 'card') return
      set({ busy: true })
      try {
        apply(await api().duelPlay(profileId, chatId, selection.cardId, targetIds))
      } finally {
        set({ busy: false })
      }
    },

    endTurn: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        apply(await api().duelEndTurn(profileId, chatId))
      } finally {
        set({ busy: false })
      }
    },

    end: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      await api().duelEnd(profileId, chatId)
      set({ state: null, catalog: {}, selection: { mode: 'idle' } })
    },

    narrate: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        await api().duelNarrate(profileId, chatId)
      } finally {
        set({ busy: false })
        await get().end(profileId) // clear the duel + return to chat after narrating
      }
    }
  }
})
