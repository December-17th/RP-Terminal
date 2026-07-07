#!/usr/bin/env node
/*
 * build-poem-play-area.cjs — assemble the 命定之诗 play-area redesign into a loadable card bundle.
 *
 * The three surfaces (poem-self/stage/world-surface.html) `@import` a shared poem-themes.css so a
 * palette is authored once. But a card's panel_ui WCV slot loads a SINGLE self-contained document
 * (served from the storage origin as one HTML per slot — relative @import/fetch don't resolve there).
 * So this build INLINES poem-themes.css into each page → self-contained HTML, then assembles the
 * `data.extensions.rp_terminal` fragment (panel_ui + theme) that makes the app render them.
 *
 * Outputs (in ./dist):
 *   poem-self.html / poem-stage.html / poem-world.html  — self-contained pages (also handy for serving)
 *   poem-play-area.rpt.json                              — the rp_terminal fragment (panel_ui + theme)
 *
 * The fragment's WCV entries are `data:text/html,<page>` URLs (wcvManager.decodeDataHtml serves them
 * from rpt-card://card/<slot>). Merge the fragment into a card's data.extensions.rp_terminal to apply
 * it. Assets (立绘/背景) ride the World Assets layer via window.assetUrl — not inlined here.
 *
 * Run:  node docs/sdk/examples/build-poem-play-area.cjs
 */
const fs = require('fs')
const path = require('path')

const DIR = __dirname
const DIST = path.join(DIR, 'dist')
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8')

// The shared token file, minus its own leading comment banner (kept lean once inlined).
const themesCss = read('poem-themes.css')

