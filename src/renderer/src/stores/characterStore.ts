import { create } from 'zustand';

export interface CharacterCard {
  id: string;
  card: any; // RPTerminalCard data
}

interface CharacterState {
  characters: CharacterCard[];
  activeCharacter: CharacterCard | null;
  loadCharacters: (profileId: string) => Promise<void>;
  setActiveCharacter: (char: CharacterCard) => void;
  importCharacter: (profileId: string) => Promise<void>;
  importMockCharacter: (profileId: string) => Promise<void>;
}

export const useCharacterStore = create<CharacterState>((set) => ({
  characters: [],
  activeCharacter: null,
  loadCharacters: async (profileId: string) => {
    const characters = await window.api.getCharacters(profileId);
    set({ characters });
    if (characters.length > 0) {
      set({ activeCharacter: characters[0] });
    }
  },
  setActiveCharacter: (char) => set({ activeCharacter: char }),
  importCharacter: async (profileId: string) => {
    const newId = await window.api.importCharacterDialog(profileId);
    if (newId) {
      const characters = await window.api.getCharacters(profileId);
      set({ characters, activeCharacter: characters.find((c: any) => c.id === newId) || null });
    }
  },
  importMockCharacter: async (profileId: string) => {
    const mockId = 'mock-guide';
    const mockCard = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'The Guide',
        description: 'A helpful interactive fiction guide.',
        personality: 'Helpful, concise, and imaginative.',
        first_mes: 'Welcome to the terminal. What would you like to do?',
        mes_example: '<user> Look around </user>\n<bot> You are standing in a dimly lit terminal. Rows of glowing text cascade down the screens around you. \n<rpt-event type="state" action="add" path="stats.exp" value="10" />\n</bot>',
        scenario: 'The user is exploring a virtual terminal.',
        system_prompt: 'You are an AI game master. Describe the outcomes of the user\'s actions in a narrative prose style. Enclose game state updates in <rpt-event> tags if necessary.',
        extensions: {
          rp_terminal: {
            ui_layout: [
              { id: 'hp_bar', type: 'StatBar', path: 'stats.hp', config: { label: 'Health', max: 100, color: '#e74c3c' } },
              { id: 'mp_bar', type: 'StatBar', path: 'stats.mp', config: { label: 'Mana', max: 50, color: '#3498db' } },
              { id: 'exp_bar', type: 'StatBar', path: 'stats.exp', config: { label: 'Experience', max: 100, color: '#f1c40f' } },
              { id: 'status_text', type: 'Text', path: 'status', config: { label: 'Condition', defaultValue: 'Healthy' } },
              { id: 'inventory_list', type: 'List', path: 'inventory', config: { label: 'Backpack' } }
            ]
          }
        }
      }
    };
    await window.api.saveCharacter(profileId, mockId, mockCard);
    const characters = await window.api.getCharacters(profileId);
    set({ characters, activeCharacter: characters.find((c: any) => c.id === mockId) || null });
  }
}));
