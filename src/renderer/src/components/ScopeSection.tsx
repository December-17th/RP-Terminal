import React, { useState } from 'react'

interface Props {
  title: string
  count: number
  /** Short hint shown under the title (e.g. what the scope means). */
  hint?: string
  defaultOpen?: boolean
  /** Optional control rendered at the right of the header (e.g. a "+ add" button).
   * Kept outside the toggle so clicking it doesn't collapse the section. */
  action?: React.ReactNode
  children: React.ReactNode
}

/**
 * A collapsible "dropdown" section used by the scope-organized managers (scripts,
 * regex) to group artifacts under Global / World / Session. The title area toggles
 * open/closed and shows the item count; an optional `action` sits to its right.
 */
export const ScopeSection: React.FC<Props> = ({
  title,
  count,
  hint,
  defaultOpen,
  action,
  children
}) => {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="scope-section">
      <div className="scope-section-head">
        <button className="scope-section-toggle" onClick={() => setOpen((o) => !o)}>
          <span className="scope-section-caret">{open ? '▾' : '▸'}</span>
          <span className="scope-section-title">{title}</span>
          <span className="entry-keys-preview">{count}</span>
          {hint && <span className="scope-section-hint">{hint}</span>}
        </button>
        {action && <div className="scope-section-action">{action}</div>}
      </div>
      {open && <div className="scope-section-body">{children}</div>}
    </div>
  )
}
