import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseStPng } from '../src/main/parsers/stPngParser'

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
})
