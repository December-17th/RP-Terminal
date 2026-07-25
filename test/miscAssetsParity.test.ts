// test/miscAssetsParity.test.ts
//
// M3 transport parity for the card-facing `miscAssets()`.
//
// CLAUDE.md: the card runtime is ONE surface with two transports at parity — behavior lives in the shared
// body and both transports inherit it. `miscAssets()` has two independent main-side entry points that each
// resolve their OWN session context (the inline `asset-misc-for-card` handler takes the renderer-supplied
// profile/lorebook ids/chatId; the WCV `wcv-host-misc-assets` handler derives them from `e.sender`), so the
// drift risk is real and lives exactly there. This test drives BOTH handlers against the SAME mocked
// `worldAssetService.miscAssetsForWorld` and asserts they call it with identical arguments and return the
// identical result — i.e. neither handler merges, filters, reorders, or re-resolves anything of its own.
//
// The shared-runtime half of the seam (one facade → one Host member → both transports) is pinned in
// test/thRuntimeAssetUrl.test.ts; the ordering/precedence rules of the shared body itself in
// test/assetUrlForWorld.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'

const WCV_ID = 101
const SLOT = { slotId: 's1', profileId: 'pA', chatId: 'cA', characterId: 'charA' }

// The one shared body both transports must bottom out in, plus the id-resolution the WCV side does.
const h = vi.hoisted(() => ({
  miscAssetsForWorld: vi.fn(() => [] as any[]),
  assetUrlForWorld: vi.fn(() => null as string | null),
  resolveRemoteAssetUrl: vi.fn((_p: string, _c: string, name: string, kind = 'character') =>
    `rptremoteasset://${kind}/pA/cA/${name}`
  ),
  getChatLorebookIds: vi.fn(() => null as string[] | null),
  contextFor: vi.fn((id: number) => (id === WCV_ID ? SLOT : null)),
  senderSend: vi.fn(),
  lifecycle: new Map<string, () => void>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

// Both IPC modules read the misc list through this ONE service function.
vi.mock('../src/main/services/worldAssetService', () => ({
  miscAssetsForWorld: h.miscAssetsForWorld,
  assetListForWorld: vi.fn(() => []),
  assetUrlForWorld: h.assetUrlForWorld,
  sceneAssetUrlForWorld: vi.fn(() => null),
  resolveAssetFile: vi.fn(() => null),
  listCoverage: vi.fn(() => []),
  getIndex: vi.fn(() => ({})),
  getMergedIndex: vi.fn(() => ({})),
  importAssetForCard: vi.fn(() => null),
  importAssetFiles: vi.fn(() => ({ imported: 0, skipped: [] })),
  importAssetsZip: vi.fn(() => ({ ok: true, entries: 0 })),
  exportAssetsZip: vi.fn(() => ({ ok: true, entries: 0 })),
  deleteAssetFile: vi.fn(() => false),
  renameAssetVariant: vi.fn(() => ({ ok: false, error: 'not-found' })),
  openAssetsFolder: vi.fn()
}))
vi.mock('../src/main/services/worldAssetProtocol', () => ({ ASSET_SCHEME: 'rptasset' }))
vi.mock('../src/main/services/chatService', () => ({
  getChatLorebookIds: h.getChatLorebookIds,
  getChat: vi.fn(() => null)
}))
vi.mock('../src/main/services/wcvManager', () => ({
  contextFor: h.contextFor,
  ensure: vi.fn(),
  destroy: vi.fn(),
  notifyEvent: vi.fn(),
  notifyVarsChanged: vi.fn(),
  cardButtonsFor: vi.fn(() => []),
  requestOverlay: vi.fn(() => true),
  pushHostReload: vi.fn(),
  pushHostVars: vi.fn(),
  sendToMain: vi.fn(),
  chatScopeFor: vi.fn(() => null),
  onSlotDestroyed: vi.fn(() => () => {})
}))

// The remaining wcvIpc imports are never exercised here; stub them so importing wcvIpc doesn't pull the
// real DB-touching service modules into the Node test run (same stub set as wcvIpcCtxBinding.test.ts).
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))
vi.mock('../src/main/services/characterService', () => ({ getCharacter: vi.fn(() => undefined) }))
vi.mock('../src/main/services/chatWriteService', () => ({
  deleteChatMessages: vi.fn(() => true),
  afterChatMutation: vi.fn(() => null)
}))
vi.mock('../src/main/services/duelPreviewService', () => ({ computeDuelPreview: vi.fn() }))
vi.mock('../src/main/services/chatCardVarsService', () => ({
  getChatCardVars: vi.fn(),
  setChatCardVars: vi.fn()
}))
vi.mock('../src/main/services/floorService', () => ({
  getAllFloors: vi.fn(() => []),
  getLatestFloor: vi.fn(() => null)
}))
vi.mock('../src/main/services/remoteAssetService', () => ({
  resolveRemoteAssetUrl: h.resolveRemoteAssetUrl,
  listRemoteAssets: vi.fn(() => [])
}))
vi.mock('../src/main/services/agentRuntime/cardAgentEvents', () => ({
  onCardFloorCommitted: vi.fn()
}))
vi.mock('../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: () => ({
    run: vi.fn(),
    runPlan: vi.fn(),
    cancelInvocation: vi.fn(() => true),
    cancelPlan: vi.fn(() => true)
  }),
  liveCardToolRegistry: () => ({
    register: vi.fn(),
    unregister: vi.fn(() => true),
    unregisterSender: vi.fn(() => 1),
    complete: vi.fn(() => true)
  })
}))
vi.mock('../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    constructor(readonly profileId: string) {}
    get(): unknown {
      return null
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
  getExtensionSettings: vi.fn(() => ({})),
  setExtensionSettings: vi.fn()
}))
vi.mock('../src/main/services/settingsService', () => ({ getSettings: vi.fn(() => ({})) }))
vi.mock('../src/main/services/presetService', () => ({ getActivePresetId: vi.fn(() => '') }))

