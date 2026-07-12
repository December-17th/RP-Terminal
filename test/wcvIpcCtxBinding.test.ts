import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMain } from 'electron'

/**
 * Card-trust-boundary issue 03 — WCV IPC ctx binding (cross-profile wall).
 *
 * A WCV card page runs with contextIsolation off, so page code can capture the preload's `ipcRenderer`
 * and reach ANY main channel — main-side ctx binding is the real boundary. Most WCV handlers already
 * resolve the session from `e.sender.id` (wcvManager.contextFor) and take no caller-supplied ids. These
 * tests pin the few channels that DO take a caller-supplied profileId/chatId (the host renderer's, which a
 * WCV card could reach): when the sender IS a bound WCV slot its supplied ids are ignored/overridden with
 * the slot's bound identity; when the sender is the host renderer the supplied ids are honored. In-profile
 * ops (including DELETES) still run against the bound profile — no capability gating was added.
 */

// The bound slot the resolver returns for a WCV-page sender; a foreign chat/profile a card might try.
const WCV_ID = 101
const RENDERER_ID = 1
const SLOT = { slotId: 's1', profileId: 'pA', chatId: 'cA', characterId: 'charA' }

// vi.mock factories are hoisted above top-level vars, so the shared mock fns must be created via
// vi.hoisted (which runs first) and referenced through `h` in both the factories and the tests.
const h = vi.hoisted(() => ({
  contextFor: vi.fn(),
  ensure: vi.fn(),
  destroy: vi.fn(),
  notifyEvent: vi.fn(),
  notifyVarsChanged: vi.fn(),
  requestOverlay: vi.fn(() => true),
  pushHostReload: vi.fn(),
  pushHostVars: vi.fn(),
  // A card exists ONLY at (pA, charA) with a declared overlay 'ov1'. If a handler wrongly used a foreign
  // profile, getCharacter returns undefined ⇒ the overlay decl resolves null ⇒ requestOverlay gets null.
  getCharacter: vi.fn((profileId: string, characterId: string) =>
    profileId === 'pA' && characterId === 'charA'
      ? {
          data: {
            extensions: { rp_terminal: { panel_ui: { overlays: [{ id: 'ov1', entry: 'ov.html' }] } } }
          }
        }
      : undefined
  ),
  getChat: vi.fn(() => null),
  deleteChatMessages: vi.fn(() => true),
  afterChatMutation: vi.fn(() => null)
}))

vi.mock('../src/main/services/wcvManager', () => ({
  contextFor: h.contextFor,
  ensure: h.ensure,
  destroy: h.destroy,
  notifyEvent: h.notifyEvent,
  notifyVarsChanged: h.notifyVarsChanged,
  requestOverlay: h.requestOverlay,
  pushHostReload: h.pushHostReload,
  pushHostVars: h.pushHostVars
}))
vi.mock('../src/main/services/characterService', () => ({ getCharacter: h.getCharacter }))
vi.mock('../src/main/services/chatService', () => ({ getChat: h.getChat }))
vi.mock('../src/main/services/chatWriteService', () => ({
  deleteChatMessages: h.deleteChatMessages,
  afterChatMutation: h.afterChatMutation
}))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

// The remaining wcvIpc imports are never exercised by these tests; stub them so importing wcvIpc doesn't
// pull the real DB-touching service modules into the Node test run.
vi.mock('../src/main/ipc/worldAssetIpc', () => ({ pickAndImportAssetForCard: vi.fn() }))
vi.mock('../src/main/services/duelPreviewService', () => ({ computeDuelPreview: vi.fn() }))
vi.mock('../src/main/services/chatCardVarsService', () => ({
  getChatCardVars: vi.fn(),
  setChatCardVars: vi.fn()
}))
vi.mock('../src/main/services/floorService', () => ({ getAllFloors: vi.fn(() => []) }))
vi.mock('../src/main/services/generationService', () => ({}))
vi.mock('../src/main/services/lorebookService', () => ({}))
vi.mock('../src/main/services/scriptApiService', () => ({}))
vi.mock('../src/main/services/regexService', () => ({}))
vi.mock('../src/main/services/pluginStorageService', () => ({}))
vi.mock('../src/main/services/pluginService', () => ({}))
vi.mock('../src/main/services/settingsService', () => ({}))
vi.mock('../src/main/services/worldAssetService', () => ({}))
vi.mock('../src/main/services/presetService', () => ({ getActivePresetId: vi.fn(() => '') }))

import { registerWcvIpc } from '../src/main/ipc/wcvIpc'

// Fake ipcMain that records every handler by channel so a test can invoke it with a synthetic event.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const fakeIpcMain = {
  on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)
} as unknown as IpcMain

const evt = (senderId: number): unknown => ({ sender: { id: senderId } })
const call = (channel: string, senderId: number, ...args: unknown[]): unknown =>
  handlers.get(channel)!(evt(senderId), ...args)

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  h.contextFor.mockImplementation((id: number) => (id === WCV_ID ? SLOT : null))
  h.deleteChatMessages.mockReturnValue(true)
  registerWcvIpc(fakeIpcMain)
})

