import { describe, it, expect, vi } from 'vitest'

// Keep the quickjs/WASM template engine (and the renderer stores it drags in) OUT of this node test:
// the pipeline transform is exercised with INJECTED fake ctx fns, so the real renderTemplate is never
// needed. Mocking the module short-circuits its top-level engine init. `currentDisplayCtx` (the only
// store-reading export) is intentionally not tested here — it's covered by the in-app behavior gate.
vi.mock('../src/renderer/src/plugin/renderTemplate', () => ({
  renderTemplate: (t: string): string => t
}))

import {
  renderFloorView,
  renderStreamingFrame,
  type DisplayCtx,
  type FloorLike
} from '../src/renderer/src/display/displayPipeline'

// Golden characterization of the headless display pipeline extracted from ChatView.currentFloor and
// StreamingView (docs/display-host-design.md §3.1). Pins the COMPOSITION — pass ordering, reasoning
// routing, marker wrapping, macro expansion, verbatim plot_block, swipe defaults — so the later
// DisplayHost broker steps can't silently drift the native view. Individual stages (macros / regex /
// responseView / buildStreamingHead) are pinned by their own tests; here we pin how they're wired.

const ctx = (over: Partial<DisplayCtx> = {}): DisplayCtx => ({
  user: 'Alice',
  char: 'Bob',
  templatesOn: true,
  renderEnabled: true,
  finalPassOn: true,
  liveOn: true,
  rateChars: 10,
  applyRegex: (t) => t,
  applyReasoning: (t) => t,
  applyPlot: (t) => t,
  // Identity EJS eval (the fixtures carry no `<%` tags), so we observe only the wiring around it.
  renderTemplate: (t) => t,
  renderMarkers: { before: [], after: [] },
  ...over
})

const mkFloor = (over: Partial<FloorLike> = {}): FloorLike => ({
  floor: 1,
  response: { content: '' },
  user_message: { content: 'user says hi' },
  variables: {},
  ...over
})

describe('renderFloorView', () => {
  it('routes <think> to `thinking` (post applyReasoning) and keeps it out of `html`', () => {
    const applyRegex = vi.fn((t: string) => t)
    const applyReasoning = vi.fn((t: string) => `[R]${t}`)
    const out = renderFloorView(
      mkFloor({ response: { content: 'Hello world<think>secret reasoning</think>' } }),
      ctx({ applyRegex, applyReasoning })
    )
    expect(out.html).toBe('Hello world') // reasoning stripped BEFORE the display regex
    expect(out.thinking).toBe('[R]secret reasoning') // extractThinking → applyReasoning (placement 6)
    // The body handed to the display regex must already be reasoning-free — a card regex can never
    // rewrite reasoning into inline UI.
    expect(applyRegex).toHaveBeenCalledWith('Hello world', { user: 'Alice', char: 'Bob' })
  })

  it('passes the stored plot_block through verbatim (not derived from response.content)', () => {
    const out = renderFloorView(
      mkFloor({ plot_block: '<用户本轮输入>plot {{user}} stuff' }),
      ctx({ applyRegex: (t) => `X${t}X` })
    )
    // No macro/regex touches it here — PlotPanel owns the placement-1⊕2 pass downstream.
    expect(out.plotBlock).toBe('<用户本轮输入>plot {{user}} stuff')
  })

  it('wraps [RENDER:*] before/after markers when templatesOn && renderEnabled', () => {
    const out = renderFloorView(
      mkFloor({ response: { content: 'BODY' } }),
      ctx({ renderMarkers: { before: ['HEADER'], after: ['FOOTER'] } })
    )
    expect(out.html).toBe('HEADER\n\nBODY\n\nFOOTER')
  })

  it('drops the markers when templates are off (master toggle gates the wrap, body still renders)', () => {
    const out = renderFloorView(
      mkFloor({ response: { content: 'BODY' } }),
      ctx({ templatesOn: false, renderMarkers: { before: ['HEADER'], after: ['FOOTER'] } })
    )
    expect(out.html).toBe('BODY')
  })

  it('expands {{user}}/{{char}} macros in the body before the regex', () => {
    const out = renderFloorView(
      mkFloor({ response: { content: 'Hi {{user}} from {{char}}' } }),
      ctx({ user: 'Alice', char: 'Bob' })
    )
    expect(out.html).toBe('Hi Alice from Bob')
  })

  it('applies the injected display regex last (after macros)', () => {
    const applyRegex = vi.fn((t: string) => t.replace('Bob', '<b>Bob</b>'))
    const out = renderFloorView(
      mkFloor({ response: { content: '{{char}} speaks' } }),
      ctx({ char: 'Bob', applyRegex })
    )
    expect(applyRegex).toHaveBeenCalledWith('Bob speaks', { user: 'Alice', char: 'Bob' })
    expect(out.html).toBe('<b>Bob</b> speaks')
  })

  it('carries user_message.content UNtransformed (raw userText is parity, not a shortcut)', () => {
    const out = renderFloorView(
      mkFloor({ user_message: { content: 'RAW {{user}}' } }),
      ctx({ applyRegex: (t) => `X${t}` })
    )
    expect(out.user).toBe('RAW {{user}}')
    expect(out.rawResponse).toBe('') // the stored raw response, verbatim
  })

  it('derives swipe id/count with the store defaults (0 / 1)', () => {
    expect(renderFloorView(mkFloor({ swipe_id: 2, swipes: [1, 2, 3] }), ctx())).toMatchObject({
      swipeId: 2,
      swipeCount: 3
    })
    expect(renderFloorView(mkFloor(), ctx())).toMatchObject({ swipeId: 0, swipeCount: 1 })
  })
})

describe('renderStreamingFrame', () => {
  it('returns an empty head below the first rate checkpoint', () => {
    expect(renderStreamingFrame('short', {}, ctx({ rateChars: 100 }))).toEqual({ html: '', atLen: 0 })
  })

  it('folds the whole body once past the checkpoint (atLen = body.length)', () => {
    const body = 'x'.repeat(20)
    const out = renderStreamingFrame(body, {}, ctx({ rateChars: 10 }))
    expect(out.atLen).toBe(body.length)
    expect(out.html).toBe(body)
  })

  it('runs the live EJS eval via ctx.renderTemplate only when liveOn AND the body has a `<%` tag', () => {
    const renderTemplate = vi.fn((t: string) => t)
    renderStreamingFrame('has <%= 1 %> tag', {}, ctx({ rateChars: 1, liveOn: true, renderTemplate }))
    expect(renderTemplate).toHaveBeenCalledWith('has <%= 1 %> tag', {}, 'live')

    renderTemplate.mockClear()
    renderStreamingFrame('has <%= 1 %> tag', {}, ctx({ rateChars: 1, liveOn: false, renderTemplate }))
    expect(renderTemplate).not.toHaveBeenCalled() // live toggle off

    renderTemplate.mockClear()
    renderStreamingFrame('no tags here', {}, ctx({ rateChars: 1, liveOn: true, renderTemplate }))
    expect(renderTemplate).not.toHaveBeenCalled() // no `<%`
  })

  it('expands macros then applies the injected regex on the streaming head', () => {
    const applyRegex = vi.fn((t: string) => t.replace('Bob', '<b>Bob</b>'))
    const out = renderStreamingFrame('hi {{char}}', {}, ctx({ rateChars: 1, char: 'Bob', applyRegex }))
    expect(out.html).toBe('hi <b>Bob</b>')
  })
})
