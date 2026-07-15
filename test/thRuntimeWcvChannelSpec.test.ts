// test/thRuntimeWcvChannelSpec.test.ts
//
// Stage-2 unit test (ADR 0013): the WCV preload adapter is GENERATED from WCV_CHANNEL_SPEC. This pins the
// spec-driven behavior — each member hits its declared channel with its declared kind, args pass through,
// and sync members return their declared fallback when the blocking read throws. The spec's member set is
// asserted (compile-time + runtime) to be exactly `keyof Host` minus the hand-written residue.
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  sendSync: vi.fn((..._a: any[]) => ({ ok: true })),
  invoke: vi.fn((..._a: any[]) => Promise.resolve('invoked')),
  send: vi.fn((..._a: any[]) => undefined),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({ ipcRenderer: ipc }))

import { createWcvHost } from '../src/preload/wcvHost'
import {
  WCV_CHANNEL_SPEC,
  WCV_CHANNELS,
  type WcvSpecMember,
  type WcvResidueMember
} from '../src/shared/thRuntime/wcvChannelSpec'
import type { Host } from '../src/shared/thRuntime/types'

// --- Compile-time completeness: spec members ⊍ residue members partition keyof Host exactly. A new Host
// member left out of both (or listed in both) fails to compile here.
type Assert<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type _PartitionsHost = Assert<Equal<keyof Host, WcvSpecMember | WcvResidueMember>>
const _partitions: _PartitionsHost = true
void _partitions

const makeHost = (): Host =>
  createWcvHost({
    ctx: { profileId: '', chatId: '', characterId: '' },
    evalTemplate: () => '',
    evalTemplateError: () => null,
    prepareContext: () => ({})
  })

describe('WCV_CHANNEL_SPEC drives createWcvHost', () => {
  beforeEach(() => {
    ipc.sendSync.mockReset().mockReturnValue({ ok: true })
    ipc.invoke.mockReset().mockResolvedValue('invoked')
    ipc.send.mockReset()
  })

  it('spec + residue partition keyof Host, and WCV_CHANNELS mirrors it', () => {
    // Runtime sanity count (compile-time Equal<> above does the real completeness check).
    expect(Object.keys(WCV_CHANNEL_SPEC).length).toBe(47)
    for (const [member, spec] of Object.entries(WCV_CHANNEL_SPEC)) {
      expect(WCV_CHANNELS[member as WcvSpecMember]).toBe(spec.channel)
    }
  })

  it('each member calls its declared channel with its declared kind, forwarding args', () => {
    const host = makeHost() as any
    for (const [member, spec] of Object.entries(WCV_CHANNEL_SPEC)) {
      ipc.sendSync.mockClear()
      ipc.invoke.mockClear()
      ipc.send.mockClear()
      host[member]('a0', 'a1')
      const call = [spec.channel, 'a0', 'a1']
      if (spec.kind === 'sync') {
        expect(ipc.sendSync, member).toHaveBeenCalledWith(...call)
        expect(ipc.invoke).not.toHaveBeenCalled()
        expect(ipc.send).not.toHaveBeenCalled()
      } else if (spec.kind === 'send') {
        expect(ipc.send, member).toHaveBeenCalledWith(...call)
        expect(ipc.sendSync).not.toHaveBeenCalled()
        expect(ipc.invoke).not.toHaveBeenCalled()
      } else {
        expect(ipc.invoke, member).toHaveBeenCalledWith(...call)
        expect(ipc.sendSync).not.toHaveBeenCalled()
        expect(ipc.send).not.toHaveBeenCalled()
      }
    }
  })

  it('sync members return their declared fallback when the blocking read throws', () => {
    const host = makeHost() as any
    for (const [member, spec] of Object.entries(WCV_CHANNEL_SPEC)) {
      if (spec.kind !== 'sync') continue
      ipc.sendSync.mockImplementation(() => {
        throw new Error('boom')
      })
      expect(host[member](), member).toEqual(spec.fallback)
    }
  })

  it('sync members pass through a non-null result (fallback only on null/undefined)', () => {
    const host = makeHost() as any
    for (const [member, spec] of Object.entries(WCV_CHANNEL_SPEC)) {
      if (spec.kind !== 'sync') continue
      const sentinel = { sentinel: member }
      ipc.sendSync.mockReturnValue(sentinel)
      expect(host[member](), member).toBe(sentinel)
      // null/undefined result coalesces to the fallback
      ipc.sendSync.mockReturnValue(null)
      expect(host[member](), member).toEqual(spec.fallback)
    }
  })
})
