import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'

function fakeHost(over = {}) {
  let kv: Record<string, any> = {}
  const applyVariableOps = vi.fn(async () => {})
  return {
    ...createNullHost(),
    getScriptVars: vi.fn(() => kv),
    setScriptVars: vi.fn(async (value: Record<string, any>) => {
      kv = value
    }),
    applyVariableOps,
    ...over
  } as any
}

describe('createThRuntime character variables', () => {
  it('reads the per-character card KV', () => {
    const host = fakeHost({
      getScriptVars: () => ({ start_presets: { presets: [{ name: 'A' }] } })
    })
    const runtime = createThRuntime(host)
    expect(runtime.getVariables({ type: 'character' })).toEqual({
      start_presets: { presets: [{ name: 'A' }] }
    })
  })

  it('round-trips an imported preset without touching stat_data', async () => {
    const host = fakeHost()
    const runtime = createThRuntime(host)
    const storage = { presets: [{ name: 'Start A', createdAt: 1, updatedAt: 1 }] }
    await runtime.insertOrAssignVariables({ start_presets: storage }, { type: 'character' })
    expect(runtime.getVariables({ type: 'character' })).toEqual({ start_presets: storage })
    expect(host.applyVariableOps).not.toHaveBeenCalled()
  })

  it('preserves sibling character keys while merging', async () => {
    const runtime = createThRuntime(fakeHost())
    await runtime.insertOrAssignVariables({ status_theme_id: 'celadon' }, { type: 'character' })
    await runtime.insertOrAssignVariables({ start_presets: { presets: [] } }, { type: 'character' })
    expect(runtime.getVariables({ type: 'character' })).toEqual({
      status_theme_id: 'celadon',
      start_presets: { presets: [] }
    })
  })

  it('whole-replaces the character bag', async () => {
    const host = fakeHost()
    const runtime = createThRuntime(host)
    await runtime.replaceVariables({ fresh: 2 }, { type: 'character' })
    expect(host.setScriptVars).toHaveBeenCalledWith({ fresh: 2 })
    expect(host.applyVariableOps).not.toHaveBeenCalled()
  })

  it('read-modify-writes the character bag', async () => {
    const runtime = createThRuntime(fakeHost())
    await runtime.insertOrAssignVariables(
      { start_presets: { presets: [{ name: 'A' }] } },
      { type: 'character' }
    )
    const next = await runtime.updateVariablesWith(
      (value: any) => ({
        ...value,
        start_presets: { presets: [...value.start_presets.presets, { name: 'B' }] }
      }),
      { type: 'character' }
    )
    expect(next.start_presets.presets).toEqual([{ name: 'A' }, { name: 'B' }])
    expect(runtime.getVariables({ type: 'character' })).toEqual(next)
  })

  it('deletes a character key without disturbing siblings', async () => {
    const runtime = createThRuntime(fakeHost())
    await runtime.insertOrAssignVariables(
      { status_theme_id: 'cinnabar', start_presets: { presets: [] } },
      { type: 'character' }
    )
    expect(await runtime.deleteVariable('status_theme_id', { type: 'character' })).toBe(true)
    expect(runtime.getVariables({ type: 'character' })).toEqual({ start_presets: { presets: [] } })
    expect(await runtime.deleteVariable('missing', { type: 'character' })).toBe(false)
  })

  it('deletes a default-scope key with an escaped JSON pointer', async () => {
    const host = fakeHost({ statData: () => ({ 'a/b~c': 1 }) })
    const runtime = createThRuntime(host)
    expect(await runtime.deleteVariable('a/b~c')).toBe(true)
    expect(host.applyVariableOps).toHaveBeenCalledWith([{ op: 'remove', path: '/a~1b~0c' }])
  })

  it('does not report prototype-chain properties as deleted', async () => {
    const inherited = Object.create({ inherited: 1 })
    const host = fakeHost({
      statData: () => inherited,
      getScriptVars: () => inherited
    })
    const runtime = createThRuntime(host)

    expect(await runtime.deleteVariable('inherited')).toBe(false)
    expect(await runtime.deleteVariable('inherited', { type: 'character' })).toBe(false)
    expect(host.applyVariableOps).not.toHaveBeenCalled()
    expect(host.setScriptVars).not.toHaveBeenCalled()
  })

  it('deletes dotted paths from card, chat, global, and default scopes', async () => {
    const host = fakeHost({
      statData: () => ({ player: { stats: { hp: 10, mp: 5 } } }),
      getScriptVars: () => ({ settings: { theme: 'dark', accent: 'blue' } }),
      getChatVars: () => ({ session: { draft: 'text', turn: 3 } }),
      getGlobalVarsSync: () => ({ preferences: { locale: 'en', density: 'compact' } }),
      setChatVars: vi.fn(async () => {}),
      setGlobalVars: vi.fn(async () => {})
    })
    const runtime = createThRuntime(host)

    expect(await runtime.deleteVariable('settings.theme', { type: 'character' })).toBe(true)
    expect(host.setScriptVars).toHaveBeenCalledWith({ settings: { accent: 'blue' } })

    expect(await runtime.deleteVariable('session.draft', { type: 'chat' })).toBe(true)
    expect(host.setChatVars).toHaveBeenCalledWith({ session: { turn: 3 } })

    expect(await runtime.deleteVariable('preferences.locale', { type: 'global' })).toBe(true)
    expect(host.setGlobalVars).toHaveBeenCalledWith({ preferences: { density: 'compact' } })

    expect(await runtime.deleteVariable('player.stats.hp')).toBe(true)
    expect(runtime.getVariables()).toEqual({ stat_data: { player: { stats: { mp: 5 } } } })
    expect(host.applyVariableOps).toHaveBeenCalledWith([{ op: 'remove', path: '/player/stats/hp' }])
  })

  it('deletes bracketed array paths and rejects malformed paths', async () => {
    const host = fakeHost({
      statData: () => ({ players: [{ stats: { hp: 10, mp: 5 } }] }),
      getScriptVars: () => ({ characters: [{ secret: 'x', visible: true }] })
    })
    const runtime = createThRuntime(host)

    expect(await runtime.deleteVariable('characters[0].secret', { type: 'character' })).toBe(true)
    expect(host.setScriptVars).toHaveBeenCalledWith({ characters: [{ visible: true }] })

    expect(await runtime.deleteVariable('players[0].stats.hp')).toBe(true)
    expect(runtime.getVariables()).toEqual({
      stat_data: { players: [{ stats: { mp: 5 } }] }
    })
    expect(host.applyVariableOps).toHaveBeenCalledWith([
      { op: 'remove', path: '/players/0/stats/hp' }
    ])

    host.applyVariableOps.mockClear()
    expect(await runtime.deleteVariable('players[]')).toBe(false)
    expect(await runtime.deleteVariable('players..0')).toBe(false)
    expect(await runtime.deleteVariable('')).toBe(false)
    expect(host.applyVariableOps).not.toHaveBeenCalled()
  })
})
