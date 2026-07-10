// The SHARED editable memory-table grid (agent & memory UX WP-I; spec §8) — extracted from
// TablesView.tsx so the workspace Tables view AND the editor's Memory sheet Data tab render the SAME
// component (grid polish lands once, both hosts inherit it). The move is verbatim for the editing
// logic (double-click cell edit / add row / delete row / reset, all through the caller's EditFn →
// `chat-tables-edit` — the renderer only ever sends a column INDEX), plus the WP-I polish:
//   · sticky header — each table scrolls in its own bounded box; the header row pins to its top.
//   · search/filter — a per-table row filter (pure filterRowIndices; index-based so a filtered view
//     still edits against the ORIGINAL rowids — filtering never re-keys the write path).
//   · column autosizing — min/max width hints from header + data (pure columnWidthHint).
//   · maintenance-pointer marker — the per-table processed/next/unprocessed line (pointerSpec over
//     readChatTablesStatus), shown under the table header when the host supplies `status`.
// Row provenance on hover is deliberately NOT in v1: the op-log stores raw SQL per (chat, floor, seq)
// with no per-ROW attribution (tableOpsService.ts:13 `table_ops (chat_id, floor, seq, sql)`), so
// "written at floor N" per row would require parsing SQL back to rowids — out of scope (recorded WP-I
// deviation; the pointer marker covers the "which floors are folded in" need at table granularity).
import React from 'react'
import { useT } from '../../i18n'
import {
  columnWidthHint,
  filterRowIndices,
  pageInfo,
  pageSlice,
  pointerSpec,
  type TableStatusLike
} from './tableGridModel'

export interface TableRead {
  sqlName: string
  displayName: string
  columns: string[]
  rows: unknown[][]
  rowids: number[]
}

/** ST-worldbook-style injection anchor (position + depth + order). Mirrors `Placement` main-side. */
export interface Placement {
  position: string
  depth: number
  order: number
}

/** Prompt-injection settings for a table (mirrors main-side `TableExportConfig`). */
export interface TableExportConfig {
  enabled: boolean
  splitByRow: boolean
  entryName: string
  entryType: 'constant' | 'keyword'
  keywords: string
  injectionTemplate: string
  extraIndexEnabled: boolean
  extraIndexEntryName: string
  extraIndexColumns: string[]
  extraIndexColumnModes: Record<string, 'both' | 'index_only'>
  extraIndexInjectionTemplate: string
  entryPlacement: Placement
  extraIndexPlacement: Placement
  fixedEntryPlacement: Placement
  fixedIndexPlacement: Placement
}

/** One table's design-time definition (mirrors main-side `TableDef`). */
export interface TableDef {
  uid: string
  displayName: string
  sqlName: string
  ddl: string
  headers: string[]
  initialRows: string[][]
  note: string
  initNode: string
  insertNode: string
  updateNode: string
  deleteNode: string
  updateFrequency: number
  exportConfig: TableExportConfig
}

/** The editable subset sent back on save. Every field but `uid` is OPTIONAL — the merge only touches
 *  provided fields, so the header frequency control sends `{ uid, updateFrequency }` while the prompt
 *  panel sends `{ uid, note, ..., exportConfig }` (manual-pass issue 04). */
export interface TableDefPatch {
  uid: string
  note?: string
  initNode?: string
  insertNode?: string
  updateNode?: string
  deleteNode?: string
  updateFrequency?: number
  exportConfig?: TableExportConfig
}

export type EditFn = (edit: {
  kind: 'cell' | 'insert' | 'delete' | 'reset'
  table: string
  rowid?: number
  columnIndex?: number
  value?: string
  values?: (string | null)[]
}) => Promise<void>

const cellStyle: React.CSSProperties = {
  border: '1px solid var(--rpt-border)',
  padding: '3px 6px',
  verticalAlign: 'top'
}

/**
 * Always-visible per-table maintenance-cadence control (manual-pass issue 04). Shows the table's
 * `updateFrequency` at a glance and commits a single-field `{ uid, updateFrequency }` patch on change.
 * Semantics mirror the main-side resolver: `-1` = 全局 (global default N), `0` = 关 (off), `N>=1` = 每 N 轮.
 */