describe('wcv-ensure — slot (re)binding is host-renderer-only', () => {
  it('ignores an ensure from a WCV card page (would rebind a slot to another profile)', () => {
    call('wcv-ensure', WCV_ID, 's1', {}, 'url', { profileId: 'pEVIL', chatId: 'cEVIL' })
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it('runs an ensure from the host renderer (not a slot)', () => {
    const ctx = { profileId: 'pA', chatId: 'cA' }
    call('wcv-ensure', RENDERER_ID, 's1', { x: 0 }, 'url', ctx)
    expect(h.ensure).toHaveBeenCalledWith('s1', { x: 0 }, 'url', ctx)
  })
})

describe('wcv-destroy — native teardown leaves the IPC callback', () => {
  it('defers WebContentsView destruction until the next main-loop turn', async () => {
    call('wcv-destroy', RENDERER_ID, 's1')
    expect(h.destroy).not.toHaveBeenCalled()

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.destroy).toHaveBeenCalledWith('s1')
  })

  it('a re-ensure for the same id before the deferred turn CANCELS the teardown (remount race)', async () => {
    // React's cleanup→body pair: unmount fires wcv-destroy, the immediate remount fires wcv-ensure for the
    // same slot. The deferred destroy must NOT close the view the remount just re-bound.
    call('wcv-destroy', RENDERER_ID, 's1')
    call('wcv-ensure', RENDERER_ID, 's1', { x: 0 }, 'url', { profileId: 'pA', chatId: 'cA' })

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.destroy).not.toHaveBeenCalled()
    expect(h.ensure).toHaveBeenCalledWith('s1', { x: 0 }, 'url', { profileId: 'pA', chatId: 'cA' })
  })
})

describe('broadcast/button channels — WCV sender confined to its bound chat', () => {
  it('wcv-broadcast-vars: overrides a foreign chatId with the bound chat for a WCV sender', () => {
    call('wcv-broadcast-vars', WCV_ID, 'cEVIL', { hp: 1 }, 'card-write')
    expect(h.notifyVarsChanged).toHaveBeenCalledWith('cA', { hp: 1 }, undefined, 'card-write')
  })

  it('wcv-broadcast-vars: honors the caller chatId for a host-renderer sender', () => {
    call('wcv-broadcast-vars', RENDERER_ID, 'cX', { hp: 2 }, 'model-fold')
    expect(h.notifyVarsChanged).toHaveBeenCalledWith('cX', { hp: 2 }, undefined, 'model-fold')
  })

  it('wcv-broadcast-event: overrides a foreign chatId for a WCV sender', () => {
    call('wcv-broadcast-event', WCV_ID, 'cEVIL', 'evt', { a: 1 })
    expect(h.notifyEvent).toHaveBeenCalledWith('cA', 'evt', { a: 1 })
  })

  it('wcv-broadcast-event: honors the caller chatId for a host-renderer sender', () => {
    call('wcv-broadcast-event', RENDERER_ID, 'cX', 'evt', { a: 1 })
    expect(h.notifyEvent).toHaveBeenCalledWith('cX', 'evt', { a: 1 })
  })

  it('wcv-button-click: overrides a foreign chatId for a WCV sender', () => {
    call('wcv-button-click', WCV_ID, 'cEVIL', 'btn')
    expect(h.notifyEvent).toHaveBeenCalledWith('cA', 'btn', undefined)
  })

  it('wcv-button-click: honors the caller chatId for a host-renderer sender', () => {
    call('wcv-button-click', RENDERER_ID, 'cX', 'btn')
    expect(h.notifyEvent).toHaveBeenCalledWith('cX', 'btn', undefined)
  })
})

describe('overlay-request — WCV sender resolved against its own profile', () => {
  it('uses the slot ctx (not caller-supplied ids) for a WCV sender', () => {
    // Caller supplies a FOREIGN profile; if honored, resolveOverlayDecl(getCharacter) misses ⇒ null decl.
    call('overlay-request', WCV_ID, 'pEVIL', 'cEVIL', 'charEVIL', 'ov1')
    expect(h.getCharacter).toHaveBeenCalledWith('pA', 'charA')
    expect(h.requestOverlay).toHaveBeenCalledWith('ov1', { entry: 'ov.html', title: undefined })
  })

  it('honors explicit ctx for a host-renderer (inline) sender', () => {
    call('overlay-request', RENDERER_ID, 'pA', 'cA', 'charA', 'ov1')
    expect(h.getCharacter).toHaveBeenCalledWith('pA', 'charA')
    expect(h.requestOverlay).toHaveBeenCalledWith('ov1', { entry: 'ov.html', title: undefined })
  })
})

describe('in-profile ops still run for a WCV card (deletes included)', () => {
  it('wcv-host-delete-chat-messages deletes within the bound profile/chat', () => {
    const out = call('wcv-host-delete-chat-messages', WCV_ID, [0, 1])
    expect(h.deleteChatMessages).toHaveBeenCalledWith('pA', 'cA', [0, 1])
    expect(out).toBe(true)
  })
})
