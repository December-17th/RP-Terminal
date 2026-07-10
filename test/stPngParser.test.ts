import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { parseStPng, extractAppendedZip } from '../src/main/parsers/stPngParser'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Build a minimal PNG chunk (length + type + data + dummy CRC; parser ignores CRC). */
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

const textChunk = (keyword: string, text: string): Buffer =>
  chunk(
    'tEXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])
  )

/** A compressed (deflate) iTXt chunk carrying a base64 payload — the S5 real-world case. */
const compressedItxtChunk = (keyword: string, text: string): Buffer => {
  const compressed = zlib.deflateSync(Buffer.from(text, 'latin1'))
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]), // keyword null terminator
    Buffer.from([1, 0]), // compressionFlag=1 (compressed), compressionMethod=0
    Buffer.from([0]), // empty language tag + null
    Buffer.from([0]), // empty translated keyword + null
    compressed
  ])
  return chunk('iTXt', data)
}

const IHDR = chunk('IHDR', Buffer.alloc(13)) // realistic header (parser ignores contents)
const IEND = chunk('IEND', Buffer.alloc(0))

const tmpFiles: string[] = []
const writePng = (...chunks: Buffer[]): string => {
  const p = path.join(
    os.tmpdir(),
    `rpt-png-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  )
  fs.writeFileSync(p, Buffer.concat([PNG_SIG, ...chunks]))
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  while (tmpFiles.length) fs.rmSync(tmpFiles.pop()!, { force: true })
})

describe('parseStPng', () => {
  it('extracts base64-encoded JSON from a "chara" tEXt chunk', () => {
    const card = { spec: 'chara_card_v2', data: { name: 'Aria' } }
    const b64 = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64')
    const file = writePng(textChunk('chara', b64))
    expect(parseStPng(file)).toEqual(card)
  })

  it('falls back to raw JSON when the text is not base64', () => {
    // Raw JSON: base64-decoding garbles it, so the parser retries JSON.parse on the raw text.
    const file = writePng(textChunk('chara', '{"data":{"name":"Raw"}}'))
    expect(parseStPng(file)).toEqual({ data: { name: 'Raw' } })
  })

  it('returns null when there is no chara/ccv3 chunk', () => {
    const file = writePng(textChunk('Comment', 'nothing here'))
    expect(parseStPng(file)).toBeNull()
  })

  it('returns null for a missing/unreadable file', () => {
    expect(parseStPng(path.join(os.tmpdir(), 'does-not-exist.png'))).toBeNull()
  })

  // Characterization (A1): a well-formed ST PNG (IHDR + chara + IEND) parses to exactly the embedded
  // card, and appending a cartridge ZIP after IEND must NOT change that result — the fixed chunk loop
  // stops at IEND instead of misreading the ZIP bytes as bogus chunks.
  it('parses a realistic ST PNG identically with and without an appended ZIP', () => {
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '爱莎', description: 'x' } }
    const b64 = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64')
    const chara = textChunk('chara', b64)

    const plain = writePng(IHDR, chara, IEND)
    expect(parseStPng(plain)).toEqual(card)

    // Same PNG with arbitrary ZIP-looking bytes appended after IEND.
    const fakeZip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64, 0xff)])
    const withZip = writePng(IHDR, chara, IEND, fakeZip)
    expect(parseStPng(withZip)).toEqual(card)
  })

  it('reads compressed iTXt (deflate) chunks', () => {
    const card = { spec: 'chara_card_v3', data: { name: 'Compressed' } }
    const b64 = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64')
    const file = writePng(IHDR, compressedItxtChunk('chara', b64), IEND)
    expect(parseStPng(file)).toEqual(card)
  })
})

describe('extractAppendedZip', () => {
  it('returns the trailing bytes when a ZIP is appended after IEND', () => {
    const zipBytes = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(32, 0xab)])
    const file = writePng(IHDR, textChunk('chara', 'e30='), IEND, zipBytes)
    const got = extractAppendedZip(file)
    expect(got).not.toBeNull()
    expect(got!.equals(zipBytes)).toBe(true)
  })

  it('returns null for a plain PNG with no appended ZIP', () => {
    const file = writePng(IHDR, textChunk('chara', 'e30='), IEND)
    expect(extractAppendedZip(file)).toBeNull()
  })

  it('returns null when trailing bytes are not a ZIP signature', () => {
    const file = writePng(IHDR, textChunk('chara', 'e30='), IEND, Buffer.from('not a zip'))
    expect(extractAppendedZip(file)).toBeNull()
  })
})
