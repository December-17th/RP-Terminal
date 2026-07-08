// test/assetWizard.test.ts — pure import-wizard helpers (no store/IPC/window access).
import { describe, it, expect } from 'vitest'
import {
  validateWizardRow,
  filenamePreview,
  classifyDropped,
  extOf,
  baseName
} from '../src/renderer/src/stores/assetStore'

describe('extOf / baseName', () => {
  it('lowercases the extension', () => {
    expect(extOf('C:/x/Pic.PNG')).toBe('png')
    expect(extOf('noext')).toBe('')
  })
  it('takes the basename across both separators', () => {
    expect(baseName('C:\\a\\b\\薇拉_头像.png')).toBe('薇拉_头像.png')
    expect(baseName('/a/b/c.png')).toBe('c.png')
  })
})

describe('validateWizardRow', () => {
  it('flags an empty name', () => {
    expect(validateWizardRow({ name: '  ', ext: 'png' })).toEqual({ valid: false, error: 'name' })
  })
  it('flags an unsupported extension', () => {
    expect(validateWizardRow({ name: '薇拉', ext: 'txt' })).toEqual({ valid: false, error: 'ext' })
  })
  it('accepts a valid row', () => {
    expect(validateWizardRow({ name: '薇拉', ext: 'PNG' })).toEqual({ valid: true })
  })
})

describe('filenamePreview', () => {
  it('builds <name>_<type>.<ext> with no variant', () => {
    expect(filenamePreview({ name: '薇拉', type: '头像', variant: '', ext: 'png' })).toBe(
      '薇拉_头像.png'
    )
  })
  it('includes the variant token when present', () => {
    expect(filenamePreview({ name: '薇拉', type: '相册', variant: ' 01 ', ext: 'jpg' })).toBe(
      '薇拉_相册_01.jpg'
    )
  })
  it('is empty for an invalid row', () => {
    expect(filenamePreview({ name: '', type: '头像', variant: '', ext: 'png' })).toBe('')
  })
})

describe('classifyDropped', () => {
  it('parses a convention basename to name/type/variant', () => {
    expect(classifyDropped('/x/薇拉_头像_微笑.png')).toEqual({
      name: '薇拉',
      type: '头像',
      variant: '微笑',
      ext: 'png'
    })
  })
  it('returns null for a non-convention basename', () => {
    expect(classifyDropped('/x/random-photo.png')).toBeNull()
  })
})
