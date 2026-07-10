// test/cardCodeService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'

let tmp: string
// Point the service's app dir at a temp dir by mocking storageService.getAppDir (as worldAssetService tests do).
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import * as svc from '../src/main/services/cardCodeService'

const MANIFEST = { cartridge: 1, code: { root: 'code/', entries: ['surfaces/self.html'] } }

/** Build a cartridge ZIP buffer from a name→content map (manifest included unless overridden). */
const buildZip = (files: Record<string, Buffer | string>, manifest: unknown = MANIFEST): Buffer => {
  const zip = new AdmZip()
  if (manifest !== null) {
    // pass `null` to omit the manifest entirely
    zip.addFile('rpt-cartridge.json', Buffer.from(JSON.stringify(manifest), 'utf-8'))
  }
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content)
  }
  return zip.toBuffer()
}

/**
 * Build a ZIP with a RAW (unsanitized) poisoned entry name. AdmZip's `addFile` normalizes paths on
 * write, so we override `entryName` after adding — this reproduces what a hand-crafted malicious
 * cartridge's central directory holds (adm-zip preserves such names on READ, which is why the import
 * guard exists). Includes a valid manifest so the traversal check, not the manifest check, is exercised.
 */
const buildPoisonedZip = (rawName: string): Buffer => {
  const zip = new AdmZip()
  zip.addFile('rpt-cartridge.json', Buffer.from(JSON.stringify(MANIFEST), 'utf-8'))
  const good = zip.addFile('code/surfaces/self.html', Buffer.from('ok', 'utf-8'))
  void good
  const evil = zip.addFile('placeholder', Buffer.from('pwn', 'utf-8'))
  evil.entryName = rawName
  return zip.toBuffer()
}

