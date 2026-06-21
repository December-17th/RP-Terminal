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

export const defaultModeLayouts = (): ModeLayouts => {
  const layouts: ModeLayouts = {}
  for (const mode of WORKSPACE_MODES) layouts[mode] = JSON.parse(JSON.stringify(DEFAULT_LAYOUT))
  return layouts
}
