import { beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  let nextId = 10
  const views: any[] = []

  class WebContentsView {
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    webContents = {
      id: nextId++,
      send: vi.fn(),
      loadURL: vi.fn(),
      on: vi.fn(),
      openDevTools: vi.fn(),
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
      capturePage: vi.fn()
    }

    constructor() {
      views.push(this)
    }

    setBackgroundColor(): void {}
    setBounds(bounds: typeof this.bounds): void {
      this.bounds = bounds
    }
    getBounds(): typeof this.bounds {
      return this.bounds
    }
    setVisible(visible: boolean): void {
      this.visible = visible
    }
  }

  return { WebContentsView, views, mainSend: vi.fn() }
})

vi.mock('electron', () => ({
  WebContentsView: h.WebContentsView,
  BrowserWindow: class {},
  session: {
    fromPartition: () => ({
      protocol: { handle: vi.fn() },
      webRequest: { onHeadersReceived: vi.fn() }
    })
  },
  net: { fetch: vi.fn() },
  webFrameMain: { fromId: vi.fn() }
}))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))
vi.mock('../src/main/services/worldAssetProtocol', () => ({
  ASSET_SCHEME: 'rptasset',
  serveAssetRequest: vi.fn()
}))
vi.mock('../src/main/services/remoteAssetProtocol', () => ({
  REMOTE_ASSET_SCHEME: 'rptremote',
  serveRemoteAssetRequest: vi.fn()
}))
vi.mock('../src/main/services/pluginService', () => ({ getGrants: vi.fn(() => ({})) }))
vi.mock('../src/main/services/cardCodeService', () => ({ cardCodeRoot: vi.fn(() => '') }))
vi.mock('../src/main/services/cardCodeProtocol', () => ({
  serveCardCode: vi.fn(),
  originTokenFor: vi.fn(() => 'token')
}))
vi.mock('../src/main/services/wcvFreezeFrame', () => ({
  createFreezeController: () => ({
    onTargetCreated: vi.fn(),
    warmTarget: vi.fn(),
    warmVisible: vi.fn(),
    dropTarget: vi.fn(),
    restore: vi.fn(),
    suppress: vi.fn(),
    clear: vi.fn()
  })
}))
vi.mock('../src/main/services/wcvOverlay', () => ({
  createOverlayController: () => ({
    request: vi.fn(() => true),
    dismiss: vi.fn()
  })
}))
vi.mock('../src/main/services/wcvDevTools', () => ({ shouldOpenWcvDevTools: () => false }))
vi.mock('../src/main/services/wcvUnsquashCompat', () => ({ attachWcvUnsquashCompat: vi.fn() }))

import * as wcvManager from '../src/main/services/wcvManager'

describe('full-screen WCV script-button feed', () => {
  beforeAll(() => {
    wcvManager.init({
      on: vi.fn(),
      getContentSize: () => [1200, 800],
      webContents: { send: h.mainSend, focus: vi.fn() },
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
    } as any)
  })

  it('hydrates matching WCVs, pushes replacements, and clears on script-host teardown', () => {
    wcvManager.ensure(
      'card-scripts:char:chat',
      { x: -1000, y: 0, width: 1200, height: 800 },
      'data:text/html,<body></body>',
      { profileId: 'profile', chatId: 'chat', characterId: 'char' }
    )
    wcvManager.ensure(
      'overlay:full',
      { x: 0, y: 0, width: 1200, height: 800 },
      'data:text/html,<body></body>',
      { profileId: 'profile', chatId: 'chat', characterId: 'char' }
    )

    const fullScreen = h.views[1]
    wcvManager.pushCardButtons('card-scripts:char:chat', 'chat', 'char', [
      { name: '命定创意工坊', visible: true },
      { name: 'hidden', visible: false }
    ])

    expect(wcvManager.cardButtonsFor(fullScreen.webContents.id)).toEqual([
      { name: '命定创意工坊' }
    ])
    expect(fullScreen.webContents.send).toHaveBeenCalledWith('wcv-script-buttons-changed', [
      { name: '命定创意工坊' }
    ])

    wcvManager.destroy('card-scripts:char:chat')

    expect(wcvManager.cardButtonsFor(fullScreen.webContents.id)).toEqual([])
    expect(fullScreen.webContents.send).toHaveBeenLastCalledWith(
      'wcv-script-buttons-changed',
      []
    )
    wcvManager.destroyAll()
  })
})
