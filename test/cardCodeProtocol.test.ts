// test/cardCodeProtocol.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  serveCardCode,
  resolveCardCodePath,
  mimeForPath,
  originTokenFor,
  LEGACY_HOST,
  LEGACY_FALLBACK_DOC,
  DEFAULT_CARD_CODE_MIME,
  CODE_NOT_INSTALLED_MESSAGE,
  CODE_UNAVAILABLE_MESSAGE,
  type CardServeDeps,
  type CardOrigin
} from '../src/main/services/cardCodeProtocol'

const CSP = "default-src 'self'; test-csp"

const deps = (over: Partial<CardServeDeps> = {}): CardServeDeps => ({
  cardCsp: CSP,
  slotHtml: () => undefined,
  resolveOrigin: () => null,
  isTrusted: () => true,
  ...over
})

describe('serveCardCode — legacy host `card` (byte-for-byte characterization)', () => {
  // Pins the pre-A2 handler behavior: host `card` serves the renderer-built slot doc as
  // `text/html; charset=utf-8` + the card CSP, with the empty-slot fallback doc unchanged.
  it('serves a slot doc verbatim with text/html + the card CSP', () => {
    const r = serveCardCode('rpt-card://card/slot-1', deps({ slotHtml: (id) => (id === 'slot-1' ? '<html>DOC</html>' : undefined) }))
    expect(r).toEqual({
      kind: 'inline',
      html: '<html>DOC</html>',
      contentType: 'text/html; charset=utf-8',
      csp: CSP
    })
  })

  it('falls back to the exact pre-A2 empty-slot document', () => {
    const r = serveCardCode('rpt-card://card/missing', deps())
    expect(r.kind).toBe('inline')
    if (r.kind !== 'inline') return
    expect(r.html).toBe(LEGACY_FALLBACK_DOC)
    expect(r.html).toBe('<!doctype html><meta charset="utf-8"><title>card</title>')
    expect(r.contentType).toBe('text/html; charset=utf-8')
    expect(r.csp).toBe(CSP)
  })

  it('decodes a percent-encoded slot id from the pathname (pre-A2 decodeURIComponent parity)', () => {
    let seen = ''
    serveCardCode('rpt-card://card/my%20slot', deps({ slotHtml: (id) => ((seen = id), undefined) }))
    expect(seen).toBe('my slot')
  })

  it('is NOT trust-gated (renderer builds the slot doc post-consent)', () => {
    const r = serveCardCode('rpt-card://card/s', deps({ isTrusted: () => false, slotHtml: () => 'x' }))
    expect(r.kind).toBe('inline') // not 403
  })
})

describe('mimeForPath (WP0 spec §5)', () => {
  const cases: Array<[string, string]> = [
    ['a.html', 'text/html; charset=utf-8'],
    ['a.htm', 'text/html; charset=utf-8'],
    ['a.js', 'text/javascript'],
    ['a.mjs', 'text/javascript'],
    ['a.css', 'text/css'],
    ['a.json', 'application/json'],
    ['a.map', 'application/json'],
    ['a.svg', 'image/svg+xml'],
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.webp', 'image/webp'],
    ['a.gif', 'image/gif'],
    ['a.woff', 'font/woff'],
    ['a.woff2', 'font/woff2'],
    ['a.wasm', 'application/wasm']
  ]
  it.each(cases)('%s → %s', (name, type) => {
    expect(mimeForPath(name)).toBe(type)
  })

  it('an unknown extension defaults to octet-stream, NEVER text/html', () => {
    expect(mimeForPath('a.bin')).toBe(DEFAULT_CARD_CODE_MIME)
    expect(mimeForPath('a.xyz')).toBe('application/octet-stream')
    expect(mimeForPath('noext')).toBe('application/octet-stream')
  })

  it('is case-insensitive on the extension', () => {
    expect(mimeForPath('A.JS')).toBe('text/javascript')
    expect(mimeForPath('B.HTML')).toBe('text/html; charset=utf-8')
  })
})

