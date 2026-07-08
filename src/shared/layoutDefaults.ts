/**
 * The app's default workspace layout (the seed). App-specific view ids live here, not
 * in the generic model (`workspaceLayout`). Since the tab nav was retired, panels host game +
 * debug views only, so the seed is a resizable two-column play shell — chat | status. Every FSM
 * mode starts from this; the user's per-mode edits diverge from there. A saved layout still
 * referencing the retired `navigator` view is migrated to `chat` on load (see migrateRetiredViews).
 */
import type { LayoutSpec, ModeLayouts, WsNode } from './workspaceLayout'

/** FSM modes that get their own saved layout (mirrors ChatToolbar's mode-switch). */
export const WORKSPACE_MODES = ['explore', 'dialogue', 'combat'] as const

const defaultRoot: WsNode = {
  type: 'split',
  dir: 'row',
  sizes: [70, 30],
  children: [
    { type: 'panel', key: 'center', view: 'chat' },
    { type: 'panel', key: 'right', view: 'status' }
  ]
}

/** View ids removed when the tab nav was retired, mapped to their replacement. A saved layout
 *  authored before the change can still reference them; this keeps its panel from resolving to the
 *  "unknown view" placeholder. Applied by the workspace store on load. */
const RETIRED_VIEWS: Record<string, string> = { navigator: 'chat' }

/** Rewrite any retired view id in a layout tree to its replacement (in place on a fresh clone).
 *  Returns the same node reference for convenience. */
export const migrateRetiredViews = (node: WsNode): WsNode => {
  if (node.type === 'panel') {
    const to = RETIRED_VIEWS[node.view]
    if (to) node.view = to
    return node
  }
  node.children.forEach(migrateRetiredViews)
  return node
}

export const DEFAULT_LAYOUT: LayoutSpec = { root: defaultRoot }

/** The seed layout for a given FSM mode. Every mode (incl. combat) starts from the same default
 *  shell so entering combat doesn't reshape the workspace; the user arranges the combat layout
 *  themselves (e.g. set a panel's view to `combat`) and it persists per-mode. (Owner-chosen
 *  2026-06-26 — was a combat-specific seed that surprised users by swapping the layout.) */
export const defaultLayoutForMode = (_mode: string): LayoutSpec => DEFAULT_LAYOUT

export const defaultModeLayouts = (): ModeLayouts => {
  const layouts: ModeLayouts = {}
  for (const mode of WORKSPACE_MODES)
    layouts[mode] = JSON.parse(JSON.stringify(defaultLayoutForMode(mode)))
  return layouts
}
