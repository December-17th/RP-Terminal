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
            extensions: {
              rp_terminal: { panel_ui: { overlays: [{ id: 'ov1', entry: 'ov.html' }] } }
            }
          }
        }
      : undefined
  ),
  getChat: vi.fn(() => null),
  getSettings: vi.fn(),
  deleteChatMessages: vi.fn(() => true),
  afterChatMutation: vi.fn(() => null),
  getExtensionSettings: vi.fn(() => ({})),
  getAllFloors: vi.fn(() => [{ floor: 12, variables: { stat_data: {} } }]),
  getLatestFloor: vi.fn(() => ({ floor: 12, variables: { stat_data: {} } })),
  runAgent: vi.fn(),
  runPlan: vi.fn(),
  cancelInvocation: vi.fn(() => true),
  cancelPlan: vi.fn(() => true),
  registerCardTool: vi.fn(),
  unregisterCardTool: vi.fn(() => true),
  unregisterCardSender: vi.fn(() => 1),
  completeCardTool: vi.fn(() => true),
  catalogGet: vi.fn((_profileId: string, _name: string) => null as unknown),
  senderSend: vi.fn(),
  lifecycle: new Map<string, () => void>(),
  floorListener: undefined as
    | undefined
    | ((profileId: string, chatId: string, event: unknown) => void)
}))

vi.mock('../src/main/services/wcvManager', () => ({
  contextFor: h.contextFor,
  ensure: h.ensure,
  destroy: h.destroy,
  notifyEvent: h.notifyEvent,
  notifyVarsChanged: h.notifyVarsChanged,
  requestOverlay: h.requestOverlay,
  pushHostReload: h.pushHostReload,
  pushHostVars: h.pushHostVars,
  // DisplayHost render broker (ADR 0023): registerWcvIpc wires these at registration time.
  sendToMain: vi.fn(),
  chatScopeFor: vi.fn(() => null),
  onSlotDestroyed: vi.fn(() => () => {})
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
vi.mock('../src/main/services/floorService', () => ({
  getAllFloors: h.getAllFloors,
  getLatestFloor: h.getLatestFloor
}))
vi.mock('../src/main/services/agentRuntime/cardAgentEvents', () => ({
  onCardFloorCommitted: (listener: typeof h.floorListener) => {
    h.floorListener = listener
  }
}))
vi.mock('../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: () => ({
    run: h.runAgent,
    runPlan: h.runPlan,
    cancelInvocation: h.cancelInvocation,
    cancelPlan: h.cancelPlan
  }),
  liveCardToolRegistry: () => ({
    register: h.registerCardTool,
    unregister: h.unregisterCardTool,
    unregisterSender: h.unregisterCardSender,
    complete: h.completeCardTool
  })
}))
vi.mock('../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    constructor(readonly profileId: string) {}
    get(name: string): unknown {
      return h.catalogGet(this.profileId, name)
    }
  }
}))
vi.mock('../src/main/services/generationService', () => ({}))
vi.mock('../src/main/services/lorebookService', () => ({}))
vi.mock('../src/main/services/scriptApiService', () => ({}))
vi.mock('../src/main/services/regexService', () => ({}))
vi.mock('../src/main/services/pluginStorageService', () => ({}))
vi.mock('../src/main/services/pluginService', () => ({}))
vi.mock('../src/main/services/extensionSettingsService', () => ({
  getExtensionSettings: h.getExtensionSettings,
  setExtensionSettings: vi.fn()
}))
vi.mock('../src/main/services/settingsService', () => ({ getSettings: h.getSettings }))
vi.mock('../src/main/services/worldAssetService', () => ({}))
vi.mock('../src/main/services/presetService', () => ({ getActivePresetId: vi.fn(() => '') }))

import { registerWcvIpc } from '../src/main/ipc/wcvIpc'
import { WCV_AGENT_CHANNELS } from '../src/shared/thRuntime/wcvChannelSpec'

// Fake ipcMain that records every handler by channel so a test can invoke it with a synthetic event.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const fakeIpcMain = {
  on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)
} as unknown as IpcMain