describe('serveCardCode — per-card origin token (file serving)', () => {
  let tmp: string
  let codeDir: string
  const TOKEN = 'card-11111111-2222-3333-4444-555555555555'
  const origin = (): CardOrigin => ({ profileId: 'p1', characterId: 'c1', codeDir })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-cardproto-'))
    codeDir = path.join(tmp, 'code')
    fs.mkdirSync(path.join(codeDir, 'surfaces'), { recursive: true })
    fs.mkdirSync(path.join(codeDir, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(codeDir, 'surfaces', 'self.html'), '<html>self</html>')
    fs.writeFileSync(path.join(codeDir, 'engine', 'main.js'), 'export const x = 1')
    fs.writeFileSync(path.join(codeDir, 'engine', 'style.css'), 'body{}')
    fs.writeFileSync(path.join(codeDir, 'blob.bin'), Buffer.from([1, 2, 3]))
    // An escape target OUTSIDE the code root.
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET')
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const serve = (url: string, over: Partial<CardServeDeps> = {}) =>
    serveCardCode(url, deps({ resolveOrigin: (t) => (t === TOKEN ? origin() : null), ...over }))

  it('routes an HTML surface to a file result with the correct abs path, MIME + CSP', () => {
    const r = serve(`rpt-card://${TOKEN}/surfaces/self.html`)
    expect(r.kind).toBe('file')
    if (r.kind !== 'file') return
    expect(r.absPath).toBe(path.join(codeDir, 'surfaces', 'self.html'))
    expect(r.contentType).toBe('text/html; charset=utf-8')
    expect(r.csp).toBe(CSP) // HTML documents keep the card CSP
  })

  it('serves a JS module with text/javascript and NO CSP (sub-resource, not forced text/html)', () => {
    const r = serve(`rpt-card://${TOKEN}/engine/main.js`)
    expect(r.kind).toBe('file')
    if (r.kind !== 'file') return
    expect(r.contentType).toBe('text/javascript')
    expect(r.csp).toBeUndefined()
  })

  it('serves css / unknown binary with the right MIME and no CSP', () => {
    const css = serve(`rpt-card://${TOKEN}/engine/style.css`)
    expect(css.kind === 'file' && css.contentType).toBe('text/css')
    const bin = serve(`rpt-card://${TOKEN}/blob.bin`)
    expect(bin.kind === 'file' && bin.contentType).toBe('application/octet-stream')
  })

  it('404s an unknown origin token', () => {
    const r = serve(`rpt-card://unknown-token/surfaces/self.html`)
    expect(r).toEqual({ kind: 'error', status: 404, message: 'Not Found' })
  })

  it('404s a file that does not exist under the code root', () => {
    const r = serve(`rpt-card://${TOKEN}/surfaces/nope.html`)
    expect(r).toEqual({ kind: 'error', status: 404, message: 'Not Found' })
  })

  // Regression (WCV-panel import bug): when the code root itself is missing or empty — the cartridge
  // never installed (extraction failed / the PNG lost its appended archive) — the 404 body must
  // self-diagnose, because that body is exactly what the panel renders. A bare "Not Found" here cost a
  // full investigation to trace back to a failed cartridge install.
  it('404s with the diagnostic body when the code root was never installed (missing dir)', () => {
    fs.rmSync(codeDir, { recursive: true, force: true })
    const r = serve(`rpt-card://${TOKEN}/surfaces/self.html`)
    expect(r).toEqual({ kind: 'error', status: 404, message: CODE_NOT_INSTALLED_MESSAGE })
  })

  it('404s with the diagnostic body when the code root exists but is empty', () => {
    fs.rmSync(codeDir, { recursive: true, force: true })
    fs.mkdirSync(codeDir, { recursive: true })
    const r = serve(`rpt-card://${TOKEN}/surfaces/self.html`)
    expect(r).toEqual({ kind: 'error', status: 404, message: CODE_NOT_INSTALLED_MESSAGE })
  })

  it('404s with an unavailable diagnostic when the code root cannot be inspected', () => {
    const read = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })
    try {
      const r = serve(`rpt-card://${TOKEN}/surfaces/nope.html`)
      expect(r).toEqual({ kind: 'error', status: 404, message: CODE_UNAVAILABLE_MESSAGE })
    } finally {
      read.mockRestore()
    }
  })

  it('still 403s an untrusted card when the code root is missing (trust gate first, fail-closed)', () => {
    fs.rmSync(codeDir, { recursive: true, force: true })
    const read = vi.spyOn(fs, 'readdirSync')
    try {
      const r = serve(`rpt-card://${TOKEN}/surfaces/self.html`, { isTrusted: () => false })
      expect(r).toEqual({ kind: 'error', status: 403, message: 'Forbidden' })
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
  })

  it('400s a malformed URL', () => {
    const r = serve('::::not a url')
    expect(r).toEqual({ kind: 'error', status: 400, message: 'Bad Request' })
  })

  describe('trust gate (main-side boundary)', () => {
    it('403s an untrusted card even when the file exists', () => {
      const r = serve(`rpt-card://${TOKEN}/surfaces/self.html`, { isTrusted: () => false })
      expect(r).toEqual({ kind: 'error', status: 403, message: 'Forbidden' })
    })
    it('checks trust BEFORE resolving the path (403 for a non-existent path too — fail-closed)', () => {
      const r = serve(`rpt-card://${TOKEN}/does/not/exist`, { isTrusted: () => false })
      expect(r).toEqual({ kind: 'error', status: 403, message: 'Forbidden' })
    })
  })

  describe('traversal rejection on the served path', () => {
    it('rejects an encoded `..` escape and never serves the outside file (404, not the secret)', () => {
      const r = serve(`rpt-card://${TOKEN}/%2e%2e%2fsecret.txt`)
      expect(r).toEqual({ kind: 'error', status: 404, message: 'Not Found' })
    })
    it('rejects a deeper encoded escape', () => {
      const r = serve(`rpt-card://${TOKEN}/engine/%2e%2e%2f%2e%2e%2fsecret.txt`)
      expect(r).toEqual({ kind: 'error', status: 404, message: 'Not Found' })
    })
  })
})

