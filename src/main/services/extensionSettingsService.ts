import path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'

/**
 * Durable backing for the TavernHelper `getContext().extensionSettings` bag (issue 19). ST persists
 * extension settings inside its `settings.json` and flushes them via `saveSettingsDebounced()`; RP
 * Terminal has no `settings.json`, so extension-style cards used to write into a throwaway stub
 * (`{ EjsTemplate: { enabled: true } }`) and their changes evaporated. This service gives that bag a
 * real, per-profile home so a card's settings survive a reload — the `saveSettingsDebounced` flush is
 * durable, not a no-op.
 *
 * One whole-object JSON file per profile (mirrors the global-vars store's shape). Pure data access; the
 * debounce lives in the card runtime (`saveSettingsDebounced`), not here.
 */

const settingsPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'extension-settings.json')

/** The whole extension-settings bag for a profile ({} when none saved yet). */
export const getExtensionSettings = (profileId: string): Record<string, unknown> => {
  const data = readJsonSync<Record<string, unknown>>(settingsPath(profileId))
  return data && typeof data === 'object' ? data : {}
}

/** Persist the whole extension-settings bag (whole-object write, atomically). */
export const setExtensionSettings = (
  profileId: string,
  settings: Record<string, unknown>
): void => {
  writeJsonSyncAtomic(settingsPath(profileId), settings && typeof settings === 'object' ? settings : {})
}
