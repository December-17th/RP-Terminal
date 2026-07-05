import React, { useMemo } from 'react'
import { ViewRegistry } from './viewRegistry'
import { WorkspaceContext } from './context'
import { WcvPanel } from './WcvPanel'
import { StaticSlot, StaticLayout, slotIsChromed } from './staticLayout'

/**
 * Static, card-determined workspace (the WCV plan): the card declares a fixed grid + slots, each
 * hosting a native view (by id, e.g. "chat"/"status") or an out-of-process card-UI WebContentsView
 * (`view:"wcv"` + an `entry` URL). Because the layout is FIXED (no splitters / drag-rearrange), the
 * WebContentsView overlay bounds are stable — the overlay tax that makes a WCV awkward in the
 * resizable workspace doesn't apply here (it only re-measures on window resize).
 *
 * A `seamless` layout drops the inter-slot gap/padding and each slot's chrome (border/radius/title
 * bar) so adjacent WCV surfaces compose into one continuous stage — the poem-play-area VN band. The
 * seam decision lives in `slotIsChromed` (staticLayout.ts).
 */

export type { StaticSlot, StaticLayout } from './staticLayout'

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
  // Seamless layouts drop the grid gap/padding so slots abut with no visible line (each slot's own
  // chrome is dropped per-slot below); chromed layouts keep the 6px inset that separates panels.
  const inset = layout.seamless ? 0 : 6
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
          gap: inset,
          padding: inset
        }}
      >
        {layout.slots.map((slot) => {
          const [c, r, cs, rs] = slot.rect
          const fill = slot.view === 'wcv' || ViewRegistry[slot.view]?.fill
          const chromed = slotIsChromed(layout, slot)
          const gridStyle = {
            gridColumn: `${c + 1} / span ${cs}`,
            gridRow: `${r + 1} / span ${rs}`
          }
          // Bare (seamless) slot: no border/radius/title bar and always fill — the card's WCV paints
          // edge-to-edge and owns its own background so neighbours compose into one surface.
          if (!chromed) {
            return (
              <div key={slot.id} className="ws-panel ws-bare" style={gridStyle}>
                <div className="ws-panel-body ws-fill">
                  <SlotBody slot={slot} />
                </div>
              </div>
            )
          }
          return (
            <div key={slot.id} className="ws-panel" style={gridStyle}>
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
