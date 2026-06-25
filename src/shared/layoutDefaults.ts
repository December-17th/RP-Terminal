/**
 * The app's default workspace layout (the seed). App-specific view ids live here, not
 * in the generic model (`workspaceLayout`). Reproduces today's fixed 3-column shell —
 * navigator | chat | (status / card-scripts) — so the foundation ships looking unchanged,
 * then becomes resizable + reconfigurable. Every FSM mode starts from this; the user's
 * per-mode edits diverge from there.
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
    {
      type: 'split',
      dir: 'col',
      sizes: [58, 42],
      children: [
        { type: 'panel', key: 'right-top', view: 'status' },
        { type: 'panel', key: 'right-bottom', view: 'card-scripts' }
      ]
    }
  ]
}

export const DEFAULT_LAYOUT: LayoutSpec = { root: defaultRoot }

// Combat mode gets its own seed: the native Combat view center, chat on the left,
// RPG status on the right. Still resizable/reconfigurable per the workspace model.
const combatRoot: WsNode = {
  type: 'split',
  dir: 'row',
  sizes: [28, 47, 25],
  children: [
    { type: 'panel', key: 'left', view: 'chat' },
    { type: 'panel', key: 'center', view: 'combat' },
    { type: 'panel', key: 'right', view: 'status' }
  ]
}

export const COMBAT_LAYOUT: LayoutSpec = { root: combatRoot }

/** The seed layout for a given FSM mode (Combat differs; others share the default). */
export const defaultLayoutForMode = (mode: string): LayoutSpec =>
  mode === 'combat' ? COMBAT_LAYOUT : DEFAULT_LAYOUT

export const defaultModeLayouts = (): ModeLayouts => {
  const layouts: ModeLayouts = {}
  for (const mode of WORKSPACE_MODES)
    layouts[mode] = JSON.parse(JSON.stringify(defaultLayoutForMode(mode)))
  return layouts
}
