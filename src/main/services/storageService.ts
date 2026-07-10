import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { log } from './logService'
import { readLocationPointer, writeLocationPointer } from './locationPointer'

export const DATA_DIR_NAME = 'rp-terminal-data'

/** Resolve the data-root base. Precedence: explicit override → saved pointer → platform default.
 *  override/pointer are used verbatim (the chosen folder IS the data dir); the default appends
 *  DATA_DIR_NAME. Pure — the electron/env/fs reads live in getAppDir (fs comes in via existsNonEmpty).
 *
 *  Packaged default = userDataDir + DATA_DIR_NAME (writable everywhere), EXCEPT back-compat: an
 *  existing portable install with a non-empty <exeDir>/DATA_DIR_NAME keeps using it. In that case
 *  persistPointer=true asks getAppDir to save a pointer so the choice is durable + visible in Settings. */
export function resolveDataBase(opts: {
  override?: string
  pointer?: string
  isDev: boolean
  cwd: string
  exeDir: string
  userDataDir: string
  existsNonEmpty: (dir: string) => boolean
}): { dir: string; appendName: boolean; persistPointer?: boolean } {
  if (opts.override) return { dir: opts.override, appendName: false }
  if (opts.pointer) return { dir: opts.pointer, appendName: false }
  if (opts.isDev) return { dir: opts.cwd, appendName: true }
  const exeData = path.join(opts.exeDir, DATA_DIR_NAME)
  if (opts.existsNonEmpty(exeData)) return { dir: exeData, appendName: false, persistPointer: true }
  return { dir: opts.userDataDir, appendName: true }
}

/** True iff dir exists and holds at least one entry. Any fs error → false. */
const dirIsNonEmpty = (dir: string): boolean => {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

let cachedAppDir: string | null = null

// The data root: RPT_DATA_DIR → saved pointer → platform default (dev=cwd / packaged=userData, with
// an existing portable <exeDir>/rp-terminal-data honored) + DATA_DIR_NAME. Memoized — the location
// cannot change without an app restart.
export const getAppDir = (): string => {
  if (cachedAppDir) return cachedAppDir
  const { dir, appendName, persistPointer } = resolveDataBase({
    override: process.env.RPT_DATA_DIR,
    pointer: readLocationPointer()?.dataDir,
    isDev: !app.isPackaged, // true in `electron-vite dev`, false in a packaged build
    cwd: process.cwd(),
    exeDir: path.dirname(app.getPath('exe')),
    userDataDir: app.getPath('userData'),
    existsNonEmpty: dirIsNonEmpty
  })
  cachedAppDir = appendName ? path.join(dir, DATA_DIR_NAME) : dir
  // Back-compat: durably record an adopted portable install so it survives + shows in Settings.
  if (persistPointer) writeLocationPointer(cachedAppDir)
  return cachedAppDir
}

export const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

export const writeJsonSyncAtomic = (filePath: string, data: any): void => {
  ensureDir(path.dirname(filePath))
  const tmpPath = `${filePath}.tmp`
  const jsonStr = JSON.stringify(data, null, 2)
  fs.writeFileSync(tmpPath, jsonStr, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

export const readJsonSync = <T = any>(filePath: string): T | null => {
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    log('error', `Failed to read JSON file at ${filePath}`, error)
    return null
  }
}

export const listDirectoriesSync = (dirPath: string): string[] => {
  if (!fs.existsSync(dirPath)) return []
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
}

export const listFilesSync = (dirPath: string): string[] => {
  if (!fs.existsSync(dirPath)) return []
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name)
}

/** One-time copy of the legacy %APPDATA% data dir into the new location, on first run only.
 *  Runs only when getAppDir used the platform default (no env/pointer), the target has no DB yet,
 *  and the legacy dir exists. Leaves the legacy copy intact as a backup. Returns true iff it copied. */
export function copyLegacyDataDirIfNeeded(opts: {
  legacyDir: string
  targetDir: string
  usingDefault: boolean
}): boolean {
  const { legacyDir, targetDir, usingDefault } = opts
  if (!usingDefault) return false
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return false
  if (fs.existsSync(path.join(targetDir, 'rpterminal.db'))) return false
  if (!fs.existsSync(legacyDir)) return false
  fs.cpSync(legacyDir, targetDir, { recursive: true, errorOnExist: false })
  return true
}
