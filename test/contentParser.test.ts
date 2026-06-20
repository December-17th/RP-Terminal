import { describe, it, expect } from 'vitest'
import { parseContent } from '../src/main/parsers/contentParser'

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
