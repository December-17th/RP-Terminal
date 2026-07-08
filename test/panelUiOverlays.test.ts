import { describe, it, expect } from 'vitest'
import { RPTerminalExtSchema } from '../src/main/types/character'

// PM-A7: `panel_ui.overlays` — cards declare full-play-area overlay surfaces next to their slots.
describe('panel_ui.overlays schema (PM-A7)', () => {
  it('parses declared overlays (id / entry / optional title) alongside slots', () => {
    const parsed = RPTerminalExtSchema.parse({
      panel_ui: {
        mode: 'static',
        grid: { cols: 12, rows: 12 },
        slots: [{ id: 'world', view: 'wcv', rect: [9, 0, 3, 12], entry: 'data:text/html,x' }],
        overlays: [
          { id: 'partner', entry: 'data:text/html,<b>sheet</b>', title: '同行者' },
          { id: 'map', entry: 'https://cdn.example/map.html' }
        ]
      }
    })
    expect(parsed.panel_ui?.overlays).toEqual([
      { id: 'partner', entry: 'data:text/html,<b>sheet</b>', title: '同行者' },
      { id: 'map', entry: 'https://cdn.example/map.html' }
    ])
  })

  it('overlays is optional — a panel_ui without it still parses', () => {
    const parsed = RPTerminalExtSchema.parse({
      panel_ui: { mode: 'static', slots: [] }
    })
    expect(parsed.panel_ui?.overlays).toBeUndefined()
  })

  it('an overlay entry is required (a declaration without one is rejected)', () => {
    const bad = RPTerminalExtSchema.safeParse({
      panel_ui: { mode: 'static', slots: [], overlays: [{ id: 'partner' }] }
    })
    expect(bad.success).toBe(false)
  })
})
