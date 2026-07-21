// test/cardCartridgeImport.test.ts
//
// Regression seam for the "WCV panels 404 after import (inline scripts still run)" bug class: a card
// whose `panel_ui` declares `card-code:` entries imports "successfully" while its PNG cartridge fails
// to install (appended ZIP stripped/truncated in transfer, rejected archive, or a .json import), and
// every panel later renders a bare 404. This drives the REAL import path (`importCharacterFromFile` /
// `updateCharacterInPlace`) on synthesized full-card PNGs and asserts:
//  - the healthy full-PNG path installs the cartridge and serves the declared surface (end-to-end),
//  - every cartridge-loss variant is SURFACED via `summary.cartridgeError` (was silent), and
//  - the serve-side 404 body self-diagnoses ("Card code not installed…") instead of "Not Found".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

let tmp: string
vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb } from '../src/main/services/db'
import {
  cardDeclaresCardCode,
  importCharacterFromFile,
  updateCharacterInPlace
} from '../src/main/services/characterService'
import { RPTerminalCardSchema } from '../src/main/types/character'
import { cardCodeRoot } from '../src/main/services/cardCodeService'
import {
  serveCardCode,
  originTokenFor,
  CODE_NOT_INSTALLED_MESSAGE,
  type CardOrigin,
  type CardServeDeps
} from '../src/main/services/cardCodeProtocol'

const P = 'p1'
const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex')

describe('card-code declaration detection', () => {
  it('treats a Yuzu takeover entry as cartridge-backed card code', () => {
    const card = RPTerminalCardSchema.parse({
      data: {
        name: 'Yuzu World',
        extensions: {
          rp_terminal: {
            yuzu: { version: 1, surface: { entry: 'card-code:yuzu/index.html' } }
          }
        }
      }
    })
    expect(cardDeclaresCardCode(card)).toBe(true)
  })
})

// --- Fixtures: a card declaring a card-code panel, packaged as .json / plain PNG / full PNG ---

const panelCard = (withCardCode = true): Record<string, unknown> => ({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Panel World',
    creator: 'Ada',
    character_version: '1.0',
    extensions: {
      rp_terminal: {
        panel_ui: withCardCode
          ? {
              mode: 'static',
              grid: { cols: 12, rows: 12 },
              slots: [
                {
                  id: 'self',
                  view: 'wcv',
                  rect: [0, 0, 12, 12],
                  entry: 'card-code:surfaces/self.html'
                }
              ]
            }
          : undefined,
        scripts: [{ name: 's', code: 'console.log(1)' }]
      }
    }
  }
})

// Minimal PNG builder (same idiom as stPngParser.test.ts): SIG + chunks; the parser ignores CRCs.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}
const charaChunk = (card: unknown): Buffer =>
  chunk(
    'tEXt',
    Buffer.concat([
      Buffer.from('chara', 'latin1'),
      Buffer.from([0]),
      Buffer.from(Buffer.from(JSON.stringify(card), 'utf-8').toString('base64'), 'latin1')
    ])
  )
const IHDR = chunk('IHDR', Buffer.alloc(13))
const IEND = chunk('IEND', Buffer.alloc(0))

/** A valid cartridge ZIP whose code/ subtree carries the declared surface. */
const cartridgeZip = (): Buffer => {
  const zip = new AdmZip()
  zip.addFile(
    'rpt-cartridge.json',
    Buffer.from(JSON.stringify({ cartridge: 1, code: { root: 'code/' } }), 'utf-8')
  )
  zip.addFile('code/surfaces/self.html', Buffer.from('<!doctype html><body>self</body>', 'utf-8'))
  zip.addFile('code/engine/main.js', Buffer.from('export const x = 1', 'utf-8'))
  return zip.toBuffer()
}

/** A syntactically valid cartridge whose declared code root selects no regular files. */
const emptyCartridgeZip = (): Buffer => {
  const zip = new AdmZip()
  zip.addFile(
    'rpt-cartridge.json',
    Buffer.from(JSON.stringify({ cartridge: 1, code: { root: 'code/' } }), 'utf-8')
  )
  zip.addFile('assets/unselected.txt', Buffer.from('outside code root', 'utf-8'))
  return zip.toBuffer()
}

const writeFile = (name: string, bytes: Buffer | string): string => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}
const writeFullPng = (card: unknown, appended?: Buffer): string =>
  writeFile(
    `card-${Math.random().toString(36).slice(2)}.png`,
    Buffer.concat([PNG_SIG, IHDR, charaChunk(card), IEND, ...(appended ? [appended] : [])])
  )

