import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): React.ReactNode {
  useEffect(() => {
    const close = (): void => onClose()
    // Defer so the opening right-click doesn't immediately dismiss it.
    const t = setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('resize', close)
    })
    return () => {
      clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('resize', close)
    }
  }, [])

  return createPortal(
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button
          key={it.label}
          className={`context-menu-item ${it.danger ? 'danger' : ''}`}
          onClick={() => {
            it.onClick()
            onClose()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
