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
console.log('\nApply: merge poem-play-area.rpt.json into a card data.extensions.rp_terminal.')
