import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { log } from './logService'
import { readLocationPointer } from './locationPointer'

export const DATA_DIR_NAME = 'rp-terminal-data'

/** Resolve the data-root base. Precedence: explicit override → saved pointer → platform default.
 *  override/pointer are used verbatim (the chosen folder IS the data dir); the default appends
 *  DATA_DIR_NAME. Pure — the electron/env reads live in getAppDir. */
export function resolveDataBase(opts: {
  override?: string
  pointer?: string
  isDev: boolean
  cwd: string
  exeDir: string
}): { dir: string; appendName: boolean } {
  if (opts.override) return { dir: opts.override, appendName: false }
  if (opts.pointer) return { dir: opts.pointer, appendName: false }
  return { dir: opts.isDev ? opts.cwd : opts.exeDir, appendName: true }
}

let cachedAppDir: string | null = null

// The data root: RPT_DATA_DIR → saved pointer → platform default (dev=cwd / packaged=exe dir) +
// DATA_DIR_NAME. Memoized — the location cannot change without an app restart.
export const getAppDir = (): string => {
  if (cachedAppDir) return cachedAppDir
  const { dir, appendName } = resolveDataBase({
    override: process.env.RPT_DATA_DIR,
    pointer: readLocationPointer()?.dataDir,
    isDev: !app.isPackaged, // true in `electron-vite dev`, false in a packaged build
    cwd: process.cwd(),
    exeDir: path.dirname(app.getPath('exe'))
  })
  cachedAppDir = appendName ? path.join(dir, DATA_DIR_NAME) : dir
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
