import { create } from 'zustand'

export interface LorebookEntry {
  keys: string[]
  secondary_keys: string[]
  content: string
  enabled: boolean
  insertion_order: number
  /** null = inject at the top (World Info block); a number = depth from the bottom of chat. */
  insertion_depth: number | null
  case_sensitive: boolean
  constant: boolean
  selective: boolean
  /** % chance (0–100) a matched entry fires; <100 rolls each turn. */
  probability: number
  /** can't be activated by recursion (only the conversation scan). */
  exclude_recursion: boolean
  /** this entry's content doesn't trigger further recursive matches. */
  prevent_recursion: boolean
  comment: string
}

export interface Lorebook {
  name: string
  entries: LorebookEntry[]
}

export interface LorebookSummary {
  id: string
  name: string
}

const emptyEntry = (): LorebookEntry => ({
  keys: [],
  secondary_keys: [],
  content: '',
  enabled: true,
  insertion_order: 100,
  insertion_depth: null,
  case_sensitive: false,
  constant: false,
  selective: false,
  probability: 100,
  exclude_recursion: false,
  prevent_recursion: false,
  comment: ''
})

interface LorebookState {
  library: LorebookSummary[]
  /** Which lorebook is open in the editor (id; equals characterId for a card's own book). */
  currentId: string | null
  lorebook: Lorebook | null
  dirty: boolean
  /** Active lorebook ids for the loaded session; null = default (the character's own book). */
  sessionIds: string[] | null

  loadLibrary: (profileId: string) => Promise<void>
  open: (profileId: string, id: string) => Promise<void>
  createNew: (profileId: string) => Promise<void>
  importLorebook: (profileId: string) => Promise<void>
  exportCurrent: (profileId: string) => Promise<void>
  removeCurrent: (profileId: string) => Promise<void>
  save: (profileId: string) => Promise<void>

  loadSession: (profileId: string, chatId: string) => Promise<void>
  setSession: (profileId: string, chatId: string, ids: string[]) => Promise<void>

  setName: (name: string) => void
  addEntry: () => void
  updateEntry: (index: number, patch: Partial<LorebookEntry>) => void
  toggleEntry: (index: number) => void
  deleteEntry: (index: number) => void
}

const mutate = (
  set: (fn: (s: LorebookState) => Partial<LorebookState>) => void,
  fn: (lb: Lorebook) => Lorebook
): void => {
  set((s) => {
    const lb = s.lorebook ?? { name: 'New Lorebook', entries: [] }
    return { lorebook: fn(lb), dirty: true }
  })
}

export const useLorebookStore = create<LorebookState>((set, get) => ({
  library: [],
  currentId: null,
  lorebook: null,
  dirty: false,
  sessionIds: null,

  loadLibrary: async (profileId) => {
    const library = await window.api.listLorebooks(profileId)
    set({ library })
  },

  open: async (profileId, id) => {
    const lorebook = await window.api.getLorebook(profileId, id)
    set({ currentId: id, lorebook: lorebook ?? { name: 'New Lorebook', entries: [] }, dirty: false })
  },

  createNew: async (profileId) => {
    const summary = await window.api.createLorebook(profileId, 'New Lorebook')
    await get().loadLibrary(profileId)
    await get().open(profileId, summary.id)
  },

  importLorebook: async (profileId) => {
    const summary = await window.api.importLorebookDialog(profileId)
    if (!summary) return
    await get().loadLibrary(profileId)
    await get().open(profileId, summary.id)
  },

  exportCurrent: async (profileId) => {
    const { currentId, lorebook } = get()
    if (!currentId || !lorebook) return
    await window.api.exportLorebookDialog(profileId, currentId, lorebook.name)
  },

  removeCurrent: async (profileId) => {
    const { currentId } = get()
    if (!currentId) return
    await window.api.deleteLorebook(profileId, currentId)
    await get().loadLibrary(profileId)
    set({ currentId: null, lorebook: null, dirty: false })
  },

  save: async (profileId) => {
    const { lorebook, currentId } = get()
    if (!lorebook || !currentId) return
    await window.api.saveLorebook(profileId, currentId, lorebook)
    await get().loadLibrary(profileId) // name may have changed
    set({ dirty: false })
  },

  loadSession: async (profileId, chatId) => {
    const sessionIds = await window.api.getChatLorebooks(profileId, chatId)
    set({ sessionIds })
  },

  setSession: async (profileId, chatId, ids) => {
    await window.api.setChatLorebooks(profileId, chatId, ids)
    set({ sessionIds: ids })
  },

  setName: (name) => mutate(set, (lb) => ({ ...lb, name })),

  addEntry: () => mutate(set, (lb) => ({ ...lb, entries: [emptyEntry(), ...lb.entries] })),

  updateEntry: (index, patch) =>
    mutate(set, (lb) => ({
      ...lb,
      entries: lb.entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
    })),

  toggleEntry: (index) =>
    mutate(set, (lb) => ({
      ...lb,
      entries: lb.entries.map((e, i) => (i === index ? { ...e, enabled: !e.enabled } : e))
    })),

  deleteEntry: (index) =>
    mutate(set, (lb) => ({ ...lb, entries: lb.entries.filter((_, i) => i !== index) }))
}))
