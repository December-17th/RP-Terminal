import { describe, it, expect } from 'vitest'
import { parseEntryMarker, markerIndex, PositionMessage } from '../src/main/parsers/injectMarkers'

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

  it('does not mistake bracketed category comments for markers (命定之诗 lorebook shapes)', () => {
    // Real entry comments from the example card — [Category] labels, not [GENERATE:…] markers.
    const realComments = [
      '[诺斯加德联盟-总览]',
      '[种族-魔物]',
      '[DLC][事件][猩红之影]入口',
      '➡️种族开始',
      '命定系统-奥托·阿波卡利斯(by_lili)',
      '[索伦蒂斯王国-珍珠湾]'
    ]
    for (const c of realComments) {
      // Content begins with `<%_` (an EJS trim tag), which must NOT read as an @@ decorator.
      const r = parseEntryMarker(c, '<%_ const x = getvar("stat_data.主角.等级") _%>等级:<%= x %>')
      expect(r.marker).toBeNull()
      expect(r.activation).toBeNull()
    }
  })
})

describe('injectMarkers — markerIndex (position math)', () => {
  // indices: 0=system, 1=user(u1), 2=assistant(a1), 3=user(u2)
  const msgs: PositionMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }
  ]

  it('[GENERATE] whole-prompt + indexed + regex', () => {
    expect(markerIndex({ kind: 'generate', side: 'before' }, msgs)).toBe(0)
    expect(markerIndex({ kind: 'generate', side: 'after' }, msgs)).toBe(4)
    expect(markerIndex({ kind: 'generate', side: 'before', index: 2 }, msgs)).toBe(2)
    expect(markerIndex({ kind: 'generate', side: 'after', index: 2 }, msgs)).toBe(3)
    expect(markerIndex({ kind: 'generate', side: 'before', regex: 'a1' }, msgs)).toBe(2)
  })

  it('@INJECT absolute pos (0 / 1-based / negative)', () => {
    expect(markerIndex({ kind: 'inject', pos: 0 }, msgs)).toBe(0)
    expect(markerIndex({ kind: 'inject', pos: 2 }, msgs)).toBe(1) // 1-based → 0-based
    expect(markerIndex({ kind: 'inject', pos: -1 }, msgs)).toBe(3) // before the last
  })

  it('@INJECT target mode (nth message of a role, before/after)', () => {
    expect(markerIndex({ kind: 'inject', target: 'user', index: 1, at: 'after' }, msgs)).toBe(2)
    expect(markerIndex({ kind: 'inject', target: 'user', index: 2, at: 'before' }, msgs)).toBe(3)
    expect(markerIndex({ kind: 'inject', target: 'assistant', index: 1, at: 'before' }, msgs)).toBe(2)
    expect(markerIndex({ kind: 'inject', target: 'user', index: 9 }, msgs)).toBeNull() // no 9th user
  })

  it('@INJECT regex mode + render markers return null', () => {
    expect(markerIndex({ kind: 'inject', regex: 'a1', at: 'after' }, msgs)).toBe(3)
    expect(markerIndex({ kind: 'render', side: 'before' }, msgs)).toBeNull()
  })
})
