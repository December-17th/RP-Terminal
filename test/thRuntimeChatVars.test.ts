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
