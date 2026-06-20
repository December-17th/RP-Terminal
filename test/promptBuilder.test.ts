import { describe, it, expect } from 'vitest'
import { buildPrompt, estimateTokens, fitToBudget, ChatMessage } from '../src/main/services/promptBuilder'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'

// --- tiny factories -------------------------------------------------------
const card = (data: any = {}): any => RPTerminalCardSchema.parse({ data: { name: 'Aria', ...data } })
const book = (entries: any[]): any => LorebookSchema.parse({ name: 'B', entries })
const blk = (marker: string, content = '', role = 'system'): any => ({
  identifier: marker || 'lit',
  name: marker || 'lit',
  role,
  content,
  enabled: true,
  marker: marker || 'none'
})
const preset = (prompts: any[]): any => ({
  name: 'P',
  parameters: { temperature: 0.9, max_tokens: 100 },
  prompts
})
const floor = (n: number, user: string, resp: string): any => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: user, timestamp: 't' },
  response: { content: resp, model: '', provider: '' },
  events: [],
  variables: {}
})
const last = (m: ChatMessage[]): ChatMessage => m[m.length - 1]

describe('estimateTokens', () => {
  it('is 0 for empty, ~chars/4 for latin, ~1/char for CJK', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('hello world')).toBe(3) // 11 chars -> ceil(11/4)
    expect(estimateTokens('你好')).toBe(2) // 2 CJK chars
  })
})

describe('fitToBudget', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'S'.repeat(40) },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }
  ]

  it('returns everything unchanged under a generous budget', () => {
    const { messages, dropped } = fitToBudget(msgs, 10_000)
    expect(dropped).toBe(0)
    expect(messages).toEqual(msgs)
  })

  it('drops the oldest turns but keeps the system prefix and the final turn', () => {
    const { messages, dropped } = fitToBudget(msgs, 20)
    expect(dropped).toBe(2)
    expect(messages[0].role).toBe('system')
    expect(last(messages).content).toBe('u2')
  })
})

describe('buildPrompt', () => {
  it('expands char_description + chat_history and ends on the user action', () => {
    const messages = buildPrompt({
      card: card({ description: 'A knight.' }),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, '', 'Hello traveler')],
      userAction: 'I wave back'
    })
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Name: Aria')
    expect(messages[0].content).toContain('A knight.')
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'Hello traveler')).toBe(true)
    expect(last(messages)).toEqual({ role: 'user', content: 'I wave back' })
  })

  it('injects top (depth-null) lorebook entries into a World Info block', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['dragon'], content: 'Dragons breathe fire' }])],
      floors: [],
      userAction: 'I see a dragon'
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('Dragons breathe fire')
  })

  it('places a depth-tagged entry near the bottom but keeps the user action last', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['dragon'], content: 'DRAGON-LORE', insertion_depth: 1 }])],
      floors: [floor(0, '', 'greet'), floor(1, 'u1', 'a1')],
      userAction: 'attack the dragon'
    })
    expect(last(messages).content).toBe('attack the dragon')
    const penultimate = messages[messages.length - 2]
    expect(penultimate.role).toBe('system')
    expect(penultimate.content).toContain('DRAGON-LORE')
  })

  it('injects the persona at the top and expands {{persona}}/{{user}} macros', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('none', 'Bio: {{user}} is {{persona}}'), blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, '', 'hi')],
      userAction: 'hello',
      userName: 'Lyra',
      persona: { description: 'a wanderer', inject: true, depth: null }
    })
    const personaBlock = messages.find((m) => m.content.includes("[Lyra's Persona]"))
    expect(personaBlock).toBeTruthy()
    expect(personaBlock!.content).toContain('a wanderer')
    // The {{persona}} / {{user}} macros expanded inside the literal block.
    expect(messages.some((m) => m.content === 'Bio: Lyra is a wanderer')).toBe(true)
  })

  it('can place the persona at a depth instead of the top', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, 'u0', 'a0')],
      userAction: 'go',
      userName: 'Lyra',
      persona: { description: 'a wanderer', inject: true, depth: 1 }
    })
    expect(last(messages).content).toBe('go')
    expect(messages.some((m) => m.role === 'system' && m.content.includes("[Lyra's Persona]"))).toBe(
      true
    )
  })

  it('does not inject the persona when inject is false or description is blank', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [],
      userAction: 'go',
      persona: { description: 'hidden', inject: false, depth: null }
    })
    expect(messages.some((m) => m.content.includes('Persona'))).toBe(false)
  })

  it('merges matches across multiple lorebooks', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ keys: ['alpha'], content: 'AAA' }]), book([{ keys: ['beta'], content: 'BBB' }])],
      floors: [],
      userAction: 'alpha and beta'
    })
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('AAA')
    expect(wi?.content).toContain('BBB')
  })

  it('injects a depth-tagged literal preset block into history, keeping its role', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([
        blk('char_description'),
        { ...blk('none', 'AUTHOR NOTE', 'assistant'), injection_depth: 1 },
        blk('chat_history')
      ]),
      lorebooks: [],
      floors: [floor(0, 'u0', 'a0')],
      userAction: 'go'
    })
    expect(last(messages).content).toBe('go')
    const penultimate = messages[messages.length - 2]
    expect(penultimate.content).toBe('AUTHOR NOTE')
    expect(penultimate.role).toBe('assistant')
  })

  it('safety nets: an empty preset still injects world info and history', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([]),
      lorebooks: [book([{ content: 'CONST-LORE', constant: true }])],
      floors: [floor(0, '', 'hi')],
      userAction: 'go'
    })
    expect(messages.some((m) => m.content.includes('CONST-LORE'))).toBe(true)
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'hi')).toBe(true)
    expect(last(messages)).toEqual({ role: 'user', content: 'go' })
  })
})
