// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

/**
 * Execution-plan M5b2, task B — the Memory Maintenance Agent settings strip in the Memory sheet's
 * Maintenance area. Mounts the component against a stubbed window.api and asserts the three controls
 * read the built-in Agent (matched by its stable source key) and write back through the agentCatalog
 * IPC: enabled → setAgentEnabled, API preset → setAgentInvocationConfig, cadence → editAgent (a trigger
 * patch on the definition).
 */

const calls = {
  setEnabled: vi.fn(async () => ({ ok: true })),
  editAgent: vi.fn(async () => ({ ok: true })),
  setInvocationConfig: vi.fn(async () => ({ ok: true }))
}

const apiOverrides: Record<string, (...args: unknown[]) => unknown> = {
  listAgentCatalog: async () => [
    {
      id: 'mem-1',
      name: 'Memory Maintenance',
      sourceKind: 'builtin',
      sourceKey: 'memory-maintenance',
      sourceVersion: '1',
      sourcePresent: true,
      enabled: true,
      customized: false,
      upgradeAvailable: false,
      blocksNextTurn: false,
      resultMode: 'text',
      promptMessages: 1,
      promptChars: 10,
      roles: [],
      updatedAt: 'now'
    }
  ],
  getAgentDefinition: async () => ({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Memory Maintenance',
    prompt: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }],
    result: { mode: 'text' },
    trigger: { onFloorCommitted: { everyNFloors: 3 } }
  }),
  getAgentInvocationConfig: async () => ({ apiPresetId: '' }),
  getSettings: async () => ({ api_presets: [{ id: 'preset-2', name: 'Cheap' }] }),
  setAgentEnabled: (...a: unknown[]) => calls.setEnabled(...(a as [])),
  editAgent: (...a: unknown[]) => calls.editAgent(...(a as [])),
  setAgentInvocationConfig: (...a: unknown[]) => calls.setInvocationConfig(...(a as []))
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
  calls.setEnabled.mockClear()
  calls.editAgent.mockClear()
  calls.setInvocationConfig.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('MemoryMaintenanceSettings strip', () => {
  it('renders the built-in Agent settings and writes each control through the catalog IPC', async () => {
    const { MemoryMaintenanceSettings } = await import(
      '../../src/renderer/src/components/memory/MemoryManagerView'
    )
    const view = render(<MemoryMaintenanceSettings profileId="p1" />)

    // Cadence input paints the Agent's current everyNFloors once the async load resolves.
    const cadence = (await view.findByDisplayValue('3')) as HTMLInputElement
    expect(cadence.type).toBe('number')

    // Enabled toggle → setAgentEnabled(profileId, id, false).
    const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    await waitFor(() => expect(calls.setEnabled).toHaveBeenCalledWith('p1', 'mem-1', false))

    // Cadence edit → editAgent with the trigger patched to the new value.
    fireEvent.change(cadence, { target: { value: '9' } })
    fireEvent.blur(cadence)
    await waitFor(() => expect(calls.editAgent).toHaveBeenCalled())
    const [, , patched] = calls.editAgent.mock.calls[0] as [string, string, any]
    expect(patched.trigger.onFloorCommitted.everyNFloors).toBe(9)

    // API preset select → setAgentInvocationConfig.
    const select = view.container.querySelector('select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'preset-2' } })
    await waitFor(() =>
      expect(calls.setInvocationConfig).toHaveBeenCalledWith('p1', 'mem-1', { apiPresetId: 'preset-2' })
    )
  })

  it('renders nothing when the built-in Memory Maintenance Agent is absent', async () => {
    apiOverrides.listAgentCatalog = async () => []
    const { MemoryMaintenanceSettings } = await import(
      '../../src/renderer/src/components/memory/MemoryManagerView'
    )
    const { container } = render(<MemoryMaintenanceSettings profileId="p1" />)
    await waitFor(() => expect(container.querySelector('.rpt-mm-agent-strip')).toBeNull())
    // Restore for any later test in the file.
    apiOverrides.listAgentCatalog = async () => [
      {
        id: 'mem-1',
        name: 'Memory Maintenance',
        sourceKind: 'builtin',
        sourceKey: 'memory-maintenance',
        sourceVersion: '1',
        sourcePresent: true,
        enabled: true,
        customized: false,
        upgradeAvailable: false,
        blocksNextTurn: false,
        resultMode: 'text',
        promptMessages: 1,
        promptChars: 10,
        roles: [],
        updatedAt: 'now'
      }
    ]
  })
})
