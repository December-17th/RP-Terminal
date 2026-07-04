import { describe, it, expect } from 'vitest'
import {
  resizeSplit,
  setPanelView,
  togglePanelHidden,
  mergeWithDefault,
  MIN_SIZE,
  type SplitNode,
  type PanelNode,
  type WsNode
} from '../src/shared/workspaceLayout'
import { DEFAULT_LAYOUT } from '../src/shared/layoutDefaults'

const root = (): WsNode => JSON.parse(JSON.stringify(DEFAULT_LAYOUT.root))
const asSplit = (n: WsNode): SplitNode => {
  if (n.type !== 'split') throw new Error('expected split')
  return n
}
const findPanel = (n: WsNode, key: string): PanelNode | undefined => {
  if (n.type === 'panel') return n.key === key ? n : undefined
  for (const c of n.children) {
    const hit = findPanel(c, key)
    if (hit) return hit
  }
  return undefined
}

describe('workspaceLayout (pure split-tree ops)', () => {
  it('resizeSplit trades weight between neighbors and preserves their sum', () => {
    const out = asSplit(resizeSplit(root(), [], 0, 10))
    expect(out.sizes).toEqual([35, 40, 25]) // 25→35, 50→40, sum 75 preserved
  })

  it('resizeSplit clamps both panes to MIN_SIZE', () => {
    const shrunk = asSplit(resizeSplit(root(), [], 0, -100))
    expect(shrunk.sizes).toEqual([MIN_SIZE, 75 - MIN_SIZE, 25])
    const grown = asSplit(resizeSplit(root(), [], 0, 100))
    expect(grown.sizes).toEqual([75 - MIN_SIZE, MIN_SIZE, 25])
  })

  it('resizeSplit resolves a nested path and is a no-op on a bad index', () => {
    // A local nested tree (the default layout is now a flat 3-column row) to exercise nested-path resolution.
    const nestedRoot: WsNode = {
      type: 'split',
      dir: 'row',
      sizes: [25, 50, 25],
      children: [
        { type: 'panel', key: 'left', view: 'navigator' },
        { type: 'panel', key: 'center', view: 'chat' },
        {
          type: 'split',
          dir: 'col',
          sizes: [58, 42],
          children: [
            { type: 'panel', key: 'a', view: 'status' },
            { type: 'panel', key: 'b', view: 'logs' }
          ]
        }
      ]
    }
    const nested = asSplit(asSplit(resizeSplit(nestedRoot, [2], 0, 10)).children[2])
    expect(nested.sizes).toEqual([68, 32]) // the nested column's 58/42
    expect(asSplit(resizeSplit(root(), [], 5, 10)).sizes).toEqual([25, 50, 25]) // out of range
  })

  it('resizeSplit does not mutate the input tree', () => {
    const tree = root()
    resizeSplit(tree, [], 0, 10)
    expect(asSplit(tree).sizes).toEqual([25, 50, 25])
  })

  it('setPanelView retargets only the matching panel', () => {
    const out = setPanelView(root(), 'center', 'logs')
    expect(findPanel(out, 'center')!.view).toBe('logs')
    expect(findPanel(out, 'left')!.view).toBe('navigator')
  })

  it('togglePanelHidden flips and flips back', () => {
    const once = togglePanelHidden(root(), 'right')
    expect(findPanel(once, 'right')!.hidden).toBe(true)
    const twice = togglePanelHidden(once, 'right')
    expect(findPanel(twice, 'right')!.hidden).toBe(false)
  })

  describe('mergeWithDefault', () => {
    it('falls back to default for missing / invalid saved layouts', () => {
      expect(mergeWithDefault(undefined, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT)
      expect(mergeWithDefault({}, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT)
      expect(mergeWithDefault({ root: { type: 'bogus' } }, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT)
    })

    it('repairs a sizes array whose length does not match the children', () => {
      const saved = {
        root: {
          type: 'split',
          dir: 'row',
          sizes: [10], // wrong length for 2 children
          children: [
            { type: 'panel', key: 'a', view: 'chat' },
            { type: 'panel', key: 'b', view: 'status' }
          ]
        }
      }
      const merged = asSplit(mergeWithDefault(saved, DEFAULT_LAYOUT).root)
      expect(merged.sizes).toEqual([50, 50])
    })

    it('round-trips a serialized default unchanged', () => {
      const restored = JSON.parse(JSON.stringify(DEFAULT_LAYOUT))
      expect(mergeWithDefault(restored, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT)
    })
  })
})
