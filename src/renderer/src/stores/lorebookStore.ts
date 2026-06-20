import { create } from 'zustand'

export interface LorebookEntry {
  keys: string[]
  secondary_keys: string[]
  content: string
  enabled: boolean
  insertion_order: number
  case_sensitive: boolean
  constant: boolean
  selective: boolean
  comment: string
}

export interface Lorebook {
  name: string
  entries: LorebookEntry[]
}

const emptyEntry = (): LorebookEntry => ({
  keys: [],
  secondary_keys: [],
  content: '',
  enabled: true,
  insertion_order: 100,
  case_sensitive: false,
  constant: false,
  selective: false,
  comment: ''
})

interface LorebookState {
  lorebook: Lorebook | null
  dirty: boolean
  load: (profileId: string, charId: string) => Promise<void>
  save: (profileId: string, charId: string) => Promise<void>
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
  lorebook: null,
  dirty: false,

  load: async (profileId, charId) => {
    const lorebook = await window.api.getLorebook(profileId, charId)
    set({ lorebook: lorebook ?? { name: 'New Lorebook', entries: [] }, dirty: false })
  },

  save: async (profileId, charId) => {
    const { lorebook } = get()
    if (!lorebook) return
    await window.api.saveLorebook(profileId, charId, lorebook)
    set({ dirty: false })
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
