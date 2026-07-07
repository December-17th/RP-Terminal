import { describe, it, expect } from 'vitest'
import { makePanelGeometry } from '../src/main/services/wcvGeometry'

describe('makePanelGeometry — the seam-slicing contract', () => {
  it('carries the slot rect plus the window content size as the viewport', () => {
    const g = makePanelGeometry({ x: 340, y: 0, width: 1020, height: 284 }, [1360, 820])
    expect(g).toEqual({
      x: 340,
      y: 0,
      width: 1020,
      height: 284,
      viewportWidth: 1360,
      viewportHeight: 820
    })
  })

  it('two adjacent slices share one viewport width so a full-width background aligns', () => {
    // SELF top (cols 0..2 of a 1360px window) and STAGE (cols 3..11): drawing the SAME background at
    // `background-position-x: -x` over `viewportWidth` makes the two slices line up into one image.
    const self = makePanelGeometry({ x: 0, y: 0, width: 340, height: 284 }, [1360, 820])
    const stage = makePanelGeometry({ x: 340, y: 0, width: 1020, height: 284 }, [1360, 820])
    expect(self.viewportWidth).toBe(stage.viewportWidth)
    // The stage's background offset equals exactly the self slice's width → no gap, no overlap.
    expect(stage.x).toBe(self.x + self.width)
  })
})
