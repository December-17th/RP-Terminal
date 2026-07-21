import { describe, it, expect, vi } from 'vitest'

// Keep the quickjs/WASM template engine out of this node test (same short-circuit as displayPipeline's
// test): the pure broker helpers under test either inject a fake DisplayCtx or take plain snapshots.
vi.mock('../src/renderer/src/plugin/renderTemplate', () => ({
  renderTemplate: (t: string): string => t
}))

import {
  revisionReason,
  frameCheckpoint,
  shouldEmitFrame,
  renderFloorToView,
  toRenderedFloorView,
  initDisplayBroker,
  type RevisionSnapshot
} from '../src/renderer/src/display/displayBroker'
import type { DisplayCtx, FloorLike } from '../src/renderer/src/display/displayPipeline'
import type { RenderedFloor } from '../src/renderer/src/components/FloorBlock'
import { useChatStore } from '../src/renderer/src/stores/chatStore'

// --- revision bump matrix (ADR 0023 §3.5) --------------------------------------------------------

const rules = ['r']
const plotRules = ['p']
const reasoningRules = ['x']
const baseSnap = (): RevisionSnapshot => ({
  rules,
  plotRules,
  reasoningRules,
  templatesOn: true,
  renderEnabled: true,
  finalPassOn: true,
  liveOn: true,
  rateChars: 2000,
  characterId: 'char-1',
  charName: 'Aria',
  reasoningTemplate: '<r>{{thought}}</r>',
  persona: 'Alice'
})

describe('revisionReason — one reason per change, none for unrelated', () => {
  it('a regex rule-set identity change bumps once, reason "regex"', () => {
    expect(revisionReason(baseSnap(), { ...baseSnap(), rules: ['r2'] })).toBe('regex')
    expect(revisionReason(baseSnap(), { ...baseSnap(), plotRules: ['p2'] })).toBe('regex')
    expect(revisionReason(baseSnap(), { ...baseSnap(), reasoningRules: ['x2'] })).toBe('regex')
  })

  it('a settings-flag change bumps, reason "settings"', () => {
    expect(revisionReason(baseSnap(), { ...baseSnap(), finalPassOn: false })).toBe('settings')
    expect(revisionReason(baseSnap(), { ...baseSnap(), renderEnabled: false })).toBe('settings')
    expect(revisionReason(baseSnap(), { ...baseSnap(), rateChars: 4000 })).toBe('settings')
  })

  it('a character switch bumps, reason "character"', () => {
    expect(revisionReason(baseSnap(), { ...baseSnap(), characterId: 'char-2' })).toBe('character')
  })

  it('a same-id active-card rename bumps, reason "character"', () => {
    expect(revisionReason(baseSnap(), { ...baseSnap(), charName: 'Aria the Bold' })).toBe(
      'character'
    )
  })

  it('a same-id reasoning_template edit bumps, reason "character"', () => {
    expect(
      revisionReason(baseSnap(), { ...baseSnap(), reasoningTemplate: '<r2>{{thought}}</r2>' })
    ).toBe('character')
    // template cleared (null) also counts as a character-facing change.
    expect(revisionReason(baseSnap(), { ...baseSnap(), reasoningTemplate: null })).toBe('character')
  })

  it('a persona rename bumps, reason "persona"', () => {
    expect(revisionReason(baseSnap(), { ...baseSnap(), persona: 'Bob' })).toBe('persona')
  })

  it('an identical snapshot (unrelated store change) does not bump', () => {
    expect(revisionReason(baseSnap(), baseSnap())).toBeNull()
  })

  it('regex takes precedence when regex AND settings both changed in one transition', () => {
    expect(revisionReason(baseSnap(), { ...baseSnap(), rules: ['r2'], finalPassOn: false })).toBe(
      'regex'
    )
  })
})

// --- streaming checkpoint cadence (ADR 0023 §3.4) ------------------------------------------------

describe('frameCheckpoint / shouldEmitFrame — native rateChars cadence', () => {
  const rate = 100
  it('no frame below rateChars (checkpoint 0)', () => {
    expect(shouldEmitFrame(0, 0, rate)).toBe(false)
    expect(shouldEmitFrame(0, 99, rate)).toBe(false)
  })

  it('a frame exactly at the boundary (checkpoint advances to 1)', () => {
    expect(frameCheckpoint(100, rate)).toBe(1)
    expect(shouldEmitFrame(0, 100, rate)).toBe(true)
  })

  it('no duplicate frame within the same checkpoint', () => {
    // Already emitted checkpoint 1; a longer body still inside checkpoint 1 must not re-emit.
    expect(shouldEmitFrame(1, 150, rate)).toBe(false)
    // Crossing into checkpoint 2 emits again.
    expect(shouldEmitFrame(1, 200, rate)).toBe(true)
  })
})

// --- RenderedFloorView mapping (ADR 0023 §3.3) ---------------------------------------------------

const fakeCtx = (over: Partial<DisplayCtx> = {}): DisplayCtx => ({
  user: 'Alice',
  char: 'Bob',
  templatesOn: true,
  renderEnabled: true,
  finalPassOn: true,
  liveOn: true,
  rateChars: 10,
  applyRegex: (t) => t,
  applyReasoning: (t) => t,
  // Uppercase so the plot pass is observable in plotHtml.
  applyPlot: (t) => t.toUpperCase(),
  renderTemplate: (t) => t,
  renderMarkers: { before: [], after: [] },
  ...over
})

