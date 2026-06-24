// test/thRuntimeShapes.test.ts
import { describe, it, expect } from 'vitest'
import {
  floorsToThMessages,
  currentMessageId,
  floorsToStChat,
  lastMessageIndex,
  lastUserMessageIndex,
  lastCharMessageIndex
} from '../src/shared/thRuntime/shapes'

const floors = [
  { floor: 0, user_message: { content: 'hi' }, response: { content: 'hello' } },
  {
    floor: 1,
    user_message: { content: 'bye' },
    response: { content: 'cya' },
    swipes: ['cya', 'later'],
    swipe_id: 1
  }
]

describe('floorsToThMessages', () => {
  it('flattens floors to compact sequential ids (= the chat-array index)', () => {
    expect(floorsToThMessages(floors)).toEqual([
      { message_id: 0, role: 'user', message: 'hi' },
      { message_id: 1, role: 'assistant', message: 'hello' },
      { message_id: 2, role: 'user', message: 'bye' },
      { message_id: 3, role: 'assistant', message: 'cya' }
    ])
  })
  it('skips an empty user slot (compact) — a contentless floor yields only the assistant message', () => {
    expect(floorsToThMessages([{}])).toEqual([{ message_id: 0, role: 'assistant', message: '' }])
  })
})

describe('currentMessageId', () => {
  it('is the last chat-array index', () => {
    expect(currentMessageId(floors)).toBe(3)
  })
  it('is the compact last index (a greeting-only chat → 0, not 1)', () => {
    expect(currentMessageId([{ response: { content: 'greet' } }])).toBe(0)
  })
  it('is 0 for no floors', () => {
    expect(currentMessageId([])).toBe(0)
  })
})

describe('lastMessageIndex (SillyTavern lastMessageId)', () => {
  const greeting = [{ response: { content: 'greet' } }]
  it('opening turn (greeting + pending user action) → 1, the "is this the opening?" value', () => {
    expect(lastMessageIndex(greeting, true)).toBe(1)
  })
  it('later turn with a pending user action → index of that new user message', () => {
    expect(lastMessageIndex(floors, true)).toBe(4) // [u,a,u,a] + pending user
  })
  it('no pending user action (regenerate/continue) → the latest assistant index', () => {
    expect(lastMessageIndex(floors, false)).toBe(3)
    expect(lastMessageIndex(floors, false)).toBe(currentMessageId(floors))
  })
  it('empty chat → 0', () => {
    expect(lastMessageIndex([], true)).toBe(0)
  })
})

describe('lastUserMessageIndex / lastCharMessageIndex', () => {
  it('pending user action is the last user message', () => {
    expect(lastUserMessageIndex([{ response: { content: 'g' } }], true)).toBe(1)
  })
  it('without a pending action, finds the last user/assistant slots', () => {
    expect(lastUserMessageIndex(floors, false)).toBe(2)
    expect(lastCharMessageIndex(floors)).toBe(3)
  })
  it('greeting-only chat → last assistant is index 0, no user message', () => {
    expect(lastCharMessageIndex([{ response: { content: 'g' } }])).toBe(0)
    expect(lastUserMessageIndex([{ response: { content: 'g' } }], false)).toBe(-1)
  })
})

describe('floorsToStChat', () => {
  it('emits user+assistant ST messages with names and swipes', () => {
    const chat = floorsToStChat(floors, { charName: 'Ellia', userName: 'Player' })
    expect(chat).toHaveLength(4)
    expect(chat[0]).toMatchObject({
      is_user: true,
      name: 'Player',
      mes: 'hi',
      swipes: ['hi'],
      swipe_id: 0
    })
    expect(chat[3]).toMatchObject({
      is_user: false,
      name: 'Ellia',
      mes: 'cya',
      swipes: ['cya', 'later'],
      swipe_id: 1
    })
  })
  it('defaults assistant swipes to [response content] when none', () => {
    const chat = floorsToStChat([{ response: { content: 'x' } }], { charName: 'C', userName: 'U' })
    expect(chat[0].swipes).toEqual(['x'])
  })

  it('skips user message when content is absent (greeting floor produces only assistant msg)', () => {
    const chat = floorsToStChat([{ response: { content: 'greet' } }], {
      charName: 'C',
      userName: 'U'
    })
    expect(chat).toHaveLength(1)
    expect(chat[0].is_user).toBe(false)
    expect(chat[0].mes).toBe('greet')
  })

  it('uses greetings as floor-0 assistant swipes when provided', () => {
    const chat = floorsToStChat([{ response: { content: 'greet' }, swipes: ['x'] }], {
      charName: 'C',
      userName: 'U',
      greetings: ['g1', 'g2']
    })
    expect(chat[0].swipes).toEqual(['g1', 'g2'])
  })

  it('uses floor own swipes (not greetings) for non-zero floors', () => {
    const twoFloors = [
      { response: { content: 'greet' } },
      {
        user_message: { content: 'hello' },
        response: { content: 'reply' },
        swipes: ['reply', 'alt'],
        swipe_id: 0
      }
    ]
    const chat = floorsToStChat(twoFloors, {
      charName: 'C',
      userName: 'U',
      greetings: ['g1', 'g2']
    })
    // floor 0: only assistant (no user msg), swipes = greetings
    expect(chat[0].is_user).toBe(false)
    expect(chat[0].swipes).toEqual(['g1', 'g2'])
    // floor 1: user then assistant; assistant swipes = floor's own
    expect(chat[1].is_user).toBe(true)
    expect(chat[1].mes).toBe('hello')
    expect(chat[2].is_user).toBe(false)
    expect(chat[2].swipes).toEqual(['reply', 'alt'])
  })

  it('user message with content appears with swipes: [content]', () => {
    const chat = floorsToStChat(
      [{ user_message: { content: 'hey' }, response: { content: 'yo' } }],
      { charName: 'C', userName: 'U' }
    )
    expect(chat[0].is_user).toBe(true)
    expect(chat[0].swipes).toEqual(['hey'])
  })
})
