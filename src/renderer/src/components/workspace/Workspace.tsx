import React, { useMemo } from 'react'
import type { WsNode } from '../../../../shared/workspaceLayout'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { WorkspaceContext } from './context'
import { Panel } from './Panel'
import { Splitter } from './Splitter'

/**
 * Renders the active FSM mode's split-tree layout: a resizable, reconfigurable set of
 * panels that replaces the old fixed 3-column shell. The tree is plain data in
 * `workspaceStore`; this just walks it (splits → flex row/col with a Splitter between
 * children, panels → <Panel>) and resizing routes back to the store's pure ops.
 */

const isHidden = (n: WsNode): boolean => n.type === 'panel' && !!n.hidden

function renderNode(node: WsNode, path: number[], mode: string): React.ReactNode {
  if (node.type === 'panel') return <Panel node={node} mode={mode} />

  const { dir, sizes, children } = node
  const items: React.ReactNode[] = []
  children.forEach((child, i) => {
    const hidden = isHidden(child)
    items.push(
      <div
        className="ws-pane"
        key={`pane-${i}`}
        style={
          hidden
            ? { flex: '0 0 auto' }
            : { flexGrow: sizes[i], flexBasis: 0, minWidth: 0, minHeight: 0 }
        }
      >
        {renderNode(child, [...path, i], mode)}
      </div>
    )
    // A splitter sits between consecutive visible children; resizing a collapsed
    // neighbor would do nothing, so suppress it there.
    if (i < children.length - 1 && !hidden && !isHidden(children[i + 1])) {
      items.push(
        <Splitter
          key={`split-${i}`}
          dir={dir}
          onResize={(d) => useWorkspaceStore.getState().resize(mode, path, i, d)}
        />
      )
    }
  })
  return <div className={`ws-split ws-split-${dir}`}>{items}</div>
}

export const Workspace: React.FC<{ profileId: string }> = ({ profileId }) => {
  const mode = useChatStore((s) => s.activeChatMode)
  const layouts = useWorkspaceStore((s) => s.layouts)
  const ctx = useMemo(() => ({ profileId }), [profileId])

  const spec = layouts[mode] || layouts.explore
  if (!spec) return <div className="ws-root" /> // layouts not loaded yet

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="ws-root">{renderNode(spec.root, [], mode)}</div>
    </WorkspaceContext.Provider>
  )
}
