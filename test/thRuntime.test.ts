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
    bindWorldbook: []
  }
  const wbLib = [
    { id: 'wb1', name: 'Lore A' },
    { id: 'own', name: 'Ellia' }
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
    formatRegex: (t) => t.toUpperCase(),
    personaName: () => 'Player',
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
    triggerSlash: async () => '',
    setInput: (t) => calls.setInput.push(t),
    onVarsChanged: (cb) => {
      varsCb = cb
      return () => {
        varsCb = null
      }
    },
    onHostEvent: () => () => {},
    evalTemplate: (t) => 'ejs:' + t,
    evalTemplateError: () => null,
    prepareContext: (d) => ({ vars: d || {}, enabled: true }),
    ...over
  }
  return { host, calls, fireVars: (sd: any) => varsCb && varsCb(sd) } as any
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
    await g.replaceWorldbook('Lore A', [{ keys: ['x'] }])
    expect(m.calls.saveWorldbookById).toEqual([['wb1', [{ keys: ['x'] }]]])
    // unknown name no-ops
    expect(await g.deleteWorldbook('Nope')).toBe(false)
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
