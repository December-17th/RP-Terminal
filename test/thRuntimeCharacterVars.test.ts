import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'

// TavernHelper's `type:'character'` (per-character, cross-chat card variables) is aliased onto RPT's
// per-character card KV — the same bag as `type:'script'` (host.getScriptVars/setScriptVars). These tests
// exercise the real failing case: 命定之诗's custom-start stores its character build presets under a
// character variable (`start_presets`), so `getVariables`/`insertOrAssignVariables`/`deleteVariable` with
// `{type:'character'}` must round-trip through that KV — NOT stat_data.
function fakeHost(over = {}) {
  let kv: Record<string, any> = {}
  const applyVariableOps = vi.fn(async () => {})
  return {
    ...createNullHost(),
    getScriptVars: vi.fn(() => kv),
    setScriptVars: vi.fn(async (v: Record<string, any>) => {
      kv = v
    }),
    applyVariableOps,
    ...over
  } as any
}

describe('createThRuntime — type:character (per-character card KV)', () => {
  it('getVariables({type:character}) reads the card KV', () => {
    const host = fakeHost({ getScriptVars: () => ({ start_presets: { presets: [{ name: 'A' }] } }) })
    const g = createThRuntime(host)
    expect(g.getVariables({ type: 'character' })).toEqual({
      start_presets: { presets: [{ name: 'A' }] }
    })
  })

  it('insertOrAssignVariables round-trips a preset and never touches stat_data (the import path)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)

    const storage = { presets: [{ name: '开局A', createdAt: 1, updatedAt: 1 }], lastUsedPreset: '开局A' }
    await g.insertOrAssignVariables({ start_presets: storage }, { type: 'character' })

    // Written to the card KV, and readable back exactly (what the preset manager relies on).
    expect(host.setScriptVars).toHaveBeenCalled()
    expect(g.getVariables({ type: 'character' })).toEqual({ start_presets: storage })
    // Character-scope writes must NOT leak into the message/MVU stat_data.
    expect(host.applyVariableOps).not.toHaveBeenCalled()
  })

  it('insertOrAssignVariables merges, preserving sibling character keys', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    await g.insertOrAssignVariables({ status_theme_id: 'celadon' }, { type: 'character' })
    await g.insertOrAssignVariables({ start_presets: { presets: [] } }, { type: 'character' })
    expect(g.getVariables({ type: 'character' })).toEqual({
      status_theme_id: 'celadon',
      start_presets: { presets: [] }
    })
  })

  it('replaceVariables({type:character}) whole-replaces the KV', async () => {
    const host = fakeHost({ getScriptVars: vi.fn(() => ({ old: 1 })) })
    const g = createThRuntime(host)
    await g.replaceVariables({ fresh: 2 }, { type: 'character' })
    expect(host.setScriptVars).toHaveBeenCalledWith({ fresh: 2 })
    expect(host.applyVariableOps).not.toHaveBeenCalled()
  })

  it('updateVariablesWith({type:character}) read-modify-writes the KV', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    await g.insertOrAssignVariables({ start_presets: { presets: [{ name: 'A' }] } }, { type: 'character' })
    const next = await g.updateVariablesWith(
      (v: any) => ({ ...v, start_presets: { presets: [...v.start_presets.presets, { name: 'B' }] } }),
      { type: 'character' }
    )
    expect(next.start_presets.presets).toEqual([{ name: 'A' }, { name: 'B' }])
    expect(g.getVariables({ type: 'character' })).toEqual(next)
  })

  it('deleteVariable(key,{type:character}) removes the key from the KV (theme reset path)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    await g.insertOrAssignVariables(
      { status_theme_id: 'cinnabar', start_presets: { presets: [] } },
      { type: 'character' }
    )
    const removed = await g.deleteVariable('status_theme_id', { type: 'character' })
    expect(removed).toBe(true)
    expect(g.getVariables({ type: 'character' })).toEqual({ start_presets: { presets: [] } })
    // Deleting an absent key is a no-op that reports false.
    expect(await g.deleteVariable('nope', { type: 'character' })).toBe(false)
  })
})
