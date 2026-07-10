// Memory Manager — card-based data view (feedback 2026-07-09). Replaces the Excel-like TableGrid in the
// Memory Manager's Data tab with the shujuku 数据库 Visualizer model: each ROW is its own CARD, editing
// is EXPLICIT (per-card local draft + Save / Reset buttons), and inputs are never disabled mid-edit — so
// the double-click / blur-commit focus race in the shared TableGrid (grey field that won't accept input)
// cannot happen here. The shared TableGrid is left untouched for the workflow-editor's embedded quick view.
//
// Pagination / filtering reuse the same pure helpers as TableGrid (tableGridModel), so the two surfaces
// page identically. The row_id PK column is shown only as the card's #id (never an editable field).
import React from 'react'
import { useT } from '../../i18n'
import { filterRowIndices, pageInfo, pageSlice } from '../workspace/tableGridModel'
import type { TableRead } from '../workspace/TableGrid'

/** A single changed cell staged by a card's Save (column index + new string value). */
export interface CellChange {
  colIndex: number
  value: string
}

type LabelFn = (colIndex: number) => string

export function TableCards({
  table,
  headers,
  onSaveRow,
  onInsertRow,
  onDeleteRow,
  pageSize = 30
}: {
  table: TableRead
  /** Optional display labels (template headers); used only when they align 1:1 with the real columns. */
  headers?: string[]
  onSaveRow: (rowid: number, changes: CellChange[]) => Promise<void> | void
  onInsertRow: (values: (string | null)[]) => Promise<void> | void
  onDeleteRow: (rowid: number) => Promise<void> | void
  pageSize?: number
}): React.JSX.Element {
  const t = useT()
  const [filter, setFilter] = React.useState('')
  const [page, setPage] = React.useState(0)
  const [adding, setAdding] = React.useState<string[] | null>(null)

  const rowIdIdx = table.columns.findIndex((c) => c.toLowerCase() === 'row_id')
  const width = Math.max(1, table.columns.length)
  const label: LabelFn = (c) =>
    headers && headers.length === table.columns.length ? headers[c] : table.columns[c]

  const visible = React.useMemo(() => filterRowIndices(table.rows, filter), [table.rows, filter])
  React.useEffect(() => {
    setPage(0)
  }, [filter, table.sqlName])
  const info = pageInfo(visible.length, page, pageSize)
  const shown = pageSlice(visible, page, pageSize)

  const pageBtns = React.useMemo(() => {
    const span = 5
    const end = Math.min(info.pageCount, Math.max(info.page - Math.floor(span / 2), 0) + span)
    const start = Math.max(0, end - span)
    return Array.from({ length: end - start }, (_, i) => start + i)
  }, [info.page, info.pageCount])

  const submitAdd = async (): Promise<void> => {
    if (!adding) return
    // row_id-convention first cell → NULL so the INTEGER PK auto-assigns; others as typed.
    const values: (string | null)[] = adding.map((v, i) => (rowIdIdx === i && v.trim() === '' ? null : v))
    setAdding(null)
    await onInsertRow(values)
  }

  return (
    <div className="rpt-mm-cards">
      <div className="rpt-mm-cards-toolbar">
        <input
          type="search"
          className="rpt-mm-cards-search"
          placeholder={t('tables.filterPh')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="rpt-mm-cards-range">
          {t('memoryManager.rangeLabel', { from: info.from, to: info.to, total: info.total })}
        </span>
        <button
          className="rpt-duel-secondary"
          disabled={adding != null}
          onClick={() => setAdding(new Array(width).fill(''))}
        >
          {t('tables.addRow')}
        </button>
      </div>

      {adding && (
        <NewCard
          columns={table.columns}
          label={label}
          rowIdIdx={rowIdIdx}
          values={adding}
          onChange={setAdding}
          onSave={submitAdd}
          onCancel={() => setAdding(null)}
        />
      )}

      {visible.length === 0 && !adding ? (
        <p className="rpt-mm-rail-empty">
          {table.rows.length === 0 ? t('tables.noRows') : t('tables.noFilterMatches')}
        </p>
      ) : (
        <div className="rpt-mm-cards-grid">
          {shown.map((r) => (
            <RowCard
              key={table.rowids[r] ?? r}
              columns={table.columns}
              label={label}
              rowIdIdx={rowIdIdx}
              values={table.rows[r]}
              rowid={table.rowids[r]}
              onSave={onSaveRow}
              onDelete={onDeleteRow}
            />
          ))}
        </div>
      )}

      {info.pageCount > 1 && (
        <div className="rpt-mm-cards-pager">
          <button
            className="rpt-duel-secondary"
            disabled={info.page <= 0}
            aria-label={t('memoryManager.prevPage')}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ‹
          </button>
          {pageBtns.map((p) => (
            <button
              key={p}
              className={`rpt-duel-secondary${p === info.page ? ' active' : ''}`}
              aria-current={p === info.page}
              onClick={() => setPage(p)}
            >
              {p + 1}
            </button>
          ))}
          <button
            className="rpt-duel-secondary"
            disabled={info.page >= info.pageCount - 1}
            aria-label={t('memoryManager.nextPage')}
            onClick={() => setPage((p) => Math.min(info.pageCount - 1, p + 1))}
          >
            ›
          </button>
        </div>
      )}
    </div>
  )
}

/** One existing row as a card. View mode shows the fields; Edit opens a LOCAL draft with explicit
 *  Save (commits only the changed cells) / Reset (discards the draft). Inputs are enabled throughout
 *  (only briefly disabled while a save is in flight), so there is no grey-but-uneditable state. */
const RowCard: React.FC<{
  columns: string[]
  label: LabelFn
  rowIdIdx: number
  values: unknown[]
  rowid: number | undefined
  onSave: (rowid: number, changes: CellChange[]) => Promise<void> | void
  onDelete: (rowid: number) => Promise<void> | void
}> = ({ columns, label, rowIdIdx, values, rowid, onSave, onDelete }) => {
  const t = useT()
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const orig = React.useMemo(
    () => columns.map((_, c) => (values[c] == null ? '' : String(values[c]))),
    [values, columns]
  )
  const [draft, setDraft] = React.useState<string[]>(orig)

  const begin = (): void => {
    setDraft(orig.slice())
    setEditing(true)
  }
  const reset = (): void => {
    setDraft(orig.slice())
    setEditing(false)
  }
  const save = async (): Promise<void> => {
    if (rowid == null) {
      setEditing(false)
      return
    }
    const changes: CellChange[] = []
    for (let c = 0; c < columns.length; c++) {
      if (c === rowIdIdx) continue
      if ((draft[c] ?? '') !== orig[c]) changes.push({ colIndex: c, value: draft[c] ?? '' })
    }
    if (changes.length === 0) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await onSave(rowid, changes)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const idLabel = rowIdIdx >= 0 ? String(values[rowIdIdx] ?? '') : ''

  return (
    <div className={`rpt-mm-card${editing ? ' editing' : ''}`}>
      <div className="rpt-mm-card-head">
        <span className="rpt-mm-card-id">#{idLabel || '—'}</span>
        {editing ? (
          <span className="rpt-mm-card-actions">
            <button className="rpt-duel-secondary" disabled={busy} onClick={() => void save()}>
              {t('common.save')}
            </button>
            <button className="btn-ghost" disabled={busy} onClick={reset}>
              {t('memoryManager.data.reset')}
            </button>
          </span>
        ) : (
          <span className="rpt-mm-card-actions">
            <button className="rpt-duel-secondary" onClick={begin}>
              {t('common.edit')}
            </button>
            <button
              className="rpt-duel-secondary rpt-mm-danger"
              title={t('tables.deleteRow')}
              onClick={() => {
                if (rowid != null && confirm(t('tables.confirmDeleteRow'))) void onDelete(rowid)
              }}
            >
              ✕
            </button>
          </span>
        )}
      </div>
      <dl className="rpt-mm-card-fields">
        {columns.map((_, c) => {
          if (c === rowIdIdx) return null
          return (
            <div className="rpt-mm-card-field" key={c}>
              <dt className="rpt-mm-card-key">{label(c)}</dt>
              <dd className="rpt-mm-card-val">
                {editing ? (
                  <textarea
                    className="rpt-mm-card-input"
                    value={draft[c] ?? ''}
                    disabled={busy}
                    rows={1}
                    onChange={(e) =>
                      setDraft((d) => {
                        const n = d.slice()
                        n[c] = e.target.value
                        return n
                      })
                    }
                  />
                ) : (
                  <span className="rpt-mm-card-text">{orig[c] || '—'}</span>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/** The blank "add row" card — all non-PK fields editable, explicit Save (insert) / Cancel. */
const NewCard: React.FC<{
  columns: string[]
  label: LabelFn
  rowIdIdx: number
  values: string[]
  onChange: (next: string[]) => void
  onSave: () => Promise<void> | void
  onCancel: () => void
}> = ({ columns, label, rowIdIdx, values, onChange, onSave, onCancel }) => {
  const t = useT()
  return (
    <div className="rpt-mm-card editing rpt-mm-card-new">
      <div className="rpt-mm-card-head">
        <span className="rpt-mm-card-id">{t('memoryManager.data.newRow')}</span>
        <span className="rpt-mm-card-actions">
          <button className="rpt-duel-secondary" onClick={() => void onSave()}>
            {t('common.save')}
          </button>
          <button className="btn-ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </span>
      </div>
      <dl className="rpt-mm-card-fields">
        {columns.map((_, c) => {
          if (c === rowIdIdx) return null
          return (
            <div className="rpt-mm-card-field" key={c}>
              <dt className="rpt-mm-card-key">{label(c)}</dt>
              <dd className="rpt-mm-card-val">
                <textarea
                  className="rpt-mm-card-input"
                  value={values[c] ?? ''}
                  rows={1}
                  onChange={(e) => {
                    const n = values.slice()
                    n[c] = e.target.value
                    onChange(n)
                  }}
                />
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}