const codeDir = (): string => path.join(tmp, 'profiles', 'p1', 'card-code', 'c1')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-cardcode-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('installCartridgeCode', () => {
  it('extracts the code/ subtree (prefix stripped) to the per-character dir', () => {
    const zip = buildZip({
      'code/surfaces/self.html': '<html>self</html>',
      'code/engine/main.js': 'export const x = 1',
      'assets/bg.png': Buffer.from([1, 2, 3]) // outside code/ — not extracted
    })
    const res = svc.installCartridgeCode('p1', 'c1', zip)
    expect(res.error).toBeUndefined()
    expect(res.installed).toBe(2)
    expect(fs.readFileSync(path.join(codeDir(), 'surfaces', 'self.html'), 'utf-8')).toBe(
      '<html>self</html>'
    )
    expect(fs.readFileSync(path.join(codeDir(), 'engine', 'main.js'), 'utf-8')).toBe(
      'export const x = 1'
    )
    // assets/ is not part of the code subtree.
    expect(fs.existsSync(path.join(codeDir(), 'assets'))).toBe(false)
    expect(fs.existsSync(path.join(codeDir(), 'bg.png'))).toBe(false)
  })

  it('rejects a missing manifest and writes nothing', () => {
    const zip = buildZip({ 'code/surfaces/self.html': 'x' }, null)
    const res = svc.installCartridgeCode('p1', 'c1', zip)
    expect(res.installed).toBe(0)
    expect(res.error).toMatch(/manifest/i)
    expect(fs.existsSync(codeDir())).toBe(false)
  })

  it('rejects an unsupported manifest version', () => {
    const zip = buildZip({ 'code/surfaces/self.html': 'x' }, { cartridge: 2 })
    const res = svc.installCartridgeCode('p1', 'c1', zip)
    expect(res.installed).toBe(0)
    expect(res.error).toMatch(/manifest version/i)
  })

  it('rejects a traversal-named entry (contains "..") and writes nothing', () => {
    const res = svc.installCartridgeCode('p1', 'c1', buildPoisonedZip('code/../evil.html'))
    expect(res.installed).toBe(0)
    expect(res.error).toMatch(/unsafe entry name/i)
    expect(fs.existsSync(codeDir())).toBe(false)
    // The escape target must not exist anywhere.
    expect(fs.existsSync(path.join(tmp, 'profiles', 'p1', 'card-code', 'evil.html'))).toBe(false)
  })

  it('rejects an absolute / drive-lettered entry name', () => {
    const abs = svc.installCartridgeCode('p1', 'c1', buildPoisonedZip('/etc/passwd'))
    expect(abs.error).toMatch(/unsafe entry name/i)
    const drive = svc.installCartridgeCode('p1', 'c1', buildPoisonedZip('C:/windows/evil'))
    expect(drive.error).toMatch(/unsafe entry name/i)
  })

  it('rejects an appended ZIP larger than the 8 MB cap', () => {
    // Random (incompressible) bytes so the ZIP buffer itself exceeds 8 MB.
    const big = require('crypto').randomBytes(9 * 1024 * 1024)
    const zip = buildZip({ 'code/big.bin': big })
    const res = svc.installCartridgeCode('p1', 'c1', zip)
    expect(res.installed).toBe(0)
    expect(res.error).toMatch(/exceeds/i)
    expect(fs.existsSync(codeDir())).toBe(false)
  })

  it('rejects a single entry larger than the 8 MB cap', () => {
    // Highly compressible: the ZIP stays small, but the declared uncompressed size trips the entry cap.
    const big = Buffer.alloc(9 * 1024 * 1024, 0)
    const zip = buildZip({ 'code/big.bin': big })
    expect(zip.length).toBeLessThan(8 * 1024 * 1024) // compresses well; not caught by the ZIP-size cap
    const res = svc.installCartridgeCode('p1', 'c1', zip)
    expect(res.installed).toBe(0)
    expect(res.error).toMatch(/entry exceeds/i)
  })

  it('returns an error (not a throw) for a truncated / unreadable ZIP', () => {
    const zip = buildZip({ 'code/surfaces/self.html': 'x' })
    const truncated = zip.subarray(0, Math.floor(zip.length / 2))
    const res = svc.installCartridgeCode('p1', 'c1', truncated)
    expect(res.installed).toBe(0)
    expect(res.error).toMatch(/invalid or unreadable/i)
  })

  it('re-import replaces the previous tree (idempotent)', () => {
    svc.installCartridgeCode('p1', 'c1', buildZip({ 'code/old.html': 'old', 'code/keep.html': '1' }))
    expect(fs.existsSync(path.join(codeDir(), 'old.html'))).toBe(true)
    // Second import without old.html — the stale file must be gone.
    const res = svc.installCartridgeCode('p1', 'c1', buildZip({ 'code/new.html': 'new' }))
    expect(res.installed).toBe(1)
    expect(fs.existsSync(path.join(codeDir(), 'new.html'))).toBe(true)
    expect(fs.existsSync(path.join(codeDir(), 'old.html'))).toBe(false)
  })

  it('honors a non-default manifest code.root prefix', () => {
    const zip = buildZip(
      { 'src/self.html': 'from-src' },
      { cartridge: 1, code: { root: 'src/' } }
    )
    const res = svc.installCartridgeCode('p1', 'c1', zip)
    expect(res.installed).toBe(1)
    expect(fs.readFileSync(path.join(codeDir(), 'self.html'), 'utf-8')).toBe('from-src')
  })
})

describe('deleteCardCode', () => {
  it('removes the character card-code dir', () => {
    svc.installCartridgeCode('p1', 'c1', buildZip({ 'code/self.html': 'x' }))
    expect(fs.existsSync(codeDir())).toBe(true)
    svc.deleteCardCode('p1', 'c1')
    expect(fs.existsSync(codeDir())).toBe(false)
  })

  it('is a no-op when the dir does not exist', () => {
    expect(() => svc.deleteCardCode('p1', 'nope')).not.toThrow()
  })
})
