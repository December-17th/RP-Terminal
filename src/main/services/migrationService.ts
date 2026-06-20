import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir, readJsonSync, listDirectoriesSync } from './storageService'
import { getDb } from './db'
import { saveCharacter, getAvatarPath } from './characterService'
import { saveCharacterLorebook } from './lorebookService'
import { saveSettings } from './settingsService'
import { savePreset } from './presetService'
import { saveFloor } from './floorService'
import { log } from './logService'
import { RPTerminalCard } from '../types/character'
import { FloorFile } from '../types/chat'

/**
 * One-time import of the legacy file-per-JSON store (rp-terminal-data/profiles/…)
 * into SQLite. Runs only when the DB has no profiles yet and the old layout
 * exists, so it's idempotent and safe to call on every startup.
 */
export const migrateIfNeeded = (): void => {
  const db = getDb()
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }
  if (n > 0) return

  const profilesPath = path.join(getAppDir(), 'profiles.json')
  if (!fs.existsSync(profilesPath)) return
  const oldProfiles = readJsonSync<any[]>(profilesPath)
  if (!Array.isArray(oldProfiles) || oldProfiles.length === 0) return

  log('info', `Migrating ${oldProfiles.length} profile(s) from JSON to SQLite…`)

  for (const p of oldProfiles) {
    try {
      migrateProfile(p)
    } catch (err: any) {
      log('error', `Migration failed for profile ${p?.id}`, err?.message || String(err))
    }
  }
  log('info', 'JSON → SQLite migration complete')
}

const migrateProfile = (p: any): void => {
  const db = getDb()
  // Atomic per profile: if anything fails, roll back so the next startup retries
  // (the migration guard keys off an empty profiles table).
  db.transaction(() => migrateProfileInner(p))()
}

const migrateProfileInner = (p: any): void => {
  const db = getDb()
  const profileDir = path.join(getAppDir(), 'profiles', p.id)

  db.prepare(
    'INSERT INTO profiles (id, name, password_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?)'
  ).run(
    p.id,
    p.name || 'Profile',
    p.password_hash ?? null,
    p.created_at || new Date().toISOString(),
    p.last_active || new Date().toISOString()
  )

  const settings = readJsonSync(path.join(profileDir, 'settings.json'))
  if (settings) saveSettings(p.id, settings as any)

  const preset = readJsonSync(path.join(profileDir, 'preset.json'))
  if (preset) {
    try {
      savePreset(p.id, preset as any)
    } catch (e: any) {
      log('error', `Skipped invalid preset for ${p.id}`, e?.message)
    }
  }

  // Characters (+ embedded lorebook + avatar).
  const charsDir = path.join(profileDir, 'characters')
  for (const charId of listDirectoriesSync(charsDir)) {
    const card = readJsonSync<RPTerminalCard>(path.join(charsDir, charId, 'card.json'))
    if (!card) continue
    try {
      saveCharacter(p.id, charId, card)
    } catch (e: any) {
      log('error', `Skipped invalid card ${charId}`, e?.message)
      continue
    }
    const lorebook = readJsonSync(path.join(charsDir, charId, 'lorebook.json'))
    if (lorebook) {
      try {
        saveCharacterLorebook(p.id, charId, lorebook as any)
      } catch {
        /* ignore bad lorebook */
      }
    }
    const avatar = path.join(charsDir, charId, 'avatar.png')
    if (fs.existsSync(avatar)) {
      ensureDir(path.dirname(getAvatarPath(charId)))
      fs.copyFileSync(avatar, getAvatarPath(charId))
    }
  }

  // Chats (+ floor files).
  const chatsDir = path.join(profileDir, 'chats')
  for (const chatId of listDirectoriesSync(chatsDir)) {
    const chat = readJsonSync<any>(path.join(chatsDir, chatId, 'chat.json'))
    if (!chat) continue
    db.prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      chatId,
      p.id,
      chat.character_id || '',
      chat.created_at || new Date().toISOString(),
      chat.updated_at || new Date().toISOString()
    )

    const chatDir = path.join(chatsDir, chatId)
    const chatTs = chat.updated_at || chat.created_at || new Date().toISOString()
    for (const file of fs.existsSync(chatDir) ? fs.readdirSync(chatDir) : []) {
      if (!file.startsWith('floor-') || !file.endsWith('.json')) continue
      const raw = readJsonSync<any>(path.join(chatDir, file))
      if (!raw) continue
      // Older floor files predate the timestamp/events fields — backfill defaults.
      const ts = raw.timestamp || raw.user_message?.timestamp || chatTs
      const floor: FloorFile = {
        floor: raw.floor,
        chat_id: chatId,
        timestamp: ts,
        user_message: {
          content: raw.user_message?.content ?? '',
          timestamp: raw.user_message?.timestamp ?? ts
        },
        response: {
          content: raw.response?.content ?? '',
          model: raw.response?.model ?? '',
          provider: raw.response?.provider ?? ''
        },
        events: Array.isArray(raw.events) ? raw.events : [],
        variables: raw.variables ?? {}
      }
      saveFloor(p.id, chatId, floor)
    }
  }
}
