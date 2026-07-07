import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { TITLEBAR_OVERLAY_HEIGHT } from '../src/main/windowChrome'

// The custom merged title bar (Windows) has two halves that MUST be the same height so the OS
// window controls sit flush with the renderer top strip: the main-process overlay height
// (TITLEBAR_OVERLAY_HEIGHT, src/main/windowChrome.ts) and the renderer token --rpt-titlebar-h
// (src/renderer/src/theme.ts + assets/index.css :root fallback). They can't literally share a
// value across the process boundary, so this test pins them together — change one, this fails
// until the other follows.

const themeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'theme.ts'),
  'utf-8'
)
const cssSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'index.css'),
  'utf-8'
)

// --rpt-titlebar-h: '44px'  (theme.ts, quoted) and  --rpt-titlebar-h: 44px;  (index.css :root).
const themeTokenPx = [...themeSrc.matchAll(/--rpt-titlebar-h'\s*:\s*'(\d+)px'/g)].map((m) =>
  Number(m[1])
)
const cssTokenPx = cssSrc.match(/--rpt-titlebar-h\s*:\s*(\d+)px/)?.[1]

describe('titlebar height single-source (PM-A5)', () => {
  it('defines the renderer token in all three theme sets', () => {
    // dark / carbon / light
    expect(themeTokenPx.length).toBe(3)
  })

  it('renderer token matches the main-process overlay height in every theme', () => {
    for (const px of themeTokenPx) expect(px).toBe(TITLEBAR_OVERLAY_HEIGHT)
  })

  it('the index.css :root first-paint fallback also matches', () => {
    expect(Number(cssTokenPx)).toBe(TITLEBAR_OVERLAY_HEIGHT)
  })
})
