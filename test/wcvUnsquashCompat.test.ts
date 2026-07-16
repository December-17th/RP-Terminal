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

  it('reports rejected compatibility injection without throwing', async () => {
    let listener: (...args: any[]) => void = () => {}
    const contents = {
      on: vi.fn((_event, callback) => {
        listener = callback
      })
    } as unknown as WebContents
    const failure = new Error('frame navigated')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const resolve = vi.fn(() => ({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(() => Promise.reject(failure))
    }))

    try {
      attachWcvUnsquashCompat(contents, resolve)
      listener({}, false, 10, 20)
      await Promise.resolve()

      expect(consoleError).toHaveBeenCalledWith(
        'wcv: unsquash compatibility injection failed',
        failure
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('ignores missing and destroyed frames', () => {
    let listener: (...args: any[]) => void = () => {}
    const contents = {
      on: vi.fn((_event, callback) => {
        listener = callback
      })
    } as unknown as WebContents
    const executeJavaScript = vi.fn(async () => undefined)
    const onError = vi.fn()
    const resolve = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ isDestroyed: () => true, executeJavaScript })

    attachWcvUnsquashCompat(contents, resolve, onError)
    listener({}, true, 10, 20)
    listener({}, false, 11, 21)

    expect(executeJavaScript).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('floors an overflowing flex-column child but skips a real scroll region', () => {
    const writes: string[][] = []
    const parent = { parentElement: null }
    const clipped = {
      parentElement: parent,
      clientHeight: 20,
      scrollHeight: 56,
      style: {
        getPropertyValue: () => '',
        getPropertyPriority: () => '',
        setProperty: (...args: string[]) => writes.push(args),
        removeProperty: () => ''
      }
    }
    const scrollRegion = {
      parentElement: parent,
      clientHeight: 20,
      scrollHeight: 56,
      style: {
        getPropertyValue: () => '',
        getPropertyPriority: () => '',
        setProperty: (...args: string[]) => writes.push(args),
        removeProperty: () => ''
      }
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

  it('restores an authored min-height when a floored child becomes a scroll region', () => {
    const inlineMinHeight = { value: '6rem', priority: '' }
    const style = {
      getPropertyValue: (name: string) => (name === 'min-height' ? inlineMinHeight.value : ''),
      getPropertyPriority: (name: string) =>
        name === 'min-height' ? inlineMinHeight.priority : '',
      setProperty: (name: string, value: string, priority = '') => {
        if (name === 'min-height') {
          inlineMinHeight.value = value
          inlineMinHeight.priority = priority
        }
      },
      removeProperty: (name: string) => {
        if (name === 'min-height') {
          inlineMinHeight.value = ''
          inlineMinHeight.priority = ''
        }
      }
    }
    const parent = { parentElement: null }
    const child = { parentElement: parent, clientHeight: 20, scrollHeight: 56, style }
    const timers: Array<() => void> = []
    let overflowY = 'hidden'
    let notifyMutation: () => void = () => {}
    const win = {
      document: {
        readyState: 'complete',
        body: { querySelectorAll: () => [child] },
        documentElement: {}
      },
      getComputedStyle: (element: unknown) =>
        element === parent
          ? { display: 'flex', flexDirection: 'column', overflowY: 'visible' }
          : { display: 'block', flexDirection: 'row', overflowY },
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          notifyMutation = callback
        }
        observe(): void {}
      },
      ResizeObserver: class {
        observe(): void {}
      },
      addEventListener: vi.fn()
    }

    Function('window', UNSQUASH_COMPAT_SOURCE)(win)
    timers.shift()?.()
    expect(inlineMinHeight).toEqual({ value: 'fit-content', priority: 'important' })

    overflowY = 'auto'
    notifyMutation()
    timers.shift()?.()

    expect(inlineMinHeight).toEqual({ value: '6rem', priority: '' })
  })

  it('reapplies the floor while eligible and later restores an external style update', () => {
    const inlineMinHeight = { value: '6rem', priority: '' }
    const style = {
      getPropertyValue: () => inlineMinHeight.value,
      getPropertyPriority: () => inlineMinHeight.priority,
      setProperty: (_name: string, value: string, priority = '') => {
        inlineMinHeight.value = value
        inlineMinHeight.priority = priority
      },
      removeProperty: () => {
        inlineMinHeight.value = ''
        inlineMinHeight.priority = ''
      }
    }
    const parent = { parentElement: null }
    const child = { parentElement: parent, clientHeight: 20, scrollHeight: 56, style }
    const timers: Array<() => void> = []
    let overflowY = 'hidden'
    let notifyMutation: () => void = () => {}
    const win = {
      document: {
        readyState: 'complete',
        body: { querySelectorAll: () => [child] },
        documentElement: {}
      },
      getComputedStyle: (element: unknown) =>
        element === parent
          ? { display: 'flex', flexDirection: 'column', overflowY: 'visible' }
          : { display: 'block', flexDirection: 'row', overflowY },
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          notifyMutation = callback
        }
        observe(): void {}
      },
      ResizeObserver: class {
        observe(): void {}
      },
      addEventListener: vi.fn()
    }

    Function('window', UNSQUASH_COMPAT_SOURCE)(win)
    timers.shift()?.()
    expect(inlineMinHeight).toEqual({ value: 'fit-content', priority: 'important' })

    inlineMinHeight.value = '12rem'
    inlineMinHeight.priority = ''
    notifyMutation()
    timers.shift()?.()
    expect(inlineMinHeight).toEqual({ value: 'fit-content', priority: 'important' })

    overflowY = 'auto'
    notifyMutation()
    timers.shift()?.()
    expect(inlineMinHeight).toEqual({ value: '12rem', priority: '' })

    overflowY = 'hidden'
    notifyMutation()
    timers.shift()?.()
    style.removeProperty()
    notifyMutation()
    timers.shift()?.()
    expect(inlineMinHeight).toEqual({ value: 'fit-content', priority: 'important' })

    overflowY = 'auto'
    notifyMutation()
    timers.shift()?.()
    expect(inlineMinHeight).toEqual({ value: '', priority: '' })
  })
})
