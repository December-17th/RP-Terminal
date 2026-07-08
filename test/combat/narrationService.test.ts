import { describe, it, expect, vi, beforeEach } from 'vitest'

// writeNarrationToChat writes through chatService/floorService (storage) — mock those so the test
// stays pure. foldNarrationMvu (below) needs neither.
const appendFloor = vi.fn()
vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'c', character_id: 'ch', floor_count: 1 }),
  appendFloor: (...a: any[]) => appendFloor(...a)
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => [{ floor: 0, variables: { stat_data: { 主角: { hp: 3 } } } }],
  saveFloor: vi.fn()
}))

import {
  foldNarrationMvu,
  writeNarrationToChat,
  combatLogText
} from '../../src/main/services/narrationService'

describe('foldNarrationMvu', () => {
  it('applies a <JSONPatch> insert into stat_data', () => {
    const vars: Record<string, any> = {}
    foldNarrationMvu(
      vars,
      '战后。<UpdateVariable><JSONPatch>[{"op":"insert","path":"/主角/技能/剑气斩","value":{"类型":"主动"}}]</JSONPatch></UpdateVariable>'
    )
    expect(vars.stat_data.主角.技能.剑气斩).toEqual({ 类型: '主动' })
  })
  it('is a no-op when there is no UpdateVariable block', () => {
    const vars: Record<string, any> = { stat_data: { 主角: {} } }
    foldNarrationMvu(vars, 'just prose, no ops')
    expect(vars.stat_data).toEqual({ 主角: {} })
  })
})

describe('combatLogText', () => {
  it('flattens an event log to plain lines, dropping empties', () => {
    expect(
      combatLogText([{ text: '格罗夫 突刺！' }, { text: '' }, { text: '梅芙 格挡。' }, {}])
    ).toBe('格罗夫 突刺！\n梅芙 格挡。')
  })
  it('tolerates an undefined log', () => {
    expect(combatLogText(undefined)).toBe('')
  })
})

describe('writeNarrationToChat (combat narration → its own floor)', () => {
  beforeEach(() => {
    appendFloor.mockClear()
  })

  it('lands as a NEW floor whose user input is the log and response is the prose', () => {
    writeNarrationToChat('p', 'c', 'The dust settles.', '格罗夫 突刺\n梅芙 反击')
    expect(appendFloor).toHaveBeenCalledTimes(1)
    const [, , floor] = appendFloor.mock.calls[0]
    expect(floor.user_message.content).toBe('格罗夫 突刺\n梅芙 反击') // the fight log = the input
    expect(floor.response.content).toBe('The dust settles.')
    expect(floor.floor).toBe(1) // appended after the single existing floor
  })

  it("folds the narration's <UpdateVariable> into the new floor's stat_data (cloned from latest)", () => {
    writeNarrationToChat(
      'p',
      'c',
      'Grov falls.<UpdateVariable><JSONPatch>[{"op":"replace","path":"/主角/hp","value":1}]</JSONPatch></UpdateVariable>',
      'log'
    )
    const [, , floor] = appendFloor.mock.calls[0]
    expect(floor.variables.stat_data.主角.hp).toBe(1)
  })

  it('does nothing when the prose is empty', () => {
    writeNarrationToChat('p', 'c', '', 'log')
    expect(appendFloor).not.toHaveBeenCalled()
  })
})
