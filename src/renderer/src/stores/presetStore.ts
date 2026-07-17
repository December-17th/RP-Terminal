import { create } from 'zustand'

export type PromptMarker =
  | 'none'
  | 'char_description'
  | 'mes_example'
  | 'world_info'
  | 'persona_description'
  | 'chat_history'
  | 'post_history'

export interface PromptBlock {
  identifier: string
  name: string
  role: 'system' | 'user' | 'assistant'
  content: string
  enabled: boolean
  marker: PromptMarker
  /** Inject a literal block at this depth (msgs from the bottom); null = inline. */
  injection_depth: number | null
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

export interface PresetSummary {
  id: string
  name: string
}

/** What importing a preset brought in: the preset name + counts of bundled artifacts. */
export interface PresetImportResult {
  name: string
  regexScripts: number
  scripts: number
}

interface PresetState {
  presets: PresetSummary[]
  activeId: string | null
  preset: Preset | null
  dirty: boolean
  load: (profileId: string) => Promise<void>
  select: (profileId: string, presetId: string) => Promise<void>
  createNew: (profileId: string) => Promise<void>
  importPreset: (profileId: string) => Promise<PresetImportResult | null>
  remove: (profileId: string) => Promise<void>
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
  presets: [],
  activeId: null,
  preset: null,
  dirty: false,

  load: async (profileId) => {
    const presets = await window.api.listPresets(profileId)
    const activeId = await window.api.getActivePresetId(profileId)
    const preset = activeId ? await window.api.getPreset(profileId, activeId) : null
    set({ presets, activeId, preset, dirty: false })
  },

  select: async (profileId, presetId) => {
    await window.api.setActivePreset(profileId, presetId)
    const preset = await window.api.getPreset(profileId, presetId)
    set({ activeId: presetId, preset, dirty: false })
  },

  createNew: async (profileId) => {
    const summary = await window.api.createPreset(profileId, 'New Preset')
    const presets = await window.api.listPresets(profileId)
    const preset = await window.api.getPreset(profileId, summary.id)
    set({ presets, activeId: summary.id, preset, dirty: false })
  },

  importPreset: async (profileId) => {
    const result = (await window.api.importPresetDialog(profileId)) as PresetImportResult | null
    if (result) await get().load(profileId)
    return result
  },

  remove: async (profileId) => {
    const { activeId } = get()
    if (!activeId) return
    await window.api.deletePreset(profileId, activeId)
    await get().load(profileId)
  },

  save: async (profileId) => {
    const { preset, activeId } = get()
    if (!preset || !activeId) return
    await window.api.savePreset(profileId, activeId, preset)
    const presets = await window.api.listPresets(profileId) // name may have changed
    set({ presets, dirty: false })
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
          marker: 'none',
          injection_depth: null
        }
      ]
    })),
  deleteBlock: (index) =>
    mutate(set, (p) => ({ ...p, prompts: p.prompts.filter((_, i) => i !== index) }))
}))