describe('resolveCardCodePath (traversal guard, unit)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-resolvepath-'))
    fs.mkdirSync(path.join(tmp, 'code', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'code', 'ok.js'), 'x')
    fs.writeFileSync(path.join(tmp, 'code', 'sub', 'deep.js'), 'y')
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'z')
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('resolves a valid file under the root', () => {
    const root = path.join(tmp, 'code')
    expect(resolveCardCodePath(root, '/ok.js')).toBe(path.join(root, 'ok.js'))
    expect(resolveCardCodePath(root, '/sub/deep.js')).toBe(path.join(root, 'sub', 'deep.js'))
  })
  it('rejects an escape to a real file outside the root', () => {
    expect(resolveCardCodePath(path.join(tmp, 'code'), '/../outside.txt')).toBeNull()
  })
  it('rejects a directory (require isFile)', () => {
    expect(resolveCardCodePath(path.join(tmp, 'code'), '/sub')).toBeNull()
  })
  it('rejects an empty / root pathname', () => {
    expect(resolveCardCodePath(path.join(tmp, 'code'), '/')).toBeNull()
  })
})

describe('originTokenFor (D3 — stable DNS-safe token)', () => {
  const sha1 = (s: string) => 'HASH(' + s + ')'

  it('passes a DNS-safe uuid characterId through verbatim (lowercased)', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(originTokenFor(id, sha1)).toBe(id)
    expect(originTokenFor(id.toUpperCase(), sha1)).toBe(id)
  })
  it('hashes a non-DNS-safe id (underscore / dots / unicode)', () => {
    expect(originTokenFor('has_underscore', sha1)).toBe('c-HASH(has_underscore)')
    expect(originTokenFor('a.b.c', sha1)).toBe('c-HASH(a.b.c)')
    expect(originTokenFor('世界', sha1)).toBe('c-HASH(世界)')
  })
  it('never collides with the reserved legacy host `card`', () => {
    const t = originTokenFor(LEGACY_HOST, sha1)
    expect(t).not.toBe(LEGACY_HOST)
    expect(t).toBe('c-HASH(card)')
  })
  it('is stable for the same id', () => {
    expect(originTokenFor('x_y', sha1)).toBe(originTokenFor('x_y', sha1))
  })
})