const FreqControl: React.FC<{
  freq: number
  globalFreq: number
  onChange: (freq: number) => void
}> = ({ freq, globalFreq, onChange }) => {
  const t = useT()
  const mode = freq === -1 ? 'global' : freq === 0 ? 'off' : 'custom'
  const label =
    freq === -1
      ? t('tables.freqGlobal') + ` (${globalFreq})`
      : freq === 0
        ? t('tables.freqOff')
        : t('tables.freqEvery', { n: freq })

  const smallSelect: React.CSSProperties = {
    fontSize: 11,
    background: 'var(--rpt-bg-tertiary)',
    color: 'var(--rpt-text-primary)',
    border: '1px solid var(--rpt-border)',
    borderRadius: 3,
    padding: '1px 4px'
  }

  return (
    <span
      style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11, opacity: 0.75 }}
      title={t('tables.updateFrequency')}
    >
      <span aria-hidden style={{ opacity: 0.8 }}>
        {label}
      </span>
      <select
        style={smallSelect}
        value={mode}
        aria-label={t('tables.updateFrequency')}
        onChange={(e) => {
          const m = e.target.value
          if (m === 'global') onChange(-1)
          else if (m === 'off') onChange(0)
          // custom: seed a sensible positive value (keep current if already positive, else 1)
          else onChange(freq >= 1 ? freq : 1)
        }}
      >
        <option value="global">{t('tables.freqGlobal')}</option>
        <option value="off">{t('tables.freqOff')}</option>
        <option value="custom">{t('tables.freqCustom')}</option>
      </select>
      {mode === 'custom' && (
        <input
          type="number"
          min={1}
          step={1}
          style={{ ...smallSelect, width: 56 }}
          value={freq >= 1 ? freq : 1}
          onChange={(e) => onChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
      )}
    </span>
  )
}

