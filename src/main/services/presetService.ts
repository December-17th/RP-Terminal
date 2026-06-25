import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { log } from './logService'
import { Preset, PresetSchema, getDefaultPreset } from '../types/preset'
import { parseStPreset } from '../parsers/stPresetParser'
import * as regexService from './regexService'
import * as scriptService from './scriptService'

export interface PresetSummary {
  id: string
  name: string
}

/** What `importPresetFromFile` installed: the preset plus any artifacts it bundled. */
export interface PresetImportResult {
  name: string
  regexScripts: number
  scripts: number
}

/**
 * ST chat-completion presets can bundle regex + Tavern Helper scripts under
 * `extensions` (`regex_scripts[]`, `tavern_helper.scripts[]`). These collectors pull
 * those out so the importer can route them into the regex/script stores, scoped to the
 * imported preset. Pure; tolerant of the non-standard exports we've seen in the wild
 * (top-level array wrapping a single preset object).
 */
const presetRoot = (raw: any): any =>
  Array.isArray(raw) ? (raw.find((x) => x && typeof x === 'object') ?? {}) : (raw ?? {})

export const collectPresetRegex = (raw: any): any[] => {
  const ext = presetRoot(raw)?.extensions
  const arr = ext?.regex_scripts
  return Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object') : []
}

export const collectPresetScripts = (raw: any): any[] => {
  const ext = presetRoot(raw)?.extensions
  const arr = ext?.tavern_helper?.scripts
  return Array.isArray(arr) ? arr.filter((s) => s && typeof s === 'object') : []
}

const presetsDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'presets')
const presetPath = (profileId: string, id: string): string =>
  path.join(presetsDir(profileId), `${id}.json`)
const activePath = (profileId: string): string => path.join(presetsDir(profileId), '_active.json')

/**
 * Ensure the presets directory exists, lazily migrating the pre-multi-preset
 * single `preset.json` into it on first access.
 */
const ensurePresetsDir = (profileId: string): string => {
  const dir = presetsDir(profileId)
  if (fs.existsSync(dir)) return dir
  ensureDir(dir)

  const legacy = readJsonSync(path.join(getAppDir(), 'profiles', profileId, 'preset.json'))
  if (legacy) {
    const parsed = PresetSchema.safeParse(legacy)
    if (parsed.success) {
      const id = randomUUID()
      writeJsonSyncAtomic(presetPath(profileId, id), parsed.data)
      writeJsonSyncAtomic(activePath(profileId), { id })
    }
  }
  return dir
}

