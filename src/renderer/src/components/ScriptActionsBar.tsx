import { useState } from 'react'
import { useToolbarStore } from '../stores/toolbarStore'

/**
 * Action buttons contributed by scripts/plugins (rpt.ui.registerButton), grouped under a
 * menu in the bar above the input — expanded by default so newly added buttons are visible.
 */
export function ScriptActionsBar(): React.ReactElement {
  const toolbarButtons = useToolbarStore((s) => s.buttons)
  const [open, setOpen] = useState(true)

  return (
    <div className="script-actions-bar">
      <button
        className={`script-actions-toggle ${open ? 'open' : ''}`}
        title={open ? 'Hide script actions' : 'Show script actions'}
        onClick={() => setOpen((o) => !o)}
      >
        ☰ Actions
        <span className="script-actions-count">{toolbarButtons.length}</span>
        <span className="script-actions-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="script-actions-list">
          {toolbarButtons.length === 0 ? (
            <span className="script-actions-empty">
              No script actions — a script can add one with <code>rpt.ui.registerButton()</code>
            </span>
          ) : (
            toolbarButtons.map((b) => (
              <button key={b.key} className="nav-ext-btn" title={b.label} onClick={b.onClick}>
                {b.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
