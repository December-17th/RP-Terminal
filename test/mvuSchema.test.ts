import { describe, it, expect } from 'vitest'
import { parseInitVars, buildInitialStatData } from '../src/main/services/mvuSchema'
import { LorebookSchema } from '../src/main/types/character'

const book = (entries: any[]): any => LorebookSchema.parse({ name: 'B', entries })

describe('parseInitVars', () => {
  it('merges JSON code blocks from [initvar]-marked entries', () => {
    const b = book([
      { comment: '[initvar] setup', content: 'Start:\n```json\n{"主角":{"生命值":100},"金币":0}\n```' },
      { keys: ['x'], content: 'plain lore ```json\n{"金币":99}\n```' } // not marked → ignored
    ])
    expect(parseInitVars([b])).toEqual({ 主角: { 生命值: 100 }, 金币: 0 })
  })

  it('parses unquoted-key objects via the tolerant reader', () => {
    const b = book([{ comment: '[initvar]', content: '```\n{ hp: 50, tags: ["a"] }\n```' }])
    expect(parseInitVars([b])).toEqual({ hp: 50, tags: ['a'] })
  })

  it('ignores entries without the [initvar] marker', () => {
    const b = book([{ comment: 'lore', content: '```json\n{"hp":1}\n```' }])
    expect(parseInitVars([b])).toEqual({})
  })
})

describe('buildInitialStatData', () => {
  it('layers native defaults under init-var overrides (deep merge)', () => {
    const b = book([{ comment: '[initvar]', content: '```json\n{"stats":{"hp":80}}\n```' }])
    const stat = buildInitialStatData({ stats: { hp: 100, mp: 30 } }, [b])
    expect(stat).toEqual({ stats: { hp: 80, mp: 30 } }) // hp overridden, mp kept
  })

  it('returns {} when there are no defaults and no init entries', () => {
    expect(buildInitialStatData(undefined, [book([])])).toEqual({})
  })
})
