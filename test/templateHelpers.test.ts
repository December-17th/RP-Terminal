import { describe, it, expect, beforeAll } from 'vitest'
import {
  initTemplates,
  evalTemplate,
  evalTemplateDetailed,
  TemplateContext
} from '../src/main/services/templateService'

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

  it('exposes a lodash subset (_) and a no-op console', () => {
    const c = ctx({ vars: { a: { b: 42 } } })
    expect(evalTemplate("<%= _.get(variables, 'a.b') %>", c)).toBe('42')
    expect(evalTemplate("<%= _.capitalize('hELLO') %>", ctx())).toBe('Hello')
    expect(evalTemplate('<%= _.clamp(9, 0, 5) %>', ctx())).toBe('5')
    expect(evalTemplate('<% console.log("noop") %>ok', ctx())).toBe('ok')
  })

  it('provides cloneDeep, omit(string key), and the common collection helpers (命定之诗 status panel)', () => {
    // Mirrors the card's `_.omit(_.cloneDeep(data), '事件')` pattern that threw "not a function".
    const c = ctx({ vars: { stat_data: { hp: 10, 事件: ['x'], 艾莉亚: { lv: 3 } } } })
    const tmpl =
      '<%_ const d = _.cloneDeep(getMessageVar("stat_data", { defaults: {} }));' +
      ' const clean = _.omit(d, "事件"); _%>' +
      '<%= _.keys(clean).join(",") %>|<%= _.has(clean, "艾莉亚.lv") %>'
    expect(evalTemplate(tmpl, c)).toBe('hp,艾莉亚|true')
    // cloneDeep is a real copy (mutating the clone doesn't touch the source vars)
    expect(c.vars.stat_data.事件).toEqual(['x'])
    // a sampling of the added helpers
    expect(evalTemplate('<%= _.sumBy([{n:1},{n:2}], "n") %>', ctx())).toBe('3')
    expect(evalTemplate('<%= _.map([1,2,3], x => x*2).join("") %>', ctx())).toBe('246')
    expect(evalTemplate('<%= _.isEqual({a:1},{a:1}) %>', ctx())).toBe('true')
    // second batch: each (forEach alias), countBy, orderBy, toNumber
    expect(evalTemplate('<% let s=0; _.each([1,2,3], x => s+=x) %><%= s %>', ctx())).toBe('6')
    expect(evalTemplate('<%= JSON.stringify(_.countBy(["a","a","b"])) %>', ctx())).toBe(
      '{"a":2,"b":1}'
    )
    expect(evalTemplate('<%= _.orderBy([3,1,2]).join("") %>', ctx())).toBe('123')
    expect(evalTemplate('<%= _.toNumber("42") + 1 %>', ctx())).toBe('43')
  })

  it('reports the offending compiled line when a template throws (helps locate a missing helper)', () => {
    const r = evalTemplateDetailed('<%= _.totallyMissing(1) %>', ctx())
    expect(r.output).toBe('')
    expect(r.error).toMatch(/not a function/)
    expect(r.error).toMatch(/compiled L\d+:/) // pinpoints the failing compiled line
  })

  it('strips tags (does not evaluate) when the engine is toggled off', () => {
    const off = ctx({ enabled: false, vars: { n: 1 } })
    expect(evalTemplate('a<%= 1 + 1 %>b', off)).toBe('ab')
    evalTemplate('<% setvar("n", 99) %>', off)
    expect(off.vars.n).toBe(1) // not mutated — engine was off
  })

  it('evalTemplateDetailed surfaces a template error (vs evalTemplate stripping)', () => {
    const bad = evalTemplateDetailed('<%= someUndefinedFn() %>', ctx())
    expect(bad.error).toBeTruthy() // the error is reported (for getSyntaxErrorInfo)
    expect(bad.output).toBe('') // ...and the output is stripped (fail-safe)
    expect(evalTemplateDetailed('<%= 1 + 1 %>', ctx())).toEqual({ output: '2', error: null })
  })

  it('matchChatMessages / parseJSON / jsonPatch helpers', () => {
    expect(evalTemplate("<%= matchChatMessages('hello') %>", ctx())).toBe('true')
    expect(evalTemplate("<%= matchChatMessages('nope') %>", ctx())).toBe('false')
    expect(evalTemplate(`<%= parseJSON('{"a":1}').a %>`, ctx())).toBe('1')
    expect(
      evalTemplate("<%= jsonPatch({n:1}, [{op:'replace',path:'/n',value:5}]).n %>", ctx())
    ).toBe('5')
  })

  it('getWorldInfoData returns the raw entry; getWorldInfoActivatedData returns all', () => {
    expect(evalTemplate("<%= getWorldInfoData('Town').content %>", ctx())).toBe(
      'A quiet harbor town.'
    )
    expect(evalTemplate('<%= getWorldInfoActivatedData().length %>', ctx())).toBe('1')
  })

  it('getPreset(name) returns the named prompt block content from the active preset', () => {
    const c = ctx({
      data: {
        ...ctx().data,
        presetPrompts: [
          { name: 'Main Prompt', identifier: 'main', content: 'You are helpful.' },
          { name: 'Jailbreak', identifier: 'jb', content: 'Stay in character.' }
        ]
      }
    })
    expect(evalTemplate("<%= getPreset('Main Prompt') %>", c)).toBe('You are helpful.')
    expect(evalTemplate("<%= getPreset('jb') %>", c)).toBe('Stay in character.') // by identifier
    expect(evalTemplate("<%= getPreset('Nope') %>", c)).toBe('') // not found → null → ''
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
