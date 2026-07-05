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
import { DEFAULT_LAYOUT, migrateRetiredViews } from '../src/shared/layoutDefaults'

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
    expect(out.sizes).toEqual([80, 20]) // 70→80, 30→20, sum 100 preserved
  })

  it('resizeSplit clamps both panes to MIN_SIZE', () => {
    const shrunk = asSplit(resizeSplit(root(), [], 0, -100))
    expect(shrunk.sizes).toEqual([MIN_SIZE, 100 - MIN_SIZE])
    const grown = asSplit(resizeSplit(root(), [], 0, 100))
    expect(grown.sizes).toEqual([100 - MIN_SIZE, MIN_SIZE])
  })

  it('resizeSplit resolves a nested path and is a no-op on a bad index', () => {
    // A local nested tree (the default layout is now a flat 2-column row) to exercise nested-path resolution.
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
    expect(asSplit(resizeSplit(root(), [], 5, 10)).sizes).toEqual([70, 30]) // out of range
  })

  it('resizeSplit does not mutate the input tree', () => {
    const tree = root()
    resizeSplit(tree, [], 0, 10)
    expect(asSplit(tree).sizes).toEqual([70, 30])
  })

  it('setPanelView retargets only the matching panel', () => {
    const out = setPanelView(root(), 'center', 'logs')
    expect(findPanel(out, 'center')!.view).toBe('logs')
    expect(findPanel(out, 'right')!.view).toBe('status')
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

  describe('migrateRetiredViews', () => {
    it('rewrites the retired `navigator` view to `chat` and leaves others untouched', () => {
      const tree: WsNode = {
        type: 'split',
        dir: 'row',
        sizes: [25, 50, 25],
        children: [
          { type: 'panel', key: 'left', view: 'navigator' },
          { type: 'panel', key: 'center', view: 'chat' },
          { type: 'panel', key: 'right', view: 'status' }
        ]
      }
      migrateRetiredViews(tree)
      expect(findPanel(tree, 'left')!.view).toBe('chat')
      expect(findPanel(tree, 'center')!.view).toBe('chat')
      expect(findPanel(tree, 'right')!.view).toBe('status')
    })
  })
})
