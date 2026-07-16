import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { log } from './logService'
import { readLocationPointer } from './locationPointer'

export const DATA_DIR_NAME = 'rp-terminal-data'

/** Resolve the data-root base. Precedence: explicit override → saved pointer → platform default.
 *  override/pointer are used verbatim (the chosen folder IS the data dir). Pure — the Electron and
 *  environment reads live in getAppDir.
 *
 *  Packaged Windows default = <exeDir>/DATA_DIR_NAME so the extracted folder is self-contained.
 *  Other packaged platforms use Electron's userData directory verbatim. */
export function resolveDataBase(opts: {
  override?: string
  pointer?: string
  isDev: boolean
  usePortableDataDir: boolean
  cwd: string
  exeDir: string
  userDataDir: string
}): { dir: string; appendName: boolean } {
  if (opts.override) return { dir: opts.override, appendName: false }
  if (opts.pointer) return { dir: opts.pointer, appendName: false }
  if (opts.isDev) return { dir: opts.cwd, appendName: true }
  if (opts.usePortableDataDir) return { dir: opts.exeDir, appendName: true }
  return { dir: opts.userDataDir, appendName: false }
}

let cachedAppDir: string | null = null

// The data root: RPT_DATA_DIR → saved pointer → platform default. Windows ZIP builds keep data beside
// the executable; packaged macOS uses Electron's userData path. Memoized — the location cannot change
// without an app restart.
export const getAppDir = (): string => {
  if (cachedAppDir) return cachedAppDir
  const { dir, appendName } = resolveDataBase({
    override: process.env.RPT_DATA_DIR,
    pointer: readLocationPointer()?.dataDir,
    isDev: !app.isPackaged, // true in `electron-vite dev`, false in a packaged build
    usePortableDataDir: app.isPackaged && process.platform === 'win32',
    cwd: process.cwd(),
    // ZIP builds run in place after extraction. Keep PORTABLE_EXECUTABLE_DIR for compatibility with
    // the earlier single-executable build when migrating an existing installation.
    exeDir: process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')),
    userDataDir: app.getPath('userData')
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

/** Atomic UTF-8 text write (write to `<file>.tmp`, then rename), mirroring writeJsonSyncAtomic for
 *  non-JSON payloads such as the per-chat notes markdown file. Creates the parent dir. */
export const writeTextSyncAtomic = (filePath: string, text: string): void => {
  ensureDir(path.dirname(filePath))
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, text, 'utf-8')
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
