import { describe, expect, it } from 'vitest'
import { RPTerminalExtSchema } from '../../src/main/types/character'

describe('Yuzu full-card surface schema', () => {
  it('accepts one card-code entry and preserves future Yuzu fields', () => {
    const ext = RPTerminalExtSchema.parse({
      yuzu: {
        version: 1,
        opening: '<| bg room |>\n<| end |>',
        surface: {
          entry: 'card-code:yuzu/index.html',
          enable_vn_mode: true,
          futureSurfaceField: true
        },
        futureYuzuField: true
      }
    })

    expect(ext.yuzu?.surface?.entry).toBe('card-code:yuzu/index.html')
    expect(ext.yuzu?.surface?.enable_vn_mode).toBe(true)
    expect(ext.yuzu?.surface?.futureSurfaceField).toBe(true)
    expect(ext.yuzu?.futureYuzuField).toBe(true)
  })

  it('rejects an empty takeover entry', () => {
    const result = RPTerminalExtSchema.safeParse({
      yuzu: { version: 1, surface: { entry: '' } }
    })
    expect(result.success).toBe(false)
  })
})
