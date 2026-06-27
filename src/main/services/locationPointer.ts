import fs from 'fs'
import path from 'path'
import { app } from 'electron'

interface LocationPointer {
  dataDir: string
}

/** Fixed, always-known, writable anchor — NOT inside the relocatable data dir (that would be circular). */
export const pointerPath = (): string => path.join(app.getPath('userData'), 'rpt-location.json')

/** The saved data-dir choice, or null if unset / unreadable / malformed. No cache (reads are rare:
 *  getAppDir memoizes its result, so this is read ~once per session). */
export function readLocationPointer(): LocationPointer | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pointerPath(), 'utf-8'))
    return parsed && typeof parsed.dataDir === 'string' && parsed.dataDir
      ? { dataDir: parsed.dataDir }
      : null
  } catch {
    return null
  }
}

/** Write (or, with null, remove) the pointer. Takes effect on next launch (getAppDir is read once). */
export function writeLocationPointer(dataDir: string | null): void {
  const p = pointerPath()
  if (dataDir) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ dataDir }, null, 2), 'utf-8')
  } else if (fs.existsSync(p)) {
    fs.unlinkSync(p)
  }
}
