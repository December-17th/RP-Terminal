import fs from 'fs'
import path from 'path'
import { getDb } from './db'
import { Preset, PresetSchema, getDefaultPreset } from '../types/preset'
import { parseStPreset } from '../parsers/stPresetParser'

export const getPreset = (profileId: string): Preset => {
  const row = getDb()
    .prepare('SELECT data FROM presets WHERE profile_id = ?')
    .get(profileId) as { data: string } | undefined
  if (!row) return getDefaultPreset()
  const parsed = PresetSchema.safeParse(safeJson(row.data))
  return parsed.success ? parsed.data : getDefaultPreset()
}

export const savePreset = (profileId: string, preset: Preset): void => {
  getDb()
    .prepare(
      `INSERT INTO presets (profile_id, data) VALUES (?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data`
    )
    .run(profileId, JSON.stringify(PresetSchema.parse(preset)))
}

/**
 * Import a SillyTavern preset file and store it as the active preset. Returns the
 * preset name, or null on failure.
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

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
