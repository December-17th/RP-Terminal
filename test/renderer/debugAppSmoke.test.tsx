// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/**
 * WP-D1 — the separate Debug window's standalone shell (DebugApp). Mounts it against a stubbed
 * window.api and asserts it seeds the Logs panel from getLogs() and renders the log entries. This
 * pins that the debug window is self-contained: it wires its own log seed + onLog subscription
 * without pulling in the full app shell (chat/character stores).
 */

let seeded: unknown[] = []
const apiOverrides: Record<string, (...args: unknown[]) => unknown> = {
  getLogs: async () => seeded,
  clearLogs: async () => {},
  onLog: () => () => {}
}

const apiStub = new Proxy(apiOverrides, {
  get(target, prop: string) {
    if (prop in target) return target[prop]
    if (prop.startsWith('on')) return () => () => {}
    return () => undefined
  }
})

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = apiStub
  // jsdom implements neither; DebugApp's theme effect calls matchMedia, LogsPanel autoscrolls.
  if (!window.matchMedia) {
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  seeded = []
})

describe('DebugApp (separate Debug window shell)', () => {
  it('mounts, shows the Logs tab, and renders seeded log entries', async () => {
    seeded = [
      { id: 'log-1', ts: '2026-07-23T00:00:00.000Z', level: 'info', label: 'Boot complete' }
    ]
    const { useLogStore } = await import('../../src/renderer/src/stores/logStore')
    useLogStore.setState({ entries: [] })
    const { DebugApp } = await import('../../src/renderer/src/components/debug/DebugApp')
    const view = render(<DebugApp />)

    expect(view.getByRole('tab', { name: 'Logs' })).toBeTruthy()
    expect(await view.findByText('Boot complete')).toBeTruthy()
  })
})
