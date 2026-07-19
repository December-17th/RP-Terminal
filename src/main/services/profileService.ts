import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { getAppDir } from './storageService'
import * as settingsService from './settingsService'
import { deleteChatFully, chatIdsForProfile } from './chatDeleteService'
import * as sessionDbService from './sessionDbService'
import { Profile } from '../types/models'
import { AgentCatalog } from './agentRuntime/catalog'

export const getProfiles = (): Profile[] => {
  const db = getDb()
  const profiles = db
    .prepare(
      'SELECT id, name, avatar_path as avatar_path, password_hash, created_at, last_active FROM profiles ORDER BY last_active DESC'
    )
    .all() as Profile[]
  for (const profile of profiles) new AgentCatalog(profile.id, db)
  return profiles
}

export const getProfile = (id: string): Profile | undefined => {
  const db = getDb()
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined
  if (profile) new AgentCatalog(profile.id, db)
  return profile
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
  new AgentCatalog(profile.id)
  return profile
}

export const updateProfileActivity = (id: string): void => {
  const db = getDb()
  db
    .prepare('UPDATE profiles SET last_active = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
  new AgentCatalog(id, db)
}

// Per-profile file content to remove on a debug wipe. The API connection config lives in the
// `settings` blob (not on disk), so nothing here needs preserving for "api presets". `chats` is the
// per-session store (§B1); `table-dbs`/`chat-notes` are the legacy pre-decentralize dirs left as a
// safety net (§B5), also cleared here on a full wipe.
const WIPE_DIRS = [
  'presets',
  'lorebooks',
  'regex',
  'scripts',
  'characters',
  'plugin-storage',
  'chats',
  'table-dbs',
  'chat-notes'
]
const WIPE_FILES = [
  'preset.json',
  'plugins-state.json',
  'plugin-grants.json',
  'character-vars.json',
  'chat-card-vars.json',
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

  // 0. Release any open per-chat session DB handles first, or Windows file locks defeat the recursive
  //    delete of the `chats/` store below (review C3).
  sessionDbService.closeAll()

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
  //    chatService.deleteChat (chatDeleteService) — a bulk `DELETE FROM chats` would LEAK the
  //    non-FK'd central chat-keyed rows (workflow_run_history / workflow_trigger_state /
  //    agent_pack_trigger_state / per-chat pack activation + chat:<id> overrides). Each
  //    deleteChatFully does its own DB txn, then closes + removes the chat's session-store folder
  //    (handle-close first — Windows file locks; step 3's wipe of the whole `chats/` dir is then a
  //    no-op for these). The characters delete runs after. Profile + reset settings rows stay.
  for (const chatId of chatIdsForProfile(profileId)) deleteChatFully(profileId, chatId)
  db.prepare('DELETE FROM characters WHERE profile_id = ?').run(profileId)
  db.prepare('DELETE FROM agent_role_bindings WHERE profile_id = ?').run(profileId)
  db.prepare('DELETE FROM agent_catalog WHERE profile_id = ?').run(profileId)
  new AgentCatalog(profileId, db)

  // 3. File-based per-profile content (includes the whole `chats/` per-session store).
  wipeProfileFiles(profileId)
}
