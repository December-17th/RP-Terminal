import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachWcvUnsquashCompat } from '../src/main/services/wcvUnsquashCompat'
import { UNSQUASH_COMPAT_SOURCE } from '../src/shared/unsquashCompat'

describe('WebContentsView unsquash compatibility', () => {
  it('injects the compatibility pass into every loaded frame', async () => {
    let listener: (...args: any[]) => void = () => {}
    const contents = {
      on: vi.fn((_event, callback) => {
        listener = callback
      })
    } as unknown as WebContents
    const executeJavaScript = vi.fn(async () => undefined)
    const resolve = vi.fn(() => ({ isDestroyed: () => false, executeJavaScript }))

    attachWcvUnsquashCompat(contents, resolve)
    listener({}, true, 10, 20)
    listener({}, false, 11, 21)
    await Promise.resolve()

    expect(resolve.mock.calls).toEqual([
      [10, 20],
      [11, 21]
    ])
    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(executeJavaScript).toHaveBeenNthCalledWith(1, UNSQUASH_COMPAT_SOURCE)
  })

  it('floors an overflowing flex-column child but skips a real scroll region', () => {
    const writes: string[][] = []
    const parent = { parentElement: null }
    const clipped = {
      parentElement: parent,
      clientHeight: 20,
      scrollHeight: 56,
      style: { setProperty: (...args: string[]) => writes.push(args) }
    }
    const scrollRegion = {
      parentElement: parent,
      clientHeight: 20,
      scrollHeight: 56,
      style: { setProperty: (...args: string[]) => writes.push(args) }
    }
    const timers: Array<() => void> = []
    const win = {
      document: {
        readyState: 'complete',
        body: { querySelectorAll: () => [clipped, scrollRegion] },
        documentElement: {}
      },
      getComputedStyle: (element: unknown) =>
        element === parent
          ? { display: 'flex', flexDirection: 'column', overflowY: 'visible' }
          : {
              display: 'block',
              flexDirection: 'row',
              overflowY: element === scrollRegion ? 'auto' : 'hidden'
            },
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      MutationObserver: class {
        observe(): void {}
      },
      ResizeObserver: class {
        observe(): void {}
      },
      addEventListener: vi.fn()
    }

    Function('window', UNSQUASH_COMPAT_SOURCE)(win)
    timers.shift()?.()

    expect(writes).toEqual([['min-height', 'fit-content', 'important']])
  })
})
