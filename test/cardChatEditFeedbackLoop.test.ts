import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression: 命定之诗 start-button loop, owner manual pass 2026-07-04
// — see .scratch/manual-pass-2026-07-04/issues/01-card-setchatmessages-feedback-loop.md
// card vars-update handler → write-back (adaptive_regex_last_message_id + date) → setChatMessages
// (content UNCHANGED) → afterChatMutation → reevaluateVariables (wipes the card's floor-0 writes)
// → notifyVarsChanged(..., undefined, 'external') → card handler re-fires → forever.
// The varsWrite runaway guard never trips because the two write signatures alternate.

// In-memory floor store so the REAL reevaluateVariables / applyVariableOps / setChatMessages run.
const floors: any[] = []
vi.mock('../src/main/services/floorService', () => ({
  getAllFloors: vi.fn(() => floors),
  getFloor: vi.fn((_p: string, _c: string, n: number) => floors.find((f) => f.floor === n)),
  saveFloor: vi.fn()
}))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import * as chatWriteService from '../src/main/services/chatWriteService'
import { applyVariableOps, resetWriteLoopGuard } from '../src/main/services/generationService'

const GREETING = '<StatusPlaceHolderImpl/> 序章文本'

beforeEach(() => {
  floors.length = 0
  floors.push({
    floor: 0,
    user_message: { content: '' },
    response: { content: GREETING }, // no <UpdateVariable> block — replay rebuilds {} like the real card
    swipes: [GREETING],
    swipe_id: 0,
    variables: { stat_data: {} }
  })
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
      const n = chatWriteService.setChatMessages('p', 'c', [
        { message_id: 0, message: GREETING }
      ])
      // wcvIpc.ts:551-558 + :56-59 glue, mirrored 1:1: n>0 → re-fold → broadcast 'external'
      if (n > 0) {
        chatWriteService.afterChatMutation('p', 'c') // reevaluateVariables — wipes the writes above
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
  })
})
