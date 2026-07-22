import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const importedResult = {
    id: 'new-card',
    summary: {
      name: 'World',
      isWorldCard: false,
      regexScripts: 0,
      loreEntries: 0,
      scripts: 0,
      uiWidgets: 0,
      presets: 0,
      lorebooks: 0,
      workflows: 0,
      tableTemplates: 0,
      pluginsSkipped: 0,
      assetsImported: 0
    }
  }
  return {
    importCharacter: vi.fn((_profileId: string, _file: string, _assets: unknown, options: any) => {
      // Faithful to characterService: a resolution is valid when it renames to a free name, skips, or
      // replaces. (The `Unique` rename target stands in for "a free name"; `Taken`/same-name is rejected.)
      const resolution = options.agentResolutions?.Shared
      const ok =
        (resolution?.action === 'rename' && resolution.newName === 'Unique') ||
        resolution?.action === 'skip' ||
        resolution?.action === 'replace'
      return ok ? importedResult : null
    })
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['card.json'] })),
    showMessageBox: vi.fn(async () => ({ response: 0 }))
  }
}))
vi.mock('../src/main/services/settingsService', () => ({
  getSettings: () => ({ ui: { locale: 'en' } })
}))
vi.mock('../src/main/services/characterService', () => ({
  parseCardFile: () => ({ card: { data: { creator: '', character_version: '1' } } }),
  summarizeCardBundle: () => ({
    name: 'World',
    isWorldCard: false,
    regexScripts: 0,
    loreEntries: 0,
    scripts: 0,
    uiWidgets: 0,
    presets: 0,
    lorebooks: 0,
    workflows: 0,
    tableTemplates: 0,
    pluginsSkipped: 0,
    assetsImported: 0
  }),
  findMatchingCharacter: () => [],
  hasBundle: () => false,
  characterAgentImportInspection: () => ({
    incomingAgents: ['Shared'],
    collisions: [
      { incomingName: 'Shared', existing: { id: 'existing', name: 'Shared', builtin: false } }
    ],
    requiredRenames: ['Shared']
  }),
  importCharacterFromFile: hoisted.importCharacter,
  updateCharacterInPlace: vi.fn(),
  replaceCharacterFromFile: vi.fn(),
  getCharacters: vi.fn(),
  getAvatarDataUrl: vi.fn(),
  saveCharacter: vi.fn(),
  deleteCharacter: vi.fn(),
  exportWorldCard: vi.fn()
}))

import type { IpcMainInvokeEvent } from 'electron'
import { registerCharacterIpc } from '../src/main/ipc/characterIpc'
import { setGuardMainWindow } from '../src/main/ipc/ipcGuards'

describe('character Agent collision IPC continuation', () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const mainFrame = {}
  const sender = { mainFrame }
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent

  beforeEach(() => {
    handlers.clear()
    hoisted.importCharacter.mockClear()
    setGuardMainWindow({ webContents: sender, on: () => undefined } as never)
    registerCharacterIpc({
      handle: (channel: string, handler: (...args: any[]) => unknown) =>
        void handlers.set(channel, handler)
    } as never)
  })

  it('returns inspection, keeps the token retryable after invalid renames, then confirms', async () => {
    const inspection = await handlers.get('import-character-dialog')!(event, 'profile')
    expect(inspection).toMatchObject({
      status: 'agent-collisions',
      incomingAgents: ['Shared'],
      requiredRenames: ['Shared']
    })

    expect(
      handlers.get('confirm-character-import')!(event, inspection.token, {
        Shared: { action: 'rename', newName: 'Shared' }
      })
    ).toMatchObject({ status: 'invalid-renames', errorCode: 'INVALID_RENAMES' })
    expect(
      handlers.get('confirm-character-import')!(event, inspection.token, {
        Shared: { action: 'rename', newName: 'Unique' }
      })
    ).toMatchObject({ status: 'imported', id: 'new-card' })
  })

  it('imports via a skip resolution', async () => {
    const inspection = await handlers.get('import-character-dialog')!(event, 'profile')
    const result = handlers.get('confirm-character-import')!(event, inspection.token, {
      Shared: { action: 'skip' }
    })
    expect(result).toMatchObject({ status: 'imported', id: 'new-card' })
    expect(hoisted.importCharacter).toHaveBeenCalledWith(
      'profile',
      expect.anything(),
      undefined,
      expect.objectContaining({ agentResolutions: { Shared: { action: 'skip' } } })
    )
  })

  it('imports via a replace resolution', async () => {
    const inspection = await handlers.get('import-character-dialog')!(event, 'profile')
    expect(
      handlers.get('confirm-character-import')!(event, inspection.token, {
        Shared: { action: 'replace' }
      })
    ).toMatchObject({ status: 'imported', id: 'new-card' })
  })

  it('keeps the token retryable when the service rejects a resolution (e.g. replace on a built-in)', async () => {
    const inspection = await handlers.get('import-character-dialog')!(event, 'profile')
    // Simulate the service rejecting this resolution (reconcile throws REPLACE_BUILTIN → null).
    hoisted.importCharacter.mockImplementationOnce(() => null)
    expect(
      handlers.get('confirm-character-import')!(event, inspection.token, {
        Shared: { action: 'replace' }
      })
    ).toMatchObject({ status: 'invalid-renames', errorCode: 'INVALID_RENAMES' })
    // The token survives, so a follow-up valid resolution still imports.
    expect(
      handlers.get('confirm-character-import')!(event, inspection.token, {
        Shared: { action: 'skip' }
      })
    ).toMatchObject({ status: 'imported', id: 'new-card' })
  })

  it('cancels a staged import and expires its token', async () => {
    const inspection = await handlers.get('import-character-dialog')!(event, 'profile')
    expect(
      await handlers.get('cancel-character-import')!(event, inspection.token)
    ).toEqual({ ok: true })
    expect(
      handlers.get('confirm-character-import')!(event, inspection.token, {
        Shared: { action: 'rename', newName: 'Unique' }
      })
    ).toMatchObject({ status: 'failed', errorCode: 'REQUEST_EXPIRED' })
    expect(hoisted.importCharacter).not.toHaveBeenCalled()
  })
})