import { registerWcvIpc } from '../src/main/ipc/wcvIpc'
import { registerWorldAssetIpc } from '../src/main/ipc/worldAssetIpc'
import { WCV_CHANNELS } from '../src/shared/thRuntime/wcvChannelSpec'

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

/** The WCV transport's entry point: ctx (profile / chat / lorebook ids) derived from `e.sender`. */
const viaWcv = (senderId = WCV_ID): unknown =>
  handlers.get(WCV_CHANNELS.miscAssets)!(evt(senderId))

/** The inline (cardBridge) transport's entry point: the renderer supplies the ids it resolved. */
const viaInline = (profileId: string, ids: string[], chatId: string): unknown =>
  handlers.get('asset-misc-for-card')!(evt(1), profileId, ids, chatId)

const LIST = [
  { name: '火球术', variant: null, url: 'rptasset://pA/w1/misc/a.png', remote: false },
  { name: '火球术', variant: 'alt', url: 'rptasset://pA/w1/misc/b.png', remote: false },
  { name: '陨星裂空', variant: null, url: 'rptremoteasset://misc/pA/cA/x?v=1', remote: true }
]

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  h.contextFor.mockImplementation((id: number) => (id === WCV_ID ? SLOT : null))
  h.getChatLorebookIds.mockReturnValue(['w1', 'w2'])
  h.miscAssetsForWorld.mockReturnValue(LIST)
  h.assetUrlForWorld.mockReturnValue(null)
  h.resolveRemoteAssetUrl.mockImplementation(
    (_p: string, _c: string, name: string, kind = 'character') =>
      `rptremoteasset://${kind}/pA/cA/${name}`
  )
  h.lifecycle.clear()
  registerWcvIpc(fakeIpcMain)
  registerWorldAssetIpc(fakeIpcMain)
})

