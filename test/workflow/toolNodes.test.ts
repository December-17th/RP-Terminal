import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tool/action nodes (spec §17.7): start combat/duel from a workflow branch (switching the chat
// mode so the renderer follows) and query-driven lorebook search.

const svc = vi.hoisted(() => ({
  startFromCard: vi.fn(),
  startDuelFromCue: vi.fn(),
  setChatMode: vi.fn(),
  notifyChatModeChanged: vi.fn(),
  matchAcross: vi.fn()
}))
vi.mock('../../src/main/services/combatService', () => ({ startFromCard: svc.startFromCard }))
vi.mock('../../src/main/services/duelService', () => ({ startDuelFromCue: svc.startDuelFromCue }))
vi.mock('../../src/main/services/chatService', () => ({ setChatMode: svc.setChatMode }))
vi.mock('../../src/main/services/chatEvents', () => ({
  notifyChatModeChanged: svc.notifyChatModeChanged
}))
vi.mock('../../src/main/services/lorebookService', () => ({ matchAcross: svc.matchAcross }))

import {
  toolStartCombat,
  toolStartDuel,
  toolLorebookSearch
} from '../../src/main/services/nodes/builtin/toolNodes'
import { NodeRunFailure, RunContext } from '../../src/main/services/nodes/types'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}
const gen = { profileId: 'p1', chatId: 'c1', lorebooks: [{ entries: [] }], maxRecursion: 0 }

beforeEach(() => {
  svc.startFromCard.mockReset()
  svc.startDuelFromCue.mockReset()
  svc.setChatMode.mockReset()
  svc.notifyChatModeChanged.mockReset()
  svc.matchAcross.mockReset()
})

describe('tool.startCombat', () => {
  it('starts the encounter with the wired cue and switches the chat to combat mode', async () => {
    const state = { turn: 1 }
    svc.startFromCard.mockReturnValue(state)
    const cue = { enemies: '2 wolves' }
    const r = await toolStartCombat.run(ctx, { gen, cue })
    expect(svc.startFromCard).toHaveBeenCalledWith('p1', 'c1', cue)
    expect(svc.setChatMode).toHaveBeenCalledWith('p1', 'c1', 'combat')
    expect(r).toEqual({ outputs: { state } })
  })

  it('a service throw (no combat bundle) propagates — the error port carries it', () => {
    svc.startFromCard.mockImplementation(() => {
      throw new Error('world has no combat bundle')
    })
    expect(() => toolStartCombat.run(ctx, { gen })).toThrow('no combat bundle')
    expect(svc.setChatMode).not.toHaveBeenCalled()
  })
})

describe('tool.startDuel', () => {
  it('starts the duel and broadcasts the (renderer-transient) duel mode', async () => {
    const view = { phase: 'lead' }
    svc.startDuelFromCue.mockReturnValue(view)
    const r = await toolStartDuel.run(ctx, { gen, cue: { roster: [] } })
    expect(svc.notifyChatModeChanged).toHaveBeenCalledWith('c1', 'duel')
    expect(svc.setChatMode).not.toHaveBeenCalled() // duel mode is never persisted (no 'duel' ChatMode)
    expect(r).toEqual({ outputs: { state: view } })
  })

  it('an unbuildable duel is a class-B failure (no mode switch)', () => {
    svc.startDuelFromCue.mockReturnValue(null)
    let err: unknown
    try {
      toolStartDuel.run(ctx, { gen })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).kind).toBe('B')
    expect(svc.notifyChatModeChanged).not.toHaveBeenCalled()
  })
})

describe('tool.lorebookSearch', () => {
  it('matches the query across the session lorebooks and joins entry contents', async () => {
    svc.matchAcross.mockReturnValue([
      { content: 'The Iron Keep guards the pass.' },
      { content: 'Wolves haunt the pass at night.' }
    ])
    const r = await toolLorebookSearch.run(ctx, { gen, query: 'the pass' }, {
      id: 'n1',
      config: {}
    })
    expect(svc.matchAcross).toHaveBeenCalled()
    expect((r.outputs as { block: string }).block).toBe(
      'The Iron Keep guards the pass.\n\nWolves haunt the pass at night.'
    )
  })

  it('caps results at max_entries and returns empty for a blank query', async () => {
    svc.matchAcross.mockReturnValue([{ content: 'a' }, { content: 'b' }, { content: 'c' }])
    const capped = await toolLorebookSearch.run(ctx, { gen, query: 'x' }, {
      id: 'n1',
      config: { max_entries: 2 }
    })
    expect((capped.outputs as { block: string }).block).toBe('a\n\nb')

    const blank = await toolLorebookSearch.run(ctx, { gen, query: '   ' }, {
      id: 'n1',
      config: {}
    })
    expect((blank.outputs as { block: string }).block).toBe('')
    expect(svc.matchAcross).toHaveBeenCalledTimes(1)
  })
})
