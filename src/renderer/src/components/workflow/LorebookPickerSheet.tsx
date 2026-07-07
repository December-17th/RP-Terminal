// The lorebook entry picker for `agent.llm`'s custom lore mode (agent & memory UX WP-H; spec §7).
// Opens from the Lorebook row in the node's Settings tab. Per the spec: a search bar filtering
// TITLES · entries listed as title (`comment`) only, no content preview · collapsible book groups
// with tri-state select-all checkboxes · selected count · missing count · Clear / Done (saves on
// Done). Picks persist per (worldId, docId, nodeId) via the lore-picks IPC — the doc itself stays
// world-portable. Entry identity = (book id, comment) — plan §0.4's comment fallback (no uid in our
// entry shape); duplicate comments within one book collapse to one row (they resolve together).
import React from 'react'
import { useT } from '../../i18n'

interface BookGroup {
  id: string
  name: string
  /** Unique entry titles (comments) in this book, list order. */
  titles: string[]
}

export interface LorePick {
  book: string
  comment: string
}

export default function LorebookPickerSheet({
  profileId,
  worldId,
  docId,
  nodeId,
  onClose
}: {
  profileId: string
  worldId: string
  docId: string
  nodeId: string
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [books, setBooks] = React.useState<BookGroup[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set()) // `${book}\n${comment}`
  const [missing, setMissing] = React.useState<LorePick[]>([])
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  const keyOf = (book: string, comment: string): string => `${book}\n${comment}`

  // Load the library's books + titles and the stored picks; split picks into resolvable (selected)
  // and missing (kept so Done can only drop them deliberately via Clear — we re-save them verbatim).
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const summaries = (await window.api.listLorebooks(profileId)) as {
          id: string
          name: string
        }[]
        const groups: BookGroup[] = []
        for (const s of summaries ?? []) {
          const book = (await window.api.getLorebook(profileId, s.id)) as {
            entries?: { comment?: string; enabled?: boolean }[]
          } | null
          if (!book) continue
          const titles: string[] = []
          const seen = new Set<string>()
          for (const e of book.entries ?? []) {
            const title = e.comment ?? ''
            if (!title || seen.has(title)) continue
            seen.add(title)
            titles.push(title)
          }
          if (titles.length > 0) groups.push({ id: s.id, name: s.name, titles })
        }
        const picks = (await window.api.getLorePicks(profileId, worldId, docId, nodeId)) ?? []
        if (cancelled) return
        const known = new Set(groups.flatMap((g) => g.titles.map((title) => keyOf(g.id, title))))
        const sel = new Set<string>()
        const miss: LorePick[] = []
        for (const p of picks) {
          if (known.has(keyOf(p.book, p.comment))) sel.add(keyOf(p.book, p.comment))
          else miss.push(p)
        }
        setBooks(groups)
        setSelected(sel)
        setMissing(miss)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, worldId, docId, nodeId])

  const toggle = (book: string, title: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = keyOf(book, title)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  /** Tri-state select-all per book: all → none; none/some → all (over the VISIBLE, filtered titles). */
  const toggleBook = (group: BookGroup, visibleTitles: string[]): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      const keys = visibleTitles.map((title) => keyOf(group.id, title))
      const allOn = keys.every((k) => next.has(k))
      for (const k of keys) {
        if (allOn) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }

  const onDone = async (): Promise<void> => {
    // Selected picks + the (deliberately kept) missing ones — Clear is the only way to drop them.
    const picks: LorePick[] = [...missing]
    for (const k of selected) {
      const idx = k.indexOf('\n')
      picks.push({ book: k.slice(0, idx), comment: k.slice(idx + 1) })
    }
    await window.api.setLorePicks(profileId, worldId, docId, nodeId, picks)
    onClose()
  }

  const onClear = (): void => {
    setSelected(new Set())
    setMissing([])
  }

  const q = query.trim().toLowerCase()

  return (
    <div className="rpt-lore-picker-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="rpt-lore-picker" onClick={(e) => e.stopPropagation()}>
        <div className="rpt-lore-picker-head">
          <strong>{t('workflowEditor.lore.pickerTitle')}</strong>
          <span className="rpt-lore-picker-counts">
            {t('workflowEditor.lore.selectedCount', { n: selected.size })}
            {missing.length > 0 && (
              <span className="rpt-lore-picker-missing">
                {' · '}
                {t('workflowEditor.lore.missingCount', { n: missing.length })}
              </span>
            )}
          </span>
        </div>
        <input
          type="search"
          value={query}
          placeholder={t('workflowEditor.lore.searchPh')}
          onChange={(e) => setQuery(e.target.value)}
          className="rpt-lore-picker-search"
        />
        <div className="rpt-lore-picker-list">
          {loading ? (
            <div className="rpt-lore-picker-empty">{t('workflowEditor.lore.loading')}</div>
          ) : books.length === 0 ? (
            <div className="rpt-lore-picker-empty">{t('workflowEditor.lore.noBooks')}</div>
          ) : (
            books.map((group) => {
              const visible = q
                ? group.titles.filter((title) => title.toLowerCase().includes(q))
                : group.titles
              if (visible.length === 0) return null
              const onCount = visible.filter((title) => selected.has(keyOf(group.id, title))).length
              const isCollapsed = collapsed.has(group.id)
              return (
                <div key={group.id} className="rpt-lore-picker-book">
                  <div className="rpt-lore-picker-book-head">
                    <input
                      type="checkbox"
                      checked={onCount === visible.length && visible.length > 0}
                      ref={(el) => {
                        // Tri-state: indeterminate when SOME visible titles are selected.
                        if (el) el.indeterminate = onCount > 0 && onCount < visible.length
                      }}
                      onChange={() => toggleBook(group, visible)}
                      aria-label={group.name}
                    />
                    <button
                      type="button"
                      className="rpt-lore-picker-book-name"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.id)) next.delete(group.id)
                          else next.add(group.id)
                          return next
                        })
                      }
                    >
                      {isCollapsed ? '▸' : '▾'} {group.name}
                      <span className="rpt-lore-picker-book-count">
                        {onCount}/{visible.length}
                      </span>
                    </button>
                  </div>
                  {!isCollapsed &&
                    visible.map((title) => (
                      <label key={title} className="rpt-lore-picker-entry">
                        <input
                          type="checkbox"
                          checked={selected.has(keyOf(group.id, title))}
                          onChange={() => toggle(group.id, title)}
                        />
                        <span>{title}</span>
                      </label>
                    ))}
                </div>
              )
            })
          )}
        </div>
        <div className="rpt-lore-picker-actions">
          <button type="button" onClick={onClear} style={{ fontSize: 12 }}>
            {t('workflowEditor.lore.clear')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ fontSize: 12 }}>
            {t('workflowEditor.moduleImport.cancel')}
          </button>
          <button type="button" onClick={() => void onDone()} style={{ fontSize: 12 }}>
            {t('workflowEditor.lore.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
