import React, { useState } from 'react'

interface Props {
  title: string
  count: number
  /** Short hint shown under the title (e.g. what the scope means). */
  hint?: string
  defaultOpen?: boolean
  children: React.ReactNode
}

/**
 * A collapsible "dropdown" section used by the scope-organized managers (scripts,
 * regex) to group artifacts under Global / World / Session. Header toggles open/closed
 * and shows the item count.
 */
export const ScopeSection: React.FC<Props> = ({ title, count, hint, defaultOpen, children }) => {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="scope-section">
      <button className="scope-section-head" onClick={() => setOpen((o) => !o)}>
        <span className="scope-section-caret">{open ? '▾' : '▸'}</span>
        <span className="scope-section-title">{title}</span>
        <span className="entry-keys-preview">{count}</span>
        {hint && <span className="scope-section-hint">{hint}</span>}
      </button>
      {open && <div className="scope-section-body">{children}</div>}
    </div>
  )
}
