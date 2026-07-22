import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression: 命定之诗 start-button loop, owner manual pass 2026-07-04
// — see .scratch/manual-pass-2026-07-04/issues/01-card-setchatmessages-feedback-loop.md
// card vars-update handler → write-back (adaptive_regex_last_message_id + date) → setChatMessages
// (content UNCHANGED) → afterChatMutation → re-fold (wipes the card's floor-0 writes)
// → notifyVarsChanged(..., undefined, 'external') → card handler re-fires → forever.
// The varsWrite runaway guard never trips because the two write signatures alternate.
//
// Runs on a REAL per-chat session database (`test/mocks/betterSqlite3Node` over `node:sqlite` + the
// real SESSION_SCHEMA, injected by overriding `getSessionDbByChat`) so the card writes are actually
// journaled and persisted — the in-memory floorService mock this used to carry made
// `floorStateForChat` null, which no longer corresponds to any reachable production state.

let sessionDb: InstanceType<typeof Adapter> | null = null

vi.mock('../src/main/services/sessionDbService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/sessionDbService')>()
  return { ...actual, getSessionDbByChat: () => sessionDb }
})
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import Adapter from './mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../src/main/services/sessionDbService'
import { getAllFloors } from '../src/main/services/floorService'
import * as chatWriteService from '../src/main/services/chatWriteService'
import { applyVariableOps, resetWriteLoopGuard } from '../src/main/services/generationService'

const GREETING = '<StatusPlaceHolderImpl/> 序章文本'

beforeEach(() => {
  sessionDb = new Adapter(':memory:')
  sessionDb.exec(SESSION_SCHEMA)
  // no <UpdateVariable> block — a re-fold rebuilds from the baseline, like the real card
  sessionDb
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES ('c', 0, '2026-07-22T00:00:00.000Z', '', ?, '[]', '{"stat_data":{}}')`
    )
    .run(GREETING)
  resetWriteLoopGuard('c')
})

describe('card-initiated setChatMessages feedback loop (manual-test finding #1)', () => {
  it('a setChatMessages that changes nothing reports 0 touched floors', () => {
    const n = chatWriteService.setChatMessages('p', 'c', [{ message_id: 0, message: GREETING }])
    expect(n).toBe(0)
  })

  it('the vars-update → write-back → setChatMessages cycle settles instead of spinning', () => {
    // The card automaton, as observed in the log: on every vars-update event it (re)writes its
    // bookkeeping vars and re-renders message 0 via setChatMessages with the SAME text.
    const cardHandler = (origin: string): void => {
      if (origin === 'card-write') return // the WS-3 runtime guard (thRuntime/index.ts:81)
      cycles++
      applyVariableOps('p', 'c', 0, [
        { op: 'add', path: '/adaptive_regex_last_message_id', value: 0 } as any
      ])
      applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/date', value: '一月一日' } as any])
      const n = chatWriteService.setChatMessages('p', 'c', [{ message_id: 0, message: GREETING }])
      // wcvIpc.ts:551-558 + :56-59 glue, mirrored 1:1: n>0 → re-fold → broadcast 'external'
      if (n > 0) {
        chatWriteService.afterChatMutation('p', 'c')
        notify('external')
      }
    }
    let cycles = 0
    const notify = (origin: string): void => {
      if (cycles > 25) return // cap so a red run terminates
      cardHandler(origin)
    }

    // Kick: the start button's first write echoes back as 'external' via the re-fold path.
    notify('external')

    // One re-render is fine; a bounded settle (<=2) is fine; 25+ is the reported infinite loop.
    expect(cycles).toBeLessThanOrEqual(2)
    // …and the card's own bookkeeping writes survived (they are journaled floor operations now).
    expect((getAllFloors('p', 'c')[0].variables as any).stat_data).toEqual({
      adaptive_regex_last_message_id: 0,
      date: '一月一日'
    })
  })
})
