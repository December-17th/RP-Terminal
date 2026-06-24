import { describe, it, expect } from 'vitest'
import {
  extractReasoningTitle,
  extractTpInfo,
  formatTp,
  escapeHtml,
  reasoningSkeleton,
  fillReasoningTemplate
} from '../src/shared/reasoningView'

describe('reasoningView — title extraction', () => {
  it('prefers a #/## heading over bold over bullets, latest on a tie', () => {
    expect(extractReasoningTitle('- a bullet\n**a bold line**\n## The Heading')).toBe('The Heading')
    expect(extractReasoningTitle('- a bullet\n**a bold line**')).toBe('a bold line')
    expect(extractReasoningTitle('- first\n- second')).toBe('second')
  })

  it('returns "" for plain text and ignores all-punctuation headings', () => {
    expect(extractReasoningTitle('just thinking out loud')).toBe('')
    expect(extractReasoningTitle('## ---')).toBe('')
  })
})

describe('reasoningView — <tp> extraction', () => {
  it('parses time @ location | weather (each optional)', () => {
    expect(extractTpInfo('<tp>子時 @ 听雨阁 | 细雨</tp>')).toEqual({
      time: '子時',
      location: '听雨阁',
      weather: '细雨'
    })
    expect(extractTpInfo('<tp>day-1</tp>')).toEqual({ time: 'day-1', location: '', weather: '' })
  })

  it('returns null when there is no <tp> or it is empty', () => {
    expect(extractTpInfo('no tag here')).toBeNull()
    expect(extractTpInfo('<tp>  </tp>')).toBeNull()
  })

  it('formatTp joins present fields with a middot', () => {
    expect(formatTp({ time: '子時', location: '听雨阁', weather: '' })).toBe('子時 · 听雨阁')
    expect(formatTp(null)).toBe('')
  })
})

describe('reasoningView — slot helpers', () => {
  const tmpl =
    '<div class="codex" data-state="{{state}}"><h3>{{title}}</h3>' +
    '<small>{{tp}}</small><div class="body">{{reasoning}}</div></div>'

  it('escapeHtml neutralizes markup', () => {
    expect(escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;')
  })

  it('reasoningSkeleton: content slots → empty updatable spans, {{state}} substituted inline', () => {
    const out = reasoningSkeleton(tmpl, 'thinking')
    expect(out).toContain('data-state="thinking"')
    expect(out).toContain('<span data-rpt-slot="reasoning"></span>')
    expect(out).toContain('<span data-rpt-slot="title"></span>')
    expect(out).toContain('<span data-rpt-slot="tp"></span>')
    expect(out).not.toContain('{{') // no slot left unsubstituted
  })

  it('fillReasoningTemplate: static escaped fill of every slot', () => {
    const out = fillReasoningTemplate(tmpl, {
      state: 'done',
      title: 'Plan',
      tp: 'day-1',
      reasoning: 'weighing <options>'
    })
    expect(out).toContain('data-state="done"')
    expect(out).toContain('<h3>Plan</h3>')
    expect(out).toContain('weighing &lt;options&gt;') // escaped
    expect(out).not.toContain('{{')
  })
})
