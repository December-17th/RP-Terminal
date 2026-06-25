import { useEffect, useRef } from 'react'
import { useT } from '../i18n'

export function EditArea({
  value,
  onChange,
  onSave,
  onCancel
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  const t = useT()
  // Auto-size to the content so the editor matches the message.
  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [value])

  return (
    <div className="edit-area">
      <textarea
        ref={ref}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onSave()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="edit-actions">
        <button className="btn-accent" onClick={onSave}>
          {t('common.save')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <span className="edit-hint">{t('chat.editHint')}</span>
      </div>
    </div>
  )
}
