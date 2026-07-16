import { describe, expect, it, vi } from 'vitest'
import {
  createInlineCardLayout,
  normalizeInlineFitDocument
} from '../src/renderer/src/components/inlineCardLayout'

describe('inline card layout', () => {
  it('rewrites only viewport minimums and preserves authored control/card minimums', () => {
    const layout = createInlineCardLayout(
      '<style>.page{min-height:100vh}.button{min-height:44px}</style>',
      'fit'
    )

    expect(layout.html).toContain('.page{min-height:var(--TH-viewport-height)}')
    expect(layout.html).toContain('.button{min-height:44px}')
  })

  it.each(['fit', 'fill'] as const)(
    '%s keeps root scrolling available as a clipping fallback',
    (sizing) => {
      expect(createInlineCardLayout('<div>card</div>', sizing).scrollable).toBe(true)
    }
  )

  it('normalizes only document roots without touching descendant minimum heights', () => {
    const htmlSetProperty = vi.fn()
    const bodySetProperty = vi.fn()
    const querySelectorAll = vi.fn(() => {
      throw new Error('descendants must not be rewritten')
    })
    const doc = {
      documentElement: { style: { setProperty: htmlSetProperty } },
      body: { style: { setProperty: bodySetProperty } },
      querySelectorAll
    } as unknown as Document

    normalizeInlineFitDocument(doc)

    expect(htmlSetProperty).toHaveBeenCalledWith('height', 'auto', 'important')
    expect(bodySetProperty).toHaveBeenCalledWith('height', 'auto', 'important')
    expect(querySelectorAll).not.toHaveBeenCalled()
  })
})
