/**
 * The app's default workspace layout (the seed). App-specific view ids live here, not
 * in the generic model (`workspaceLayout`). A resizable + reconfigurable 3-column shell —
 * navigator | chat | status. Every FSM mode starts from this; the user's per-mode edits
 * diverge from there.
 */
import type { LayoutSpec, ModeLayouts, WsNode } from './workspaceLayout'

/** FSM modes that get their own saved layout (mirrors ChatToolbar's mode-switch). */
export const WORKSPACE_MODES = ['explore', 'dialogue', 'combat'] as const

const defaultRoot: WsNode = {
  type: 'split',
  dir: 'row',
  sizes: [25, 50, 25],
  children: [
    { type: 'panel', key: 'left', view: 'navigator' },
    { type: 'panel', key: 'center', view: 'chat' },
    { type: 'panel', key: 'right', view: 'status' }
  ]
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
