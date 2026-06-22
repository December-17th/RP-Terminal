import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { log } from './logService'

// Get the base data directory for the app
export const getAppDir = (): string => {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'rp-terminal-data')
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
