#!/usr/bin/env node
/*
 * patch-poem-party-panel.cjs — install the 命定之诗 party-avatar panel into the card PNG.
 *
 * Reads the source card (arg 1, default v4.2.1+combat.png), writes a new PNG (arg 2, default
 * …+party.png) with BOTH `chara` and `ccv3` tEXt chunks patched. Idempotent.
 *
 * It applies:
 *   1. poem-party-panel.regex.json → data.extensions.regex_scripts  (with renderMode:'panel')
 *      so the app's one-click import auto-promotes it to a docked WCV panel.
 *   2. data.extensions.rp_terminal.left_panel = { name: '命定之诗-队伍面板' }
 *      so the app auto-docks the panel on the workspace's left side (PA4 resolution).
 *
 * Run:  node docs/sdk/examples/patch-poem-party-panel.cjs [src.png] [out.png]
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../../..')
const DIR = path.join(ROOT, 'example sillytarvern character card, presets, extensions and scripts', '命定之诗')
const SRC = process.argv[2] || path.join(DIR, 'v4.2.1+combat.png')
const OUT = process.argv[3] || path.join(DIR, 'v4.2.1+combat+party.png')

// Load the party-panel regex object and inject renderMode:'panel' so the importer
// auto-promotes it to a docked WCV panel (saveRegexScript reads rules[0].renderMode).
const regexObj = JSON.parse(fs.readFileSync(path.join(__dirname, 'poem-party-panel.regex.json'), 'utf8'))
const PANEL_REGEX = Object.assign({}, regexObj, { renderMode: 'panel' })
const PANEL_NAME = PANEL_REGEX.scriptName // '命定之诗-队伍面板'

// ── PNG chunk utilities (identical to patch-poem-card.cjs) ──────────────────

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const makeChunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, 'ascii')
  const cb = Buffer.alloc(4)
  cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([len, tb, data, cb])
}

// ── Card patching ────────────────────────────────────────────────────────────

const editCard = (card, log) => {
  const d = card.data || (card.data = {})
  d.extensions = d.extensions || {}

  // 1) Install the party-panel regex into the ST-standard regex_scripts array.
  //    collectBundledRegex() in characterService reads this slot.
  const scripts = Array.isArray(d.extensions.regex_scripts) ? d.extensions.regex_scripts : []
  const existing = scripts.findIndex((s) => s && s.scriptName === PANEL_NAME)
  if (existing >= 0) {
    scripts[existing] = PANEL_REGEX
    log.push('regex_scripts[' + existing + ']: replaced (idempotent) ' + PANEL_NAME)
  } else {
    scripts.push(PANEL_REGEX)
    log.push('regex_scripts[' + (scripts.length - 1) + ']: added ' + PANEL_NAME)
  }
  d.extensions.regex_scripts = scripts

  // 2) Declare the left panel (PA4 auto-dock logic resolves by scriptName match).
  d.extensions.rp_terminal = Object.assign({}, d.extensions.rp_terminal, {
    left_panel: { name: PANEL_NAME },
  })
  log.push('rp_terminal.left_panel.name: ' + PANEL_NAME)
}

// ── Read → patch → write ─────────────────────────────────────────────────────

const buf = fs.readFileSync(SRC)
const out = [buf.slice(0, 8)]
let off = 8
let patched = 0
const log = []
while (off < buf.length) {
  const length = buf.readUInt32BE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  const total = 12 + length
  if (type === 'tEXt') {
    const data = buf.slice(off + 8, off + 8 + length)
    const z = data.indexOf(0)
    const keyword = data.slice(0, z).toString('latin1')
    if (keyword === 'chara' || keyword === 'ccv3') {
      const card = JSON.parse(
        Buffer.from(data.slice(z + 1).toString('latin1'), 'base64').toString('utf8')
      )
      log.push('--- ' + keyword + ' ---')
      editCard(card, log)
      const nb64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
      out.push(
        makeChunk(
          'tEXt',
          Buffer.concat([Buffer.from(keyword + '\0', 'latin1'), Buffer.from(nb64, 'latin1')])
        )
      )
      patched++
      off += total
      continue
    }
  }
  out.push(buf.slice(off, off + total))
  if (type === 'IEND') break
  off += total
}
fs.writeFileSync(OUT, Buffer.concat(out))
console.log('patched ' + patched + ' chunk(s) -> ' + path.relative(ROOT, OUT))
console.log(log.join('\n'))
