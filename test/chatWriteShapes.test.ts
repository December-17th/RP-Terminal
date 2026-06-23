import { describe, it, expect } from 'vitest'
import { chatIndexMap } from '../src/shared/thRuntime/shapes'
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

  it('diverges from floorsToThMessages ids when floor 0 has no user (the documented mismatch)', () => {
    // getChatMessages would call floor0 assistant message_id 1 (2*0+1); the compact map puts it at index 0.
    const map = chatIndexMap([floor('', 'greeting')])
    expect(map[0]).toEqual({ floorIdx: 0, isUser: false }) // index 0, not 1
  })
})
