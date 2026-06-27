import { create } from 'zustand'
import type { FloorMetrics } from '../../../shared/usageTypes'
import { useCombatStore } from './combatStore'

export interface FloorIndexEntry {
  floor: number
  timestamp: string
  user_preview: string
  response_preview: string
}

export interface ChatSession {
  id: string
  character_id: string
  updated_at: string
  floor_count: number
  floor_index: FloorIndexEntry[]
}

export interface Floor {
  floor: number
  chat_id: string
  user_message: { content: string }
  response: { content: string }
  /** Alternate responses (TH-2 swipes); swipes[swipe_id] === response.content. */
  swipes?: string[]
  swipe_id?: number
  /** Cache/token metrics for this floor (present once it has been through a metered turn). */
  metrics?: FloorMetrics
  variables: Record<string, any>
}

/** A JSONPatch-style variable op for the write-back bridge (panel UI editing stat_data). */
export interface VarOp {
  op: string
  path: string
  value?: unknown
  from?: string
}

interface ChatState {
  chats: ChatSession[]
  activeChatId: string | null
  /** Active FSM mode for the open session (Phase H). */
  activeChatMode: string
  floors: Floor[]
  isGenerating: boolean
  /** Live partial text for the in-flight response (pre-regex), shown while streaming. */
  streamingText: string
  error: string | null
  loadChats: (profileId: string) => Promise<void>
  createChat: (profileId: string, characterId: string) => Promise<void>
  setActiveChat: (profileId: string, chatId: string) => Promise<void>
  /** Re-derive stat_data by replaying the stored <UpdateVariable> updates (no regeneration). */
  reevaluateVariables: (profileId: string) => Promise<void>
  /** Apply variable ops (JSONPatch) to a floor's stat_data from panel UI (write-back). */
  applyVariableOps: (profileId: string, ops: VarOp[], floor?: number) => Promise<void>
  /** Switch the open session's FSM mode (Explore/Dialogue/Combat). */
  setMode: (profileId: string, mode: string) => Promise<void>
  sendAction: (profileId: string, actionText: string) => Promise<void>
  regenerate: (profileId: string) => Promise<void>
  stopGeneration: () => Promise<void>
  deleteChat: (profileId: string, chatId: string) => Promise<void>
  /** Drop the active session + its loaded floors (e.g. when switching/deleting worlds, so a
   * stale chat from another world isn't rendered). */
  clearActiveChat: () => void
  editFloor: (
    profileId: string,
    floorIndex: number,
    field: 'user' | 'response',
    text: string
  ) => Promise<void>
  /** Navigate or generate a floor's swipe. 'left'/'right' rotate existing alternates;
   * 'right' past the last alternate on the latest floor generates a new one. */
  swipe: (profileId: string, floorIndex: number, dir: 'left' | 'right') => Promise<void>
  appendDelta: (delta: string) => void
  /** Replace the latest floor's variables (used by card scripts that mutate state
   * outside a generation turn, so status widgets reflect the change immediately). */
  setLatestFloorVariables: (variables: Record<string, any>) => void
}

