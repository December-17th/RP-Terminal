// test/thRuntime.test.ts
import { describe, it, expect } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import type { Host } from '../src/shared/thRuntime/types'

function mockHost(over: Partial<Host> = {}): { host: Host; calls: any } {
  const calls: any = {
    applyVariableOps: [],
    generate: [],
    generateRaw: [],
    setInput: [],
    submitInput: [],
    createWorldbook: [],
    deleteWorldbook: [],
    saveWorldbookById: [],
    bindWorldbook: [],
    setGlobalVar: [],
    setGlobalVars: [],
    replaceRegexes: [],
    setScriptVars: [],
    setChatVars: [],
    setButtons: []
  }
  let hostCb: ((name: string, payload?: any) => void) | null = null
  const wbLib = [
    { id: 'wb1', name: 'Lore A' },
    { id: 'own', name: 'Ellia' }
  ]
  const globals: Record<string, any> = { coins: 7 }
  let scriptVars: Record<string, any> = { existing: 1 }
  let chatVars: Record<string, any> = { existing: 1 }
  let regexFull: any[] = [
    {
      id: 'rx1',
      script_name: 'R',
      enabled: true,
      find_regex: '/a/g',
      replace_string: 'b',
      trim_strings: [],
      source: { user_input: false, ai_output: true, slash_command: false, world_info: false },
      destination: { display: true, prompt: false },
      run_on_edit: false,
      min_depth: null,
      max_depth: null
    }
  ]
  let varsCb: ((sd: any, meta?: { origin: any }) => void) | null = null
  // Spread the inert null host, then override ONLY the members these tests exercise (behavioral
  // getters + the call-tracking writers). The dropped members keep createNullHost's neutrals.
  const host: Host = {
    ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
    statData: () => ({ hp: 1 }),
    floors: () => [{ user_message: { content: 'u' }, response: { content: 'a' } }],
    charData: () => ({ name: 'Ellia' }),
    regexesFull: () => regexFull,
    formatRegex: (t) => t.toUpperCase(),
    personaName: () => 'Player',
    personaDescription: () => 'a brave knight',
    currentChatId: () => 'c',
    getScriptVars: () => scriptVars,
    getChatVars: () => chatVars,
    applyVariableOps: async (ops) => {
      calls.applyVariableOps.push(ops)
    },
    generate: async (i) => {
      calls.generate.push(i)
      return { content: 'gen:' + i }
    },
    generateRaw: async (cfg) => {
      calls.generateRaw.push(cfg)
      return 'raw'
    },
    getWorldbook: async () => ({ entries: [{ keys: ['k'], comment: 'Lore Title' }] }),
    listWorldbooks: () => wbLib,
    createWorldbook: async (n) => {
      const id = 'id_' + n
      wbLib.push({ id, name: n })
      calls.createWorldbook.push(n)
      return id
    },
    deleteWorldbook: async (id) => {
      calls.deleteWorldbook.push(id)
      return true
    },
    getWorldbookById: async (id) => ({ name: id, entries: [{ id }] }),
    saveWorldbookById: async (id, e) => {
      calls.saveWorldbookById.push([id, e])
    },
    bindWorldbook: async (id, on) => {
      calls.bindWorldbook.push([id, on])
    },
    setInput: (t) => calls.setInput.push(t),
    submitInput: () => calls.submitInput.push(true),
    getGlobalVars: async () => globals,
    setGlobalVar: async (key: string, value: any) => {
      globals[key] = value
      calls.setGlobalVar.push([key, value])
    },
    getGlobalVarsSync: () => globals,
    setGlobalVars: async (vars: Record<string, any>) => {
      for (const k of Object.keys(globals)) delete globals[k]
      Object.assign(globals, vars || {})
      calls.setGlobalVars.push(vars)
    },
    replaceRegexes: async (regexes: any[], option?: any) => {
      regexFull = regexes
      calls.replaceRegexes.push([regexes, option])
    },
    setScriptVars: async (v: Record<string, any>) => {
      scriptVars = v
      calls.setScriptVars.push(v)
    },
    setChatVars: async (v: Record<string, any>) => {
      chatVars = v
      calls.setChatVars.push(v)
    },
    setButtons: (b: any) => {
      calls.setButtons.push(b)
    },
    onVarsChanged: (cb) => {
      varsCb = cb
      return () => {
        varsCb = null
      }
    },
    onHostEvent: (cb) => {
      hostCb = cb
      return () => {
        hostCb = null
      }
    },
    prepareContext: (d) => ({ vars: d || {}, enabled: true }),
    ...over
  }
  return {
    host,
    calls,
    fireVars: (sd: any, meta?: { origin: any }) => varsCb && varsCb(sd, meta),
    fireHostEvent: (n: string, p?: any) => hostCb && hostCb(n, p)
  } as any
}

