import React, { useMemo } from 'react'
import { ViewRegistry } from './viewRegistry'
import { WorkspaceContext } from './context'
import { WcvPanel } from './WcvPanel'

/**
 * Static, card-determined workspace (the WCV plan): the card declares a fixed grid + slots, each
 * hosting a native view (by id, e.g. "chat"/"status") or an out-of-process card-UI WebContentsView
 * (`view:"wcv"` + an `entry` URL). Because the layout is FIXED (no splitters / drag-rearrange), the
 * WebContentsView overlay bounds are stable — the overlay tax that makes a WCV awkward in the
 * resizable workspace doesn't apply here (it only re-measures on window resize).
 */

export interface StaticSlot {
  id: string
  view: string
  rect: [number, number, number, number] // [col, row, colSpan, rowSpan]
  entry?: string
  title?: string
}
export interface StaticLayout {
  grid: { cols: number; rows: number }
  slots: StaticSlot[]
}

const SlotBody: React.FC<{ slot: StaticSlot }> = ({ slot }) => {
  if (slot.view === 'wcv') {
    return <WcvPanel slotId={`static:${slot.id}`} url={slot.entry || 'about:blank'} />
  }
  const entry = ViewRegistry[slot.view]
  if (!entry) {
    return <div style={{ color: 'var(--rpt-danger, #e66)' }}>Unknown view: {slot.view}</div>
  }
  return <entry.Component />
}

export function StaticWorkspace({
  profileId,
  layout
}: {
  profileId: string
  layout: StaticLayout
}): React.ReactElement {
  const ctx = useMemo(() => ({ profileId }), [profileId])
  const { cols, rows } = layout.grid
  return (
    <WorkspaceContext.Provider value={ctx}>
      <div
        className="ws-static"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 6,
          padding: 6
        }}
      >
        {layout.slots.map((slot) => {
          const [c, r, cs, rs] = slot.rect
          const fill = slot.view === 'wcv' || ViewRegistry[slot.view]?.fill
          return (
            <div
              key={slot.id}
              className="ws-panel"
              style={{ gridColumn: `${c + 1} / span ${cs}`, gridRow: `${r + 1} / span ${rs}` }}
            >
              <div className="ws-panel-head">
                {slot.title || ViewRegistry[slot.view]?.title || slot.view}
              </div>
              <div className={`ws-panel-body ${fill ? 'ws-fill' : 'ws-scroll'}`}>
                <SlotBody slot={slot} />
              </div>
            </div>
          )
        })}
      </div>
    </WorkspaceContext.Provider>
  )
}
