import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { Profile } from '../types/models'

export const getProfiles = (): Profile[] => {
  return getDb()
    .prepare('SELECT id, name, avatar_path as avatar_path, password_hash, created_at, last_active FROM profiles ORDER BY last_active DESC')
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
