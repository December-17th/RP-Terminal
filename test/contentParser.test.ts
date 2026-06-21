import { describe, it, expect } from 'vitest'
import { parseContent, stripThinking } from '../src/main/parsers/contentParser'
import { parseMvuCommands } from '../src/main/parsers/mvuParser'

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
      '<rpt-event type="STATE" path="x" value="1" />' +
        '<rpt-event type="state" path="noValue" />' // missing value -> ignored
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
