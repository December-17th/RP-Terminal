// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/workspace/WcvPanel', () => ({
  WcvPanel: ({ slotId, url }: { slotId: string; url: string }) =>
    createElement('div', { 'data-testid': 'wcv', 'data-slot': slotId, 'data-url': url })
}))

let resolveVnMode: (() => void) | undefined
let root: Root | undefined
let container: HTMLDivElement | undefined
const setVnMode = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveVnMode = resolve
    })
)

beforeEach(() => {
  setVnMode.mockClear()
  resolveVnMode = undefined
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = { setVnMode }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

describe('Yuzu full-card surface MVP', () => {
  it.each([
    ['classic generation', false],
    ['Yuzu generation', true]
  ])('selects %s before mounting the unrestricted WCV', async (_label, enableVnMode) => {
    const { YuzuCardSurface } =
      await import('../../src/renderer/src/components/yuzu/YuzuCardSurface')
    await act(async () => {
      root?.render(
        createElement(YuzuCardSurface, {
          profileId: 'p1',
          chatId: 'c1',
          entry: 'card-code:yuzu/index.html',
          enableVnMode
        })
      )
    })

    expect(container?.querySelector('[data-testid="wcv"]')).toBeNull()
    expect(setVnMode).toHaveBeenCalledWith('p1', 'c1', enableVnMode)

    await act(async () => resolveVnMode?.())
    const wcv = container?.querySelector('[data-testid="wcv"]')
    expect(wcv?.getAttribute('data-slot')).toBe('yuzu:c1')
    expect(wcv?.getAttribute('data-url')).toBe('card-code:yuzu/index.html')
  })
})
