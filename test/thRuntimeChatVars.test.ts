import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'

function fakeHost(over = {}) {
  let chat: Record<string, any> = { 'party.members': ['爱莎'] }
  return {
    ...createNullHost(),
    getChatVars: vi.fn(() => chat),
    setChatVars: vi.fn(async (v: Record<string, any>) => {
      chat = v
    }),
    ...over
  } as any
}

describe('createThRuntime — type:chat per-chat KV', () => {
  it('getVariables({type:chat}) returns host.getChatVars()', () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    expect(g.getVariables({ type: 'chat' })).toEqual({ 'party.members': ['爱莎'] })
    expect(host.getChatVars).toHaveBeenCalled()
  })

  it('updateVariablesWith(updater,{type:chat}) read-modify-writes via setChatVars', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    const next = await g.updateVariablesWith(
      (v: any) => ({ ...v, 'party.members': [...(v['party.members'] || []), '凯尔'] }),
      { type: 'chat' }
    )
    expect(next).toEqual({ 'party.members': ['爱莎', '凯尔'] })
    expect(host.setChatVars).toHaveBeenCalledWith({ 'party.members': ['爱莎', '凯尔'] })
  })

  it('replaceVariables(obj,{type:chat}) full-replaces via setChatVars and does NOT touch stat_data', async () => {
    const applyVariableOps = vi.fn(async () => {})
    const host = fakeHost({ applyVariableOps })
    const g = createThRuntime(host)
    await g.replaceVariables({ 'party.stripPos': { x: 5, y: 5 } }, { type: 'chat' })
    expect(host.setChatVars).toHaveBeenCalledWith({ 'party.stripPos': { x: 5, y: 5 } })
    expect(applyVariableOps).not.toHaveBeenCalled()
  })
})

// Upstream (SillyTavern), local variables and TavernHelper's `type:'chat'` bag are ONE store
// (`chat_metadata.variables`). RPT splits them — the floor's top-level variables (what a lorebook/preset
// `setvar`/`setLocalVar` writes) vs. the per-chat card KV — so a chat-scope READ merges them, with the card
// KV on top. Writes stay on the card KV alone.
describe('createThRuntime — type:chat reads layer the card KV over the floor local vars', () => {
  // A floor bag as it actually looks: MVU's message-scope keys alongside the template-engine local vars.
  const floorHost = (over = {}) =>
    fakeHost({
      getFloorVars: vi.fn(() => ({
        char_info_visuals: { 艾琪奈夏: 'https://example.invalid/a.png' },
        world_phase: 'dusk'
      })),
      ...over
    })

  it('exposes a floor local var the per-chat KV does not have', () => {
    const host = floorHost()
    const g = createThRuntime(host)
    expect(g.getVariables({ type: 'chat' })).toEqual({
      char_info_visuals: { 艾琪奈夏: 'https://example.invalid/a.png' },
      world_phase: 'dusk',
      'party.members': ['爱莎']
    })
    expect(host.getFloorVars).toHaveBeenCalled()
  })

  it('the per-chat KV wins on a colliding key', () => {
    const host = floorHost({ getChatVars: vi.fn(() => ({ world_phase: 'card-owned' })) })
    const g = createThRuntime(host)
    expect(g.getVariables({ type: 'chat' }).world_phase).toBe('card-owned')
  })

  it('does NOT expose stat_data / delta_data in chat scope', () => {
    // The host's getFloorVars already omits them (shapes.floorLocalVars); this pins that the runtime
    // adds nothing back — the message scope stays reachable only through getVariables() with no option.
    const host = floorHost({
      getFloorVars: () => ({ char_info_visuals: { a: 1 } }),
      statData: () => ({ hp: 3 })
    })
    const g = createThRuntime(host)
    const chatScope = g.getVariables({ type: 'chat' })
    expect(chatScope).not.toHaveProperty('stat_data')
    expect(chatScope).not.toHaveProperty('delta_data')
    expect(g.getVariables()).toEqual({ stat_data: { hp: 3 } })
  })

  it('write paths read+write ONLY the card KV (a floor local var is never persisted into it)', async () => {
    const host = floorHost()
    const g = createThRuntime(host)

    // read-modify-write: the updater must see the card KV alone, and the persisted object must not
    // acquire char_info_visuals / world_phase.
    const seen = await g.updateVariablesWith(
      (v: any) => ({ ...v, 'party.stripPos': { x: 1, y: 2 } }),
      {
        type: 'chat'
      }
    )
    expect(seen).toEqual({ 'party.members': ['爱莎'], 'party.stripPos': { x: 1, y: 2 } })
    expect(host.setChatVars).toHaveBeenLastCalledWith({
      'party.members': ['爱莎'],
      'party.stripPos': { x: 1, y: 2 }
    })

    await g.replaceVariables({ only: 'this' }, { type: 'chat' })
    expect(host.setChatVars).toHaveBeenLastCalledWith({ only: 'this' })

    // deleteVariable on a FLOOR key is a miss (it isn't in the card KV) and must not write.
    host.setChatVars.mockClear()
    expect(await g.deleteVariable('char_info_visuals', { type: 'chat' })).toBe(false)
    expect(host.setChatVars).not.toHaveBeenCalled()

    // deleting a real card-KV key still works and persists only the card KV.
    expect(await g.deleteVariable('only', { type: 'chat' })).toBe(true)
    expect(host.setChatVars).toHaveBeenLastCalledWith({})
  })
})
