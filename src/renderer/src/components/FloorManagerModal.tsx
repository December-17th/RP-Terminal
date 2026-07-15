import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

// Rows are variable height (each of the player/AI previews clamps to 3 lines and the player line is
// optional), so windowing is driven by PER-ROW measurement, not a single global pitch: each rendered
// row reports its own height (ResizeObserver), we keep those in a floor-keyed map, and estimate the
// still-unmeasured rows with the running average of the measured ones (seeded at EST_SEED). A single
// global/average pitch made the spacer sizes and the `first` index jump when scrolling between regions
// with different height distributions — cumulative offsets from real measurements don't. Selection lives
// in `cut` (a floor number), so it survives a row scrolling out of the rendered window.
const EST_SEED = 100
const OVERSCAN = 10

// Binary-search the cumulative-offset table for the row whose [offsets[i], offsets[i+1]) band contains
// `y`, clamped to a valid row index. `offsets` has length total+1 (offsets[total] === total height).
function rowAt(offsets: Float64Array, total: number, y: number): number {
  if (total <= 0) return 0
  let lo = 0
  let hi = total - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

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
  onMeasure: (floor: number, height: number) => void
}

// Memoized so re-renders (a new selection, a scroll that only shifts the window) reconcile just the
// rows whose primitive props actually changed — not all ~60 rendered rows, and never the preview text.
// Each row also reports its own measured height (initial layout + on any resize) so the parent can build
// cumulative offsets; `floor` and `onMeasure` are both stable, so the observer wires up once per mount.
const FloorRow = React.memo(function FloorRow({
  floor,
  youText,
  aiText,
  marked,
  isCut,
  youLabel,
  aiLabel,
  selectTip,
  onSelect,
  onMeasure
}: FloorRowProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = (): void => onMeasure(floor, el.getBoundingClientRect().height)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [floor, onMeasure])
  return (
    <button
      ref={ref}
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

  // Per-row measured heights, keyed by floor number (stable across scroll). Filled by each rendered
  // FloorRow's ResizeObserver via onMeasure; a version counter bumps only when a stored height actually
  // changes (deadband > 1px) so measurement can't spin a measure→setState loop.
  const heightsRef = useRef<Map<number, number>>(new Map())
  const [measureTick, setMeasureTick] = useState(0)
  const onMeasure = useCallback((floor: number, height: number) => {
    const m = heightsRef.current
    const prev = m.get(floor)
    if (prev == null || Math.abs(prev - height) > 1) {
      m.set(floor, height)
      setMeasureTick((v) => v + 1)
    }
  }, [])

  // Cumulative offsets via a single O(total) prefix-sum pass: measured rows use their real height,
  // unmeasured rows the running average of the measured ones (seeded at EST_SEED). Recomputed only when
  // the floors list or a measurement changes. offsets[i] = top of row i; offsets[total] = total height.
  const { offsets, totalHeight } = useMemo(() => {
    const m = heightsRef.current
    let sum = 0
    let cnt = 0
    for (const f of floors) {
      const h = m.get(f.floor)
      if (h != null) {
        sum += h
        cnt++
      }
    }
    const est = cnt > 0 ? sum / cnt : EST_SEED
    const offs = new Float64Array(total + 1)
    let acc = 0
    for (let i = 0; i < total; i++) {
      offs[i] = acc
      const h = m.get(floors[i].floor)
      acc += h != null ? h : est
    }
    offs[total] = acc
    return { offsets: offs, totalHeight: acc }
    // measureTick invalidates the memo when a measured height changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floors, total, measureTick])

  // Derive the mounted window by binary search over the offsets, then pad by OVERSCAN and clamp. Spacer
  // heights come straight from the offset table, so they stay consistent with the rows between them and
  // don't jump when scrolling across regions of differing row height. Small lists: firstVisible 0 and
  // lastVisible total-1 → first 0, last total → both spacers 0, every row rendered (as before).
  const firstVisible = rowAt(offsets, total, scroll.top)
  const lastVisible = rowAt(offsets, total, scroll.top + winH)
  const first = Math.max(0, firstVisible - OVERSCAN)
  const last = Math.min(total, lastVisible + 1 + OVERSCAN)
  const topPad = offsets[first]
  const bottomPad = Math.max(0, totalHeight - offsets[last])

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
                    onMeasure={onMeasure}
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
