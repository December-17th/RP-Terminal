import React from 'react'
import { Modal } from './Modal'
import { useT } from '../i18n'

interface ConfirmDialogProps {
  title: string
  body: string
  /** Caller passes the confirm label; falls back to t('common.confirm'). */
  confirmLabel?: string
  /** true → confirm button uses the danger style. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * In-app replacement for the OS-native `confirm()`: a blocking confirm built on `Modal`.
 * Esc / overlay-click cancels via Modal's onClose. Enter confirms only when the confirm
 * button is focused (native button behavior — no global key handler).
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel
}) => {
  const t = useT()
  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ margin: '0 0 16px' }}>{body}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-ghost" autoFocus onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className={danger ? 'btn-danger' : 'btn-accent'} onClick={onConfirm}>
          {confirmLabel ?? t('common.confirm')}
        </button>
      </div>
    </Modal>
  )
}
