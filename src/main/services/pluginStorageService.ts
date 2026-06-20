import path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'

/**
 * Plugin-scoped key/value persistence (P5, `rpt.storage`). Each owner (a plugin
 * id or a card id) gets its own JSON file under the profile, so plugins can't
 * read each other's data. The `owner` is supplied by the host runtime (not the
 * sandboxed iframe), so a plugin can't spoof another's namespace.
 */

export interface StorageAction {
  op: 'get' | 'set' | 'remove' | 'keys' | 'all'
  key?: string
  value?: any
}

const safeOwner = (owner: string): string => owner.replace(/[^a-z0-9._-]/gi, '_')

const fileFor = (profileId: string, owner: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'plugin-storage', `${safeOwner(owner)}.json`)

const read = (profileId: string, owner: string): Record<string, any> =>
  readJsonSync<Record<string, any>>(fileFor(profileId, owner)) || {}

export const storageOp = (profileId: string, owner: string, action: StorageAction): any => {
  const data = read(profileId, owner)
  switch (action.op) {
    case 'get':
      return action.key ? data[action.key] : undefined
    case 'all':
      return data
    case 'keys':
      return Object.keys(data)
    case 'set':
      if (!action.key) return undefined
      data[action.key] = action.value
      writeJsonSyncAtomic(fileFor(profileId, owner), data)
      return action.value
    case 'remove':
      if (action.key) {
        delete data[action.key]
        writeJsonSyncAtomic(fileFor(profileId, owner), data)
      }
      return undefined
    default:
      return undefined
  }
}
