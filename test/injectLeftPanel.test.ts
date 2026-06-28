import { describe, it, expect } from 'vitest'
import { injectLeftPanel, hasPanelView } from '../src/shared/workspaceLayout'
import type { WsNode } from '../src/shared/workspaceLayout'

const base: WsNode = { type: 'split', dir: 'row', sizes: [50, 50], children: [
  { type: 'panel', key: 'center', view: 'chat' },
  { type: 'panel', key: 'right', view: 'status' }
] }

describe('injectLeftPanel', () => {
  it('wraps the root in a row split with the new panel on the left', () => {
    const out = injectLeftPanel(base, 'regex:party', 'card-left', 14) as any
    expect(out.type).toBe('split')
    expect(out.dir).toBe('row')
    expect(out.sizes).toEqual([14, 86])
    expect(out.children[0]).toEqual({ type: 'panel', key: 'card-left', view: 'regex:party' })
    expect(out.children[1]).toBe(base)
  })
  it('is idempotent — does not add a second panel for the same view', () => {
    const once = injectLeftPanel(base, 'regex:party', 'card-left')
    const twice = injectLeftPanel(once, 'regex:party', 'card-left')
    expect(twice).toBe(once)
  })
})

describe('hasPanelView', () => {
  it('finds a view anywhere in the tree', () => {
    expect(hasPanelView(base, 'status')).toBe(true)
    expect(hasPanelView(base, 'regex:party')).toBe(false)
  })
})
