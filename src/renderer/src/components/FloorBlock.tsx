import { type ReactNode } from 'react'
import { MessageContent } from './MessageContent'
import { EditArea } from './EditArea'

/** A floor with display regex already applied — what the chat actually renders. */
export interface RenderedFloor {
  floor: number
  user: string
  rawResponse: string
  html: string
}

/** Where + what a floor's right-click "edit" context menu targets. */
export interface FloorMenuTarget {
  x: number
  y: number
  floor: number
  field: 'user' | 'response'
  value: string
}

/** A single floor block (user action + AI response) with inline edit + context menu. */
export function FloorBlock({
  f,
  cardCss,
  editing,
  editText,
  onEditTextChange,
  onSaveEdit,
  onCancelEdit,
  onOpenMenu
}: {
  f: RenderedFloor
  cardCss?: string
  editing: { floor: number; field: 'user' | 'response' } | null
  editText: string
  onEditTextChange: (v: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onOpenMenu: (m: FloorMenuTarget) => void
}): ReactNode {
  const editingUser = editing?.floor === f.floor && editing.field === 'user'
  const editingResp = editing?.floor === f.floor && editing.field === 'response'
  return (
    <div className="floor-block">
      {editingUser ? (
        <EditArea
          value={editText}
          onChange={onEditTextChange}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : f.user ? (
        <div
          className="user-action"
          title="Right-click for options"
          onContextMenu={(e) => {
            e.preventDefault()
            onOpenMenu({ x: e.clientX, y: e.clientY, floor: f.floor, field: 'user', value: f.user })
          }}
        >
          &gt; {f.user}
        </div>
      ) : null}
      {editingResp ? (
        <EditArea
          value={editText}
          onChange={onEditTextChange}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <MessageContent
          content={f.html}
          css={cardCss}
          onContextMenu={(x, y) =>
            onOpenMenu({ x, y, floor: f.floor, field: 'response', value: f.rawResponse })
          }
        />
      )}
    </div>
  )
}