describe('createThRuntime', () => {
  it('exposes the surface (bare + namespaced)', () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(typeof g.getVariables).toBe('function')
    expect(g.TavernHelper.getChatMessages).toBe(g.getChatMessages)
    expect(g.Mvu).toBeTruthy()
    expect(g.SillyTavern).toBeTruthy()
    expect(g.EjsTemplate).toBeTruthy()
    // prepareContext must delegate to the host (a full EJS context), not return the raw input —
    // regression guard: cards detect/use the engine via prepareContext()'s shape (enabled, vars).
    expect(g.EjsTemplate.prepareContext({ x: 1 })).toEqual({ vars: { x: 1 }, enabled: true })
    expect(g.tavern_events.MESSAGE_RECEIVED).toBe('message_received')
  })

  it('reads sync getters via the host + shape mappers', () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } })
    expect(g.getChatMessages()).toEqual([
      { message_id: 0, role: 'user', message: 'u' },
      { message_id: 1, role: 'assistant', message: 'a' }
    ])
    // Numeric ranges select one compact chat-array message; negative indexes count from the end.
    // 自动正则 depends on -1 to scan the latest assistant message after each received event.
    expect(g.getChatMessages(-1)).toEqual([
      { message_id: 1, role: 'assistant', message: 'a' }
    ])
    expect(g.getChatMessages(0)).toEqual([{ message_id: 0, role: 'user', message: 'u' }])
    expect(g.getChatMessages(-3)).toEqual([])
    expect(g.getChatMessages(2)).toEqual([])
    expect(g.getCurrentMessageId()).toBe(1)
    expect(g.getCharData()).toEqual({ name: 'Ellia' })
    expect(g.formatAsTavernRegexedString('hi')).toBe('HI')
    // substituteParams / substitudeMacros expand {{macros}} over char/user/stat_data
    expect(g.SillyTavern.substituteParams('{{char}}/{{user}}/{{getvar::hp}}')).toBe(
      'Ellia/Player/1'
    )
    // {{user}} = persona name, {{persona}} = persona DESCRIPTION (ST-faithful; not the name).
    expect(g.SillyTavern.substituteParams('{{user}}={{persona}}')).toBe('Player=a brave knight')
    expect(g.substitudeMacros('hi {{char}}')).toBe('hi Ellia')
    expect(g.SillyTavern.chat[0].name).toBe('Player')
  })

  it('refreshes the cache + emits MVU events on host var change (fold / undefined origin)', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const seen: any[] = []
    g.eventOn('mag_variable_updated', (vars: any) => seen.push(vars))
    m.fireVars({ hp: 99 }) // undefined origin ⇒ treated as a fold (events fire) for back-compat
    expect(g.getVariables()).toEqual({ stat_data: { hp: 99 } })
    // MVU events carry the WRAPPED { stat_data } object (MvuData contract), not bare stat_data.
    expect(seen).toEqual([{ stat_data: { hp: 99 } }])
    m.fireVars({ hp: 100 }, { origin: 'model-fold' })
    expect(seen).toEqual([{ stat_data: { hp: 99 } }, { stat_data: { hp: 100 } }])
  })

  it('WS-3: a card-write origin refreshes the cache but fires NO MVU events (no self-loop)', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const seen: any[] = []
    const msgSeen: any[] = []
    g.eventOn('mag_variable_updated', (vars: any) => seen.push(vars))
    g.eventOn('mag_variable_update_ended', (vars: any) => seen.push(vars))
    g.eventOn('message_updated', (id: any) => msgSeen.push(id))
    // The card's own programmatic write echoed back — a constantly-changing value would otherwise loop.
    m.fireVars({ date: 'x1' }, { origin: 'card-write' })
    // Cache IS refreshed (getvar / EJS injection must see the new value)...
    expect(g.getVariables()).toEqual({ stat_data: { date: 'x1' } })
    // ...but NO mag_* / message_updated events fired, so the card's own handler isn't re-triggered.
    expect(seen).toEqual([])
    expect(msgSeen).toEqual([])
    // A subsequent genuine fold on the SAME runtime still fires events (cache carry-over is correct).
    m.fireVars({ date: 'x2' }, { origin: 'model-fold' })
    expect(seen).toEqual([{ stat_data: { date: 'x2' } }, { stat_data: { date: 'x2' } }])
  })

  it('setMvuVariable persists via applyVariableOps', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.Mvu.setMvuVariable({}, 'a.b', 5)
    await Promise.resolve()
    expect(m.calls.applyVariableOps[0]).toEqual([{ op: 'set', path: '/a/b', value: 5 }])
  })

  it('MVU write-back: persists a handler that MUTATES after.stat_data in place (MagVarUpdate idiom)', async () => {
    // Faithful to MagVarUpdate: a variable-update handler derives state by replacing/mutating the passed
    // variables.stat_data and never calls a write (命定之诗's XP script sets 主角.升级所需经验 this way).
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.eventOn('mag_variable_update_ended', (vars: any) => {
      // The card replaces stat_data with a normalized clone that adds the derived field.
      vars.stat_data = { 主角: { ...(vars.stat_data.主角 || {}), 升级所需经验: 120 } }
    })
    m.fireVars({ 主角: { 等级: 1, 累计经验值: 0 } }) // model fold
    await Promise.resolve()
    // ONLY the derived leaf is written back (unchanged 等级/累计经验值 are not), via the card-write path.
    expect(m.calls.applyVariableOps).toContainEqual([
      { op: 'set', path: '/主角/升级所需经验', value: 120 }
    ])
    // The runtime cache reflects it too (getvar / EJS injection see the derived value).
    expect(g.getVariables()).toEqual({
      stat_data: { 主角: { 等级: 1, 累计经验值: 0, 升级所需经验: 120 } }
    })
  })

  it('MVU write-back: an untouched fold writes nothing (no spurious card-write, no loop)', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.eventOn('mag_variable_update_ended', () => {
      /* reads only — does not mutate after.stat_data */
    })
    m.fireVars({ hp: 7 }, { origin: 'model-fold' })
    expect(m.calls.applyVariableOps).toEqual([])
  })

  it('insertOrAssignVariables DEEP-merges a partial nested object, preserving siblings (命定之诗 date bug)', async () => {
    // Initial stat has a nested `date` game-state object; a partial write to date.log must NOT wipe
    // date.npcs / date.event or the other date.log fields (real TavernHelper merge, not shallow replace).
    const m: any = mockHost({
      statData: () => ({ date: { npcs: { a: 1 }, event: { cache: '' }, log: { deathCount: 0 } } })
    })
    const g = createThRuntime(m.host)
    await g.insertOrAssignVariables({ date: { log: { totalFPGained: 7 } } })
    // Only the changed leaf is persisted (siblings untouched)...
    expect(m.calls.applyVariableOps[0]).toEqual([
      { op: 'set', path: '/date/log/totalFPGained', value: 7 }
    ])
    // ...and the optimistic cache is the DEEP merge, not a top-level replace.
    expect(g.getVariables()).toEqual({
      stat_data: { date: { npcs: { a: 1 }, event: { cache: '' }, log: { deathCount: 0, totalFPGained: 7 } } }
    })
  })

  it('keeps the default stat_data cache update synchronous before the returned promise settles', async () => {
    const m: any = mockHost({ statData: () => ({ hp: 1 }) })
    const g = createThRuntime(m.host)

    const write = g.insertOrAssignVariables({ hp: 2 })

    expect(g.getVariables()).toEqual({ stat_data: { hp: 2 } })
    await write
  })

  it('insertVariables DEEP inserts only missing leaves (seeds defaults without overwriting)', async () => {
    const m: any = mockHost({ statData: () => ({ date: { log: { deathCount: 3 } } }) })
    const g = createThRuntime(m.host)
    // Seed the full default structure; existing date.log.deathCount must be kept, missing fields added.
    await g.insertVariables({ date: { npcs: {}, log: { deathCount: 0, illegalLevelUpId: [] } } })
    expect(m.calls.applyVariableOps[0]).toEqual([
      { op: 'set', path: '/date/npcs', value: {} },
      { op: 'set', path: '/date/log/illegalLevelUpId', value: [] }
    ])
    expect(g.getVariables()).toEqual({
      stat_data: { date: { npcs: {}, log: { deathCount: 3, illegalLevelUpId: [] } } }
    })
  })

  it('insertVariables preserves an existing scalar parent instead of forcing it into an object', async () => {
    const m: any = mockHost({ statData: () => ({ date: 'manual note' }) })
    const g = createThRuntime(m.host)
    await g.insertVariables({ date: { npcs: {}, log: { deathCount: 0 } } })
    expect(m.calls.applyVariableOps).toEqual([])
    expect(g.getVariables()).toEqual({ stat_data: { date: 'manual note' } })
  })

  it('insertOrAssignVariables honors chat scope for 自动正则 state', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)

    await g.insertOrAssignVariables(
      { adaptive_regex_names: ['读者对话渲染'] },
      { type: 'chat' }
    )

    expect(m.calls.setChatVars).toEqual([
      { existing: 1, adaptive_regex_names: ['读者对话渲染'] }
    ])
    expect(g.getVariables({ type: 'chat' })).toEqual({
      existing: 1,
      adaptive_regex_names: ['读者对话渲染']
    })
    expect(m.calls.applyVariableOps).toEqual([])
  })

  it('insertVariables honors scoped insert-only semantics', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)

    await g.insertVariables({ existing: 9, added: 2 }, { type: 'chat' })

    expect(m.calls.setChatVars).toEqual([{ existing: 1, added: 2 }])
    expect(m.calls.applyVariableOps).toEqual([])
  })

  it.each([
    ['script', 'setScriptVars', { existing: 1, nested: { value: 2 } }],
    ['global', 'setGlobalVars', { coins: 7, nested: { value: 2 } }]
  ])('insertOrAssignVariables honors %s scope', async (type, callKey, expected) => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)

    await g.insertOrAssignVariables({ nested: { value: 2 } }, { type })

    expect(m.calls[callKey]).toEqual([expected])
    expect(m.calls.applyVariableOps).toEqual([])
  })

  it('normalizes generate/generateRaw config', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(await g.generate('hi')).toBe('gen:hi')
    expect(await g.generate({ user_input: 'yo' })).toBe('gen:yo')
    await g.generateRaw({ user_input: 'x', max_tokens: 7 })
    expect(m.calls.generateRaw[0]).toMatchObject({ userInput: 'x', maxTokens: 7 })
  })

  it('createChatMessages injects the last message text via host.setInput (onboarding)', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    await g.createChatMessages([{ message: 'first' }, { message: 'last prompt' }])
    expect(m.calls.setInput).toEqual(['last prompt'])
  })

  it('getWorldbook returns entries in the TH shape (uid + name from our comment)', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const ents = await g.getWorldbook('') // empty name → the card's own book (host.getWorldbook)
    expect(ents[0]).toMatchObject({ keys: ['k'], uid: 0, name: 'Lore Title' })
  })

  it('worldbook CRUD: real library names, create→resolve-by-id, delete/bind/replace by name', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(g.getWorldbookNames()).toEqual(['Lore A', 'Ellia']) // the real library, not char-derived
    // createWorldbook returns the NAME (TH contract); a later getWorldbook(name) resolves it by id
    expect(await g.createWorldbook('Quests')).toBe('Quests')
    expect(m.calls.createWorldbook).toEqual(['Quests'])
    expect((await g.getWorldbook('Quests'))[0].id).toBe('id_Quests')
    // delete + bind + replace resolve name → id
    expect(await g.deleteWorldbook('Lore A')).toBe(true)
    expect(m.calls.deleteWorldbook).toEqual(['wb1'])
    await g.bindLorebook('Ellia', true)
    expect(m.calls.bindWorldbook).toEqual([['own', true]])
    // replaceWorldbook maps the card's TavernHelper entry shape → native before persisting (resolves name→id)
    await g.replaceWorldbook('Lore A', [{ name: 'E', strategy: { type: 'constant', keys: ['x'] } }])
    expect(m.calls.saveWorldbookById[0][0]).toBe('wb1')
    expect(m.calls.saveWorldbookById[0][1][0]).toMatchObject({
      keys: ['x'],
      constant: true,
      comment: 'E'
    })
    // unknown name no-ops
    expect(await g.deleteWorldbook('Nope')).toBe(false)
  })

  it('createWorldbookEntries appends (keys/constant mapped); deleteWorldbookEntries removes by predicate', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const created = await g.createWorldbookEntries('Lore A', [
      { name: 'New', strategy: { type: 'constant', keys: ['x'] } }
    ])
    expect(created.new_entries).toHaveLength(1)
    const afterCreate = m.calls.saveWorldbookById.at(-1)
    expect(afterCreate[0]).toBe('wb1')
    expect(afterCreate[1].some((e: any) => e.keys?.includes('x') && e.constant === true)).toBe(true)
    // the mock book has one entry (mapped name 'Entry 1') — delete it via predicate
    const del = await g.deleteWorldbookEntries('Lore A', (e: any) => e.name === 'Entry 1')
    expect(del.deleted_entries).toHaveLength(1)
    expect(m.calls.saveWorldbookById.at(-1)[1]).toEqual([]) // nothing kept
  })

  it('triggerSlash runs the STScript subset over the Host (chat vars, macros, pipes)', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    // chat-var round-trip: /setvar persists to stat_data via applyVariableOps, /getvar reads it back
    expect(await g.triggerSlash('/setvar key=hp 5 | /getvar key=hp')).toBe('5')
    expect(m.calls.applyVariableOps).toContainEqual([{ op: 'set', path: '/hp', value: 5 }])
    // macro identity (char/user) expands in args
    expect(await g.triggerSlash('/echo {{char}}/{{user}}')).toBe('Ellia/Player')
    // pipes thread {{pipe}}
    expect(await g.triggerSlash('/echo a | /echo {{pipe}}!')).toBe('a!')
    // an unsupported command resolves to '' (warned, not thrown)
    expect(await g.triggerSlash('/nope whatever')).toBe('')
  })

  it('triggerSlash: /gen → host.generate; globals persist via host.setGlobalVar', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(await g.triggerSlash('/gen hi there')).toBe('gen:hi there')
    expect(m.calls.generate).toContain('hi there')
    // /getglobalvar reads the (seeded) persistent store; /setglobalvar writes through the Host
    expect(await g.triggerSlash('/getglobalvar key=coins')).toBe('7')
    await g.triggerSlash('/setglobalvar key=coins 12')
    expect(m.calls.setGlobalVar).toContainEqual(['coins', 12])
  })

  it('triggerSlash: /setinput fills the input box (the options-scripts inject mode)', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(await g.triggerSlash('/setinput 查看四周')).toBe('')
    expect(m.calls.setInput.at(-1)).toBe('查看四周')
    expect(m.calls.generate).toHaveLength(0) // inject only — nothing generated
  })

  it('triggerSlash: /trigger PRESSES THE SEND BUTTON — both clickable-options combos submit the box', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    // `/send x | /trigger` (and equally `/setinput x | /trigger`): x lands in the box, then the
    // host submits the box through the Composer's normal send path. Fire-and-forget (returns '').
    expect(await g.triggerSlash('/send 选项一：出发 | /trigger')).toBe('')
    expect(m.calls.setInput).toEqual(['选项一：出发'])
    expect(m.calls.submitInput).toHaveLength(1)
    expect(await g.triggerSlash('/setinput 选项二：等待 | /trigger')).toBe('')
    expect(m.calls.setInput.at(-1)).toBe('选项二：等待')
    expect(m.calls.submitInput).toHaveLength(2)
    // /trigger never calls the generate API directly when the host can submit the box.
    expect(m.calls.generate).toHaveLength(0)
  })

  it('script-scope vars use the KV store, not stat_data', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    // read: type:'script' returns the KV; no arg returns the message vars
    expect(g.getVariables({ type: 'script' })).toEqual({ existing: 1 })
    expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } })
    // write: updateVariablesWith({type:'script'}) persists via setScriptVars and does NOT touch stat_data
    const next = await g.updateVariablesWith(
      (t: any) => {
        t.cache = { a: 1 }
        return t
      },
      { type: 'script' }
    )
    expect(next).toEqual({ existing: 1, cache: { a: 1 } })
    expect(m.calls.setScriptVars[0]).toEqual({ existing: 1, cache: { a: 1 } })
    expect(m.calls.applyVariableOps).toEqual([]) // stat_data untouched
    expect(g.getVariables({ type: 'script' })).toEqual({ existing: 1, cache: { a: 1 } })
  })

  it("global scope: getVariables/replaceVariables/updateVariablesWith({type:'global'}) hit the globals bag, not stat_data", async () => {
    // Regression for the 艾莉亚 beautification: it stores UI settings in {type:'global'} at
    // 'dialog_beauty.ui'. Before global routing, the read returned stat_data and the write dropped the
    // settings key → nothing persisted, settings reset every floor.
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    // read: returns the globals bag (seeded { coins: 7 }), NOT { stat_data }
    expect(g.getVariables({ type: 'global' })).toEqual({ coins: 7 })
    // replace: whole-object write persists via setGlobalVars and does NOT touch stat_data
    await g.replaceVariables({ coins: 7, dialog_beauty: { ui: { theme: 'dark' } } }, { type: 'global' })
    expect(m.calls.setGlobalVars.at(-1)).toEqual({ coins: 7, dialog_beauty: { ui: { theme: 'dark' } } })
    expect(m.calls.applyVariableOps).toEqual([]) // stat_data untouched
    expect(g.getVariables({ type: 'global' })).toEqual({ coins: 7, dialog_beauty: { ui: { theme: 'dark' } } })
    // update: read-modify-write the globals bag
    const next = await g.updateVariablesWith(
      (t: any) => {
        t.dialog_beauty.ui.theme = 'light'
        return t
      },
      { type: 'global' }
    )
    expect(next.dialog_beauty.ui.theme).toBe('light')
    expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } }) // message vars never touched
  })

  it('regex: getTavernRegexes reads the host; update/replace write through host.replaceRegexes', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(g.getTavernRegexes({ type: 'character' })[0].script_name).toBe('R')
    expect(g.isCharacterTavernRegexesEnabled()).toBe(true)
    // updateTavernRegexesWith: the updater's returned list is written for that option
    const added = { id: 'rx2', script_name: 'New', find_regex: '/x/g', replace_string: 'y' }
    const out = await g.updateTavernRegexesWith((list: any[]) => [...list, added], {
      type: 'character'
    })
    expect(out).toHaveLength(2)
    expect(m.calls.replaceRegexes[0][0]).toHaveLength(2)
    expect(m.calls.replaceRegexes[0][1]).toEqual({ type: 'character' })
    // replaceTavernRegexes writes directly
    await g.replaceTavernRegexes([added], { type: 'global' })
    expect(m.calls.replaceRegexes[1]).toEqual([[added], { type: 'global' }])
  })

  it('exposes getScriptId (stable), getCurrentCharacterName, SillyTavern.getCurrentChatId', () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(g.getCurrentCharacterName()).toBe('Ellia')
    expect(g.SillyTavern.getCurrentChatId()).toBe('c')
    const id = g.getScriptId()
    expect(typeof id).toBe('string')
    expect(g.getScriptId()).toBe(id) // stable across calls
  })

  it('persists SillyTavern chatMetadata.variables through saveMetadata (读者对话渲染 settings)', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const ctx = g.SillyTavern.getContext()

    // The real regex mutates this object in place, then calls ctx.saveMetadata() and shows its toast.
    expect(ctx.chatMetadata.variables).toEqual({ existing: 1 })
    ctx.chatMetadata.variables.dream_persona = 'kuromaku'
    ctx.chatMetadata.variables.dream_appearance = 'mature'
    await ctx.saveMetadata()

    expect(m.calls.setChatVars.at(-1)).toEqual({
      existing: 1,
      dream_persona: 'kuromaku',
      dream_appearance: 'mature'
    })
    expect(await g.SillyTavern.saveMetadata()).toBe(true)
  })

  it('script buttons: replaceScriptButtons pushes visible buttons; a click event fires eventOn', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    // getButtonEvent is identity (button name == event name)
    expect(g.getButtonEvent('命定创意工坊')).toBe('命定创意工坊')
    // replaceScriptButtons stores all, but only the VISIBLE ones are pushed to the host (the toolbar)
    g.replaceScriptButtons([
      { name: '命定创意工坊', visible: true },
      { name: 'hidden', visible: false }
    ])
    expect(g.getScriptButtons()).toHaveLength(2)
    expect(m.calls.setButtons.at(-1)).toEqual([{ name: '命定创意工坊', visible: true }])
    // a toolbar click arrives as a host event named after the button → the script's eventOn fires
    let clicked = 0
    g.eventOn(g.getButtonEvent('命定创意工坊'), () => {
      clicked++
    })
    m.fireHostEvent('命定创意工坊')
    expect(clicked).toBe(1)
  })

  it('errorCatched swallows throws and rejections', async () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(
      g.errorCatched(() => {
        throw new Error('x')
      })()
    ).toBeUndefined()
    await expect(
      g.errorCatched(async () => {
        throw new Error('y')
      })()
    ).resolves.toBeUndefined()
  })

  it('__rptDispose unsubscribes from host vars', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.__rptDispose()
    m.fireVars({ hp: 7 })
    expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } }) // cache unchanged after dispose
  })

  describe('panel chat scope', () => {
    // The plot panel's use case: one assistant message whose content IS the plot text. The card must see
    // a chat built from THAT, not the fake host's [user 'u', assistant 'a'] floors.
    const scope = { messages: [{ role: 'assistant' as const, content: 'PLOT' }] }

    it('scoped: getChatMessages / getCurrent+LastMessageId reflect the scope, not host.floors()', () => {
      const { host } = mockHost()
      const g = createThRuntime(host, { chatScope: scope })
      expect(g.getChatMessages()).toEqual([{ message_id: 0, role: 'assistant', message: 'PLOT' }])
      expect(g.getChatMessages(-1)).toEqual([{ message_id: 0, role: 'assistant', message: 'PLOT' }])
      expect(g.getCurrentMessageId()).toBe(0)
      expect(g.getLastMessageId()).toBe(0)
    })

    it('scoped: SillyTavern.chat and getContext().chat reflect the scope message (greetings suppressed)', () => {
      const { host } = mockHost()
      const g = createThRuntime(host, { chatScope: scope })
      expect(g.SillyTavern.chat).toHaveLength(1)
      expect(g.SillyTavern.chat[0]).toMatchObject({ is_user: false, name: 'Ellia', mes: 'PLOT' })
      const ctxChat = g.SillyTavern.getContext().chat
      expect(ctxChat).toHaveLength(1)
      expect(ctxChat[0].mes).toBe('PLOT')
    })

    it('scoped: only chat DERIVATION changes — vars/stat_data still come from the real host', () => {
      const { host } = mockHost()
      const g = createThRuntime(host, { chatScope: scope })
      expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } }) // real host vars, not the scope
      expect(g.Mvu.getMvuData().stat_data).toEqual({ hp: 1 })
    })

    it('unscoped: chat reads are byte-identical to today (host.floors())', () => {
      const { host } = mockHost()
      const g = createThRuntime(host)
      expect(g.getChatMessages()).toEqual([
        { message_id: 0, role: 'user', message: 'u' },
        { message_id: 1, role: 'assistant', message: 'a' }
      ])
      expect(g.getCurrentMessageId()).toBe(1)
      expect(g.SillyTavern.chat[0].name).toBe('Player') // the host floor's user message
    })

    it('an empty scope (no messages) falls back to the real host floors', () => {
      const { host } = mockHost()
      const g = createThRuntime(host, { chatScope: { messages: [] } })
      expect(g.getChatMessages()).toEqual([
        { message_id: 0, role: 'user', message: 'u' },
        { message_id: 1, role: 'assistant', message: 'a' }
      ])
    })

    it('scoped: SillyTavern.saveChat is a no-op (never persists the panel content to the real chat)', async () => {
      let saved = 0
      const scopedHost = mockHost({
        saveChat: async () => {
          saved++
          return true
        }
      }).host
      const gScoped = createThRuntime(scopedHost, { chatScope: scope })
      await gScoped.SillyTavern.saveChat()
      expect(saved).toBe(0) // READ-only fence: the scope-derived chat is never written back

      // Unscoped, the same call still reaches the host (existing behavior preserved).
      const unscopedHost = mockHost({
        saveChat: async () => {
          saved++
          return true
        }
      }).host
      const gUnscoped = createThRuntime(unscopedHost)
      await gUnscoped.SillyTavern.saveChat()
      expect(saved).toBe(1)
    })
  })
})
