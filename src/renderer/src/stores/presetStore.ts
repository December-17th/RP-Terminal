import { create } from 'zustand'

// Mirror of the main-process PromptMarker enum (src/main/types/preset.ts) — kept in sync by hand
// (the renderer can't import main types across the module boundary).
export type PromptMarker =
  | 'none'
  | 'char_description'
  | 'char_personality'
  | 'scenario'
  | 'mes_example'
  | 'world_info'
  | 'world_info_before'
  | 'world_info_after'
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
  /** ST generation-type allow-list ([] = all types). */
  injection_trigger?: string[]
  /** ST: block a character-card override from replacing this block's content. */
  forbid_overrides?: boolean
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

/**
 * A capability inventory of an imported preset (ADR 0017) — counts + flags, not a trust gate.
 * Mirrors `PresetInventory` in `src/main/services/presetService.ts` (IPC has no shared type).
 */
export interface PresetInventory {
  prompts: number
  promptsEnabled: number
  regexScripts: number
  spresetRegex: number
  /** SPreset ChatSquash features RPT won't run when enabled (issue 16): post-script/parse-clewd/… */
  unsupportedSpreset: string[]
  tavernHelperScripts: number
  remoteCodeScripts: number
  ejsPrompts: number
  unknownExtensions: string[]
  duplicateIdentifiers: string[]
  orphanIdentifiers: string[]
}

/** What importing a preset brought in: the preset name, installed counts, and the inventory. */
export interface PresetImportResult {
  name: string
  regexScripts: number
  scripts: number
  inventory: PresetInventory
}

interface PresetState {
  presets: PresetSummary[]
  activeId: string | null
  preset: Preset | null
  dirty: boolean
  /** Invalidates runtime consumers when the active preset's installed script set changes in place. */
  runtimeRevision: number
  invalidateRuntime: () => void
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
  runtimeRevision: 0,
  invalidateRuntime: () => set((s) => ({ runtimeRevision: s.runtimeRevision + 1 })),

  load: async (profileId) => {
    const presets = await window.api.listPresets(profileId)
    const activeId = await window.api.getActivePresetId(profileId)
    const preset = activeId ? await window.api.getPreset(profileId, activeId) : null
    set({ presets, activeId, preset, dirty: false })
  },

  select: async (profileId, presetId) => {
    await window.api.setActivePreset(profileId, presetId)
    const preset = await window.api.getPreset(profileId, presetId)
    set((s) => ({
      activeId: presetId,
      preset,
      dirty: false,
      runtimeRevision: s.runtimeRevision + 1
    }))
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