export const useChatStore = create<ChatState>((set, get) => {
  // Coalesce streamed tokens: append to a buffer and flush to state at most once
  // per animation frame. This avoids an O(n^2) re-render/markdown-parse storm on
  // long responses (and a backlog freeze when the window is backgrounded).
  let streamBuffer = ''
  let rafId: number | null = null
  const flush = (): void => {
    rafId = null
    set({ streamingText: streamBuffer })
  }
  const scheduleFlush = (): void => {
    if (rafId == null) rafId = requestAnimationFrame(flush)
  }
  const resetStream = (): void => {
    streamBuffer = ''
    if (rafId != null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }
  // A re-roll/swipe rewrites the message a fight branched from; the server clears the encounter, so
  // drop the local combat mirror and leave combat mode if we were in it.
  const stopStaleCombat = (profileId: string): void => {
    useCombatStore.getState().reset()
    if (get().activeChatMode === 'combat') void get().setMode(profileId, 'explore')
  }

  return {
    chats: [],
    activeChatId: null,
    activeChatMode: 'explore',
    floors: [],
    isGenerating: false,
    streamingText: '',
    error: null,

    appendDelta: (delta) => {
      streamBuffer += delta
      scheduleFlush()
    },

    setLatestFloorVariables: (variables) =>
      set((state) => {
        if (state.floors.length === 0) return {}
        const floors = state.floors.slice()
        const last = floors[floors.length - 1]
        floors[floors.length - 1] = { ...last, variables }
        return { floors }
      }),

    loadChats: async (profileId) => {
      const chats = await window.api.getChats(profileId)
      set({ chats })
    },

    createChat: async (profileId, characterId) => {
      const newChat = await window.api.createChat(profileId, characterId)
      set((state) => ({
        chats: [newChat, ...state.chats],
        activeChatId: newChat.id,
        activeChatMode: 'explore',
        error: null
      }))
      // A freshly created chat may already contain a seeded greeting floor.
      const floors = await window.api.getFloors(profileId, newChat.id)
      set({ floors })
    },

    setActiveChat: async (profileId, chatId) => {
      set({ activeChatId: chatId, floors: [], error: null })
      const [floors, mode] = await Promise.all([
        window.api.getFloors(profileId, chatId),
        window.api.getChatMode(profileId, chatId)
      ])
      set({ floors, activeChatMode: mode || 'explore' })
    },

    reevaluateVariables: async (profileId) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      const floors = await window.api.reevaluateVariables(profileId, activeChatId)
      set({ floors })
    },

    applyVariableOps: async (profileId, ops, floor) => {
      const { activeChatId, floors } = get()
      if (!activeChatId || floors.length === 0) return
      // Default to the latest floor (the "current message" whose variables the UI shows).
      const target = floor ?? floors[floors.length - 1].floor
      const updated = await window.api.applyVariableOps(profileId, activeChatId, target, ops)
      if (updated) set((s) => ({ floors: s.floors.map((f) => (f.floor === target ? updated : f)) }))
    },

    setMode: async (profileId, mode) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      set({ activeChatMode: mode }) // optimistic; the write is a simple column update
      await window.api.setChatMode(profileId, activeChatId, mode)
    },

    sendAction: async (profileId, actionText) => {
      const { activeChatId } = get()
      if (!activeChatId) return

      resetStream()
      set({ isGenerating: true, streamingText: '', error: null })
      try {
        // Main assembles the prompt (card + preset + lorebook + history), streams the
        // provider (deltas arrive via appendDelta), post-processes, persists and returns.
        const newFloor = await window.api.generate(profileId, activeChatId, actionText)
        resetStream()
        set((state) => ({
          floors: newFloor ? [...state.floors, newFloor] : state.floors,
          isGenerating: false,
          streamingText: ''
        }))
        get().loadChats(profileId) // refresh session previews / sort order
      } catch (err: any) {
        console.error(err)
        resetStream()
        set({ isGenerating: false, streamingText: '', error: err?.message || 'Generation failed' })
      }
    },

    regenerate: async (profileId) => {
      const { activeChatId, floors } = get()
      if (!activeChatId || floors.length === 0) return

      resetStream()
      set({ isGenerating: true, streamingText: '', error: null })
      try {
        // Optimistically drop the last floor so the UI shows the re-roll in progress.
        set((state) => ({ floors: state.floors.slice(0, -1) }))
        const newFloor = await window.api.regenerate(profileId, activeChatId)
        resetStream()
        set((state) => ({
          floors: newFloor ? [...state.floors, newFloor] : state.floors,
          isGenerating: false,
          streamingText: ''
        }))
        get().loadChats(profileId)
        stopStaleCombat(profileId)
      } catch (err: any) {
        console.error(err)
        resetStream()
        // Reload the persisted floors so the optimistic removal can't desync state.
        const restored = await window.api.getFloors(profileId, activeChatId)
        set({
          floors: restored,
          isGenerating: false,
          streamingText: '',
          error: err?.message || 'Regeneration failed'
        })
      }
    },

    stopGeneration: async () => {
      const { activeChatId } = get()
      if (!activeChatId) return
      // Aborts the provider request in main; the in-flight generate()/regenerate()
      // promise then resolves with the partial floor (or null) and clears state.
      await window.api.abortGeneration(activeChatId)
    },

    editFloor: async (profileId, floorIndex, field, text) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      await window.api.editFloor(
        profileId,
        activeChatId,
        floorIndex,
        field === 'user' ? text : null,
        field === 'response' ? text : null
      )
      set((state) => ({
        floors: state.floors.map((f) =>
          f.floor === floorIndex
            ? field === 'user'
              ? { ...f, user_message: { ...f.user_message, content: text } }
              : { ...f, response: { ...f.response, content: text } }
            : f
        )
      }))
      get().loadChats(profileId)
    },

    swipe: async (profileId, floorIndex, dir) => {
      const { activeChatId, floors, isGenerating } = get()
      if (!activeChatId || isGenerating) return
      const idx = floors.findIndex((f) => f.floor === floorIndex)
      if (idx < 0) return
      const f = floors[idx]
      const swipeArr = f.swipes && f.swipes.length ? f.swipes : [f.response.content]
      const cur = f.swipe_id ?? 0
      const isLastFloor = idx === floors.length - 1

      // Apply a server-returned swiped floor to the store (response text + active index).
      const applyUpdated = (updated: any): void =>
        set((state) => ({
          floors: state.floors.map((fl) =>
            fl.floor === floorIndex
              ? {
                  ...fl,
                  response: { ...fl.response, content: updated.response.content },
                  swipes: updated.swipes,
                  swipe_id: updated.swipe_id
                }
              : fl
          )
        }))

      // Navigate within existing alternates.
      const target = dir === 'left' ? cur - 1 : cur + 1
      if (dir === 'left' ? cur > 0 : cur < swipeArr.length - 1) {
        const updated = await window.api.setActiveSwipe(profileId, activeChatId, floorIndex, target)
        if (updated) applyUpdated(updated)
        stopStaleCombat(profileId)
        return
      }

      // Right past the last alternate on the latest floor → generate a new swipe.
      if (dir !== 'right' || !isLastFloor) return
      resetStream()
      set({ isGenerating: true, streamingText: '', error: null })
      try {
        set((state) => ({ floors: state.floors.slice(0, -1) })) // show the re-roll in progress
        const fresh = await window.api.generateSwipe(profileId, activeChatId)
        resetStream()
        set((state) => ({
          floors: fresh ? [...state.floors, fresh] : state.floors,
          isGenerating: false,
          streamingText: ''
        }))
        get().loadChats(profileId)
        stopStaleCombat(profileId)
      } catch (err: any) {
        console.error(err)
        resetStream()
        const restored = await window.api.getFloors(profileId, activeChatId)
        set({
          floors: restored,
          isGenerating: false,
          streamingText: '',
          error: err?.message || 'Swipe failed'
        })
      }
    },

    deleteChat: async (profileId, chatId) => {
      await window.api.deleteChat(profileId, chatId)
      set((state) => {
        const isActive = state.activeChatId === chatId
        return {
          chats: state.chats.filter((c) => c.id !== chatId),
          activeChatId: isActive ? null : state.activeChatId,
          floors: isActive ? [] : state.floors
        }
      })
    },

    clearActiveChat: () => {
      resetStream()
      set({
        activeChatId: null,
        floors: [],
        activeChatMode: 'explore',
        streamingText: '',
        error: null
      })
    }
  }
})
