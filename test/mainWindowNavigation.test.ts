import { describe, expect, it, vi } from 'vitest'
import { installMainWindowNavigationPolicy } from '../src/main/mainWindowNavigation'

type NavigationEvent = {
  url: string
  preventDefault: ReturnType<typeof vi.fn>
}

const setup = (appUrl = 'file:///E:/Projects/RP%20Terminal/out/renderer/index.html') => {
  let navigate: ((event: NavigationEvent) => void) | undefined
  let openWindow: ((details: { url: string }) => { action: 'deny' }) | undefined
  const openExternal = vi.fn(async () => undefined)
  const webContents = {
    on: vi.fn((event: string, handler: (event: NavigationEvent) => void) => {
      if (event === 'will-navigate') navigate = handler
    }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: 'deny' }) => {
      openWindow = handler
    })
  }

  installMainWindowNavigationPolicy(webContents as never, appUrl, openExternal)
  return { navigate: navigate!, openWindow: openWindow!, openExternal }
}

describe('main-window navigation policy', () => {
  it('allows only the configured packaged document in the main frame', () => {
    const h = setup()
    const appEvent = {
      url: 'file:///E:/Projects/RP%20Terminal/out/renderer/index.html?view=chat',
      preventDefault: vi.fn()
    }
    const attackerEvent = { url: 'https://attacker.example/', preventDefault: vi.fn() }

    h.navigate(appEvent)
    h.navigate(attackerEvent)

    expect(appEvent.preventDefault).not.toHaveBeenCalled()
    expect(attackerEvent.preventDefault).toHaveBeenCalledOnce()
    expect(h.openExternal).toHaveBeenCalledWith('https://attacker.example/')
  })

  it('opens only https and mailto targets externally', () => {
    const h = setup()

    expect(h.openWindow({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(h.openWindow({ url: 'mailto:user@example.com' })).toEqual({ action: 'deny' })
    expect(h.openWindow({ url: 'http://example.com/' })).toEqual({ action: 'deny' })
    expect(h.openWindow({ url: 'file:///E:/secret.txt' })).toEqual({ action: 'deny' })
    expect(h.openWindow({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })

    expect(h.openExternal.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/',
      'mailto:user@example.com'
    ])
  })
})
