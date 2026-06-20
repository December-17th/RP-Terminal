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
      // Basic Macro Expansion
      const expandMacros = (text: string) => {
        if (!text) return '';
        let expanded = text;
        expanded = expanded.replace(/{{user}}/gi, 'Participant'); // In RP terminal, usually User/Participant
        expanded = expanded.replace(/{{char}}/gi, character.card.data.name || 'Character');
        // Handle ST's <%_ if ... _%> conditionally, for MVP we just strip them out or leave them since true EJS requires a full engine
        // Let's at least remove the EJS tags that ST uses heavily so they don't leak into the prompt
        expanded = expanded.replace(/<%_[^%]+_%>/g, '');
        return expanded;
      };

      // Build basic prompt
      const sysPrompt = expandMacros(character.card.data.system_prompt || '');
      const charDesc = expandMacros(`Name: ${character.card.data.name}\nDescription: ${character.card.data.description}`);

      const messages = [
        { role: 'system', content: sysPrompt },
        { role: 'system', content: charDesc },
      ];
      
      // Add history
      floors.forEach(f => {
        messages.push({ role: 'user', content: f.user_message.content });
        messages.push({ role: 'assistant', content: f.response.content });
      });
      
      // Add new action
      messages.push({ role: 'user', content: actionText });

      // Call API
      const parsedResponse = await window.api.apiComplete(settings, messages);
      const responseContent = parsedResponse.text || '';
      const newEvents = parsedResponse.events || [];

      // Create new floor
      const newFloorIndex = floors.length;
      
      // Clone previous variables
      const currentVars = floors.length > 0 ? JSON.parse(JSON.stringify(floors[floors.length-1].variables)) : {};
      
      // Apply new events to variables
      newEvents.forEach((evt: any) => {
        if (evt.type === 'state') {
          // simple nested path setter
          const pathParts = evt.path.split('.');
          let obj = currentVars;
          for (let i = 0; i < pathParts.length - 1; i++) {
            if (!obj[pathParts[i]]) obj[pathParts[i]] = {};
            obj = obj[pathParts[i]];
          }
          const lastPart = pathParts[pathParts.length - 1];
          
          if (evt.action === 'add') {
             obj[lastPart] = (obj[lastPart] || 0) + evt.value;
          } else if (evt.action === 'remove') {
             // For arrays or strings, we could handle removal, but MVP let's assume numbers
             obj[lastPart] = (obj[lastPart] || 0) - evt.value;
          } else {
             obj[lastPart] = evt.value;
          }
        }
      });

      const newFloor: Floor = {
        floor: newFloorIndex,
        chat_id: activeChatId,
        user_message: { content: actionText },
        response: { content: responseContent },
        variables: currentVars
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
