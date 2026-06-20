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
  deleteChat: (profileId: string, chatId: string) => Promise<void>
  appendDelta: (delta: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatId: null,
  floors: [],
  isGenerating: false,
  streamingText: '',
  error: null,

  appendDelta: (delta) => set((state) => ({ streamingText: state.streamingText + delta })),

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

    set({ isGenerating: true, streamingText: '', error: null })
    try {
      // Main assembles the prompt (card + preset + lorebook + history), streams the
      // provider (deltas arrive via appendDelta), post-processes, persists and returns.
      const newFloor = await window.api.generate(profileId, activeChatId, actionText)
      set((state) => ({ floors: [...state.floors, newFloor], isGenerating: false, streamingText: '' }))
      get().loadChats(profileId) // refresh session previews / sort order
    } catch (err: any) {
      console.error(err)
      set({ isGenerating: false, streamingText: '', error: err?.message || 'Generation failed' })
    }
  },

  regenerate: async (profileId) => {
    const { activeChatId, floors } = get()
    if (!activeChatId || floors.length === 0) return

    set({ isGenerating: true, streamingText: '', error: null })
    try {
      // Optimistically drop the last floor so the UI shows the re-roll in progress.
      set((state) => ({ floors: state.floors.slice(0, -1) }))
      const newFloor = await window.api.regenerate(profileId, activeChatId)
      set((state) => ({ floors: [...state.floors, newFloor], isGenerating: false, streamingText: '' }))
      get().loadChats(profileId)
    } catch (err: any) {
      console.error(err)
      // Reload the persisted floors so the optimistic removal can't desync state.
      const restored = await window.api.getFloors(profileId, activeChatId)
      set({ floors: restored, isGenerating: false, streamingText: '', error: err?.message || 'Regeneration failed' })
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
  }
}))
