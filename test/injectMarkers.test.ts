import { describe, it, expect } from 'vitest'
import { parseEntryMarker } from '../src/main/parsers/injectMarkers'

describe('injectMarkers — parseEntryMarker', () => {
  it('parses [GENERATE:BEFORE]/[GENERATE:AFTER] comment markers', () => {
    expect(parseEntryMarker('[GENERATE:BEFORE]', 'hi').marker).toEqual({
      kind: 'generate',
      side: 'before'
    })
    expect(parseEntryMarker('[generate:after]', 'hi').marker).toEqual({
      kind: 'generate',
      side: 'after'
    })
  })

  it('parses the 0-based indexed and REGEX generate forms', () => {
    expect(parseEntryMarker('[GENERATE:2:AFTER]', 'x').marker).toEqual({
      kind: 'generate',
      side: 'after',
      index: 2
    })
    expect(parseEntryMarker('[GENERATE:REGEX:^You ]', 'x').marker).toEqual({
      kind: 'generate',
      side: 'before',
      regex: '^You '
    })
  })

  it('parses [RENDER:*]', () => {
    expect(parseEntryMarker('[RENDER:BEFORE]', 'x').marker).toEqual({ kind: 'render', side: 'before' })
    expect(parseEntryMarker('[RENDER:AFTER]', 'x').marker).toEqual({ kind: 'render', side: 'after' })
  })

  it('parses @INJECT (absolute / target / regex modes)', () => {
    expect(parseEntryMarker('@INJECT pos=0,role=system', 'x').marker).toEqual({
      kind: 'inject',
      role: 'system',
      pos: 0
    })
    expect(parseEntryMarker('@INJECT target=user,index=1,at=after,role=system', 'x').marker).toEqual({
      kind: 'inject',
      role: 'system',
      target: 'user',
      index: 1,
      at: 'after'
    })
    expect(parseEntryMarker("@INJECT regex='hello',at=before,role=assistant", 'x').marker).toEqual({
      kind: 'inject',
      role: 'assistant',
      regex: 'hello',
      at: 'before'
    })
  })

  it('parses @@ decorator markers + strips them from the template', () => {
    const r = parseEntryMarker('', '@@generate_after\n@@private\nbody text')
    expect(r.marker).toEqual({ kind: 'generate', side: 'after' })
    expect(r.private).toBe(true)
    expect(r.template).toBe('body text')
  })

  it('reads activation decorators (@@activate / @@dont_activate)', () => {
    expect(parseEntryMarker('', '@@activate\nx').activation).toBe('force')
    expect(parseEntryMarker('', '@@always_enabled\nx').activation).toBe('force')
    expect(parseEntryMarker('', '@@dont_activate\nx').activation).toBe('never')
  })

  it('a comment bracket marker wins over an @@ decorator', () => {
    const r = parseEntryMarker('[GENERATE:BEFORE]', '@@generate_after\nbody')
    expect(r.marker).toEqual({ kind: 'generate', side: 'before' })
    expect(r.template).toBe('body')
  })

  it('plain entries return marker null + the full content', () => {
    const r = parseEntryMarker('Town', 'A quiet harbor town.')
    expect(r.marker).toBeNull()
    expect(r.template).toBe('A quiet harbor town.')
    expect(r.activation).toBeNull()
    expect(r.private).toBe(false)
  })
})
