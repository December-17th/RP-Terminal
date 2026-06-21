import { describe, it, expect, beforeAll } from 'vitest'
import { initTemplates, evalTemplate, TemplateContext } from '../src/main/services/templateService'

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  vars: {},
  globals: {},
  constants: {},
  data: {
    charData: { name: 'Mira', personality: 'curious' },
    worldInfo: [{ name: 'Town', content: 'A quiet harbor town.' }],
    messages: [
      { user: 'hi', assistant: 'hello' },
      { user: 'bye', assistant: 'farewell' }
    ],
    chatName: 'Session 1',
    presetName: 'Default'
  },
  ...over
})

describe('templateService TH-3 helpers', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('strips <%# comment %> tags', () => {
    expect(evalTemplate('a<%# secret note %>b', ctx())).toBe('ab')
  })

  it('defines message/chat-scoped var helpers (no ReferenceError; map to chat vars)', () => {
    const c = ctx({ vars: { hp: 80 } })
    expect(evalTemplate('<%= getMessageVar("hp") %>', c)).toBe('80')
    expect(evalTemplate('<%= getChatVar("hp") %>', c)).toBe('80')
    evalTemplate('<% setMessageVar("mp", 50) %>', c)
    expect(c.vars.mp).toBe(50)
  })

  it('getchar() returns the card data, or a field', () => {
    expect(evalTemplate("<%= getchar('name') %>", ctx())).toBe('Mira')
    expect(evalTemplate("<%= getchar('personality') %>", ctx())).toBe('curious')
  })

  it('getwi(name) returns a matched world-info entry by name', () => {
    expect(evalTemplate("<%= getwi('Town') %>", ctx())).toBe('A quiet harbor town.')
    expect(evalTemplate("<%= getwi('Nope') %>", ctx())).toBe('')
  })

  it('getCurrentChatName / getPreset expose context strings', () => {
    expect(evalTemplate('<%= getCurrentChatName() %>', ctx())).toBe('Session 1')
    expect(evalTemplate('<%= getPreset() %>', ctx())).toBe('Default')
  })

  it('getMessageHistory() exposes the transcript length', () => {
    expect(evalTemplate('<%= getMessageHistory().length %>', ctx())).toBe('2')
  })

  it('define() registers a reusable value for later in the template', () => {
    expect(evalTemplate("<% define('greet', 'hi there') %><%= greet %>", ctx())).toBe('hi there')
  })

  it('exposes a minimal faker (deterministic in a degenerate range)', () => {
    expect(evalTemplate('<%= faker.number(7, 7) %>', ctx())).toBe('7')
    expect(evalTemplate('<%= faker.uuid().length %>', ctx())).toBe('36')
  })
})
