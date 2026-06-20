import fs from 'fs'
import path from 'path'
import { getAppDir, writeJsonSyncAtomic, readJsonSync } from './storageService'
import { Preset, PresetSchema, getDefaultPreset } from '../types/preset'
import { parseStPreset } from '../parsers/stPresetParser'

const getPresetPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'preset.json')

export const getPreset = (profileId: string): Preset => {
  const raw = readJsonSync(getPresetPath(profileId))
  const parsed = PresetSchema.safeParse(raw)
  return parsed.success ? parsed.data : getDefaultPreset()
}

export const savePreset = (profileId: string, preset: Preset): void => {
  writeJsonSyncAtomic(getPresetPath(profileId), PresetSchema.parse(preset))
}

/**
 * Import a SillyTavern preset file and store it as the active preset. The ST
 * `prompts`/`prompt_order` model is mapped onto our marker-based blocks so the
 * preset's ordering and sampler params carry over. Returns the preset name.
 */
export const importPresetFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const normalized = parseStPreset(raw, path.basename(filePath, '.json'))
    if (!normalized) return null
    const preset = PresetSchema.parse(normalized)
    savePreset(profileId, preset)
    return preset.name
  } catch (error) {
    console.error('Failed to import preset:', error)
    return null
  }
}