describe('miscAssets() — inline and WCV transports are at parity', () => {
  it('both handlers are registered', () => {
    expect(WCV_CHANNELS.miscAssets).toBe('wcv-host-misc-assets')
    expect(handlers.has(WCV_CHANNELS.miscAssets)).toBe(true)
    expect(handlers.has('asset-misc-for-card')).toBe(true)
  })

  it('given identical state, both call the SAME shared body with identical args and return the same list', () => {
    const wcv = viaWcv()
    const wcvArgs = h.miscAssetsForWorld.mock.calls.at(-1)
    // The inline transport passes the ids the renderer resolved — the same ones the WCV side derived.
    const inline = viaInline('pA', ['w1', 'w2'], 'cA')
    const inlineArgs = h.miscAssetsForWorld.mock.calls.at(-1)

    expect(wcvArgs).toEqual(['pA', ['w1', 'w2'], 'cA'])
    expect(inlineArgs).toEqual(wcvArgs)
    expect(wcv).toEqual(LIST)
    expect(inline).toEqual(wcv)
  })

  it('neither handler post-processes the shared body: order, variants and the remote flag pass through', () => {
    // A card takes the first match per name; that ordering is the SHARED body's job, and each transport
    // must hand it over untouched (no re-sort, no dedupe, no local/remote filtering).
    expect(viaWcv()).toEqual(LIST)
    expect(viaInline('pA', ['w1', 'w2'], 'cA')).toEqual(LIST)
    expect(viaWcv()).toBe(h.miscAssetsForWorld.mock.results.at(-1)!.value)
  })

  it('WCV falls back to the card id when the chat carries no lorebooks — inline does the same, in the renderer', () => {
    h.getChatLorebookIds.mockReturnValue(null)
    viaWcv()
    expect(h.miscAssetsForWorld).toHaveBeenLastCalledWith('pA', ['charA'], 'cA')
  })

  it('returns [] (never throws) when the WCV sender has no bound session', () => {
    expect(viaWcv(999)).toEqual([])
    expect(h.miscAssetsForWorld).not.toHaveBeenCalled()
  })

  it('the inline handler coerces a missing chat id to the empty string rather than passing undefined', () => {
    handlers.get('asset-misc-for-card')!(evt(1), 'pA', ['w1'], undefined)
    expect(h.miscAssetsForWorld).toHaveBeenLastCalledWith('pA', ['w1'], '')
  })
})

// The single-lookup companion to the above. `localFirstRemoteAssetUrl` opens the remote gate for BOTH
// `立绘bg` and `misc`, but every remote resolver defaults to the `character` bag — so a call site that
// forgets to forward the kind answers a `misc` lookup with a char_info_visuals portrait, minted under
// the WRONG protocol host. That is the cross-namespace shadowing the kind exists to prevent, and it is
// invisible to a test of the pure helper alone: this drives the real handler.
describe("assetUrl(name, 'misc') falls back into the misc bag, not char_info_visuals", () => {
  const viaWcvAssetUrl = (name: string, type: string, senderId = WCV_ID): unknown =>
    handlers.get(WCV_CHANNELS.assetUrl)!(evt(senderId), name, type)

  it('forwards kind=misc for a misc lookup with no local file', async () => {
    await expect(viaWcvAssetUrl('火球术', 'misc')).resolves.toBe(
      'rptremoteasset://misc/pA/cA/火球术'
    )
    expect(h.resolveRemoteAssetUrl).toHaveBeenLastCalledWith('pA', 'cA', '火球术', 'misc')
  })

  it('still forwards kind=character for the legacy 立绘bg shim', async () => {
    await expect(viaWcvAssetUrl('傲雪', '立绘bg')).resolves.toBe(
      'rptremoteasset://character/pA/cA/傲雪'
    )
    expect(h.resolveRemoteAssetUrl).toHaveBeenLastCalledWith('pA', 'cA', '傲雪', 'character')
  })

  it('never consults the remote bags for a strict type, or when a local file exists', async () => {
    await expect(viaWcvAssetUrl('傲雪', '立绘')).resolves.toBeNull()
    expect(h.resolveRemoteAssetUrl).not.toHaveBeenCalled()

    h.assetUrlForWorld.mockReturnValue('rptasset://pA/w1/misc/火球术_misc.png')
    await expect(viaWcvAssetUrl('火球术', 'misc')).resolves.toBe(
      'rptasset://pA/w1/misc/火球术_misc.png'
    )
    expect(h.resolveRemoteAssetUrl).not.toHaveBeenCalled()
  })
})