export const listPresets = (profileId: string): PresetSummary[] => {
  const dir = ensurePresetsDir(profileId)
  const out: PresetSummary[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const id = file.replace(/\.json$/, '')
    const data = readJsonSync<Preset>(path.join(dir, file))
    if (data) out.push({ id, name: data.name || 'Untitled Preset' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const getActivePresetId = (profileId: string): string | null => {
  ensurePresetsDir(profileId)
  const active = readJsonSync<{ id: string }>(activePath(profileId))
  if (active?.id && fs.existsSync(presetPath(profileId, active.id))) return active.id
  const first = listPresets(profileId)[0]
  return first?.id ?? null
}

export const setActivePreset = (profileId: string, presetId: string): void => {
  ensurePresetsDir(profileId)
  writeJsonSyncAtomic(activePath(profileId), { id: presetId })
}

export const getPresetById = (profileId: string, presetId: string): Preset | null => {
  const data = readJsonSync(presetPath(profileId, presetId))
  if (!data) return null
  const parsed = PresetSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** The active preset's data, used by generation. Falls back to a default. */
export const getActivePreset = (profileId: string): Preset => {
  const id = getActivePresetId(profileId)
  if (!id) return getDefaultPreset()
  return getPresetById(profileId, id) ?? getDefaultPreset()
}

/** Write a preset to its own JSON file; optionally make it active. Returns its id. */
export const createPresetFromData = (
  profileId: string,
  name: string,
  data: Preset,
  makeActive = true
): string => {
  ensurePresetsDir(profileId)
  const id = randomUUID()
  const parsed = PresetSchema.parse({ ...data, name })
  writeJsonSyncAtomic(presetPath(profileId, id), parsed)
  if (makeActive) setActivePreset(profileId, id)
  return id
}

/** Create a new, empty preset (no prompt blocks) and make it active. */
export const createEmptyPreset = (profileId: string, name = 'New Preset'): PresetSummary => {
  const empty: Preset = { name, parameters: { temperature: 0.9, max_tokens: 4000 }, prompts: [] }
  const id = createPresetFromData(profileId, name, empty, true)
  return { id, name }
}

export const savePreset = (profileId: string, presetId: string, preset: Preset): void => {
  ensurePresetsDir(profileId)
  writeJsonSyncAtomic(presetPath(profileId, presetId), PresetSchema.parse(preset))
}

export const deletePreset = (profileId: string, presetId: string): void => {
  const p = presetPath(profileId, presetId)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  // Remove any regex/scripts the preset bundled (scope=preset, owner=presetId) so a
  // deleted preset doesn't leave orphaned artifacts firing for a preset that's gone.
  regexService.deleteScriptsByOwner(profileId, 'preset', presetId)
  scriptService.deleteScriptsByOwner(profileId, 'preset', presetId)
  const next = getActivePresetId(profileId)
  writeJsonSyncAtomic(activePath(profileId), { id: next ?? null })
}

/**
 * Install a preset bundled in a World Card (Track S §3). Accepts our native
 * `{ name, parameters, prompts }` shape directly, else normalizes an ST chat-completion
 * preset. Never hijacks the active preset, and skips (returns null) if a preset with the
 * same name already exists so re-importing a world is idempotent. Returns the name.
 */
export const installBundledPreset = (profileId: string, raw: any): string | null => {
  try {
    let preset: Preset | null = null
    // Native bundles carry a structured `parameters` object — parse those directly;
    // otherwise treat it as an ST preset and run it through the importer's normalizer.
    if (raw && typeof raw === 'object' && raw.parameters && typeof raw.parameters === 'object') {
      const direct = PresetSchema.safeParse(raw)
      if (direct.success) preset = direct.data
    }
    if (!preset) {
      const normalized = parseStPreset(raw, raw?.name || 'Bundled Preset')
      if (normalized) preset = PresetSchema.parse(normalized)
    }
    if (!preset) return null
    if (listPresets(profileId).some((p) => p.name === preset!.name)) return null // dedup by name
    createPresetFromData(profileId, preset.name, preset, false)
    return preset.name
  } catch (error) {
    log('error', 'Failed to install bundled preset:', error)
    return null
  }
}

/**
 * Import a SillyTavern preset file as a NEW active preset, AND extract any regex /
 * Tavern Helper scripts it bundles under `extensions` into the regex/script stores,
 * scoped to this preset (so they only fire while it's the active preset — mirroring how
 * ST applies preset-bound regex). Returns the preset name + how many artifacts came with it.
 */
export const importPresetFromFile = (
  profileId: string,
  filePath: string
): PresetImportResult | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const normalized = parseStPreset(raw, path.basename(filePath, '.json'))
    if (!normalized) return null
    const preset = PresetSchema.parse(normalized)
    const presetId = createPresetFromData(profileId, preset.name, preset, true)

    // Route bundled regex (each ST rule → its own script file) scoped to the preset.
    let regexScripts = 0
    for (const rule of collectPresetRegex(raw)) {
      if (regexService.saveRegexScript(profileId, rule, 'preset', presetId)) regexScripts++
    }

    // Route bundled Tavern Helper scripts (declarative buttons baked in) scoped to the preset.
    let scripts = 0
    for (const s of scriptService.normalizeImportedScripts(collectPresetScripts(raw))) {
      const file = scriptService.saveScript(
        profileId,
        { name: s.name, code: s.code },
        'preset',
        presetId
      )
      if (!s.enabled) scriptService.setScriptDisabled(profileId, file, true)
      scripts++
    }

    return { name: preset.name, regexScripts, scripts }
  } catch (error) {
    log('error', 'Failed to import preset:', error)
    return null
  }
}
