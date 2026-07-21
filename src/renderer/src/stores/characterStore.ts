import { create } from 'zustand'
import { useToastStore } from './toastStore'
import { useRegexStore } from './regexStore'
import { usePresetStore } from './presetStore'
import { useScriptsStore } from './scriptsStore'
import { useChatStore } from './chatStore'
import { useUiStore } from './uiStore'
import { t } from '../i18n'
import { characterImportErrorMessage } from '../i18n/errorMessages'
import type { CharacterImportDialogResult } from '../../../shared/characterImport'

type AgentCollisionResult = Extract<
  CharacterImportDialogResult,
  { status: 'agent-collisions' }
>

export interface CharacterCard {
  id: string
  card: any // RPTerminalCard data
}

interface CharacterState {
  characters: CharacterCard[]
  activeCharacter: CharacterCard | null
  loadCharacters: (profileId: string) => Promise<void>
  setActiveCharacter: (char: CharacterCard) => void
  importCharacter: (profileId: string) => Promise<void>
  pendingAgentImport: (AgentCollisionResult & { profileId: string }) | null
  confirmAgentImport: (renames: Record<string, string>) => Promise<void>
  cancelAgentImport: () => Promise<void>
  exportCharacter: (profileId: string, characterId: string) => Promise<void>
  importMockCharacter: (profileId: string) => Promise<void>
  deleteCharacter: (profileId: string, characterId: string) => Promise<void>
  /** Persist a full card (e.g. after editing its scripts) and refresh the list/active. */
  saveCard: (profileId: string, characterId: string, card: any) => Promise<void>
}

