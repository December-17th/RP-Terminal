import { describe, it, expect } from 'vitest'
import { paletteMatch } from '../../src/renderer/src/components/workflow/paletteModel'

// The palette search model (agent-memory-ux WP-G; spec §2): one box filters BOTH sections.
describe('paletteMatch', () => {
  it('empty/blank query matches everything', () => {
    expect(paletteMatch('', ['anything'])).toBe(true)
    expect(paletteMatch('   ', ['anything'])).toBe(true)
    expect(paletteMatch('', [])).toBe(true)
  })

  it('case-insensitive substring over any provided text', () => {
    expect(paletteMatch('MEMORY', ['Table memory', 'maintains tables'])).toBe(true)
    expect(paletteMatch('table.apply', [undefined, 'table.apply'])).toBe(true)
    expect(paletteMatch('missing', ['Table memory'])).toBe(false)
  })

  it('multi-term: every term must match somewhere', () => {
    expect(paletteMatch('table mem', ['Table memory'])).toBe(true)
    expect(paletteMatch('table ghost', ['Table memory'])).toBe(false)
    // Terms may match across DIFFERENT texts of the same entry.
    expect(paletteMatch('agent llm', ['Agent', 'agent.llm — one model call'])).toBe(true)
  })

  it('undefined texts are ignored, not matched', () => {
    expect(paletteMatch('undefined', [undefined, undefined])).toBe(false)
  })
})
