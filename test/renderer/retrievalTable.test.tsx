// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react'
import type { RetrievalPreviewResponse } from '../../src/shared/retrievalTrace'

/**
 * The unified retrieval comparison table (Debug window). Renders RetrievalPanel against a stubbed
 * window.api that returns a crafted ok result and asserts the join/tint logic: an added row (scorer
 * fires, keyword retrieval missed), a dropped row (keyword fires, scorer ranks out), a pins-delta cell,
 * the constants strip, and the inert toggle.
 */

const traceRow = (
  comment: string,
  entryIndex: number,
  fired: boolean,
  matchedKey?: string,
  reason: 'key' | 'constant' | 'none' = 'key'
): unknown => ({
  bookName: 'W',
  entryIndex,
  comment,
  fired,
  reason: fired ? reason : 'none',
  recursionPass: 0,
  probability: 100,
  ...(matchedKey ? { matchedKey } : {})
})

const scoredRow = (comment: string, entryIndex: number, o: Record<string, unknown>): unknown => ({
  bookName: 'W',
  entryIndex,
  comment,
  constant: false,
  fired: false,
  score: 0,
  seedScore: 0,
  linkBonus: 0,
  probabilityFactor: 1,
  keyHits: [],
  ...o
})

const okResult: RetrievalPreviewResponse = {
  ok: true,
  baseScanText: 'scan text',
  pinBlock: '\n[PINS]\nb',
  scanDepth: 3,
  maxRecursion: 0,
  pinPaths: [],
  extraPinPaths: [],
  resolvedPins: [],
  lorebookNames: ['W'],
  scoringParams: { lambda: 0.6, hopDecay: 0.5, pinBoost: 2.5, topK: 8 },
  baseline: [
    traceRow('A', 0, true, 'a'),
    traceRow('B', 1, false),
    traceRow('C', 2, true, undefined, 'constant'),
    traceRow('D', 3, false),
    traceRow('E', 4, false)
  ],
  rpt: [
    traceRow('A', 0, true, 'a'),
    traceRow('B', 1, true, 'b'), // fires only with pins → pins-delta + dropped (scorer ranks it out)
    traceRow('C', 2, true, undefined, 'constant'),
    traceRow('D', 3, false),
    traceRow('E', 4, false)
  ],
  scored: [
    scoredRow('C', 2, { constant: true, fired: true, score: 0 }),
    scoredRow('A', 0, {
      fired: true,
      score: 5,
      keyHits: [{ key: 'a', depth: 0, pin: false, idf: 2, weight: 1 }]
    }),
    scoredRow('E', 4, {
      fired: true,
      score: 3,
      keyHits: [{ key: 'e', depth: 1, pin: false, idf: 1.5, weight: 0.6 }]
    }), // scorer-only fire → added
    scoredRow('B', 1, { fired: false, score: 0 }),
    scoredRow('D', 3, { fired: false, score: 0 }) // fires nowhere, score 0 → inert
  ]
} as unknown as RetrievalPreviewResponse

const apiStub = {
  getProfiles: async () => [{ id: 'p', name: 'P' }],
  getChats: async () => [{ id: 'c', character_id: 'x', updated_at: '', floor_count: 1 }],
  getCharacters: async () => [],
  retrievalPreview: async () => okResult
}

afterEach(() => cleanup())

describe('RetrievalPanel unified comparison table', () => {
  it('renders the table with added/dropped tints, pins delta, constants strip, and inert toggle', async () => {
    ;(window as unknown as { api: unknown }).api = apiStub
    const { RetrievalPanel } = await import(
      '../../src/renderer/src/components/debug/RetrievalPanel'
    )
    const view = render(<RetrievalPanel />)

    // Wait for the profiles/chats effects to resolve (Run enables once a chat is selected), then run.
    const runBtn = (await view.findByText('Run dry-run')) as HTMLButtonElement
    await waitFor(() => expect(runBtn.disabled).toBe(false))
    fireEvent.click(runBtn)

    // Table header + a scored row appear once the result resolves.
    expect(await view.findByText('ST keyword')).toBeTruthy()
    expect(view.getByText('+Pins')).toBeTruthy()

    const container = view.container
    expect(container.querySelector('.rt-row-added')).toBeTruthy() // E: scorer adds
    expect(container.querySelector('.rt-row-dropped')).toBeTruthy() // B: scorer drops
    expect(container.querySelector('.rt-cell-delta')).toBeTruthy() // B fires only with pins

    // Constants live in the strip; the inert D row is hidden behind the toggle.
    expect(view.getByText('1 constant entries — always fire')).toBeTruthy()
    expect(view.getByText('show 1 inert entries')).toBeTruthy()

    // Summary counts: keyword=2 (A,C) · +pins=3 (A,B,C) · scorer=2 (A,E) · drops=1 (B) · adds=1 (E).
    expect(
      view.getByText(
        'keyword fires 2 · +pins fires 3 · scorer fires 2 · scorer drops 1 · scorer adds 1'
      )
    ).toBeTruthy()
  })
})
