import React from 'react'
import { createRafScheduler } from '../../lib/rafScheduler'

/**
 * A draggable boundary between two split children. Emits incremental resize deltas as a
 * PERCENT of the parent split's extent (so the pure tree op stays unit-agnostic). Measures
 * the parent `.ws-split` on drag start; listens on window so the drag survives the cursor
 * leaving the 6px handle.
 *
 * Mousemoves fire faster than the display refreshes and each `onResize` rebuilds the whole split
 * tree (and pushes WCV panel bounds), so we sum the pixel deltas between frames and emit at most one
 * `onResize` per animation frame — same percent-of-extent semantics, just batched. (A local
 * preview-then-commit-on-mouseup could avoid touching persisted layout mid-drag entirely; deferred
 * as follow-up since it changes when the store is written.)
 */
export const Splitter: React.FC<{ dir: 'row' | 'col'; onResize: (deltaPct: number) => void }> = ({
  dir,
  onResize
}) => {
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const container = e.currentTarget.parentElement
    const extent = container ? (dir === 'row' ? container.clientWidth : container.clientHeight) : 0
    if (extent <= 0) return
    let last = dir === 'row' ? e.clientX : e.clientY

    // Deltas accumulated since the last emitted frame; flushed as one onResize per rAF.
    let pendingPx = 0
    const scheduler = createRafScheduler()
    const flush = (): void => {
      const px = pendingPx
      pendingPx = 0
      if (px !== 0) onResize((px / extent) * 100)
    }
    const onMove = (ev: MouseEvent): void => {
      const pos = dir === 'row' ? ev.clientX : ev.clientY
      const deltaPx = pos - last
      last = pos
      if (deltaPx !== 0) {
        pendingPx += deltaPx
        scheduler.schedule(flush)
      }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      scheduler.cancel()
      flush() // emit any delta accumulated since the last frame so the final position isn't dropped
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize'
  }

  return <div className={`ws-splitter ws-splitter-${dir}`} onMouseDown={onMouseDown} />
}
