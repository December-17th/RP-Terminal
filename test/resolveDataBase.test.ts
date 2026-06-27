import { describe, it, expect } from 'vitest'
import { resolveDataBase, DATA_DIR_NAME } from '../src/main/services/storageService'

const def = { isDev: true, cwd: '/repo', exeDir: '/app' }

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
  it('default in dev = cwd, append name', () => {
    expect(resolveDataBase({ isDev: true, cwd: '/repo', exeDir: '/app' })).toEqual({
      dir: '/repo',
      appendName: true
    })
  })
  it('default packaged = exeDir, append name', () => {
    expect(resolveDataBase({ isDev: false, cwd: '/repo', exeDir: '/app' })).toEqual({
      dir: '/app',
      appendName: true
    })
  })
  it('exposes the data dir name', () => {
    expect(DATA_DIR_NAME).toBe('rp-terminal-data')
  })
})
