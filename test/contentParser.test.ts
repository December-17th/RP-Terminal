import { describe, it, expect } from 'vitest'
import { parseContent, parseCombatStart, stripThinking } from '../src/main/parsers/contentParser'
import { parseMvuCommands } from '../src/main/parsers/mvuParser'

describe('parseCombatStart', () => {
  it('returns null cue when there is no tag', () => {
    expect(parseCombatStart('just prose').cue).toBeNull()
  })

  it('parses attributes + strips the tag (no roster)', () => {
    const r = parseCombatStart(
      'before <rpt-combat-start enemies="哥布林 x2" map="forest"></rpt-combat-start> after'
    )
    expect(r.cue).toEqual({ enemies: '哥布林 x2', map: 'forest' })
    expect(r.text).toBe('before  after')
  })

  it('parses a JSON roster from the tag body', () => {
    const content =
      'A fight! <rpt-combat-start>[' +
      '{"名称":"哥布林","数量":2,"生命层级":"第一层级","属性":{"力量":3}},' +
      '{"名称":"头目","生命层级":"第二层级","属性":{"力量":6}}' +
      ']</rpt-combat-start> narrative'
    const r = parseCombatStart(content)
    expect(r.cue?.roster).toHaveLength(2)
    expect(r.cue?.roster?.[0]).toMatchObject({ 名称: '哥布林', 数量: 2 })
    expect(r.text).toBe('A fight!  narrative')
  })

  it('tolerates a ```json fence + a single object (→ 1-element array)', () => {
    const r = parseCombatStart(
      '<rpt-combat-start>```json\n{"名称":"史莱姆"}\n```</rpt-combat-start>'
    )
    expect(r.cue?.roster).toEqual([{ 名称: '史莱姆' }])
  })

  it('ignores an unparseable body (cue still detected)', () => {
    const r = parseCombatStart('<rpt-combat-start enemies="x">not json</rpt-combat-start>')
    expect(r.cue).toEqual({ enemies: 'x', map: '' })
    expect(r.cue?.roster).toBeUndefined()
  })
})

describe('stripThinking', () => {
  it('removes <think>/<thinking> blocks (incl. attributes), keeps the narrative', () => {
    expect(stripThinking('<thinking>plan the scene</thinking>\nThe rain falls.')).toBe(
      'The rain falls.'
    )
    expect(stripThinking('<think>a</think>X<think>b</think>Y')).toBe('XY')
    expect(stripThinking('<thinking foo="1">x</thinking>Done')).toBe('Done')
    expect(stripThinking('all narration, no cot')).toBe('all narration, no cot')
  })

  it('drops a dangling unclosed trailing block (truncated output)', () => {
    expect(stripThinking('Scene text.\n<thinking>cut off mid-reaso')).toBe('Scene text.')
  })

  it('prevents a stray <UpdateVariable> in reasoning from eating the narrative', () => {
    // The real bug: thinking mentions "<UpdateVariable>" with no close, so the MVU stripper
    // would match through to the real block, deleting <gametxt>. Stripping thinking first fixes it.
    const raw =
      '<thinking>Then I will output <UpdateVariable> with the patch.</thinking>\n' +
      '<gametxt>The guild hall roars with rain.</gametxt>\n' +
      "<UpdateVariable>\n_.set('hp', 100, 80);//hit\n</UpdateVariable>"
    const { text, commands } = parseMvuCommands(stripThinking(raw))
    expect(text).toContain('<gametxt>The guild hall roars with rain.</gametxt>')
    expect(commands).toEqual([{ op: 'set', path: 'hp', value: 80, reason: 'hit' }])
  })
})

describe('parseContent', () => {
  it('strips an rpt-event tag and returns trimmed narrative text', () => {
    const { text, events } = parseContent(
      'You take 5 damage. <rpt-event type="state" action="add" path="stats.hp" value="-5" />'
    )
    expect(text).toBe('You take 5 damage.')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'state', action: 'add', path: 'stats.hp', value: -5 })
  })

  it('JSON-parses numeric/boolean/object values, keeps plain strings', () => {
    const { events } = parseContent(
      '<rpt-event type="state" action="set" path="hp" value="50" />' +
        '<rpt-event type="state" action="set" path="flags.alive" value="true" />' +
        '<rpt-event type="state" action="set" path="name" value="Aria" />'
    )
    expect(events.map((e) => e.value)).toEqual([50, true, 'Aria'])
  })

  it('defaults the action to "set" when omitted', () => {
    const { events } = parseContent('<rpt-event type="state" path="hp" value="10" />')
    expect(events[0].action).toBe('set')
  })

  it('lowercases the type and ignores tags missing required attrs', () => {
    const { events } = parseContent(
      '<rpt-event type="STATE" path="x" value="1" />' + '<rpt-event type="state" path="noValue" />' // missing value -> ignored
    )
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('state')
  })

  it('returns text unchanged when there are no tags', () => {
    const { text, events } = parseContent('Just a normal line.')
    expect(text).toBe('Just a normal line.')
    expect(events).toEqual([])
  })
})
