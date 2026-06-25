// Combat core — grid geometry, movement & targeting (Track Combat / P1).
//
// Pure module (no main/renderer imports). Square grid with 8-directional movement
// and Chebyshev distance (a diagonal step costs the same as an orthogonal one —
// the lean v1 rule; refined later). Difficult terrain costs 2 to enter. Functions
// take only the slices they need so they're trivial to unit-test.

import type { AoeShape, Combatant, Coord, GridSpec, TileFlags } from './types'

const OPEN: TileFlags = { passable: true, blocksLoS: false, difficult: false, hazard: false }

const DIRS: Coord[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
]

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0)
const cellKey = ([x, y]: Coord): string => `${x},${y}`
const fromKey = (k: string): Coord => {
  const i = k.indexOf(',')
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))]
}

/** Is the cell inside the grid? */
export const inBounds = (grid: GridSpec, [x, y]: Coord): boolean =>
  x >= 0 && y >= 0 && x < grid.w && y < grid.h

/** Terrain at a cell; out-of-bounds and untiled cells read as fully open. */
export const tileAt = (grid: GridSpec, c: Coord): TileFlags => {
  if (!grid.tiles || !inBounds(grid, c)) return OPEN
  return grid.tiles[c[1] * grid.w + c[0]] ?? OPEN
}

/** Chebyshev (king-move) distance in cells. */
export const distance = (a: Coord, b: Coord): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

/** Within `range` cells of each other (inclusive). */
export const inRange = (a: Coord, b: Coord, range: number): boolean => distance(a, b) <= range

/** Unit direction (each component ∈ {-1,0,1}) from one cell toward another. */
export const octantDir = (from: Coord, to: Coord): Coord => [
  sign(to[0] - from[0]),
  sign(to[1] - from[1])
]

/**
 * Cells a combatant can reach this turn: Dijkstra over passable, unoccupied cells
 * (other combatants block), normal step = 1, difficult = 2, total ≤ `speed`. The
 * start cell is excluded. Grids are small so a linear-scan frontier is fine.
 */
export const reachable = (grid: GridSpec, combatants: Combatant[], id: string): Coord[] => {
  const self = combatants.find((c) => c.id === id)
  if (!self) return []
  const speed = self.block.speed
  const blocked = new Set(combatants.filter((c) => c.id !== id).map((c) => cellKey(c.pos)))

  const best = new Map<string, number>([[cellKey(self.pos), 0]])
  const visited = new Set<string>()
  for (;;) {
    let curKey: string | null = null
    let curCost = Infinity
    for (const [k, c] of best) {
      if (!visited.has(k) && c < curCost) {
        curCost = c
        curKey = k
      }
    }
    if (curKey === null) break
    visited.add(curKey)
    const [cx, cy] = fromKey(curKey)
    for (const [dx, dy] of DIRS) {
      const next: Coord = [cx + dx, cy + dy]
      const nk = cellKey(next)
      if (!inBounds(grid, next) || blocked.has(nk)) continue
      const tile = tileAt(grid, next)
      if (!tile.passable) continue
      const nc = curCost + (tile.difficult ? 2 : 1)
      if (nc <= speed && nc < (best.get(nk) ?? Infinity)) best.set(nk, nc)
    }
  }

  const out: Coord[] = []
  for (const [k, c] of best) if (c > 0 && c <= speed) out.push(fromKey(k))
  return out
}

/**
 * The cells an AoE shape covers. `origin` is the template anchor (center for
 * burst/aura; first projected cell for line/cone). `dir` aims line/cone (any
 * non-zero delta works; it's reduced to one of the 8 octants). Geometry only —
 * returned cells may fall off-grid; clip with `clipToGrid` and collect occupants
 * with `targetsInCells`. Lean shapes: burst/aura = Chebyshev square of radius r;
 * cone half-width grows as floor(k/2) at step k.
 */
export const templateCells = (shape: AoeShape, origin: Coord, dir: Coord = [1, 0]): Coord[] => {
  const [ox, oy] = origin
  switch (shape.kind) {
    case 'self':
      return [origin]
    case 'burst':
    case 'aura': {
      const r = shape.r
      const out: Coord[] = []
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push([ox + dx, oy + dy])
      return out
    }
    case 'line':
    case 'cone': {
      let [sx, sy] = [sign(dir[0]), sign(dir[1])]
      if (sx === 0 && sy === 0) [sx, sy] = [1, 0]
      const [px, py] = [-sy, sx] // perpendicular
      const out: Coord[] = []
      if (shape.kind === 'line') {
        const width = shape.width ?? 1
        const lo = -Math.floor((width - 1) / 2)
        const hi = lo + width - 1
        for (let k = 1; k <= shape.len; k++)
          for (let w = lo; w <= hi; w++) out.push([ox + sx * k + px * w, oy + sy * k + py * w])
      } else {
        for (let k = 1; k <= shape.len; k++) {
          const half = Math.floor(k / 2)
          for (let w = -half; w <= half; w++) out.push([ox + sx * k + px * w, oy + sy * k + py * w])
        }
      }
      return out
    }
  }
}

/** Keep only the in-bounds cells of a template. */
export const clipToGrid = (grid: GridSpec, cells: Coord[]): Coord[] =>
  cells.filter((c) => inBounds(grid, c))

/** Combatants standing on any of the given cells. */
export const targetsInCells = (combatants: Combatant[], cells: Coord[]): Combatant[] => {
  const set = new Set(cells.map(cellKey))
  return combatants.filter((c) => set.has(cellKey(c.pos)))
}