// Replace `@import url('./poem-themes.css');` with the file's contents so the page stands alone. The
// font @import at the top of poem-themes.css becomes the first statement of the page's <style>, which
// is where CSS requires @import to live — so ordering stays valid.
function inline(pageFile) {
  const html = read(pageFile)
  const importRe = /@import url\(['"]\.\/poem-themes\.css['"]\);?/
  if (!importRe.test(html)) {
    throw new Error(`${pageFile}: expected an @import of ./poem-themes.css to inline`)
  }
  return html.replace(importRe, themesCss.trim())
}

const pages = {
  self: inline('poem-self-surface.html'),
  stage: inline('poem-stage-surface.html'),
  world: inline('poem-world-surface.html')
}

// A panel_ui WCV entry: the page as a data:text/html URL (decoded + served from the card origin).
const dataUrl = (html) => 'data:text/html,' + encodeURIComponent(html)

// The seamless 4-slot layout (redesign §4.2): SELF full-height | STAGE top-band | STORY native chat
// (exactly 50% width) | WORLD lower-right.
const panel_ui = {
  mode: 'static',
  seamless: true,
  grid: { cols: 12, rows: 12 },
  slots: [
    { id: 'self', view: 'wcv', entry: dataUrl(pages.self), rect: [0, 0, 3, 12] },
    { id: 'stage', view: 'wcv', entry: dataUrl(pages.stage), rect: [3, 0, 9, 4] },
    { id: 'story', view: 'chat', rect: [3, 4, 6, 8], title: '正文' },
    { id: 'world', view: 'wcv', entry: dataUrl(pages.world), rect: [9, 4, 3, 8] }
  ]
}

// The card theme reskins the app SHELL + native chat (the STORY slot) to the dusk-gilt palette, and
// sets the prose serif register for the story (the P3 --rpt-chat-font-family token). The 4 WCV pages
// carry their own poem-themes.css palettes; this theme is the static dusk pairing for the native chrome.
// (Card supplies fills; the app derives on-* text + enforces WCAG-AA — see cardTheme.ts.)
const theme = {
  base: 'dark',
  tokens: {
    'bg-primary': '#14121b',
    'bg-secondary': '#1d1a27',
    'bg-tertiary': '#100e16',
    'bg-elevated': '#1d1a27',
    'text-primary': '#e9e3d4',
    'text-secondary': '#a89f8c',
    'text-tertiary': '#6f6858',
    accent: '#d9b56b',
    'on-accent': '#17131f',
    border: '#2e2a3d',
    danger: '#cf5a6d',
    success: '#5fb98a',
    warning: '#d9b56b',
    'prose-font': "'Noto Serif SC', 'Songti SC', Georgia, serif"
  }
}

const fragment = { panel_ui, theme }

fs.mkdirSync(DIST, { recursive: true })
fs.writeFileSync(path.join(DIST, 'poem-self.html'), pages.self)
fs.writeFileSync(path.join(DIST, 'poem-stage.html'), pages.stage)
fs.writeFileSync(path.join(DIST, 'poem-world.html'), pages.world)
fs.writeFileSync(path.join(DIST, 'poem-play-area.rpt.json'), JSON.stringify(fragment, null, 2))

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB'
console.log('built poem play-area bundle → docs/sdk/examples/dist/')
console.log(`  poem-self.html   ${kb(pages.self)}`)
console.log(`  poem-stage.html  ${kb(pages.stage)}`)
console.log(`  poem-world.html  ${kb(pages.world)}`)
console.log(`  poem-play-area.rpt.json  ${kb(JSON.stringify(fragment))}  (panel_ui + theme)`)

// ── optional: apply the fragment to a card PNG (`--apply [src] [out]`) ──────────────────
// Merges { panel_ui, theme } into data.extensions.rp_terminal in the card's chara + ccv3 tEXt chunks
// (PNG surgery mirrors patch-poem-card.cjs). NEVER in place: the 命定之诗 asset folder is shared across
// worktrees + gitignored, so this always writes a NEW copy and refuses if out === src.
const DEFAULT_SRC =
  'E:/Projects/RP Terminal/example sillytarvern character card, presets, extensions and scripts/命定之诗/v4.2.1+combat+party+duel.png'

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
const mergeCard = (card) => {
  const d = card.data || (card.data = {})
  d.extensions = d.extensions || {}
  // Preserve everything already under rp_terminal (combat, etc.); overwrite panel_ui + theme.
  d.extensions.rp_terminal = Object.assign({}, d.extensions.rp_terminal, { panel_ui, theme })
}
// Walk chunks; rewrite chara/ccv3 tEXt (base64 card JSON); `mut` mutates the parsed card.
const eachCardChunk = (buf, mut) => {
  const out = [buf.slice(0, 8)]
  let off = 8
  let n = 0
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
        const result = mut(card, keyword)
        const nb64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
        out.push(
          makeChunk(
            'tEXt',
            Buffer.concat([Buffer.from(keyword + '\0', 'latin1'), Buffer.from(nb64, 'latin1')])
          )
        )
        if (result !== false) n++
        off += total
        continue
      }
    }
    out.push(buf.slice(off, off + total))
    if (type === 'IEND') break
    off += total
  }
  return { buf: Buffer.concat(out), n }
}
const readFirstCard = (buf) => {
  let found = null
  eachCardChunk(buf, (card) => {
    if (!found) found = card
    return false
  })
  return found
}

const args = process.argv.slice(2)
if (args.includes('--apply')) {
  const rest = args.filter((a) => a !== '--apply')
  const src = path.resolve(rest[0] || DEFAULT_SRC)
  const out = path.resolve(rest[1] || src.replace(/\.png$/i, '+playarea.png'))
  if (src === out) throw new Error('refusing to overwrite the source PNG in place — pick a new output name')
  const { buf, n } = eachCardChunk(fs.readFileSync(src), mergeCard)
  fs.writeFileSync(out, buf)
  // verify: re-read the written PNG and assert the 4-slot panel_ui landed
  const check = readFirstCard(fs.readFileSync(out))
  const slots = check && check.data && check.data.extensions && check.data.extensions.rp_terminal &&
    check.data.extensions.rp_terminal.panel_ui && check.data.extensions.rp_terminal.panel_ui.slots
  if (!slots || slots.length !== 4) throw new Error('verify failed: panel_ui not present in output')
  console.log(`\napplied → ${out}`)
  console.log(`  patched ${n} card chunk(s); panel_ui slots: ${slots.map((s) => s.id).join(', ')}`)
} else {
  console.log('\nApply to a card PNG:  node docs/sdk/examples/build-poem-play-area.cjs --apply')
  console.log('(defaults to the 命定之诗 card, writes a NEW …+playarea.png alongside it)')
}
