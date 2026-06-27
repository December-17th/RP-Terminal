import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { copyLegacyDataDirIfNeeded } from '../src/main/services/storageService'

let root: string
const seed = (dir: string, withDb = true): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'profiles.json'), '[]')
  if (withDb) fs.writeFileSync(path.join(dir, 'rpterminal.db'), 'db')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-legacy-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('copyLegacyDataDirIfNeeded', () => {
  it('copies legacy → target when target is absent and we use the default', () => {
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    seed(legacy)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: legacy, targetDir: target, usingDefault: true })).toBe(true)
    expect(fs.existsSync(path.join(target, 'rpterminal.db'))).toBe(true)
    expect(fs.existsSync(path.join(legacy, 'rpterminal.db'))).toBe(true) // legacy kept as backup
  })
  it('does nothing when target already has the DB', () => {
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    seed(legacy)
    seed(target)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: legacy, targetDir: target, usingDefault: true })).toBe(false)
  })
  it('does nothing when not using the default (pointer/override active)', () => {
    const legacy = path.join(root, 'legacy')
    seed(legacy)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: legacy, targetDir: path.join(root, 't'), usingDefault: false })).toBe(false)
  })
  it('does nothing when legacy is absent', () => {
    expect(copyLegacyDataDirIfNeeded({ legacyDir: path.join(root, 'nope'), targetDir: path.join(root, 't'), usingDefault: true })).toBe(false)
  })
  it('does nothing when legacy === target', () => {
    const d = path.join(root, 'same')
    seed(d, false)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: d, targetDir: d, usingDefault: true })).toBe(false)
  })
})