export const TableGrid: React.FC<{
  table: TableRead
  def: TableDef | null
  globalFreq: number
  onEdit: EditFn
  onSaveTemplate: (patch: TableDefPatch) => Promise<void>
  /** WP-I: this table's maintenance status (readChatTablesStatus slice) → the pointer marker line.
   *  Omit to hide the line (hosts that don't load status). */
  status?: TableStatusLike | null
  /** Memory Manager WP1: OPT-IN pagination. When `paginate` is set (or a positive `pageSize` is given)
   *  the grid renders one page of `pageSize` rows (default 30) with a prev/next/page-number pager below
   *  it. UNSET (the default for every other host) = render all rows, unchanged. */
  paginate?: boolean
  pageSize?: number
}> = ({ table, def, globalFreq, onEdit, onSaveTemplate, status, paginate, pageSize }) => {
  const t = useT()
  const width = Math.max(1, table.columns.length)
  // The blank "add row" editor: one input per column, or null when not adding.
  const [adding, setAdding] = React.useState<string[] | null>(null)
  // The cell currently being edited: `${rowIndex}:${colIndex}` → draft value (ORIGINAL row index).
  const [editing, setEditing] = React.useState<{ key: string; value: string } | null>(null)
  // Whether the per-table prompt editor panel is expanded (collapsed by default).
  const [editingTemplate, setEditingTemplate] = React.useState(false)
  // WP-I: the per-table row filter. Index-based so edits keep targeting the original rowids.
  const [filter, setFilter] = React.useState('')

  const rowIdConvention = table.columns[0] === 'row_id'
  const visibleIndices = React.useMemo(
    () => filterRowIndices(table.rows, filter),
    [table.rows, filter]
  )

  // Memory Manager WP1: opt-in pagination. When off, `rendered` === `visibleIndices` and no pager
  // renders, so every existing host's DOM is byte-for-byte unchanged.
  const paginated = paginate === true || (pageSize != null && pageSize > 0)
  const effectivePageSize = pageSize && pageSize > 0 ? Math.floor(pageSize) : 30
  const [page, setPage] = React.useState(0)
  // First page whenever the filter or the table identity changes (row set shifts under the pointer).
  React.useEffect(() => {
    setPage(0)
  }, [filter, table.sqlName])
  const pageState = React.useMemo(
    () => pageInfo(visibleIndices.length, page, effectivePageSize),
    [visibleIndices.length, page, effectivePageSize]
  )
  const rendered = paginated ? pageSlice(visibleIndices, page, effectivePageSize) : visibleIndices
  // A small centered window of page buttons (never render one button per page for a huge table).
  const pageButtons = React.useMemo(() => {
    const span = 5
    const end = Math.min(pageState.pageCount, Math.max(pageState.page - Math.floor(span / 2), 0) + span)
    const start = Math.max(0, end - span)
    return Array.from({ length: end - start }, (_, i) => start + i)
  }, [pageState.page, pageState.pageCount])
  // WP-I: column width hints (ch units) — short columns stay narrow, prose columns wrap.
  const widthHints = React.useMemo(
    () => table.columns.map((col, i) => columnWidthHint(col, table.rows, i)),
    [table.columns, table.rows]
  )
  const pointer = pointerSpec(status)

  const commitCell = (rowIndex: number, colIndex: number, value: string): void => {
    setEditing(null)
    const rowid = table.rowids[rowIndex]
    if (rowid == null) return
    // No-op if unchanged.
    const current = table.rows[rowIndex]?.[colIndex]
    if ((current == null ? '' : String(current)) === value) return
    void onEdit({ kind: 'cell', table: table.sqlName, rowid, columnIndex: colIndex, value })
  }

  const commitAdd = (): void => {
    if (!adding) return
    // row_id-convention first cell → NULL so INTEGER PRIMARY KEY auto-assigns; others as typed.
    const values: (string | null)[] = adding.map((v, i) =>
      rowIdConvention && i === 0 && v.trim() === '' ? null : v
    )
    setAdding(null)
    void onEdit({ kind: 'insert', table: table.sqlName, values })
  }

  const onDeleteRow = (rowIndex: number): void => {
    const rowid = table.rowids[rowIndex]
    if (rowid == null) return
    if (!confirm(t('tables.confirmDeleteRow'))) return
    void onEdit({ kind: 'delete', table: table.sqlName, rowid })
  }

  const onReset = (): void => {
    if (!confirm(t('tables.confirmReset'))) return
    void onEdit({ kind: 'reset', table: table.sqlName })
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 4,
          flexWrap: 'wrap'
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rpt-text-primary)' }}>
          {table.displayName}
        </span>
        <span style={{ opacity: 0.5, fontWeight: 400, fontSize: 11 }}>{table.sqlName}</span>
        {def && (
          <FreqControl
            freq={def.updateFrequency}
            globalFreq={globalFreq}
            onChange={(v) => void onSaveTemplate({ uid: def.uid, updateFrequency: v })}
          />
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="search"
            value={filter}
            placeholder={t('tables.filterPh')}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              fontSize: 11,
              padding: '2px 6px',
              width: 130,
              background: 'var(--rpt-bg-tertiary)',
              color: 'var(--rpt-text-primary)',
              border: '1px solid var(--rpt-border)',
              borderRadius: 4
            }}
          />
          {def && (
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 11, padding: '2px 8px' }}
              aria-expanded={editingTemplate}
              onClick={() => setEditingTemplate((v) => !v)}
            >
              {t('tables.editTemplate')}
            </button>
          )}
          <button
            className="rpt-duel-secondary"
            style={{ fontSize: 11, padding: '2px 8px' }}
            disabled={adding != null}
            onClick={() => setAdding(new Array(width).fill(''))}
          >
            {t('tables.addRow')}
          </button>
          <button
            className="rpt-duel-secondary"
            style={{ fontSize: 11, padding: '2px 8px' }}
            disabled={table.rows.length === 0}
            onClick={onReset}
          >
            {t('tables.resetTable')}
          </button>
        </span>
      </div>
      {/* WP-I: the maintenance-pointer marker — which floors are already folded into this table. */}
      {status !== undefined && (
        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 4, color: 'var(--rpt-text-primary)' }}>
          {pointer.kind === 'never' ? t(pointer.key) : t(pointer.key, pointer.params)}
        </div>
      )}
      {def && editingTemplate && (
        <TemplateEditPanel key={def.uid} def={def} onSave={onSaveTemplate} onClose={() => setEditingTemplate(false)} />
      )}
      {/* WP-I: each table scrolls in its own bounded box so the sticky header can pin to its top. */}
      <div className="rpt-tablegrid-scroll">
        <table
          style={{
            borderCollapse: 'separate',
            borderSpacing: 0,
            fontSize: 12,
            width: '100%',
            color: 'var(--rpt-text-primary)'
          }}
        >
          <thead>
            <tr>
              {table.columns.map((col, i) => (
                <th
                  key={i}
                  className="rpt-tablegrid-th"
                  style={{ minWidth: `${Math.min(widthHints[i], 16)}ch`, maxWidth: `${widthHints[i]}ch` }}
                >
                  {col}
                </th>
              ))}
              <th className="rpt-tablegrid-th" style={{ width: 1 }} />
            </tr>
          </thead>
          <tbody>
            {visibleIndices.length === 0 && !adding ? (
              <tr>
                <td colSpan={width + 1} style={{ ...cellStyle, opacity: 0.5, fontStyle: 'italic' }}>
                  {table.rows.length === 0 ? t('tables.noRows') : t('tables.noFilterMatches')}
                </td>
              </tr>
            ) : (
              rendered.map((r) => {
                const row = table.rows[r]
                return (
                  <tr key={table.rowids[r] ?? r}>
                    {table.columns.map((_, c) => {
                      const key = `${r}:${c}`
                      const raw = row[c] == null ? '' : String(row[c])
                      const isEditing = editing?.key === key
                      return (
                        <td
                          key={c}
                          style={{ ...cellStyle, maxWidth: `${widthHints[c]}ch`, overflowWrap: 'break-word' }}
                          onDoubleClick={() => setEditing({ key, value: raw })}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              value={editing.value}
                              onChange={(e) => setEditing({ key, value: e.target.value })}
                              onBlur={() => commitCell(r, c, editing.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitCell(r, c, editing.value)
                                else if (e.key === 'Escape') setEditing(null)
                              }}
                              style={{
                                width: '100%',
                                boxSizing: 'border-box',
                                fontSize: 12,
                                background: 'var(--rpt-bg-tertiary)',
                                color: 'var(--rpt-text-primary)',
                                border: '1px solid var(--rpt-accent)',
                                borderRadius: 2,
                                padding: '1px 3px'
                              }}
                            />
                          ) : (
                            raw
                          )}
                        </td>
                      )
                    })}
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                      <button
                        className="rpt-duel-secondary"
                        style={{ fontSize: 11, padding: '1px 6px' }}
                        title={t('tables.deleteRow')}
                        onClick={() => onDeleteRow(r)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
            {adding && (
              <tr>
                {adding.map((v, c) => (
                  <td key={c} style={cellStyle}>
                    <input
                      value={v}
                      placeholder={rowIdConvention && c === 0 ? 'auto' : ''}
                      onChange={(e) => {
                        const next = adding.slice()
                        next[c] = e.target.value
                        setAdding(next)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitAdd()
                        else if (e.key === 'Escape') setAdding(null)
                      }}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        fontSize: 12,
                        background: 'var(--rpt-bg-tertiary)',
                        color: 'var(--rpt-text-primary)',
                        border: '1px solid var(--rpt-border)',
                        borderRadius: 2,
                        padding: '1px 3px'
                      }}
                    />
                  </td>
                ))}
                <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                  <button
                    className="rpt-duel-secondary"
                    style={{ fontSize: 11, padding: '1px 6px', marginRight: 4 }}
                    onClick={commitAdd}
                  >
                    {t('tables.saveRow')}
                  </button>
                  <button
                    className="rpt-duel-secondary"
                    style={{ fontSize: 11, padding: '1px 6px' }}
                    onClick={() => setAdding(null)}
                  >
                    {t('tables.cancel')}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Memory Manager WP1: opt-in pager. Range label always shows when there are rows; the page
          buttons appear only once the list spills past one page. */}
      {paginated && visibleIndices.length > 0 && (
        <div className="rpt-tablegrid-pager">
          <span className="rpt-tablegrid-pager-range">
            {t('memoryManager.rangeLabel', {
              from: pageState.from,
              to: pageState.to,
              total: pageState.total
            })}
          </span>
          {pageState.pageCount > 1 && (
            <span className="rpt-tablegrid-pager-nav">
              <button
                type="button"
                className="rpt-tablegrid-pager-btn"
                disabled={pageState.page === 0}
                aria-label={t('memoryManager.prevPage')}
                onClick={() => setPage(pageState.page - 1)}
              >
                ‹
              </button>
              {pageButtons.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`rpt-tablegrid-pager-btn${p === pageState.page ? ' active' : ''}`}
                  aria-current={p === pageState.page}
                  onClick={() => setPage(p)}
                >
                  {p + 1}
                </button>
              ))}
              <button
                type="button"
                className="rpt-tablegrid-pager-btn"
                disabled={pageState.page >= pageState.pageCount - 1}
                aria-label={t('memoryManager.nextPage')}
                onClick={() => setPage(pageState.page + 1)}
              >
                ›
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Per-table template prompt editor (issue 03) — moved verbatim from TablesView.tsx ─────────────
// A collapsible panel under a table's header that edits the NON-STRUCTURAL template fields: the five
// per-op prompts, updateFrequency, and the full exportConfig (injection settings). Structural fields
// (ddl/sqlName/headers/initialRows/displayName) are immutable and NOT edited here; DDL is shown
// read-only. Edits persist via updateTableTemplate → applyTemplatePatch, are shared across every chat
// using the template, and take effect on the next maintenance pass.

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  opacity: 0.75,
  marginBottom: 3,
  color: 'var(--rpt-text-primary)'
}
const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 12,
  fontFamily: 'var(--rpt-font-mono, monospace)',
  background: 'var(--rpt-bg-tertiary)',
  color: 'var(--rpt-text-primary)',
  border: '1px solid var(--rpt-border)',
  borderRadius: 3,
  padding: '4px 6px'
}
const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  fontSize: 12,
  background: 'var(--rpt-bg-tertiary)',
  color: 'var(--rpt-text-primary)',
  border: '1px solid var(--rpt-border)',
  borderRadius: 3,
  padding: '2px 6px'
}
const fieldGroupStyle: React.CSSProperties = { marginBottom: 10 }

/** A single {position, depth, order} placement editor row. */
const PlacementRow: React.FC<{
  label: string
  value: Placement
  onChange: (next: Placement) => void
}> = ({ label, value, onChange }) => (
  <div style={{ ...fieldGroupStyle, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
    <span style={{ ...labelStyle, marginBottom: 0, minWidth: 130 }}>{label}</span>
    <input
      style={{ ...inputStyle, flex: 1, minWidth: 120 }}
      value={value.position}
      onChange={(e) => onChange({ ...value, position: e.target.value })}
    />
    <input
      type="number"
      style={{ ...inputStyle, width: 70 }}
      value={value.depth}
      onChange={(e) => onChange({ ...value, depth: Number(e.target.value) || 0 })}
      title="depth"
    />
    <input
      type="number"
      style={{ ...inputStyle, width: 90 }}
      value={value.order}
      onChange={(e) => onChange({ ...value, order: Number(e.target.value) || 0 })}
      title="order"
    />
  </div>
)

/** Deep clone of an exportConfig for local draft editing (structured-clone-free, JSON-safe shape). */
const cloneExportConfig = (c: TableExportConfig): TableExportConfig => ({
  ...c,
  extraIndexColumns: [...c.extraIndexColumns],
  extraIndexColumnModes: { ...c.extraIndexColumnModes },
  entryPlacement: { ...c.entryPlacement },
  extraIndexPlacement: { ...c.extraIndexPlacement },
  fixedEntryPlacement: { ...c.fixedEntryPlacement },
  fixedIndexPlacement: { ...c.fixedIndexPlacement }
})

/** Build the draft (editable subset) from a TableDef. `updateFrequency` is NOT part of this panel any
 *  more — it lives in the always-visible table header control (manual-pass issue 04). */
const draftFromDef = (
  def: TableDef
): {
  note: string
  initNode: string
  insertNode: string
  updateNode: string
  deleteNode: string
  exportConfig: TableExportConfig
} => ({
  note: def.note ?? '',
  initNode: def.initNode ?? '',
  insertNode: def.insertNode ?? '',
  updateNode: def.updateNode ?? '',
  deleteNode: def.deleteNode ?? '',
  exportConfig: cloneExportConfig(def.exportConfig)
})

const TemplateEditPanel: React.FC<{
  def: TableDef
  onSave: (patch: TableDefPatch) => Promise<void>
  onClose: () => void
}> = ({ def, onSave, onClose }) => {
  const t = useT()
  const [draft, setDraft] = React.useState(() => draftFromDef(def))
  const [showInjection, setShowInjection] = React.useState(false)

  // Re-seed the draft whenever the underlying def identity changes (e.g. after a save refetch).
  React.useEffect(() => {
    setDraft(draftFromDef(def))
  }, [def])

  const dirty = React.useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(draftFromDef(def)),
    [draft, def]
  )

  const ec = draft.exportConfig
  const setEc = (patch: Partial<TableExportConfig>): void =>
    setDraft((d) => ({ ...d, exportConfig: { ...d.exportConfig, ...patch } }))

  const save = (): void => {
    // Sending the full editable set is idempotent — the merge only touches provided fields.
    // updateFrequency is NOT sent here (the header control owns it via its own single-field patch).
    void onSave({
      uid: def.uid,
      note: draft.note,
      initNode: draft.initNode,
      insertNode: draft.insertNode,
      updateNode: draft.updateNode,
      deleteNode: draft.deleteNode,
      exportConfig: cloneExportConfig(draft.exportConfig)
    })
  }

  const cancel = (): void => {
    setDraft(draftFromDef(def))
    onClose()
  }

  const prompt = (key: string, field: 'note' | 'initNode' | 'insertNode' | 'updateNode' | 'deleteNode', rows: number): React.ReactNode => (
    <div style={fieldGroupStyle}>
      <label style={labelStyle}>{t(key)}</label>
      <textarea
        rows={rows}
        style={fieldStyle}
        value={draft[field]}
        onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
      />
    </div>
  )

  return (
    <div
      style={{
        border: '1px solid var(--rpt-border)',
        borderRadius: 4,
        background: 'var(--rpt-bg-secondary)',
        padding: 10,
        marginBottom: 8,
        fontSize: 12
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>{t('tables.templateEditHint')}</div>

      {prompt('tables.promptNote', 'note', 8)}
      {prompt('tables.promptInit', 'initNode', 5)}
      {prompt('tables.promptInsert', 'insertNode', 5)}
      {prompt('tables.promptUpdate', 'updateNode', 5)}
      {prompt('tables.promptDelete', 'deleteNode', 5)}

      {/* updateFrequency moved to the always-visible table header control (manual-pass issue 04). */}

      {/* Injection settings (exportConfig) — nested collapsible subsection. */}
      <div style={fieldGroupStyle}>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 11, padding: '2px 8px' }}
          aria-expanded={showInjection}
          onClick={() => setShowInjection((v) => !v)}
        >
          {showInjection ? '▾ ' : '▸ '}
          {t('tables.injectionSettings')}
        </button>
        {showInjection && (
          <div style={{ marginTop: 8, paddingLeft: 8, borderLeft: '2px solid var(--rpt-border)' }}>
            <div style={{ ...fieldGroupStyle, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <input type="checkbox" checked={ec.enabled} onChange={(e) => setEc({ enabled: e.target.checked })} />
                enabled
              </label>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={ec.splitByRow}
                  onChange={(e) => setEc({ splitByRow: e.target.checked })}
                />
                splitByRow
              </label>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={ec.extraIndexEnabled}
                  onChange={(e) => setEc({ extraIndexEnabled: e.target.checked })}
                />
                extraIndexEnabled
              </label>
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>entryName</label>
              <input style={{ ...inputStyle, width: '100%' }} value={ec.entryName} onChange={(e) => setEc({ entryName: e.target.value })} />
            </div>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>entryType</label>
              <select
                style={{ ...inputStyle, width: 160 }}
                value={ec.entryType}
                onChange={(e) => setEc({ entryType: e.target.value as 'constant' | 'keyword' })}
              >
                <option value="constant">constant</option>
                <option value="keyword">keyword</option>
              </select>
            </div>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>keywords</label>
              <input style={{ ...inputStyle, width: '100%' }} value={ec.keywords} onChange={(e) => setEc({ keywords: e.target.value })} />
            </div>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>injectionTemplate</label>
              <textarea rows={3} style={fieldStyle} value={ec.injectionTemplate} onChange={(e) => setEc({ injectionTemplate: e.target.value })} />
            </div>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>extraIndexEntryName</label>
              <input style={{ ...inputStyle, width: '100%' }} value={ec.extraIndexEntryName} onChange={(e) => setEc({ extraIndexEntryName: e.target.value })} />
            </div>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>extraIndexInjectionTemplate</label>
              <textarea rows={3} style={fieldStyle} value={ec.extraIndexInjectionTemplate} onChange={(e) => setEc({ extraIndexInjectionTemplate: e.target.value })} />
            </div>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>extraIndexColumns</label>
              <input
                style={{ ...inputStyle, width: '100%' }}
                value={ec.extraIndexColumns.join(', ')}
                onChange={(e) => {
                  const cols = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                  // Prune modes for columns no longer present; default new columns to 'both' on save.
                  const modes: Record<string, 'both' | 'index_only'> = {}
                  for (const c of cols) modes[c] = ec.extraIndexColumnModes[c] ?? 'both'
                  setEc({ extraIndexColumns: cols, extraIndexColumnModes: modes })
                }}
              />
            </div>
            {ec.extraIndexColumns.length > 0 && (
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>extraIndexColumnModes</label>
                {ec.extraIndexColumns.map((col) => (
                  <div key={col} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ minWidth: 120, fontSize: 12 }}>{col}</span>
                    <select
                      style={{ ...inputStyle, width: 140 }}
                      value={ec.extraIndexColumnModes[col] ?? 'both'}
                      onChange={(e) =>
                        setEc({
                          extraIndexColumnModes: {
                            ...ec.extraIndexColumnModes,
                            [col]: e.target.value as 'both' | 'index_only'
                          }
                        })
                      }
                    >
                      <option value="both">both</option>
                      <option value="index_only">index_only</option>
                    </select>
                  </div>
                ))}
              </div>
            )}

            <PlacementRow label={t('tables.placementEntry')} value={ec.entryPlacement} onChange={(v) => setEc({ entryPlacement: v })} />
            <PlacementRow label={t('tables.placementIndex')} value={ec.extraIndexPlacement} onChange={(v) => setEc({ extraIndexPlacement: v })} />
            <PlacementRow label={t('tables.placementFixedEntry')} value={ec.fixedEntryPlacement} onChange={(v) => setEc({ fixedEntryPlacement: v })} />
            <PlacementRow label={t('tables.placementFixedIndex')} value={ec.fixedIndexPlacement} onChange={(v) => setEc({ fixedIndexPlacement: v })} />
          </div>
        )}
      </div>

      <details style={fieldGroupStyle}>
        <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.75 }}>{t('tables.ddl')}</summary>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--rpt-font-mono, monospace)',
            fontSize: 11,
            background: 'var(--rpt-bg-tertiary)',
            border: '1px solid var(--rpt-border)',
            borderRadius: 3,
            padding: 6,
            margin: '6px 0 0',
            color: 'var(--rpt-text-primary)'
          }}
        >
          {def.ddl}
        </pre>
      </details>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <button
          className="rpt-duel-primary"
          style={{ fontSize: 12, padding: '3px 12px' }}
          disabled={!dirty}
          onClick={save}
        >
          {t('tables.savePrompts')}
        </button>
        <button className="rpt-duel-secondary" style={{ fontSize: 12, padding: '3px 12px' }} onClick={cancel}>
          {t('tables.cancel')}
        </button>
        {dirty && <span style={{ fontSize: 11, opacity: 0.7 }}>●</span>}
      </div>
    </div>
  )
}
