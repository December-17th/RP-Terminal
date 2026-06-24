import { describe, it, expect } from 'vitest'
import { chatIndexMap, floorsToThMessages } from '../src/shared/thRuntime/shapes'
import type { FloorLike } from '../src/shared/thRuntime/types'

const floor = (user: string, resp: string): FloorLike => ({
  user_message: { content: user },
  response: { content: resp }
})

describe('chatIndexMap', () => {
  it('maps a floor with user content to user then assistant', () => {
    expect(chatIndexMap([floor('hi', 'hello')])).toEqual([
      { floorIdx: 0, isUser: true },
      { floorIdx: 0, isUser: false }
    ])
  })

  it('skips the user slot when the user message is empty (compact, ST chat[] convention)', () => {
    // floor 0 is the greeting (empty user) → only the assistant slot at index 0.
    expect(chatIndexMap([floor('', 'greeting')])).toEqual([{ floorIdx: 0, isUser: false }])
  })

  it('compacts across a greeting floor + a normal turn', () => {
    // floor0 greeting (no user) + floor1 (user+resp): index 0 = floor0 assistant, 1 = floor1 user, 2 = floor1 assistant.
    expect(chatIndexMap([floor('', 'greeting'), floor('hi', 'hello')])).toEqual([
      { floorIdx: 0, isUser: false },
      { floorIdx: 1, isUser: true },
      { floorIdx: 1, isUser: false }
    ])
  })

  it('returns an empty map for no floors', () => {
    expect(chatIndexMap([])).toEqual([])
  })

  it('shares ONE index space with floorsToThMessages (reconciled: index i ↔ message_id i)', () => {
    // After reconciliation, getChatMessages and set/delete use the same compact ids — floor0's greeting
    // assistant is message_id 0 in BOTH (previously getChatMessages called it 1).
    const fl = [floor('', 'greeting'), floor('hi', 'hello')]
    const map = chatIndexMap(fl)
    const msgs = floorsToThMessages(fl)
    expect(msgs).toHaveLength(map.length)
    msgs.forEach((m, i) => {
      expect(m.message_id).toBe(i)
      expect(m.role).toBe(map[i].isUser ? 'user' : 'assistant')
    })
  })
})
