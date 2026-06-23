// test/thRuntimeShapes.test.ts
import { describe, it, expect } from 'vitest'
import {
  floorsToThMessages,
  currentMessageId,
  floorsToStChat
} from '../src/shared/thRuntime/shapes'

const floors = [
  { floor: 0, user_message: { content: 'hi' }, response: { content: 'hello' } },
  { floor: 1, user_message: { content: 'bye' }, response: { content: 'cya' }, swipes: ['cya', 'later'], swipe_id: 1 }
]

describe('floorsToThMessages', () => {
  it('flattens floors to sequential ids (user 2i, assistant 2i+1)', () => {
    expect(floorsToThMessages(floors)).toEqual([
      { message_id: 0, role: 'user', message: 'hi' },
      { message_id: 1, role: 'assistant', message: 'hello' },
      { message_id: 2, role: 'user', message: 'bye' },
      { message_id: 3, role: 'assistant', message: 'cya' }
    ])
  })
  it('handles missing content as empty strings', () => {
    expect(floorsToThMessages([{}])).toEqual([
      { message_id: 0, role: 'user', message: '' },
      { message_id: 1, role: 'assistant', message: '' }
    ])
  })
})

describe('currentMessageId', () => {
  it('is the last flat index', () => {
    expect(currentMessageId(floors)).toBe(3)
  })
  it('is 0 for no floors', () => {
    expect(currentMessageId([])).toBe(0)
  })
})

describe('floorsToStChat', () => {
  it('emits user+assistant ST messages with names and swipes', () => {
    const chat = floorsToStChat(floors, { charName: 'Ellia', userName: 'Player' })
    expect(chat).toHaveLength(4)
    expect(chat[0]).toMatchObject({ is_user: true, name: 'Player', mes: 'hi', swipes: [], swipe_id: 0 })
    expect(chat[3]).toMatchObject({ is_user: false, name: 'Ellia', mes: 'cya', swipes: ['cya', 'later'], swipe_id: 1 })
  })
  it('defaults assistant swipes to [response content] when none', () => {
    const chat = floorsToStChat([{ response: { content: 'x' } }], { charName: 'C', userName: 'U' })
    expect(chat[1].swipes).toEqual(['x'])
  })
})
