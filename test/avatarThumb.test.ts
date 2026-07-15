// test/avatarThumb.test.ts
// Covers the avatar serve-path resolution + traversal guard (perf P1-6). NOTE: the thumbnail
// GENERATION side (ensureAvatarThumb) uses Electron's `nativeImage`, which the vitest electron mock
// (test/mocks/electron.ts) does not stub — so we exercise the pure fs/path seam
// `resolveAvatarServePath`, which shares its root-escape guard with the generator.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})
import * as svc from '../src/main/services/characterService'
import { parseAvatarUrl } from '../src/main/services/avatarProtocol'

const avatarsDir = (): string => path.join(tmp, 'avatars')
const writeAvatar = (file: string): void => {
  const dir = avatarsDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), 'png-bytes')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-avatar-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveAvatarServePath', () => {
  it('prefers the thumbnail when both thumb and original exist', () => {
    writeAvatar('abc-123.png')
    writeAvatar('abc-123.thumb.png')
    expect(svc.resolveAvatarServePath('abc-123')).toBe(
      path.resolve(avatarsDir(), 'abc-123.thumb.png')
    )
  })

  it('falls back to the original when no thumbnail exists yet', () => {
    writeAvatar('abc-123.png')
    expect(svc.resolveAvatarServePath('abc-123')).toBe(path.resolve(avatarsDir(), 'abc-123.png'))
  })

  it('returns null when neither thumb nor original exists', () => {
    expect(svc.resolveAvatarServePath('nope')).toBeNull()
  })

  it('rejects a path-traversing character id (escapes the avatars root)', () => {
    // Even if an attacker plants a file, a traversing id must not resolve outside the avatars dir.
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'secret.png'), 'x')
    expect(svc.resolveAvatarServePath('../secret')).toBeNull()
    expect(svc.resolveAvatarServePath('..%2Fsecret')).toBeNull()
  })
})

describe('parseAvatarUrl', () => {
  it('reads the character id from the url hostname', () => {
    expect(parseAvatarUrl('rptavatar://abc-123')).toEqual({ characterId: 'abc-123' })
  })
  it('returns null for a malformed url', () => {
    expect(parseAvatarUrl('not a url')).toBeNull()
  })
})

describe('getAvatarThumbPath', () => {
  it('is a `.thumb.png` sibling of the original avatar path', () => {
    expect(svc.getAvatarThumbPath('id42')).toBe(path.join(avatarsDir(), 'id42.thumb.png'))
    expect(svc.getAvatarPath('id42')).toBe(path.join(avatarsDir(), 'id42.png'))
  })
})