/** Serve the declared panel entry through the real gate, trusted (decided ∧ trusted at import). */
const servePanel = (characterId: string): ReturnType<typeof serveCardCode> => {
  const token = originTokenFor(characterId, sha1)
  const origin: CardOrigin = { profileId: P, characterId, codeDir: cardCodeRoot(P, characterId) }
  const deps: CardServeDeps = {
    cardCsp: "default-src 'self'",
    slotHtml: () => undefined,
    resolveOrigin: (t) => (t === token ? origin : null),
    isTrusted: () => true
  }
  return serveCardCode(`rpt-card://${token}/surfaces/self.html`, deps)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-cartimport-'))
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(P, 'P', 't', 't')
})
afterEach(() => {
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('full-PNG cartridge import → panel serving (end-to-end seam)', () => {
  it('treats a Yuzu takeover entry as cartridge-backed card code', () => {
    const card = RPTerminalCardSchema.parse({
      data: {
        name: 'Yuzu World',
        extensions: {
          rp_terminal: {
            yuzu: { version: 1, surface: { entry: 'card-code:yuzu/index.html' } }
          }
        }
      }
    })
    expect(cardDeclaresCardCode(card)).toBe(true)
  })

  it('a full PNG (appended cartridge) installs the code and the declared surface serves', () => {
    const res = importCharacterFromFile(P, writeFullPng(panelCard(), cartridgeZip()))
    expect(res).not.toBeNull()
    expect(res!.summary.cartridgeError).toBeUndefined()
    expect(fs.existsSync(path.join(cardCodeRoot(P, res!.id), 'surfaces', 'self.html'))).toBe(true)
    expect(servePanel(res!.id).kind).toBe('file')
  })

  it('update-in-place from a full PNG re-installs the cartridge against the same id', () => {
    const first = importCharacterFromFile(P, writeFullPng(panelCard(), cartridgeZip()))!
    const upd = updateCharacterInPlace(P, first.id, writeFullPng(panelCard(), cartridgeZip()))
    expect(upd).not.toBeNull()
    expect(upd!.summary.cartridgeError).toBeUndefined()
    expect(servePanel(first.id).kind).toBe('file')
  })
})

describe('cartridge loss is surfaced, not silent (the reported-bug class)', () => {
  it('EMPTY selected subtree: fresh import warns and leaves no installed tree', () => {
    const res = importCharacterFromFile(P, writeFullPng(panelCard(), emptyCartridgeZip()))
    expect(res).not.toBeNull()
    expect(res!.summary.cartridgeError).toMatch(/no files/i)
    expect(fs.existsSync(cardCodeRoot(P, res!.id))).toBe(false)
  })

  it('TRUNCATED appended ZIP (partial download): import succeeds, cartridgeError set, panel 404s with the diagnostic body', () => {
    const zip = cartridgeZip()
    const truncated = zip.subarray(0, Math.floor(zip.length / 2)) // still starts with PK
    const res = importCharacterFromFile(P, writeFullPng(panelCard(), truncated))
    expect(res).not.toBeNull() // the card import itself still succeeds (scripts run inline)
    expect(res!.summary.cartridgeError).toMatch(/invalid or unreadable/i)
    expect(servePanel(res!.id)).toEqual({
      kind: 'error',
      status: 404,
      message: CODE_NOT_INSTALLED_MESSAGE
    })
  })

  it('STRIPPED trailing ZIP (re-saved/transfer-mangled PNG): import succeeds, cartridgeError set, panel 404s with the diagnostic body', () => {
    const res = importCharacterFromFile(P, writeFullPng(panelCard())) // no appended bytes at all
    expect(res).not.toBeNull()
    expect(res!.summary.cartridgeError).toMatch(/no appended code archive/i)
    expect(servePanel(res!.id)).toEqual({
      kind: 'error',
      status: 404,
      message: CODE_NOT_INSTALLED_MESSAGE
    })
  })

  it('.json import of a card that declares card-code panels: cartridgeError points at the full PNG', () => {
    const res = importCharacterFromFile(P, writeFile('card.json', JSON.stringify(panelCard())))
    expect(res).not.toBeNull()
    expect(res!.summary.cartridgeError).toMatch(/full PNG/i)
  })

  it('update-in-place from .json preserves the installed cartridge and reports the rejected update', () => {
    const first = importCharacterFromFile(P, writeFullPng(panelCard(), cartridgeZip()))!
    expect(servePanel(first.id).kind).toBe('file') // panel works before the update
    const upd = updateCharacterInPlace(
      P,
      first.id,
      writeFile('upd.json', JSON.stringify(panelCard()))
    )
    expect(upd).not.toBeNull()
    expect(upd!.summary.cartridgeError).toMatch(/full PNG/i)
    expect(servePanel(first.id).kind).toBe('file')
  })

  it('EMPTY selected subtree: update reports rejection without wiping working code', () => {
    const first = importCharacterFromFile(P, writeFullPng(panelCard(), cartridgeZip()))!
    expect(servePanel(first.id).kind).toBe('file')

    const upd = updateCharacterInPlace(P, first.id, writeFullPng(panelCard(), emptyCartridgeZip()))

    expect(upd).not.toBeNull()
    expect(upd!.summary.cartridgeError).toMatch(/no files/i)
    expect(servePanel(first.id).kind).toBe('file')
  })

  it('no false warning: a card WITHOUT card-code panels imports from a plain PNG with no cartridgeError', () => {
    const res = importCharacterFromFile(P, writeFullPng(panelCard(false)))
    expect(res).not.toBeNull()
    expect(res!.summary.cartridgeError).toBeUndefined()
  })
})
