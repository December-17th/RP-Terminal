// test/assetUrlForWorld.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})
import * as svc from '../src/main/services/worldAssetService'

const charDir = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'character')
const write = (lb: string, file: string): void => {
  fs.mkdirSync(charDir(lb), { recursive: true })
  fs.writeFileSync(path.join(charDir(lb), file), 'img')
}

beforeEach(() => {
  svc.clearAssetCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-aufw-'))
})
afterEach(() => {
  svc.clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('assetUrlForWorld', () => {
  it('builds an rptasset:// URL for a resolved portrait (encoded file)', () => {
    write('w1', '爱莎_头像.jpg')
    expect(svc.assetUrlForWorld('p1', ['w1'], '爱莎', '头像')).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像.jpg')}`
    )
  })
  it('prefers a mood variant', () => {
    write('w1', '爱莎_头像.jpg')
    write('w1', '爱莎_头像_愤怒.png')
    expect(svc.assetUrlForWorld('p1', ['w1'], '爱莎', '头像', '愤怒')).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像_愤怒.png')}`
    )
  })
  it('returns null when no asset resolves', () => {
    expect(svc.assetUrlForWorld('p1', ['w1'], '无名', '头像')).toBeNull()
  })
})
