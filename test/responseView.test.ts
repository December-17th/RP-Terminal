import { describe, it, expect } from 'vitest'
import {
  stripThinking,
  stripRptEvents,
  stripMvuBlocks,
  cleanForDisplay,
  cleanForHistory,
  hasThinking,
  extractThinking,
  splitReasoning
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

  it('hides recognized Yuzu control lines from Classic display and narrator history', () => {
    const annotated =
      '<| block |>\n<| bg 教室 |>\n<gametxt>The rain falls.</gametxt>\n<| 柚子 smile left |>\n<| end |>'
    for (const out of [cleanForDisplay(annotated), cleanForHistory(annotated)]) {
      expect(out).toBe('<gametxt>The rain falls.</gametxt>')
      expect(out).not.toContain('<|')
    }
  })

  it('a <rpt-combat-start> MENTION inside <think> does not swallow the narrative (tempered strip)', () => {
    // Real duel bug: the model mentions the tag in its reasoning ("输出<rpt-combat-start>标签"), then
    // emits the real paired tag + roster later. An un-tempered strip bridged from the mention to the
    // real close, deleting the whole body (and, with the </think> eaten, the dangling <think> made
    // stripThinking drop everything) → an empty message showing only the reasoning panel.
    const dup =
      '<think>plan: 输出<rpt-combat-start>标签; 再次确认<rpt-combat-start>位于正文之后</think>\n' +
      '<gametxt>The knight raises her blade.</gametxt>\n' +
      '<rpt-combat-start map="road">[{"名称":"Bandit"}]</rpt-combat-start>\n' +
      'Choose: fight or flee.'
    const out = cleanForDisplay(dup)
    expect(out).toContain('The knight raises her blade.')
    expect(out).toContain('Choose: fight or flee.')
    expect(out).not.toContain('<rpt-combat-start') // both the mention and the real tag are gone
    expect(out).not.toContain('Bandit') // the roster body is still stripped
    expect(out).not.toContain('plan:') // reasoning still removed
    // The committed-floor order (strip combat-start on RAW, then thinking) must ALSO keep the body.
    expect(stripThinking(stripRptEvents(dup))).toContain('The knight raises her blade.')
  })

  it('is a no-op on already-clean text (legacy floors stay intact)', () => {
    expect(cleanForDisplay('Just narrative.')).toBe('Just narrative.')
    expect(cleanForHistory('Just narrative.')).toBe('Just narrative.')
    expect(stripRptEvents('hello')).toBe('hello')
    expect(stripMvuBlocks('hello')).toBe('hello')
    expect(stripThinking('hello')).toBe('hello')
  })

  it('hasThinking detects a raw <think>/<thinking> open tag (gone once a regex folds it)', () => {
    expect(hasThinking('<think>plan</think> body')).toBe(true)
    expect(hasThinking('<thinking>plan')).toBe(true) // dangling/unclosed
    expect(hasThinking('<details>plan</details> body')).toBe(false) // already folded by a card regex
    expect(hasThinking('plain narrative')).toBe(false)
  })

  it('extractThinking returns the inner reasoning (closed blocks + a dangling trailing one)', () => {
    expect(extractThinking('<thinking>plan A</thinking>\nThe rain falls.')).toBe('plan A')
    expect(extractThinking('a <think>one</think> b <think>two</think>')).toBe('one\n\ntwo')
    expect(extractThinking('<think>cut off…')).toBe('cut off…') // unclosed (truncated output)
    expect(extractThinking('no reasoning here')).toBe('')
  })

  describe('splitReasoning (streaming lifecycle: <think> → panel, </think> → body)', () => {
    it('no reasoning tag → all body, state none', () => {
      expect(splitReasoning('The rain falls.')).toEqual({
        reasoning: '',
        body: 'The rain falls.',
        state: 'none'
      })
    })

    it('open <think> with no close → thinking; reasoning streams, body withheld', () => {
      const r = splitReasoning('<think>weighing options')
      expect(r.state).toBe('thinking')
      expect(r.reasoning).toBe('weighing options')
      expect(r.body).toBe('') // body only streams after </think>
    })

    it('closed </think> → done; reasoning is the inner text, body is the rest', () => {
      const r = splitReasoning('<thinking>plan A</thinking>\nThe rain falls.')
      expect(r.state).toBe('done')
      expect(r.reasoning).toBe('plan A')
      expect(r.body).toBe('The rain falls.')
    })

    it('a closed block followed by a fresh open one is still thinking', () => {
      const r = splitReasoning('<think>a</think><think>b')
      expect(r.state).toBe('thinking')
      expect(r.reasoning).toBe('a\n\nb')
      expect(r.body).toBe('')
    })

    it('keeps <tp> in the body (for the panel to read) and drops rpt-events', () => {
      const r = splitReasoning('<think>x</think><tp>day-1</tp><rpt-event type="s" />Body.')
      expect(r.state).toBe('done')
      expect(r.body).toContain('<tp>day-1</tp>')
      expect(r.body).not.toContain('<rpt-event')
    })
  })
})
