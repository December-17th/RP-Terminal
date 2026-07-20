// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('../../src/renderer/src/components/workspace/WcvPanel', () => ({
  WcvPanel: ({ slotId, url }: { slotId: string; url: string }) => (
    <div data-testid="wcv" data-slot={slotId} data-url={url} />
  )
}))

const setVnMode = vi.fn(async () => undefined)

beforeEach(() => {
  setVnMode.mockClear()
  ;(window as unknown as { api: unknown }).api = { setVnMode }
})

afterEach(cleanup)

describe('Yuzu full-card surface MVP', () => {
  it('applies the explicit VN generation flag before mounting the unrestricted WCV', async () => {
    const { YuzuCardSurface } =
      await import('../../src/renderer/src/components/yuzu/YuzuCardSurface')
    const view = render(
      <YuzuCardSurface
        profileId="p1"
        chatId="c1"
        entry="card-code:yuzu/index.html"
        enableVnMode={true}
      />
    )

    expect(view.queryByTestId('wcv')).toBeNull()
    await waitFor(() => expect(view.getByTestId('wcv')).toBeTruthy())
    expect(setVnMode).toHaveBeenCalledWith('p1', 'c1', true)
    expect(view.getByTestId('wcv').getAttribute('data-slot')).toBe('yuzu:c1')
    expect(view.getByTestId('wcv').getAttribute('data-url')).toBe('card-code:yuzu/index.html')
  })
})
