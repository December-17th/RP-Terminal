import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { getAppDir } from './storageService'
import * as settingsService from './settingsService'
import { deleteChatFully, chatIdsForProfile } from './chatDeleteService'
import { Profile } from '../types/models'

export const getProfiles = (): Profile[] => {
  return getDb()
    .prepare(
      'SELECT id, name, avatar_path as avatar_path, password_hash, created_at, last_active FROM profiles ORDER BY last_active DESC'
    )
    .all() as Profile[]
}

export const getProfile = (id: string): Profile | undefined => {
  return getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined
}

export const createProfile = (name: string, passwordHash?: string): Profile => {
  const now = new Date().toISOString()
  const profile: Profile = {
    id: uuidv4(),
    name,
    password_hash: passwordHash,
    created_at: now,
    last_active: now
  }
  getDb()
    .prepare(
      'INSERT INTO profiles (id, name, password_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?)'
    )
    .run(profile.id, profile.name, profile.password_hash ?? null, now, now)
  return profile
}

export const updateProfileActivity = (id: string): void => {
  getDb()
    .prepare('UPDATE profiles SET last_active = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

// Per-profile file content to remove on a debug wipe. The API connection config lives in the
// `settings` blob (not on disk), so nothing here needs preserving for "api presets".
const WIPE_DIRS = ['presets', 'lorebooks', 'regex', 'scripts', 'characters', 'plugin-storage']
const WIPE_FILES = [
  'preset.json',
  'plugins-state.json',
  'plugin-grants.json',
  'character-vars.json',
  'template-globals.json'
]

const wipeProfileFiles = (profileId: string): void => {
  const dir = path.join(getAppDir(), 'profiles', profileId)
  for (const d of WIPE_DIRS) fs.rmSync(path.join(dir, d), { recursive: true, force: true })
  for (const f of WIPE_FILES) fs.rmSync(path.join(dir, f), { force: true })
}

/**
 * Debug-only: wipe ALL of a profile's content — characters, chats (→ floors / combat encounters /
 * episodic memory / rpg entities via FK cascade), presets, lorebooks, regex, scripts, plugin data —
 * and reset settings to defaults, **preserving the API connection config** (`api_presets` + the
 * active/live connection) so you can keep generating without re-entering keys. The profile row
 * itself (and its avatar) survive.
 */
export const wipeProfile = (profileId: string): void => {
  const db = getDb()

  // 1. Reset settings, keeping the API presets / active connection. get→save round-trips through the
  //    encrypt logic, so the retained keys stay protected.
  const cur = settingsService.getSettings(profileId)
  settingsService.saveSettings(profileId, {
    ...settingsService.getDefaultSettings(),
    api: cur.api,
    api_presets: cur.api_presets,
    active_api_preset_id: cur.active_api_preset_id
  })

  // 2. DB content. Tear down every chat through the SAME centralized per-chat cleanup as
  //    chatService.deleteChat — deleting the chat rows in bulk would FK-cascade floors/table_ops/etc
  //    but LEAK the non-cascading chat-keyed tables (workflow_run_history / *_trigger_state /
  //    agent_pack_activation) and the per-chat files (table sandbox / refill shadow / notes). Each
  //    deleteChatFully does its own DB txn + post-commit file removals (files can't be transactional),
  //    so the characters delete runs after. The profile + (reset) settings rows stay.
  for (const chatId of chatIdsForProfile(profileId)) deleteChatFully(profileId, chatId)
  db.prepare('DELETE FROM characters WHERE profile_id = ?').run(profileId)

  // 3. File-based per-profile content.
  wipeProfileFiles(profileId)
}
