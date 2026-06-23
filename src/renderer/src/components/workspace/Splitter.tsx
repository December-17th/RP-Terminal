import React from 'react'

/**
 * A draggable boundary between two split children. Emits incremental resize deltas as a
 * PERCENT of the parent split's extent (so the pure tree op stays unit-agnostic). Measures
 * the parent `.ws-split` on drag start; listens on window so the drag survives the cursor
 * leaving the 6px handle.
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

    const onMove = (ev: MouseEvent): void => {
      const pos = dir === 'row' ? ev.clientX : ev.clientY
      const deltaPx = pos - last
      last = pos
      if (deltaPx !== 0) onResize((deltaPx / extent) * 100)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
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
