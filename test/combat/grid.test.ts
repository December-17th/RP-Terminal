import { describe, it, expect } from 'vitest'
import {
  inBounds,
  tileAt,
  distance,
  inRange,
  octantDir,
  reachable,
  templateCells,
  clipToGrid,
  targetsInCells
} from '../../src/shared/combat/grid'
import type { Combatant, Coord, GridSpec, TileFlags } from '../../src/shared/combat/types'

const open = (w: number, h: number): GridSpec => ({ w, h, cellFt: 5 })

const tile = (over: Partial<TileFlags>): TileFlags => ({
  passable: true,
  blocksLoS: false,
  difficult: false,
  hazard: false,
  ...over
})

const withTiles = (grid: GridSpec, set: (t: TileFlags[], w: number) => void): GridSpec => {
  const tiles = Array.from({ length: grid.w * grid.h }, () => tile({}))
  set(tiles, grid.w)
  return { ...grid, tiles }
}

const fighter = (id: string, pos: Coord, block: Partial<Combatant['block']> = {}): Combatant => ({
  id,
  side: 'party',
  name: id,
  pos,
  block: { hp: 10, maxHp: 10, ac: 12, speed: 1, mods: {}, abilities: [], conditions: [], ...block }
})

const has = (cells: Coord[], c: Coord): boolean => cells.some(([x, y]) => x === c[0] && y === c[1])

describe('distance / inRange / inBounds / octantDir', () => {
  it('uses Chebyshev distance', () => {
    expect(distance([0, 0], [3, 1])).toBe(3)
    expect(distance([2, 2], [2, 2])).toBe(0)
    expect(inRange([0, 0], [2, 2], 2)).toBe(true)
    expect(inRange([0, 0], [3, 0], 2)).toBe(false)
  })
  it('bounds and octant direction', () => {
    const g = open(5, 5)
    expect(inBounds(g, [0, 0])).toBe(true)
    expect(inBounds(g, [5, 0])).toBe(false)
    expect(inBounds(g, [-1, 2])).toBe(false)
    expect(octantDir([2, 2], [4, 1])).toEqual([1, -1])
    expect(octantDir([2, 2], [2, 5])).toEqual([0, 1])
  })
})

describe('tileAt', () => {
  it('defaults untiled / out-of-bounds cells to open', () => {
    expect(tileAt(open(3, 3), [1, 1]).passable).toBe(true)
    const g = withTiles(open(3, 3), (t, w) => {
      t[1 * w + 1] = tile({ passable: false })
    })
    expect(tileAt(g, [1, 1]).passable).toBe(false)
    expect(tileAt(g, [9, 9]).passable).toBe(true) // out-of-bounds reads as open
  })
})

describe('reachable', () => {
  it('returns the 8 neighbors at speed 1 on an open grid (start excluded)', () => {
    const cs = [fighter('a', [2, 2], { speed: 1 })]
    const r = reachable(open(5, 5), cs, 'a')
    expect(r).toHaveLength(8)
    expect(has(r, [2, 2])).toBe(false)
    expect(has(r, [1, 1])).toBe(true)
  })
  it('expands with speed at Chebyshev cost', () => {
    const cs = [fighter('a', [2, 2], { speed: 2 })]
    const r = reachable(open(5, 5), cs, 'a')
    // every non-origin cell of a 5x5 grid is within Chebyshev distance 2 of the center
    expect(r).toHaveLength(24)
  })
  it('treats difficult terrain as cost 2 and other combatants as blockers', () => {
    const grid = withTiles(open(5, 5), (t, w) => {
      t[2 * w + 3] = tile({ difficult: true }) // [3,2]
    })
    const cs = [fighter('a', [2, 2], { speed: 1 }), fighter('b', [2, 1], { speed: 1 })]
    const r = reachable(grid, cs, 'a')
    expect(has(r, [3, 2])).toBe(false) // difficult → cost 2 > speed 1
    expect(has(r, [2, 1])).toBe(false) // occupied by b
    expect(has(r, [1, 2])).toBe(true)
  })
  it('does not enter impassable walls', () => {
    const grid = withTiles(open(5, 5), (t, w) => {
      t[2 * w + 3] = tile({ passable: false })
    })
    const cs = [fighter('a', [2, 2], { speed: 1 })]
    expect(has(reachable(grid, cs, 'a'), [3, 2])).toBe(false)
  })
})

describe('templateCells', () => {
  it('self is just the origin', () => {
    expect(templateCells({ kind: 'self' }, [2, 2])).toEqual([[2, 2]])
  })
  it('burst r=1 is a 3x3 square', () => {
    const cells = templateCells({ kind: 'burst', r: 1 }, [2, 2])
    expect(cells).toHaveLength(9)
    expect(has(cells, [1, 1])).toBe(true)
    expect(has(cells, [3, 3])).toBe(true)
  })
  it('line projects in the aimed direction', () => {
    expect(templateCells({ kind: 'line', len: 3 }, [0, 0], [1, 0])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0]
    ])
  })
  it('cone widens with distance (half-width floor(k/2))', () => {
    expect(templateCells({ kind: 'cone', len: 2 }, [0, 0], [1, 0])).toEqual([
      [1, 0],
      [2, -1],
      [2, 0],
      [2, 1]
    ])
  })
})

describe('clipToGrid / targetsInCells', () => {
  it('clips off-grid cells and finds occupants', () => {
    const g = open(3, 3)
    const cells = templateCells({ kind: 'burst', r: 1 }, [0, 0])
    expect(clipToGrid(g, cells).every(([x, y]) => x >= 0 && y >= 0)).toBe(true)
    const cs = [fighter('a', [0, 0]), fighter('b', [1, 1]), fighter('c', [2, 2])]
    const hit = targetsInCells(cs, clipToGrid(g, cells)).map((c) => c.id)
    expect(hit.sort()).toEqual(['a', 'b'])
  })
})
