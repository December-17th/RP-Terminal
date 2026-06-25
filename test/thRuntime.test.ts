// test/thRuntime.test.ts
import { describe, it, expect } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import type { Host } from '../src/shared/thRuntime/types'

function mockHost(over: Partial<Host> = {}): { host: Host; calls: any } {
  const calls: any = {
    applyVariableOps: [],
    generate: [],
    generateRaw: [],
    saveWorldbook: [],
    setInput: [],
    createWorldbook: [],
    deleteWorldbook: [],
    saveWorldbookById: [],
    bindWorldbook: [],
    setGlobalVar: [],
    replaceRegexes: [],
    setScriptVars: [],
    setButtons: []
  }
  let hostCb: ((name: string, payload?: any) => void) | null = null
  const wbLib = [
    { id: 'wb1', name: 'Lore A' },
    { id: 'own', name: 'Ellia' }
  ]
  const globals: Record<string, any> = { coins: 7 }
  let scriptVars: Record<string, any> = { existing: 1 }
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
  let varsCb: ((sd: any) => void) | null = null
  const host: Host = {
    ctx: { profileId: 'p', chatId: 'c', characterId: 'ch' },
    statData: () => ({ hp: 1 }),
    floors: () => [{ user_message: { content: 'u' }, response: { content: 'a' } }],
    charData: () => ({ name: 'Ellia' }),
    charAvatarPath: () => null,
    preset: () => ({ name: 'P' }),
    presetNames: () => ['P'],
    worldbookNames: () => ({ primary: 'Ellia', additional: [] }),
    regexes: () => [{ find: 'a', replace: 'b' }],
    regexesFull: () => regexFull,
    isCharacterRegexesEnabled: () => true,
    formatRegex: (t) => t.toUpperCase(),
    personaName: () => 'Player',
    currentChatId: () => 'c',
    getScriptVars: () => scriptVars,
    applyVariableOps: async (ops) => {
      calls.applyVariableOps.push(ops)
    },
    setVariables: async () => {},
    generate: async (i) => {
      calls.generate.push(i)
      return { content: 'gen:' + i }
    },
    generateRaw: async (cfg) => {
      calls.generateRaw.push(cfg)
      return 'raw'
    },
    getWorldbook: async () => ({ entries: [{ keys: ['k'], comment: 'Lore Title' }] }),
    saveWorldbook: async (n, e) => {
      calls.saveWorldbook.push([n, e])
    },
    listWorldbooks: () => wbLib,
    chatWorldbookIds: () => ['own'],
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
    setChatMessages: async () => true,
    deleteChatMessages: async () => true,
    createChat: async () => 'id',
    saveChat: async () => true,
    reloadChat: async () => true,
    setInput: (t) => calls.setInput.push(t),
    getGlobalVars: async () => globals,
    setGlobalVar: async (key: string, value: any) => {
      globals[key] = value
      calls.setGlobalVar.push([key, value])
    },
    replaceRegexes: async (regexes: any[], option?: any) => {
      regexFull = regexes
      calls.replaceRegexes.push([regexes, option])
    },
    setScriptVars: async (v: Record<string, any>) => {
      scriptVars = v
      calls.setScriptVars.push(v)
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
    evalTemplate: (t) => 'ejs:' + t,
    evalTemplateError: () => null,
    prepareContext: (d) => ({ vars: d || {}, enabled: true }),
    ...over
  }
  return {
    host,
    calls,
    fireVars: (sd: any) => varsCb && varsCb(sd),
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
    expect(g.getCurrentMessageId()).toBe(1)
    expect(g.getCharData()).toEqual({ name: 'Ellia' })
    expect(g.formatAsTavernRegexedString('hi')).toBe('HI')
    // substituteParams / substitudeMacros expand {{macros}} over char/user/stat_data
    expect(g.SillyTavern.substituteParams('{{char}}/{{user}}/{{getvar::hp}}')).toBe(
      'Ellia/Player/1'
    )
    expect(g.substitudeMacros('hi {{char}}')).toBe('hi Ellia')
    expect(g.SillyTavern.chat[0].name).toBe('Player')
  })

  it('refreshes the cache + emits MVU events on host var change', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const seen: any[] = []
    g.eventOn('mag_variable_updated', (sd: any) => seen.push(sd))
    m.fireVars({ hp: 99 })
    expect(g.getVariables()).toEqual({ stat_data: { hp: 99 } })
    expect(seen).toEqual([{ hp: 99 }])
  })

  it('setMvuVariable persists via applyVariableOps', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.Mvu.setMvuVariable({}, 'a.b', 5)
    await Promise.resolve()
    expect(m.calls.applyVariableOps[0]).toEqual([{ op: 'set', path: '/a/b', value: 5 }])
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

  it('regex: getTavernRegexes reads the host; update/replace write through host.replaceRegexes', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(g.getTavernRegexes({ type: 'character' })[0].script_name).toBe('R')
    expect(g.isCharacterTavernRegexesEnabled()).toBe(true)
    // updateTavernRegexesWith: the updater's returned list is written for that option
    const added = { id: 'rx2', script_name: 'New', find_regex: '/x/g', replace_string: 'y' }
    const out = await g.updateTavernRegexesWith(
      (list: any[]) => [...list, added],
      { type: 'character' }
    )
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
})
