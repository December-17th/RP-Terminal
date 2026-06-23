import { describe, it, expect } from 'vitest'
import {
  stripThinking,
  stripRptEvents,
  stripMvuBlocks,
  cleanForDisplay,
  cleanForHistory
} from '../src/shared/responseView'

describe('responseView (lossless storage, view-time transforms)', () => {
  const raw =
    '<thinking>plan: emit <UpdateVariable></thinking>\n' +
    '<tp>day-1</tp>\n' +
    '<gametxt>The rain falls.</gametxt>\n' +
    '<rpt-event type="state" action="set" path="hp" value="80" />\n' +
    "<UpdateVariable>\n_.set('hp', 100, 80);//hit\n</UpdateVariable>"

  it('cleanForDisplay hides reasoning + rpt-event but KEEPS the MVU block (card regex folds it)', () => {
    const out = cleanForDisplay(raw)
    expect(out).not.toContain('<thinking>')
    expect(out).not.toContain('plan: emit')
    expect(out).not.toContain('<rpt-event')
    expect(out).toContain('<gametxt>The rain falls.</gametxt>')
    expect(out).toContain('<UpdateVariable>') // left for the card's display regex to fold
  })

  it('cleanForHistory also drops the MVU block (model never re-reads its raw state ops)', () => {
    const out = cleanForHistory(raw)
    expect(out).not.toContain('<thinking>')
    expect(out).not.toContain('<rpt-event')
    expect(out).not.toContain('<UpdateVariable>')
    expect(out).toContain('<gametxt>The rain falls.</gametxt>')
  })

  it('is a no-op on already-clean text (legacy floors stay intact)', () => {
    expect(cleanForDisplay('Just narrative.')).toBe('Just narrative.')
    expect(cleanForHistory('Just narrative.')).toBe('Just narrative.')
    expect(stripRptEvents('hello')).toBe('hello')
    expect(stripMvuBlocks('hello')).toBe('hello')
    expect(stripThinking('hello')).toBe('hello')
  })
})
