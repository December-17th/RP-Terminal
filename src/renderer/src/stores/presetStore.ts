import { create } from 'zustand'

export type PromptMarker =
  | 'none'
  | 'char_description'
  | 'mes_example'
  | 'world_info'
  | 'chat_history'
  | 'post_history'

export interface PromptBlock {
  identifier: string
  name: string
  role: 'system' | 'user' | 'assistant'
  content: string
  enabled: boolean
  marker: PromptMarker
}

export interface PresetParameters {
  temperature: number
  max_tokens: number
  top_p?: number
  top_k?: number
  frequency_penalty?: number
  presence_penalty?: number
  repetition_penalty?: number
  min_p?: number
  top_a?: number
}

export interface Preset {
  name: string
  parameters: PresetParameters
  prompts: PromptBlock[]
}

interface PresetState {
  preset: Preset | null
  dirty: boolean
  load: (profileId: string) => Promise<void>
  save: (profileId: string) => Promise<void>
  setName: (name: string) => void
  setParam: (key: keyof PresetParameters, value: number | undefined) => void
  updateBlock: (index: number, patch: Partial<PromptBlock>) => void
  toggleBlock: (index: number) => void
  moveBlock: (index: number, dir: -1 | 1) => void
  addBlock: () => void
  deleteBlock: (index: number) => void
}

const mutate = (
  set: (fn: (s: PresetState) => Partial<PresetState>) => void,
  fn: (preset: Preset) => Preset
): void => {
  set((s) => (s.preset ? { preset: fn(s.preset), dirty: true } : {}))
}

export const usePresetStore = create<PresetState>((set, get) => ({
  preset: null,
  dirty: false,

  load: async (profileId) => {
    const preset = await window.api.getPreset(profileId)
    set({ preset, dirty: false })
  },

  save: async (profileId) => {
    const { preset } = get()
    if (!preset) return
    await window.api.savePreset(profileId, preset)
    set({ dirty: false })
  },

  setName: (name) => mutate(set, (p) => ({ ...p, name })),

  setParam: (key, value) =>
    mutate(set, (p) => ({ ...p, parameters: { ...p.parameters, [key]: value } })),

  updateBlock: (index, patch) =>
    mutate(set, (p) => ({
      ...p,
      prompts: p.prompts.map((b, i) => (i === index ? { ...b, ...patch } : b))
    })),

  toggleBlock: (index) =>
    mutate(set, (p) => ({
      ...p,
      prompts: p.prompts.map((b, i) => (i === index ? { ...b, enabled: !b.enabled } : b))
    })),

  moveBlock: (index, dir) =>
    mutate(set, (p) => {
      const target = index + dir
      if (target < 0 || target >= p.prompts.length) return p
      const prompts = [...p.prompts]
      ;[prompts[index], prompts[target]] = [prompts[target], prompts[index]]
      return { ...p, prompts }
    }),

  addBlock: () =>
    mutate(set, (p) => ({
      ...p,
      prompts: [
        ...p.prompts,
        {
          identifier: `custom-${Date.now()}`,
          name: 'New Prompt',
          role: 'system',
          content: '',
          enabled: true,
          marker: 'none'
        }
      ]
    })),

  deleteBlock: (index) =>
    mutate(set, (p) => ({ ...p, prompts: p.prompts.filter((_, i) => i !== index) }))
}))
