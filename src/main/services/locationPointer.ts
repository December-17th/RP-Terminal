import fs from 'fs'
import path from 'path'
import { app } from 'electron'

interface LocationPointer {
  dataDir: string
}

const pointerFilePath = (userDataDir: string): string => path.join(userDataDir, 'rpt-location.json')

/** Fixed, always-known anchor for this extracted app folder. When a custom data directory is active,
 *  the pointer remains beside the app instead of inside that chosen directory (which would be circular). */
export const pointerPath = (): string => pointerFilePath(app.getPath('userData'))

const readPointerFile = (filePath: string): LocationPointer | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return parsed && typeof parsed.dataDir === 'string' && parsed.dataDir
      ? { dataDir: parsed.dataDir }
      : null
  } catch {
    return null
  }
}

/** The saved data-dir choice, or null if unset / unreadable / malformed. No cache (reads are rare:
 *  getAppDir memoizes its result, so this is read ~once per session). */
export function readLocationPointer(): LocationPointer | null {
  return readPointerFile(pointerPath())
}

/** Carry a valid custom-location choice from the previous AppData anchor into a fresh portable
 *  folder. Existing portable data or a portable pointer always wins; the source is left intact. */
export function copyLegacyLocationPointerIfNeeded(opts: {
  legacyUserDataDir: string
  portableUserDataDir: string
}): boolean {
  const { legacyUserDataDir, portableUserDataDir } = opts
  if (path.resolve(legacyUserDataDir) === path.resolve(portableUserDataDir)) return false
  if (fs.existsSync(path.join(portableUserDataDir, 'rpterminal.db'))) return false
  const target = pointerFilePath(portableUserDataDir)
  if (fs.existsSync(target)) return false
  const pointer = readPointerFile(pointerFilePath(legacyUserDataDir))
  if (!pointer) return false
  fs.mkdirSync(portableUserDataDir, { recursive: true })
  fs.writeFileSync(target, JSON.stringify(pointer, null, 2), 'utf-8')
  return true
}

/** Write (or, with a falsy value — null or '' — remove) the pointer. Takes effect on next launch (getAppDir is read once). */
export function writeLocationPointer(dataDir: string | null): void {
  const p = pointerPath()
  if (dataDir) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ dataDir }, null, 2), 'utf-8')
  } else if (fs.existsSync(p)) {
    fs.unlinkSync(p)
  }
}