describe('renderFloorToView — plot transformed, userText raw, hasReasoning derived', () => {
  it('maps a floor with reasoning + plot through the pipeline + plot pass', () => {
    const floor: FloorLike = {
      floor: 3,
      response: { content: '<thinking>secret</thinking>the body' },
      user_message: { content: 'raw <b>user</b> text' },
      variables: {},
      plot_block: 'recall directive',
      swipe_id: 1,
      swipes: ['a', 'b']
    }
    const view = renderFloorToView(floor, 3, fakeCtx(), 7, 'TEMPLATE')

    expect(view.floorIndex).toBe(3)
    expect(view.revision).toBe(7)
    // userText is the RAW user_message.content (native parity — never transformed).
    expect(view.userText).toBe('raw <b>user</b> text')
    // plotHtml is the placement-1⊕2 pass over the raw plot_block (fakeCtx uppercases).
    expect(view.plotHtml).toBe('RECALL DIRECTIVE')
    // reasoning extracted + post placement-6; hasReasoning derives from it.
    expect(view.thinking).toBe('secret')
    expect(view.hasReasoning).toBe(true)
    expect(view.reasoningTemplate).toBe('TEMPLATE')
    // body has the thinking stripped.
    expect(view.html).toContain('the body')
    expect(view.html).not.toContain('secret')
    expect(view.swipeId).toBe(1)
    expect(view.swipeCount).toBe(2)
  })

  it('a floor with no plot / no reasoning yields empty plotHtml + hasReasoning false', () => {
    const floor: FloorLike = {
      floor: 0,
      response: { content: 'plain body' },
      user_message: { content: 'hi' },
      variables: {}
    }
    const view = renderFloorToView(floor, 0, fakeCtx(), 1, null)
    expect(view.plotHtml).toBe('')
    expect(view.thinking).toBe('')
    expect(view.hasReasoning).toBe(false)
    expect(view.reasoningTemplate).toBeNull()
    expect(view.swipeCount).toBe(1)
  })

  it('toRenderedFloorView derives hasReasoning from thinking presence', () => {
    const rendered: RenderedFloor = {
      floor: 0,
      user: 'u',
      rawResponse: 'r',
      html: 'h',
      thinking: '',
      plotBlock: undefined,
      swipeId: 0,
      swipeCount: 1
    }
    const off = toRenderedFloorView(rendered, {
      floorIndex: 0,
      revision: 2,
      reasoningTemplate: null,
      plotHtml: ''
    })
    expect(off.hasReasoning).toBe(false)
    const on = toRenderedFloorView(
      { ...rendered, thinking: 'x' },
      { floorIndex: 0, revision: 2, reasoningTemplate: null, plotHtml: '' }
    )
    expect(on.hasReasoning).toBe(true)
  })
})

// --- render-request answerer feeds [RENDER:*] markers into the ctx (verifier fidelity fix) ----------

describe('initDisplayBroker render answer — [RENDER:*] marker wrapping (native parity)', () => {
  const makeApi = (over: Partial<Record<string, any>> = {}) => {
    let requestCb: ((req: any) => void) | null = null
    const responses: Array<{ reqId: number; views: any[] }> = []
    const api: any = {
      onDisplayRenderRequest: (cb: (req: any) => void) => {
        requestCb = cb
        return () => {}
      },
      onDisplayStreamEnabledChats: () => () => {},
      sendDisplayRenderResponse: (msg: { reqId: number; views: any[] }) => responses.push(msg),
      sendDisplayRevisionChanged: () => {},
      getFloors: async () => [],
      getRenderMarkers: async () => ({ before: ['[[MARK]]'], after: [] }),
      ...over
    }
    ;(globalThis as any).window = { api }
    return { get requestCb() { return requestCb }, responses, api }
  }

  it("wraps a floor's html with the fetched render markers (would be omitted with default empty markers)", async () => {
    const harness = makeApi()
    // Active chat so resolveFloors reads chatStore floors directly.
    useChatStore.setState({
      activeChatId: 'c',
      floors: [
        {
          floor: 0,
          chat_id: 'c',
          response: { content: 'the body' },
          user_message: { content: 'u' },
          variables: {},
          swipe_id: 0
        } as any
      ]
    })
    const dispose = initDisplayBroker()
    harness.requestCb!({ reqId: 1, profileId: 'p', chatId: 'c', from: 0, to: 0 })
    await vi.waitFor(() => expect(harness.responses).toHaveLength(1))
    dispose()

    const view = harness.responses[0].views[0]
    // The marker template (rendered identity by the mocked engine) precedes the body — proving the
    // fetched markers reached currentDisplayCtx (the defect: default empty markers dropped this).
    expect(view.html).toContain('[[MARK]]')
    expect(view.html).toContain('the body')
  })

  it('omits marker wrapping when getRenderMarkers yields none', async () => {
    const harness = makeApi({ getRenderMarkers: async () => ({ before: [], after: [] }) })
    useChatStore.setState({
      activeChatId: 'c2',
      floors: [
        {
          floor: 0,
          chat_id: 'c2',
          response: { content: 'plain' },
          user_message: { content: 'u' },
          variables: {},
          swipe_id: 0
        } as any
      ]
    })
    const dispose = initDisplayBroker()
    harness.requestCb!({ reqId: 2, profileId: 'p', chatId: 'c2', from: 0, to: 0 })
    await vi.waitFor(() => expect(harness.responses).toHaveLength(1))
    dispose()

    expect(harness.responses[0].views[0].html).not.toContain('[[MARK]]')
    expect(harness.responses[0].views[0].html).toContain('plain')
  })
})
