import { describe, it, expect, vi, beforeEach } from 'vitest'

// Factory mocks so vitest never loads the real services (which pull native/db deps).
vi.mock('../src/main/services/floorService', () => ({
  getAllFloors: vi.fn(),
  saveFloor: vi.fn()
}))
vi.mock('../src/main/services/chatService', () => ({
  truncateFloors: vi.fn()
}))
vi.mock('../src/main/services/generationService', () => ({
  reevaluateVariables: vi.fn()
}))

import * as floorService from '../src/main/services/floorService'
import * as chatService from '../src/main/services/chatService'
import * as generationService from '../src/main/services/generationService'
import {
  setChatMessages,
  deleteChatMessages,
  saveChat,
  afterChatMutation
} from '../src/main/services/chatWriteService'

const mkFloor = (floor: number, user: string, resp: string): any => ({
  floor,
  user_message: { content: user },
  response: { content: resp },
  swipes: [resp],
  swipe_id: 0,
  variables: { stat_data: {} }
})

beforeEach(() => vi.clearAllMocks())

describe('setChatMessages', () => {
  it('edits the mapped floor + role and counts touched floors', () => {
    // compact map over [greeting(no user), turn]: 0={0,asst} 1={1,user} 2={1,asst}
    const floors = [mkFloor(0, '', 'greeting'), mkFloor(1, 'hi', 'hello')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    expect(setChatMessages('p', 'c', [{ message_id: 2, message: 'EDITED' }])).toBe(1)
    expect(floors[1].response.content).toBe('EDITED')
    expect(floorService.saveFloor).toHaveBeenCalledWith('p', 'c', floors[1])
  })

  it('edits the user slot for a user-mapped index', () => {
    const floors = [mkFloor(0, '', 'g'), mkFloor(1, 'hi', 'hello')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    setChatMessages('p', 'c', [{ message_id: 1, message: 'newUser' }])
    expect(floors[1].user_message.content).toBe('newUser')
  })

  it('skips out-of-range ids and non-string messages', () => {
    const floors = [mkFloor(0, '', 'g')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    expect(
      setChatMessages('p', 'c', [
        { message_id: 99, message: 'x' },
        { message_id: 0, message: 5 }
      ])
    ).toBe(0)
    expect(floorService.saveFloor).not.toHaveBeenCalled()
  })

  it('does NOT write the opening greeting onto a later floor response (stale card guard)', () => {
    // map: 0={0,asst} 1={1,user} 2={1,asst}. floor 0 = 'HOME'. A card echoing 'HOME' at id 2 must
    // not clobber floor 1's real reply. Writing 'HOME' back to id 0 (floor 0) is still allowed.
    const floors = [mkFloor(0, '', 'HOME'), mkFloor(1, 'u', 'realReply')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    expect(setChatMessages('p', 'c', [{ message_id: 2, message: 'HOME' }])).toBe(0)
    expect(floors[1].response.content).toBe('realReply')
    expect(floorService.saveFloor).not.toHaveBeenCalled()
  })

  it('skips a message whose text is unchanged', () => {
    // A card re-rendering the same text must not count as an edit (no re-fold/reload chain).
    const floors = [mkFloor(0, '', 'greeting')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    expect(setChatMessages('p', 'c', [{ message_id: 0, message: 'greeting' }])).toBe(0)
    expect(floorService.saveFloor).not.toHaveBeenCalled()
  })

  it('counts only floors that actually changed', () => {
    // map: 0={0,asst} 1={1,user} 2={1,asst}. Edit id 0 with identical text + id 2 with new text.
    const floors = [mkFloor(0, '', 'greeting'), mkFloor(1, 'hi', 'hello')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    expect(
      setChatMessages('p', 'c', [
        { message_id: 0, message: 'greeting' }, // unchanged
        { message_id: 2, message: 'EDITED' } // changed
      ])
    ).toBe(1)
    expect(floors[1].response.content).toBe('EDITED')
    expect(floorService.saveFloor).toHaveBeenCalledTimes(1)
    expect(floorService.saveFloor).toHaveBeenCalledWith('p', 'c', floors[1])
  })
})

describe('deleteChatMessages', () => {
  it('truncates from the earliest targeted floor', () => {
    const floors = [mkFloor(0, '', 'g'), mkFloor(1, 'a', 'b'), mkFloor(2, 'c', 'd')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    // map: 0={0,asst} 1={1,user} 2={1,asst} 3={2,user} 4={2,asst} → ids 3,4 → earliest floor 2
    expect(deleteChatMessages('p', 'c', [4, 3])).toBe(true)
    expect(chatService.truncateFloors).toHaveBeenCalledWith('p', 'c', 2)
  })

  it('returns false (no truncate) when no valid ids', () => {
    vi.mocked(floorService.getAllFloors).mockReturnValue([mkFloor(0, '', 'g')])
    expect(deleteChatMessages('p', 'c', [])).toBe(false)
    expect(chatService.truncateFloors).not.toHaveBeenCalled()
  })
})

describe('saveChat', () => {
  it('maps assistant messages to floors (content + swipes + swipe_id), leaves user', () => {
    const floors = [mkFloor(0, '', 'g'), mkFloor(1, 'u', 'old')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    const chat = [
      { is_user: false, mes: 'newGreeting', swipes: ['newGreeting', 'alt'], swipe_id: 1 },
      { is_user: true, mes: 'u' },
      { is_user: false, mes: 'newResp' }
    ]
    expect(saveChat('p', 'c', chat)).toBe(true)
    expect(floors[0].response.content).toBe('newGreeting')
    expect(floors[0].swipes).toEqual(['newGreeting', 'alt'])
    expect(floors[0].swipe_id).toBe(1)
    expect(floors[1].response.content).toBe('newResp')
    expect(floors[1].user_message.content).toBe('u') // user untouched
  })

  it('returns false on a non-array chat', () => {
    expect(saveChat('p', 'c', null)).toBe(false)
  })

  it('does NOT propagate the opening greeting onto a later floor (stale chat guard)', () => {
    // Owner bug: after a custom-start, a stale SillyTavern.chat held the home placeholder in the
    // assistant[1] slot; saving it clobbered floor 1's real response. floor 0 = 'HOME'.
    const floors = [mkFloor(0, '', 'HOME'), mkFloor(1, '', 'realReply')]
    vi.mocked(floorService.getAllFloors).mockReturnValue(floors)
    saveChat('p', 'c', [
      { is_user: false, mes: 'HOME' }, // floor 0 (greeting) — unchanged
      { is_user: false, mes: 'HOME' } // floor 1 — MUST NOT overwrite the real reply
    ])
    expect(floors[1].response.content).toBe('realReply')
    expect(floorService.saveFloor).not.toHaveBeenCalledWith('p', 'c', floors[1])
  })
})

describe('afterChatMutation', () => {
  it('reevaluates and returns the latest rebuilt floor', () => {
    const rebuilt = [mkFloor(0, '', 'g'), mkFloor(1, 'a', 'b')]
    vi.mocked(generationService.reevaluateVariables).mockReturnValue(rebuilt)
    expect(afterChatMutation('p', 'c')).toBe(rebuilt[1])
  })

  it('returns null when there are no floors', () => {
    vi.mocked(generationService.reevaluateVariables).mockReturnValue([])
    expect(afterChatMutation('p', 'c')).toBe(null)
  })
})
