/**
 * The workspace layout model — a recursive split-tree, kept as plain serializable
 * data so it round-trips to settings and later upgrades to free drag-dock without a
 * model change. Pure + shared (renderer store + unit tests): every op returns a NEW
 * tree (never mutates) and clamps panes to a minimum size, so the store can persist
 * the result and tests can assert on it. View ids are app-specific and live in the
 * seed data (`layoutDefaults`), not here — this module stays generic.
 */

import { clone } from './objectPath'

export type ViewId = string

export interface PanelNode {
  type: 'panel'
  /** Stable id used to target a panel (resize/setView/toggle); unique within a layout. */
  key: string
  view: ViewId
  hidden?: boolean
}

export interface SplitNode {
  type: 'split'
  dir: 'row' | 'col'
  /** One relative weight per child (percent-ish; a split's weights sum to ~100). */
  sizes: number[]
  children: WsNode[]
}

export type WsNode = SplitNode | PanelNode

export interface LayoutSpec {
  root: WsNode
}

export type ModeLayouts = Record<string, LayoutSpec>

/** A route to a node: child indices from the root (empty = root). */
export type NodePath = number[]

/** Minimum pane weight (percent) so a pane can't be dragged to nothing. */
export const MIN_SIZE = 8

const evenSizes = (n: number): number[] => Array(n).fill(100 / n)

/** Rebuild the tree applying `fn` to the node at `path` (structural copy along the path). */
function updateAtPath(node: WsNode, path: NodePath, fn: (n: WsNode) => WsNode): WsNode {
  if (path.length === 0) return fn(node)
  if (node.type !== 'split') return node // path doesn't resolve — leave untouched
  const [i, ...rest] = path
  if (i < 0 || i >= node.children.length) return node
  const children = node.children.slice()
  children[i] = updateAtPath(children[i], rest, fn)
  return { ...node, children }
}

/** Map every panel leaf through `fn`, returning a new tree. */
function mapPanels(node: WsNode, fn: (p: PanelNode) => PanelNode): WsNode {
  if (node.type === 'panel') return fn(node)
  return { ...node, children: node.children.map((c) => mapPanels(c, fn)) }
}

/**
 * Move the boundary between child `index` and `index+1` of the split at `path` by
 * `deltaPct` (percent of that split's extent). The two panes trade weight, their sum
 * preserved, each clamped to >= MIN_SIZE.
 */
export function resizeSplit(root: WsNode, path: NodePath, index: number, deltaPct: number): WsNode {
  return updateAtPath(root, path, (n) => {
    if (n.type !== 'split') return n
    if (index < 0 || index + 1 >= n.sizes.length) return n
    const sizes = n.sizes.slice()
    const sum = sizes[index] + sizes[index + 1]
    const a = Math.max(MIN_SIZE, Math.min(sum - MIN_SIZE, sizes[index] + deltaPct))
    sizes[index] = a
    sizes[index + 1] = sum - a
    return { ...n, sizes }
  })
}

/** Point the panel with `key` at a different view. */
export function setPanelView(root: WsNode, key: string, view: ViewId): WsNode {
  return mapPanels(root, (p) => (p.key === key ? { ...p, view } : p))
}

/** Flip a panel's hidden flag (hidden panels render collapsed; siblings reflow). */
export function togglePanelHidden(root: WsNode, key: string): WsNode {
  return mapPanels(root, (p) => (p.key === key ? { ...p, hidden: !p.hidden } : p))
}

function validateNode(n: unknown): n is WsNode {
  if (!n || typeof n !== 'object') return false
  const node = n as Record<string, unknown>
  if (node.type === 'panel') return typeof node.key === 'string' && typeof node.view === 'string'
  if (node.type === 'split') {
    return (
      (node.dir === 'row' || node.dir === 'col') &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      node.children.every(validateNode)
    )
  }
  return false
}

/** Re-derive a clean node: fix sizes whose length/values don't match the children. */
function normalizeNode(n: WsNode): WsNode {
  if (n.type === 'panel') {
    return n.hidden
      ? { type: 'panel', key: n.key, view: n.view, hidden: true }
      : { type: 'panel', key: n.key, view: n.view }
  }
  const children = n.children.map(normalizeNode)
  const ok =
    Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((s) => s > 0)
  return {
    type: 'split',
    dir: n.dir,
    sizes: ok ? n.sizes.slice() : evenSizes(children.length),
    children
  }
}

/**
 * Coerce a (possibly stale/partial) persisted layout into a valid one — falling back
 * to `def` when the saved value isn't a structurally valid tree, and repairing size
 * arrays otherwise. Keeps old settings from crashing the workspace after a shape change.
 */
export function mergeWithDefault(saved: unknown, def: LayoutSpec): LayoutSpec {
  const root =
    saved && typeof saved === 'object' ? (saved as Record<string, unknown>).root : undefined
  if (!validateNode(root)) return clone(def)
  return { root: normalizeNode(root) }
}

/** True if any panel leaf in the tree hosts `view`. */
export function hasPanelView(node: WsNode, view: string): boolean {
  if (node.type === 'panel') return node.view === view
  return node.children.some((c) => hasPanelView(c, view))
}

/** Wrap `root` in a row split with a new left panel hosting `view`. Idempotent: if `view`
 *  already appears anywhere, returns `root` unchanged (don't double-add on re-seed). */
export function injectLeftPanel(
  root: WsNode,
  view: string,
  key: string,
  leftPct = 14
): WsNode {
  if (hasPanelView(root, view)) return root
  return {
    type: 'split',
    dir: 'row',
    sizes: [leftPct, 100 - leftPct],
    children: [{ type: 'panel', key, view }, root]
  }
}
