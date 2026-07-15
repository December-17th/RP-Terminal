import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './Modal'
import { useChatStore } from '../stores/chatStore'
import { stripThinking, stripRptEvents } from '../../../shared/responseView'
import { useT } from '../i18n'

/**
 * View + delete floors. Deletion is a CONSECUTIVE TAIL from the latest floor (pick a floor → it and
 * everything below it are removed), mirroring SillyTavern's "delete messages" mode. The heavy lifting
 * (removing the floors' memory-table ops + journaled variable writes, rebuilding the SQL sandbox from
 * the survivors) is main-side truncateFloors, reached via chatStore.deleteFloorsFrom.
 */
const preview = (s: string, n: number): string => {
  const clean = stripRptEvents(stripThinking(s || ''))
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

// Rough vertical pitch of one row incl. the 4px flex gap. Rows are variable height (each of the
// player/AI previews clamps to 3 lines and the player line is optional), so windowing is APPROXIMATE:
// the estimate + generous overscan keep the visible band correct; the scrollbar length is only an
// estimate, which is fine for a management modal. Selection lives in `cut` (a floor number), so it
// survives a row scrolling out of the rendered window.
const ROW_PITCH = 100
const OVERSCAN = 10

interface FloorRowProps {
  floor: number
  youText: string | null
  aiText: string
  marked: boolean
  isCut: boolean
  youLabel: string
  aiLabel: string
  selectTip: string
  onSelect: (floor: number) => void
}

// Memoized so re-renders (a new selection, a scroll that only shifts the window) reconcile just the
// rows whose primitive props actually changed — not all ~60 rendered rows, and never the preview text.
const FloorRow = React.memo(function FloorRow({
  floor,
  youText,
  aiText,
  marked,
  isCut,
  youLabel,
  aiLabel,
  selectTip,
  onSelect
}: FloorRowProps) {
  return (
    <button
      type="button"
      className={`rpt-floors-row${marked ? ' marked' : ''}${isCut ? ' cut' : ''}`}
      title={selectTip}
      onClick={() => onSelect(floor)}
    >
      <span className="rpt-floors-idx">#{floor}</span>
      <span className="rpt-floors-prev">
        {youText != null ? (
          <span className="rpt-floors-you">
            <b>{youLabel}:</b> {youText}
          </span>
        ) : null}
        <span className="rpt-floors-ai">
          <b>{aiLabel}:</b> {aiText}
        </span>
      </span>
    </button>
  )
})

export const FloorManagerModal: React.FC<{ profileId: string; onClose: () => void }> = ({
  profileId,
  onClose
}) => {
  const t = useT()
  const floors = useChatStore((s) => s.floors)
  const deleteFloorsFrom = useChatStore((s) => s.deleteFloorsFrom)
  const [cut, setCut] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  // Preview strings are the per-floor cost the audit flagged (stripThinking/stripRptEvents/whitespace
  // over up to 500 chars × every floor). Compute them once per floors change, not per render/scroll.
  const previews = useMemo(
    () =>
      floors.map((f) => ({
        you: f.user_message.content ? preview(f.user_message.content, 300) : null,
        ai: preview(f.response.content, 500)
      })),
    [floors]
  )

  const latest = floors.length ? floors[floors.length - 1].floor : -1
  // Deletion is a contiguous tail; floors are ascending by `floor` (the file already assumes this via
  // `latest`). The first index whose floor ≥ cut starts the tail, so the count is index arithmetic —
  // no per-render array rescan of every floor.
  const cutIndex = useMemo(
    () => (cut == null ? -1 : floors.findIndex((f) => f.floor >= cut)),
    [floors, cut]
  )
  const count = cutIndex < 0 ? 0 : floors.length - cutIndex

  // Windowed rendering: only the rows around the scroll position are mounted, so a 500-floor chat mounts
  // ~60 buttons instead of 500. Small lists (first === 0 && last === total, no spacers) render exactly as
  // before.
  const listRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, h: 0 })
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setScroll({ top: el.scrollTop, h: el.clientHeight })
  }, [])
  useEffect(() => {
    const el = listRef.current
    if (el) setScroll({ top: el.scrollTop, h: el.clientHeight })
  }, [floors.length])

  const total = floors.length
  const winH = scroll.h || 600
  const first = Math.max(0, Math.floor(scroll.top / ROW_PITCH) - OVERSCAN)
  const last = Math.min(total, first + Math.ceil(winH / ROW_PITCH) + OVERSCAN * 2)
  const topPad = first * ROW_PITCH
  const bottomPad = Math.max(0, (total - last) * ROW_PITCH)

  const handleSelect = useCallback((floor: number) => {
    setCut(floor)
    setConfirming(false)
  }, [])

  const onDelete = async (): Promise<void> => {
    if (cut == null) return
    setBusy(true)
    try {
      await deleteFloorsFrom(profileId, cut)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const youLabel = t('floors.you')
  const aiLabel = t('floors.ai')
  const selectTip = t('floors.selectTip')

  return (
    <Modal title={t('floors.title')} onClose={onClose}>
      <div className="rpt-floors">
        {floors.length === 0 ? (
          <div style={{ opacity: 0.6 }}>{t('floors.empty')}</div>
        ) : (
          <>
            <p className="rpt-floors-hint">{t('floors.hint')}</p>
            <div className="rpt-floors-list" ref={listRef} onScroll={onScroll}>
              {topPad > 0 ? <div aria-hidden style={{ flex: '0 0 auto', height: topPad }} /> : null}
              {floors.slice(first, last).map((f, i) => {
                const idx = first + i
                const p = previews[idx]
                return (
                  <FloorRow
                    key={f.floor}
                    floor={f.floor}
                    youText={p.you}
                    aiText={p.ai}
                    marked={cut != null && f.floor >= cut}
                    isCut={cut === f.floor}
                    youLabel={youLabel}
                    aiLabel={aiLabel}
                    selectTip={selectTip}
                    onSelect={handleSelect}
                  />
                )
              })}
              {bottomPad > 0 ? (
                <div aria-hidden style={{ flex: '0 0 auto', height: bottomPad }} />
              ) : null}
            </div>

            <div className="rpt-floors-actions">
              <span className="rpt-floors-summary">
                {cut == null
                  ? t('floors.pickPrompt')
                  : t('floors.willDelete', { from: cut, to: latest, count })}
              </span>
              {!confirming ? (
                <button
                  type="button"
                  className="rpt-floors-del"
                  disabled={cut == null || busy}
                  onClick={() => setConfirming(true)}
                >
                  {t('floors.delete')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="rpt-duel-secondary"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="rpt-floors-del"
                    disabled={busy}
                    onClick={() => void onDelete()}
                  >
                    {t('floors.confirmDelete', { count })}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
