import { create } from 'zustand'

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
  variables: Record<string, any>
}

interface ChatState {
  chats: ChatSession[]
  activeChatId: string | null
  floors: Floor[]
  isGenerating: boolean
  /** Live partial text for the in-flight response (pre-regex), shown while streaming. */
  streamingText: string
  error: string | null
  loadChats: (profileId: string) => Promise<void>
  createChat: (profileId: string, characterId: string) => Promise<void>
  setActiveChat: (profileId: string, chatId: string) => Promise<void>
  sendAction: (profileId: string, actionText: string) => Promise<void>
  regenerate: (profileId: string) => Promise<void>
  stopGeneration: () => Promise<void>
  deleteChat: (profileId: string, chatId: string) => Promise<void>
  editFloor: (profileId: string, floorIndex: number, field: 'user' | 'response', text: string) => Promise<void>
  appendDelta: (delta: string) => void
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

  return {
  chats: [],
  activeChatId: null,
  floors: [],
  isGenerating: false,
  streamingText: '',
  error: null,

  appendDelta: (delta) => {
    streamBuffer += delta
    scheduleFlush()
  },

  loadChats: async (profileId) => {
    const chats = await window.api.getChats(profileId)
    set({ chats })
  },

  createChat: async (profileId, characterId) => {
    const newChat = await window.api.createChat(profileId, characterId)
    set((state) => ({ chats: [newChat, ...state.chats], activeChatId: newChat.id, error: null }))
    // A freshly created chat may already contain a seeded greeting floor.
    const floors = await window.api.getFloors(profileId, newChat.id)
    set({ floors })
  },

  setActiveChat: async (profileId, chatId) => {
    set({ activeChatId: chatId, floors: [], error: null })
    const floors = await window.api.getFloors(profileId, chatId)
    set({ floors })
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
    } catch (err: any) {
      console.error(err)
      resetStream()
      // Reload the persisted floors so the optimistic removal can't desync state.
      const restored = await window.api.getFloors(profileId, activeChatId)
      set({ floors: restored, isGenerating: false, streamingText: '', error: err?.message || 'Regeneration failed' })
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
  }
  }
})