const finishCharacterImport = async (
  profileId: string,
  res: Extract<CharacterImportDialogResult, { status: 'imported' }>,
  set: (partial: Partial<CharacterState>) => void
): Promise<void> => {
  const characters = await window.api.getCharacters(profileId)
  useChatStore.getState().clearActiveChat()
  set({
    characters,
    activeCharacter: characters.find((c: any) => c.id === res.id) || null,
    pendingAgentImport: null
  })

  const s = res.summary
  const parts = [
    s.regexScripts && `${s.regexScripts} regex`,
    s.presets && `${s.presets} presets`,
    s.lorebooks && `${s.lorebooks} lorebooks`,
    s.loreEntries && `${s.loreEntries} lore`,
    s.scripts && `${s.scripts} scripts`,
    s.assetsImported && `${s.assetsImported} assets`
  ].filter(Boolean)
  useToastStore
    .getState()
    .push(
      parts.length
        ? `Imported “${s.name}” — installed ${parts.join(', ')}`
        : `Imported “${s.name}”`
    )
  if (s.cartridgeError) {
    useToastStore
      .getState()
      .push(t('characterImport.cartridgeWarning', { error: s.cartridgeError }))
  }
  if (s.regexScripts) {
    await useRegexStore.getState().load(profileId)
    await useRegexStore.getState().loadScripts(profileId)
  }
  if (s.scripts) await useScriptsStore.getState().load(profileId)
  if (s.presets) await usePresetStore.getState().load(profileId)
  if (s.requiresTrust) {
    useUiStore.getState().openTrustPrompt({ profileId, cardId: res.id, cardName: s.name })
  }
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  activeCharacter: null,
  pendingAgentImport: null,
  loadCharacters: async (profileId: string) => {
    const characters = await window.api.getCharacters(profileId)
    set({ characters })
    if (characters.length > 0) {
      set({ activeCharacter: characters[0] })
    }
  },
  setActiveCharacter: (char) =>
    set((state) => {
      // Switching to a different world invalidates the open session (it belongs to the
      // previous world) — drop it so a stale chat isn't rendered for the new world.
      if (char.id !== state.activeCharacter?.id) useChatStore.getState().clearActiveChat()
      return { activeCharacter: char }
    }),
  deleteCharacter: async (profileId, characterId) => {
    await window.api.deleteCharacter(profileId, characterId)
    const characters = await window.api.getCharacters(profileId)
    set((state) => {
      const wasActive = state.activeCharacter?.id === characterId
      // The deleted world's session (+ its loaded floors) must not linger.
      if (wasActive) useChatStore.getState().clearActiveChat()
      return { characters, activeCharacter: wasActive ? null : state.activeCharacter }
    })
  },
  importCharacter: async (profileId: string) => {
    const res = await window.api.importCharacterDialog(profileId)
    if (!res) return
    if (res.status === 'agent-collisions') {
      set({ pendingAgentImport: { ...res, profileId } })
      return
    }
    if (res.status === 'imported') await finishCharacterImport(profileId, res, set)
    else useToastStore.getState().push(characterImportErrorMessage(t, res.errorCode))
  },
  confirmAgentImport: async (renames) => {
    const pending = get().pendingAgentImport
    if (!pending) return
    const res = await window.api.confirmCharacterImport(pending.token, renames)
    if (res.status === 'imported') await finishCharacterImport(pending.profileId, res, set)
    else useToastStore.getState().push(characterImportErrorMessage(t, res.errorCode))
  },
  cancelAgentImport: async () => {
    const pending = get().pendingAgentImport
    if (pending) await window.api.cancelCharacterImport(pending.token)
    set({ pendingAgentImport: null })
  },
  exportCharacter: async (profileId: string, characterId: string) => {
    const name = await window.api.exportCharacterDialog(profileId, characterId)
    if (name) useToastStore.getState().push(`Exported World Card “${name}”`)
  },
  saveCard: async (profileId: string, characterId: string, card: any) => {
    await window.api.saveCharacter(profileId, characterId, card)
    const characters = await window.api.getCharacters(profileId)
    set((state) => ({
      characters,
      activeCharacter: characters.find((c: any) => c.id === characterId) || state.activeCharacter
    }))
  },
  importMockCharacter: async (profileId: string) => {
    const mockId = 'mock-guide'
    const mockCard = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'The Guide',
        description: 'A helpful interactive fiction guide.',
        personality: 'Helpful, concise, and imaginative.',
        first_mes: 'Welcome to the terminal. What would you like to do?',
        mes_example:
          '<user> Look around </user>\n<bot> You are standing in a dimly lit terminal. Rows of glowing text cascade down the screens around you. \n<rpt-event type="state" action="add" path="stats.exp" value="10" />\n</bot>',
        scenario: 'The user is exploring a virtual terminal.',
        system_prompt:
          "You are an AI game master. Describe the outcomes of the user's actions in a narrative prose style. Enclose game state updates in <rpt-event> tags if necessary.",
        extensions: {
          rp_terminal: {
            ui_layout: [
              {
                id: 'hp_bar',
                type: 'StatBar',
                path: 'stats.hp',
                config: { label: 'Health', max: 100, color: '#e74c3c' }
              },
              {
                id: 'mp_bar',
                type: 'StatBar',
                path: 'stats.mp',
                config: { label: 'Mana', max: 50, color: '#3498db' }
              },
              {
                id: 'exp_bar',
                type: 'StatBar',
                path: 'stats.exp',
                config: { label: 'Experience', max: 100, color: '#f1c40f' }
              },
              {
                id: 'status_text',
                type: 'Text',
                path: 'status',
                config: { label: 'Condition', defaultValue: 'Healthy' }
              },
              {
                id: 'inventory_list',
                type: 'List',
                path: 'inventory',
                config: { label: 'Backpack' }
              }
            ],
            // P1 demo: a sandboxed card script. Reads/writes chat variables,
            // renders its own UI, reacts to generation, and shows a toast.
            scripts: [
              {
                name: 'demo-stats',
                code: `
const root = document.createElement('div');
document.body.appendChild(root);
async function refresh() {
  const hp = await rpt.vars.get('stats.hp');
  const exp = await rpt.vars.get('stats.exp');
  root.innerHTML =
    '<div style="font-weight:600;margin-bottom:6px">Demo Script</div>' +
    '<div>HP: <b>' + (hp == null ? '—' : hp) + '</b> · EXP: <b>' + (exp == null ? '—' : exp) + '</b></div>';
  const heal = document.createElement('button');
  heal.textContent = '+10 HP';
  heal.onclick = async () => { await rpt.vars.inc('stats.hp', 10); rpt.ui.toast('Healed +10 HP'); refresh(); };
  root.appendChild(heal);
}
rpt.on('ready', refresh);
rpt.on('generation:end', refresh);
refresh();
`.trim()
              }
            ]
          }
        }
      }
    }
    await window.api.saveCharacter(profileId, mockId, mockCard)
    const characters = await window.api.getCharacters(profileId)
    useChatStore.getState().clearActiveChat()
    set({ characters, activeCharacter: characters.find((c: any) => c.id === mockId) || null })
  }
}))
