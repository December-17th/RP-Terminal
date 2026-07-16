import { describe, it, expect } from 'vitest'
import { resolveDataBase, DATA_DIR_NAME } from '../src/main/services/storageService'

const def = {
  isDev: true,
  usePortableDataDir: false,
  cwd: '/repo',
  exeDir: '/app',
  userDataDir: '/users/me/Library/Application Support/RP Terminal'
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
  it('override wins in packaged builds', () => {
    const r = resolveDataBase({ ...def, isDev: false, override: '/o' })
    expect(r).toEqual({ dir: '/o', appendName: false })
  })
  it('pointer wins in packaged builds', () => {
    const r = resolveDataBase({ ...def, isDev: false, pointer: '/p' })
    expect(r).toEqual({ dir: '/p', appendName: false })
  })
  it('default in dev = cwd, append name', () => {
    expect(resolveDataBase({ ...def, isDev: true })).toEqual({
      dir: '/repo',
      appendName: true
    })
  })
  it('packaged Windows portable default = executable directory, append name', () => {
    expect(resolveDataBase({ ...def, isDev: false, usePortableDataDir: true })).toEqual({
      dir: '/app',
      appendName: true
    })
  })
  it('other packaged platforms use Electron userData verbatim', () => {
    expect(resolveDataBase({ ...def, isDev: false })).toEqual({
      dir: '/users/me/Library/Application Support/RP Terminal',
      appendName: false
    })
  })
  it('exposes the data dir name', () => {
    expect(DATA_DIR_NAME).toBe('rp-terminal-data')
  })
})
