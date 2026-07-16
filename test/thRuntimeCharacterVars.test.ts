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
})
