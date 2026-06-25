import { type ReactNode } from 'react'
import { MessageContent } from './MessageContent'
import { ReasoningPanel } from './ReasoningPanel'
import { EditArea } from './EditArea'
import { useT } from '../i18n'

/** A floor with display regex already applied — what the chat actually renders. */
export interface RenderedFloor {
  floor: number
  user: string
  rawResponse: string
  html: string
  /** Reasoning (`<think>`) the card's regex did NOT beautify — shown in a collapsible section. '' = none. */
  thinking: string
  /** Active swipe index + total alternates for this floor (TH-2). */
  swipeId: number
  swipeCount: number
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
  reasoningTemplate,
  editing,
  editText,
  isLast,
  isGenerating,
  onEditTextChange,
  onSaveEdit,
  onCancelEdit,
  onOpenMenu,
  onSwipe
}: {
  f: RenderedFloor
  cardCss?: string
  /** Card-authored reasoning UI shell (data.extensions.rp_terminal.reasoning_template). */
  reasoningTemplate?: string
  editing: { floor: number; field: 'user' | 'response' } | null
  editText: string
  isLast: boolean
  isGenerating: boolean
  onEditTextChange: (v: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onOpenMenu: (m: FloorMenuTarget) => void
  onSwipe: (dir: 'left' | 'right') => void
}): ReactNode {
  const t = useT()
  const editingUser = editing?.floor === f.floor && editing.field === 'user'
  const editingResp = editing?.floor === f.floor && editing.field === 'response'
  // Swipe controls show on the latest floor (so a right-swipe can generate a new
  // alternate) and on any floor that already has more than one alternate.
  const showSwipes = !editingResp && f.user !== '' && (f.swipeCount > 1 || isLast)
  // Right is enabled when more alternates exist, or — on the last floor — to generate one.
  const canRight = f.swipeId < f.swipeCount - 1 || isLast
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
          title={t('chat.rightClickOptions')}
          onContextMenu={(e) => {
            e.preventDefault()
            onOpenMenu({ x: e.clientX, y: e.clientY, floor: f.floor, field: 'user', value: f.user })
          }}
        >
          &gt; {f.user}
        </div>
      ) : null}
      {f.thinking && (
        <ReasoningPanel
          reasoning={f.thinking}
          body={f.rawResponse}
          state="done"
          template={reasoningTemplate}
          css={cardCss}
        />
      )}
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
      {showSwipes && (
        <div className="swipe-controls">
          <button
            className="swipe-btn"
            title={t('chat.prevResponse')}
            disabled={isGenerating || f.swipeId <= 0}
            onClick={() => onSwipe('left')}
          >
            ‹
          </button>
          <span className="swipe-count">
            {f.swipeId + 1}/{f.swipeCount}
          </span>
          <button
            className="swipe-btn"
            title={f.swipeId < f.swipeCount - 1 ? t('chat.nextResponse') : t('chat.generateNew')}
            disabled={isGenerating || !canRight}
            onClick={() => onSwipe('right')}
          >
            ›
          </button>
        </div>
      )}
    </div>
  )
}
