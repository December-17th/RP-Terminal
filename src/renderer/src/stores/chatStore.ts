import { create } from 'zustand';

export interface ChatSession {
  id: string;
  character_id: string;
}

export interface Floor {
  floor: number;
  chat_id: string;
  user_message: { content: string };
  response: { content: string };
  variables: Record<string, any>;
}

interface ChatState {
  chats: ChatSession[];
  activeChatId: string | null;
  floors: Floor[];
  isGenerating: boolean;
  loadChats: (profileId: string) => Promise<void>;
  createChat: (profileId: string, characterId: string) => Promise<void>;
  setActiveChat: (profileId: string, chatId: string) => Promise<void>;
  sendAction: (profileId: string, actionText: string, settings: any, character: any) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatId: null,
  floors: [],
  isGenerating: false,
  loadChats: async (profileId: string) => {
    const chats = await window.api.getChats(profileId);
    set({ chats });
  },
  createChat: async (profileId: string, characterId: string) => {
    const newChat = await window.api.createChat(profileId, characterId);
    set((state) => ({ chats: [newChat, ...state.chats], activeChatId: newChat.id, floors: [] }));
  },
  setActiveChat: async (profileId: string, chatId: string) => {
    set({ activeChatId: chatId, floors: [] });
    // In a real app, we'd load the chat index and load the visible floors on demand
    // For the MVP, we just start fresh or load floor 0
    const floor0 = await window.api.getFloor(profileId, chatId, 0);
    if (floor0) {
      set({ floors: [floor0] });
    }
  },
  sendAction: async (profileId, actionText, settings, character) => {
    const { activeChatId, floors } = get();
    if (!activeChatId) return;

    set({ isGenerating: true });
    
    try {
      // Build basic prompt
      const messages = [
        { role: 'system', content: character.card.data.system_prompt || '' },
        { role: 'system', content: `Name: ${character.card.data.name}\nDescription: ${character.card.data.description}` },
      ];
      
      // Add history
      floors.forEach(f => {
        messages.push({ role: 'user', content: f.user_message.content });
        messages.push({ role: 'assistant', content: f.response.content });
      });
      
      // Add new action
      messages.push({ role: 'user', content: actionText });

      // Call API
      const responseContent = await window.api.apiComplete(settings, messages);

      // Create new floor
      const newFloorIndex = floors.length;
      const newFloor: Floor = {
        floor: newFloorIndex,
        chat_id: activeChatId,
        user_message: { content: actionText },
        response: { content: responseContent },
        variables: floors.length > 0 ? { ...floors[floors.length-1].variables } : {}
      };

      // Save to disk
      await window.api.saveFloor(profileId, activeChatId, newFloor);

      // Update state
      set((state) => ({ floors: [...state.floors, newFloor], isGenerating: false }));
    } catch (err) {
      console.error(err);
      set({ isGenerating: false });
    }
  }
}));