const evt = (senderId: number): unknown => ({
  sender: {
    id: senderId,
    send: h.senderSend,
    once: (name: string, listener: () => void) => h.lifecycle.set(senderId + ':' + name, listener),
    removeListener: (name: string) => h.lifecycle.delete(senderId + ':' + name)
  }
})
const call = (channel: string, senderId: number, ...args: unknown[]): unknown =>
  handlers.get(channel)!(evt(senderId), ...args)

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  h.contextFor.mockImplementation((id: number) => (id === WCV_ID ? SLOT : null))
  h.catalogGet.mockReturnValue(null)
  h.getSettings.mockReturnValue({
    persona: { name: 'Lyra', description: 'A quiet cartographer', inject: false }
  })
  h.deleteChatMessages.mockReturnValue(true)
  h.getAllFloors.mockReturnValue([{ floor: 12, variables: { stat_data: {} } }])
  h.getLatestFloor.mockReturnValue({ floor: 12, variables: { stat_data: {} } })
  const run = Object.assign(
    Promise.resolve({
      invocationId: 'inv-1',
      status: 'succeeded',
      sourceRestarts: 0,
      required: true
    }),
    { invocationId: 'inv-1' }
  )
  const plan = Object.assign(
    Promise.resolve({ planId: 'plan-1', status: 'succeeded', outcomes: [] }),
    { planId: 'plan-1' }
  )
  h.runAgent.mockReturnValue(run)
  h.runPlan.mockReturnValue(plan)
  h.lifecycle.clear()
  h.floorListener = undefined
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

  it('acknowledges an authorization refresh only after the old view is destroyed', async () => {
    const result = call('wcv-destroy-await', RENDERER_ID, 's1') as Promise<boolean>
    expect(h.destroy).not.toHaveBeenCalled()

    await expect(result).resolves.toBe(true)
    expect(h.destroy).toHaveBeenCalledWith('s1')
  })

  it('does not let a WCV page destroy another runtime slot through the acknowledged channel', async () => {
    await expect(
      call('wcv-destroy-await', WCV_ID, 'foreign-slot') as Promise<boolean>
    ).resolves.toBe(false)
    expect(h.destroy).not.toHaveBeenCalled()
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

describe('extension-settings sync read — unresolved ctx signals FAILURE, not empty', () => {
  it('returns the store bag for a bound WCV sender', () => {
    h.getExtensionSettings.mockReturnValue({ MyCard: { n: 1 } })
    const event = { sender: { id: WCV_ID }, returnValue: undefined as unknown }
    handlers.get('wcv-host-get-extension-settings-sync')!(event)

    expect(h.getExtensionSettings).toHaveBeenCalledWith('pA')
    expect(event.returnValue).toEqual({ MyCard: { n: 1 } })
  })

  it('returns undefined (a failed read, NOT `{}`) when the sender ctx is unresolved', () => {
    // An unresolved ctx must NOT masquerade as a genuinely-empty store — returning `{}` would let the
    // runtime hydration gate treat the boot seed as loaded and flush an empty bag over valid settings.
    const event = { sender: { id: 999 }, returnValue: 'sentinel' as unknown }
    handlers.get('wcv-host-get-extension-settings-sync')!(event)

    expect(event.returnValue).toBeUndefined()
    expect(h.getExtensionSettings).not.toHaveBeenCalled() // no profile to read against
  })
})

describe('persona macro transport', () => {
  it('returns the bound profile persona description even when prompt injection is disabled', () => {
    const event = { sender: { id: WCV_ID }, returnValue: undefined as unknown }
    handlers.get('wcv-host-get-persona-description')!(event)

    expect(h.getSettings).toHaveBeenCalledWith('pA')
    expect(event.returnValue).toBe('A quiet cartographer')
  })
})

describe('WCV AgentHost IPC authority and lifecycle', () => {
  it('derives profile/chat/card from the WCV sender and preserves direct JSON input', async () => {
    await call(WCV_AGENT_CHANNELS.run, WCV_ID, {
      requestId: 'request-1',
      name: 'Monthly Property',
      profileId: 'pEVIL',
      chatId: 'cEVIL',
      characterId: 'charEVIL',
      options: { floor: 12, input: { month: 7 } }
    })

    expect(h.runAgent).toHaveBeenCalledWith({
      profileId: 'pA',
      chatId: 'cA',
      characterId: 'charA',
      floor: 12,
      agent: 'Monthly Property',
      options: { floor: 12, input: { month: 7 } },
      toolScope: { profileId: 'pA', chatId: 'cA', characterId: 'charA' }
    })
  })

  it('rejects an unresolvable sender scope with an accurate scope-rejection code', async () => {
    await expect(
      call(WCV_AGENT_CHANNELS.run, 999, { requestId: 'request-1', name: 'Agent', options: {} })
    ).rejects.toMatchObject({ code: 'AGENT_RUN_SCOPE_REJECTED' })
    expect(h.runAgent).not.toHaveBeenCalled()
  })

  it('rebinds to a fresh session when the slot ctx moves to a new chat/profile (no navigation)', async () => {
    await call(WCV_AGENT_CHANNELS.run, WCV_ID, {
      requestId: 'r1',
      name: 'Agent',
      options: { floor: 12 }
    })
    expect(h.runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: 'pA', chatId: 'cA', characterId: 'charA' })
    )
    // The SAME slot/webContents is reused for a new (profile, chat) WITHOUT a navigation event.
    h.contextFor.mockImplementation((id: number) =>
      id === WCV_ID ? { slotId: 's1', profileId: 'pB', chatId: 'cB', characterId: 'charB' } : null
    )
    await call(WCV_AGENT_CHANNELS.run, WCV_ID, {
      requestId: 'r2',
      name: 'Agent',
      options: { floor: 12 }
    })
    // The stale session was closed (its tools unregistered) and a fresh one bound to the new scope.
    expect(h.unregisterCardSender).toHaveBeenCalledWith(WCV_ID)
    expect(h.runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: 'pB',
        chatId: 'cB',
        characterId: 'charB',
        toolScope: { profileId: 'pB', chatId: 'cB', characterId: 'charB' }
      })
    )
  })

  it('applies the user per-Agent binding preset and ignores a card-supplied preset/model', async () => {
    h.catalogGet.mockReturnValue({ invocationConfig: { apiPresetId: 'user-preset' } })
    await call(WCV_AGENT_CHANNELS.run, WCV_ID, {
      requestId: 'r1',
      name: 'Agent',
      options: { floor: 12, apiPresetId: 'card-preset', model: 'card-model' }
    })
    expect(h.catalogGet).toHaveBeenCalledWith('pA', 'Agent')
    expect(h.runAgent.mock.calls.at(-1)![0].options).toEqual({
      floor: 12,
      apiPresetId: 'user-preset'
    })
  })

  it('rejects a malformed tool binding on the WCV registerTool channel', () => {
    expect(() =>
      call(WCV_AGENT_CHANNELS.registerTool, WCV_ID, { inputSchema: { type: 'object' } })
    ).toThrow(expect.objectContaining({ code: 'AGENT_RUN_INVALID_REQUEST' }))
    expect(() => call(WCV_AGENT_CHANNELS.registerTool, WCV_ID, { name: '' })).toThrow(
      expect.objectContaining({ code: 'AGENT_RUN_INVALID_REQUEST' })
    )
    expect(h.registerCardTool).not.toHaveBeenCalled()
  })

  it('registers card tools under authoritative scope and unregisters them on reload', () => {
    const binding = {
      name: 'clock',
      inputSchema: { type: 'object' },
      transactionMode: 'transactional',
      parallelSafe: false
    }
    expect(call(WCV_AGENT_CHANNELS.registerTool, WCV_ID, binding)).toBe(true)
    expect(h.registerCardTool).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { profileId: 'pA', chatId: 'cA', characterId: 'charA', senderId: WCV_ID },
        binding
      })
    )
    h.lifecycle.get(WCV_ID + ':did-start-navigation')?.()
    expect(h.unregisterCardSender).toHaveBeenCalledWith(WCV_ID)
  })

  it('accepts tool results only with the authoritative sender id', () => {
    call(WCV_AGENT_CHANNELS.toolResult, WCV_ID, { requestId: 'tool-1', result: { ok: true } })
    expect(h.completeCardTool).toHaveBeenCalledWith({
      senderId: WCV_ID,
      requestId: 'tool-1',
      scope: { profileId: 'pA', chatId: 'cA', characterId: 'charA' },
      result: { ok: true }
    })
  })

  it('delivers one floor event only to a subscribed matching WCV scope', () => {
    expect(call(WCV_AGENT_CHANNELS.floorSubscribe, WCV_ID)).toBe(true)
    const event = { floor: 12, variables: { month: 7 }, previousVariables: { month: 6 } }
    h.floorListener?.('pA', 'cA', event)
    expect(h.senderSend).toHaveBeenCalledWith(WCV_AGENT_CHANNELS.floorCommitted, event)
    h.senderSend.mockClear()
    h.floorListener?.('pA', 'cB', event)
    expect(h.senderSend).not.toHaveBeenCalled()
  })
})
