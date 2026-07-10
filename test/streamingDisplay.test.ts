import { describe, it, expect, vi } from 'vitest'
import {
  buildStreamingHead,
  type StreamingHeadOpts
} from '../src/renderer/src/components/streamingDisplay'

// Pins the streaming display transform used by StreamingView: the SAME chain the settled floor runs
// (ChatView currentFloor) — EJS('live') → {{macros}} → display regex — plus the rate-limit gating that
// keeps the early stream raw. The individual stages are pinned elsewhere (macros/regexApply/responseView
// tests); here we pin the COMPOSITION: ordering, checkpoint gating, and EJS gating.

const opts = (over: Partial<StreamingHeadOpts> = {}): StreamingHeadOpts => ({
  rateChars: 10,
  liveOn: true,
  vars: {},
  user: 'User',
  char: 'Character',
  ...over
})

describe('buildStreamingHead', () => {
  it('returns an empty head below the first rate checkpoint (early stream stays raw)', () => {
    const renderLive = vi.fn((t: string) => t)
    const applyRegex = vi.fn((t: string) => t)
    const out = buildStreamingHead('short', opts({ rateChars: 100 }), { renderLive, applyRegex })
    expect(out).toEqual({ html: '', atLen: 0 })
    // Nothing expensive runs before the first checkpoint.
    expect(renderLive).not.toHaveBeenCalled()
    expect(applyRegex).not.toHaveBeenCalled()
  })

  it('folds the whole body into the head once past the checkpoint (atLen = body.length)', () => {
    const body = 'x'.repeat(20)
    const out = buildStreamingHead(body, opts({ rateChars: 10 }), {
      renderLive: (t) => t,
      applyRegex: (t) => t
    })
    expect(out.atLen).toBe(body.length)
    expect(out.html).toBe(body)
  })

  it('expands {{…}} macros BEFORE the regex sees the text (macros → regex order)', () => {
    let regexInput = ''
    const out = buildStreamingHead('hello {{char}}!', opts({ rateChars: 1, char: 'Ava' }), {
      renderLive: (t) => t,
      applyRegex: (t) => {
        regexInput = t
        return t.replace('Ava', '<b>Ava</b>')
      }
    })
    // The macro must already be expanded in the text handed to regex, else regex can't match 'Ava'.
    expect(regexInput).toBe('hello Ava!')
    expect(out.html).toBe('hello <b>Ava</b>!')
  })

  it('runs the EJS live eval only when enabled AND the body contains a `<%` tag', () => {
    const called = (liveOn: boolean, body: string): boolean => {
      const renderLive = vi.fn((t: string) => t)
      buildStreamingHead(body, opts({ rateChars: 1, liveOn }), {
        renderLive,
        applyRegex: (t) => t
      })
      return renderLive.mock.calls.length > 0
    }
    expect(called(true, 'has <%= 1 %> tag')).toBe(true)
    expect(called(false, 'has <%= 1 %> tag')).toBe(false) // live toggle off
    expect(called(true, 'no template tags here')).toBe(false) // no `<%`
  })
})
