import React from 'react'
import { useWcvSuppression } from './useWcvSuppression'

interface ModalProps {
  title: string
  onClose: () => void
  headerActions?: React.ReactNode
  children: React.ReactNode
}

export const Modal: React.FC<ModalProps> = ({ title, onClose, headerActions, children }) => {
  // Native card WCVs would otherwise paint over the modal (they ignore DOM z-order).
  useWcvSuppression()
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
