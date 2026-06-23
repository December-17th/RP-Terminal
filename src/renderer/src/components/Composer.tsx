import { useComposer } from '../hooks/useComposer'

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
        placeholder="What do you do?  (type / for commands)"
        disabled={isGenerating}
      />
      <button
        className={`send-btn ${isGenerating ? 'stop' : ''}`}
        title={isGenerating ? 'Stop generation' : 'Send'}
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
