import { useEffect } from 'react'
import { useComposer } from '../hooks/useComposer'
import { useT } from '../i18n'

/**
 * The action input: a textarea with slash-command autocomplete and a send/stop button.
 * Composer owns its own text/slash state (via useComposer); the parent supplies what to
 * do on a real message (`onSendMessage`) and on stop (`onStop`).
 */
export function Composer({
  isGenerating,
  onSendMessage,
  onStop
}: {
  isGenerating: boolean
  onSendMessage: (text: string) => void
  onStop: () => void
}): React.ReactElement {
  const {
    actionInput,
    onChange,
    setSlashIndex,
    setSlashDismissed,
    slashItems,
    slashOpen,
    slashActive,
    completeCommand,
    submit,
    actionRef
  } = useComposer({ onSendMessage })
  const t = useT()

  // Auto-grow the input: start at one line, grow with the content, cap at ~5 lines (CSS max-height),
  // then scroll. Re-measured whenever the text changes (incl. the reset to '' after a send).
  useEffect(() => {
    const el = actionRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }, [actionInput, actionRef])

  return (
    <div className="action-input-container">
      {slashOpen && (
        <div className="slash-menu" role="listbox">
          {slashItems.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === slashActive}
              className={`slash-item ${i === slashActive ? 'active' : ''}`}
              // mousedown (not click) + preventDefault keeps the textarea focused
              onMouseDown={(e) => {
                e.preventDefault()
                completeCommand(c)
              }}
              onMouseEnter={() => setSlashIndex(i)}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={actionRef}
        className="action-input"
        value={actionInput}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (slashOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSlashIndex((i) => (Math.min(i, slashItems.length - 1) + 1) % slashItems.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSlashIndex(
                (i) =>
                  (Math.min(i, slashItems.length - 1) - 1 + slashItems.length) % slashItems.length
              )
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              completeCommand(slashItems[slashActive])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setSlashDismissed(true)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (!isGenerating) submit()
          }
        }}
        placeholder={t('composer.placeholder')}
      />
      <button
        className={`send-btn ${isGenerating ? 'stop' : ''}`}
        title={isGenerating ? t('composer.stop') : t('composer.send')}
        disabled={!isGenerating && !actionInput.trim()}
        onClick={() => {
          if (isGenerating) {
            onStop()
            return
          }
          submit()
        }}
      >
        {isGenerating ? '■' : '⏎'}
      </button>
    </div>
  )
}
