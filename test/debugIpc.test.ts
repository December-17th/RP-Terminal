import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMain } from 'electron'

/**
 * WP-D1 — the separate Debug window IPC. `registerDebugIpc` must register an 'open-debug-window'
 * handler, and invoking it must delegate to the singleton service (which opens/focuses the window).
 * The service is mocked so this stays a pure registration+delegation test with no BrowserWindow.
 */

const h = vi.hoisted(() => ({ openDebugWindow: vi.fn() }))
vi.mock('../src/main/services/debugWindowService', () => ({ openDebugWindow: h.openDebugWindow }))

import { registerDebugIpc } from '../src/main/ipc/debugIpc'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)
} as unknown as IpcMain

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerDebugIpc(fakeIpcMain)
})

describe('registerDebugIpc', () => {
  it('registers the open-debug-window handler', () => {
    expect(handlers.has('open-debug-window')).toBe(true)
  })

  it('opens (or focuses) the debug window when invoked', () => {
    handlers.get('open-debug-window')!({})
    expect(h.openDebugWindow).toHaveBeenCalledTimes(1)
  })
})
