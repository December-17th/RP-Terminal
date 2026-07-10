import { describe, it, expect } from 'vitest'
import path from 'path'
import { resolveDataBase, DATA_DIR_NAME } from '../src/main/services/storageService'

// No exe-dir data by default; individual tests override existsNonEmpty when they need the sniff.
const def = {
  isDev: true,
  cwd: '/repo',
  exeDir: '/app',
  userDataDir: '/userData',
  existsNonEmpty: () => false
}

describe('resolveDataBase', () => {
  it('uses RPT_DATA_DIR override verbatim (no name appended)', () => {
    expect(resolveDataBase({ ...def, override: '/custom' })).toEqual({
      dir: '/custom',
      appendName: false
    })
  })
  it('uses the pointer verbatim when no override', () => {
    expect(resolveDataBase({ ...def, pointer: '/picked' })).toEqual({
      dir: '/picked',
      appendName: false
    })
  })
  it('override beats pointer', () => {
    expect(resolveDataBase({ ...def, override: '/o', pointer: '/p' }).dir).toBe('/o')
  })
  it('override wins even in packaged builds with existing exe-dir data', () => {
    const r = resolveDataBase({
      ...def,
      isDev: false,
      override: '/o',
      existsNonEmpty: () => true
    })
    expect(r).toEqual({ dir: '/o', appendName: false })
  })
  it('pointer wins even in packaged builds with existing exe-dir data', () => {
    const r = resolveDataBase({
      ...def,
      isDev: false,
      pointer: '/p',
      existsNonEmpty: () => true
    })
    expect(r).toEqual({ dir: '/p', appendName: false })
  })
  it('default in dev = cwd, append name', () => {
    expect(resolveDataBase({ ...def, isDev: true })).toEqual({
      dir: '/repo',
      appendName: true
    })
  })
  it('default in dev ignores existing exe-dir data (no sniff, no pointer persist)', () => {
    expect(resolveDataBase({ ...def, isDev: true, existsNonEmpty: () => true })).toEqual({
      dir: '/repo',
      appendName: true
    })
  })
  it('packaged default = userData + name when no exe-dir data exists', () => {
    expect(resolveDataBase({ ...def, isDev: false, existsNonEmpty: () => false })).toEqual({
      dir: '/userData',
      appendName: true
    })
  })
  it('packaged back-compat: non-empty exe-dir data is adopted verbatim + pointer persisted', () => {
    const seen: string[] = []
    const r = resolveDataBase({
      ...def,
      isDev: false,
      existsNonEmpty: (d) => {
        seen.push(d)
        return true
      }
    })
    const expectedExeData = path.join('/app', DATA_DIR_NAME)
    expect(r).toEqual({ dir: expectedExeData, appendName: false, persistPointer: true })
    // it sniffed exactly the <exeDir>/rp-terminal-data path
    expect(seen).toContain(expectedExeData)
  })
  it('exposes the data dir name', () => {
    expect(DATA_DIR_NAME).toBe('rp-terminal-data')
  })
})
