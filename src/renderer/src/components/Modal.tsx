import React from 'react'
import { useWcvSuppression } from './useWcvSuppression'

interface ModalProps {
  title: string
  onClose: () => void
  headerActions?: React.ReactNode
  children: React.ReactNode
}

// Mounted modals, in mount order — Esc must close only the TOPMOST one, and must not leak to the
// window-level Esc listeners of whatever hosts the modal (e.g. the Memory Manager closes itself on
// Esc; without the stopPropagation a confirm dialog's Esc would tear down the whole manager).
const modalStack: symbol[] = []

export const Modal: React.FC<ModalProps> = ({ title, onClose, headerActions, children }) => {
  // Native card WCVs would otherwise paint over the modal (they ignore DOM z-order).
  useWcvSuppression()
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  React.useEffect(() => {
    const id = Symbol('modal')
    modalStack.push(id)
    // Capture phase, like the Memory Manager's ⋯-menu listener: runs before (and suppresses) the
    // host's bubble-phase Esc handling.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || modalStack[modalStack.length - 1] !== id) return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const i = modalStack.indexOf(id)
      if (i >= 0) modalStack.splice(i, 1)
    }
  }, [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {headerActions}
            <button className="btn-ghost" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
