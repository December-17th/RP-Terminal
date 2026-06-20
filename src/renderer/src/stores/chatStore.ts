import { create } from 'zustand'

export interface ChatSession {
  id: string
  character_id: string
  updated_at: string
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
  error: string | null
  loadChats: (profileId: string) => Promise<void>
  createChat: (profileId: string, characterId: string) => Promise<void>
  setActiveChat: (profileId: string, chatId: string) => Promise<void>
  sendAction: (profileId: string, actionText: string) => Promise<void>
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatId: null,
  floors: [],
  isGenerating: false,
  error: null,

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

    set({ isGenerating: true, error: null })
    try {
      // Main assembles the prompt (card + preset + lorebook + history), calls the
      // provider, post-processes, persists the floor and returns it.
      const newFloor = await window.api.generate(profileId, activeChatId, actionText)
      set((state) => ({ floors: [...state.floors, newFloor], isGenerating: false }))
    } catch (err: any) {
      console.error(err)
      set({ isGenerating: false, error: err?.message || 'Generation failed' })
    }
  }
}))
