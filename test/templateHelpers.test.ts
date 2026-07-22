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

  it('TavernHelper read shims: getVariables reads the live stat_data store; getLastMessageId gates', () => {
    // Mirrors 命定之诗's 艾莉亚 status core: `getLastMessageId() > 0` gate, then read stat_data via
    // TavernHelper.getVariables({type:'message'}). Before the shim this threw (TavernHelper undefined)
    // and the whole block was stripped → the current stat values never reached the prompt.
    const c = ctx({ vars: { stat_data: { 主角: { 生命值: 105, 等级: 10 } } } })
    const tmpl =
      "<% if (TavernHelper.getLastMessageId() > 0) { %>" +
      "HP=<%= _.get(TavernHelper.getVariables({type:'message'}), 'stat_data.主角.生命值') %>" +
      " LV=<%= _.get(TavernHelper.getVariables({type:'message'}), 'stat_data.主角.等级') %>" +
      "<% } %>"
    expect(evalTemplate(tmpl, c)).toBe('HP=105 LV=10')
  })

  it('TavernHelper.getLastMessageId() is -1 with no history (gate suppresses on the first message)', () => {
    const c = ctx({ data: { messages: [] } })
    expect(evalTemplate('<%= TavernHelper.getLastMessageId() %>', c)).toBe('-1')
    expect(evalTemplate('<% if (TavernHelper.getLastMessageId() > 0) { %>x<% } %>', c)).toBe('')
  })

  it('TavernHelper write/side-effect APIs are no-ops at build time (present, do not throw or mutate)', () => {
    const c = ctx({ vars: { n: 1 } })
    expect(evalTemplate("<% TavernHelper.insertOrAssignVariables({n: 999}) %>ok", c)).toBe('ok')
    expect(evalTemplate("<% TavernHelper.triggerSlash('/setvar n 999') %>ok", c)).toBe('ok')
    expect(c.vars.n).toBe(1) // unchanged — writers don't touch the store during a prompt build
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

  it('aborts a runaway (infinite-loop) template at the deadline instead of hanging', () => {
    // Regression: quickjs evalCode is synchronous and, with no interrupt handler, a `<% while(true) %>`
    // hung it FOREVER — freezing the renderer on display and the main process at build, and re-freezing
    // on every reload of that floor. The deadline interrupt aborts it → empty output + a reported error.
    const r = evalTemplateDetailed('<% while(true){} %>after', ctx())
    expect(r.output).toBe('') // interrupted → empty (fail-safe), not the literal tail
    expect(r.error).toBeTruthy() // the interrupt surfaces as an error
  }, 5000)

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

  // ST-Prompt-Template `setvar(key, value, { merge: true })`. The pattern that needs it: several
  // world-info entries (one per DLC character) each write THEIR key into one shared variable. Without
  // merge each `setvar` replaces the whole map, so only the last entry to render survives.
  //
  // Upstream documents the semantic as lodash `_.merge` BY NAME ("Whether to use merge to set the
  // variable (_.merge)"), so these cases are pinned against observed lodash behaviour — element-wise
  // array merge that keeps the target's tail, and `undefined` source values skipped — NOT against
  // RPT's own `deepMerge` (which replaces arrays wholesale and stays the semantic for MVU layering).
  describe('setvar { merge: true }', () => {
    it('deep-merges into an existing object instead of replacing it', () => {
      const c = ctx({ vars: {} })
      evalTemplate(
        "<% setLocalVar('visuals', { 艾琪奈夏: { url: 'a.png' } }, { merge: true }) %>" +
          "<% setLocalVar('visuals', { 瓦德尔基奥萨: { url: 'b.png' } }, { merge: true }) %>",
        c
      )
      expect(c.vars.visuals).toEqual({
        艾琪奈夏: { url: 'a.png' },
        瓦德尔基奥萨: { url: 'b.png' }
      })
    })

    it('merges nested keys and lets the newer value win a collision', () => {
      const write = "setvar('v', { a: { tint: 'new' }, b: 2 }"
      const merged = ctx({ vars: { v: { a: { keep: 1, tint: 'old' } } } })
      evalTemplate(`<% ${write}, { merge: true }) %>`, merged)
      expect(merged.vars.v).toEqual({ a: { keep: 1, tint: 'new' }, b: 2 })
      // The SAME write without the option replaces the subtree — `keep` is gone.
      const replaced = ctx({ vars: { v: { a: { keep: 1, tint: 'old' } } } })
      evalTemplate(`<% ${write}) %>`, replaced)
      expect(replaced.vars.v).toEqual({ a: { tint: 'new' }, b: 2 })
    })

    it('merges at a NESTED path, resolved through the live store', () => {
      // Guards the whole point of reading with getPath rather than store[key]: an implementation that
      // only handled single-segment keys would degrade every nested merge to a wholesale replace.
      const c = ctx({ vars: { ui: { visuals: { 艾琪奈夏: { url: 'a.png' } }, theme: 'dark' } } })
      evalTemplate(
        "<% setvar('ui.visuals', { 瓦德尔基奥萨: { url: 'b.png' } }, { merge: true }) %>",
        c
      )
      expect(c.vars.ui).toEqual({
        visuals: { 艾琪奈夏: { url: 'a.png' }, 瓦德尔基奥萨: { url: 'b.png' } },
        theme: 'dark' // the sibling survives — the merge landed on the subtree, not on `ui`
      })
    })

    it('merges through a bracketed (array-index) path segment', () => {
      const c = ctx({ vars: { list: [{ meta: { keep: 1 } }] } })
      evalTemplate("<% setvar('list[0].meta', { added: 2 }, { merge: true }) %>", c)
      expect(c.vars.list).toEqual([{ meta: { keep: 1, added: 2 } }])
    })

    it('without merge, the last write still replaces (unchanged default)', () => {
      const c = ctx({ vars: {} })
      evalTemplate("<% setvar('visuals', { a: 1 }) %><% setvar('visuals', { b: 2 }) %>", c)
      expect(c.vars.visuals).toEqual({ b: 2 })
    })

    it('falls back to a plain set when there is no container to merge into', () => {
      const fresh = ctx({ vars: {} })
      evalTemplate("<% setvar('n.deep', { a: 1 }, { merge: true }) %>", fresh)
      expect(fresh.vars.n).toEqual({ deep: { a: 1 } }) // created, intermediates and all
      const scalar = ctx({ vars: { n: 5 } })
      evalTemplate("<% setvar('n', { a: 1 }, { merge: true }) %>", scalar)
      expect(scalar.vars.n).toEqual({ a: 1 }) // upstream: "otherwise replaced"
    })

    it('merges arrays ELEMENT-WISE, keeping the target tail (_.merge, not a wholesale replace)', () => {
      const c = ctx({ vars: { list: [1, 2, 3] } })
      evalTemplate("<% setvar('list', [9], { merge: true }) %>", c)
      expect(c.vars.list).toEqual([9, 2, 3])
      const objs = ctx({ vars: { l: [{ a: 1 }, { b: 2 }] } })
      evalTemplate("<% setvar('l', [{ c: 3 }], { merge: true }) %>", objs)
      expect(objs.vars.l).toEqual([{ a: 1, c: 3 }, { b: 2 }])
    })

    it('skips undefined source values instead of writing them through (_.merge)', () => {
      const c = ctx({ vars: { v: { keep: 1, tint: 'old' } } })
      evalTemplate("<% setvar('v', { keep: undefined, tint: 'new' }, { merge: true }) %>", c)
      expect(c.vars.v).toEqual({ keep: 1, tint: 'new' })
    })

    it('a mismatched source type replaces rather than merges', () => {
      const c = ctx({ vars: { v: { a: { x: 1 } } } })
      evalTemplate("<% setvar('v', { a: [1, 2] }, { merge: true }) %>", c)
      expect(c.vars.v).toEqual({ a: [1, 2] }) // array source over an object target wins outright
    })

    it('reports the merged path to the write recorder, so build-time capture journals it', () => {
      const writes: string[] = []
      const c = ctx({ vars: { visuals: { a: 1 } }, onVarWrite: (p) => writes.push(p) })
      evalTemplate("<% setLocalVar('visuals', { b: 2 }, { merge: true }) %>", c)
      expect(writes).toEqual(['visuals'])
      expect(c.vars.visuals).toEqual({ a: 1, b: 2 })
    })

    it('keyless setvar(null, …) merges instead of clearing when asked', () => {
      const c = ctx({ vars: { keep: 1 } })
      evalTemplate('<% setvar(null, { added: 2 }, { merge: true }) %>', c)
      expect(c.vars).toEqual({ keep: 1, added: 2 })
      evalTemplate('<% setvar(null, { only: 3 }) %>', c)
      expect(c.vars).toEqual({ only: 3 }) // no merge → wholesale replace (unchanged)
    })

    it('keyless merge of an array splats indices onto the tree, exactly as _.merge does', () => {
      // Degenerate but pinned: `_.merge({keep:1}, [7,8])` === `{keep:1, 0:7, 1:8}`. Faithfulness over
      // tidiness — the engine's contract is upstream's behaviour, not what reads nicest.
      const c = ctx({ vars: { keep: 1 } })
      evalTemplate('<% setvar(null, [7, 8], { merge: true }) %>', c)
      expect(c.vars).toEqual({ keep: 1, 0: 7, 1: 8 })
    })
  })

  // WS-1: the variable surface resolves a stat_data key whether read with the explicit `stat_data.`
  // prefix or bare (hoisted) — consistently, in every context. The store passed here is the WRAPPED
  // floor-vars shape ({ stat_data: {...} }) that all three callers now use.
  describe('stat_data read-fallback + hoisted variables (WS-1)', () => {
    const wrapped = (): TemplateContext =>
      ctx({
        vars: { 系统名: 'X', stat_data: { 主角: { hp: 42 }, 世界后台状态: { 时局: '安稳' } } }
      })

    it('getvar resolves a stat_data key with the explicit stat_data. prefix', () => {
      expect(evalTemplate('<%= getvar("stat_data.主角.hp") %>', wrapped())).toBe('42')
    })
    it('getvar resolves a stat_data key BARE (hoisted fallback)', () => {
      expect(evalTemplate('<%= getvar("主角.hp") %>', wrapped())).toBe('42')
      expect(evalTemplate('<%= getMessageVar("世界后台状态.时局") %>', wrapped())).toBe('安稳')
    })
    it('top-level vars still win over the stat_data fallback', () => {
      expect(evalTemplate('<%= getvar("系统名") %>', wrapped())).toBe('X')
    })
    it('a genuinely missing key still falls through to the default', () => {
      expect(evalTemplate('<%= getvar("没有", { defaults: "none" }) %>', wrapped())).toBe('none')
    })
    it('the `variables` constant exposes both the hoisted key and the stat_data key', () => {
      expect(evalTemplate('<%= variables.主角.hp %>', wrapped())).toBe('42')
      expect(evalTemplate('<%= variables.stat_data.主角.hp %>', wrapped())).toBe('42')
    })
    it('global scope is NOT affected by the stat_data fallback', () => {
      const c = ctx({ globals: { g: 1 }, vars: { stat_data: { g: 999 } } })
      expect(evalTemplate('<%= getGlobalVar("g") %>', c)).toBe('1')
    })
  })

  // The `YAML` sandbox global — world-info/status entries (e.g. 命定之诗 <status_current_variables>) call
  // YAML.stringify/parse. Absent, the entry throws and its EJS is stripped → the status block reaches the
  // AI empty. Main wires the real `yaml`; tests use the JSON-passthrough default (JSON is valid YAML).
  describe('YAML global', () => {
    it('YAML.stringify serializes nested objects (values, not [object Object])', () => {
      const out = evalTemplate('<%= YAML.stringify({ hp: 105, lvl: 10, box: { a: [1, 2] } }) %>', ctx())
      expect(out).toContain('105')
      expect(out).toContain('10')
      expect(out).not.toContain('[object Object]')
    })

    it('YAML.parse round-trips (JSON is valid YAML)', () => {
      expect(evalTemplate('<%= YAML.parse(\'{"n":7}\').n %>', ctx())).toBe('7')
    })

    it('the status-panel shape (_.chain + _.omit/_.cloneDeep + YAML.stringify) renders without error', () => {
      // Mirrors getVisibleAscensionFieldsForPerson + the final YAML.stringify(cleanData) in the real entry.
      const tmpl =
        '<status_current_variables>\n<%_ {\n' +
        "  const data = getMessageVar('stat_data', { defaults: {} });\n" +
        "  const cleanData = _.omit(_.cloneDeep(data), '事件');\n" +
        '  const level = 25;\n' +
        '  const visible = _.chain([{ level: 13, fields: ["要职"] }, { level: 17, fields: ["权柄"] }])\n' +
        '    .filter(function (t) { return level >= t.level }).flatMap("fields").value();\n' +
        '  cleanData.__visible = visible;\n' +
        '_%>\n<%= YAML.stringify(cleanData) _%>\n<%_ } _%>\n</status_current_variables>'
      const c = ctx({ vars: { stat_data: { 主角: { 生命值: 105, 等级: 10 }, 事件: ['x'] } } })
      const { output, error } = evalTemplateDetailed(tmpl, c)
      expect(error).toBeNull()
      expect(output).toContain('生命值: 105')
      expect(output).toContain('要职')
      expect(output).toContain('权柄')
      expect(output).not.toContain('事件') // omitted before serialize
    })
  })
})
