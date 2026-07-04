import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useT } from '../../i18n'

/**
 * Tables view for SQL-table memory — the lean DATA surface (agent-packs plan WP3.8 de-scatter). Per
 * active chat: one section per assigned table (display name + an EDITABLE grid). Memory CONFIGURATION
 * + MAINTENANCE (template binding / import / export / delete, per-table progress, and the manual
 * backfill) moved to the control-center Memory rail (MemoryPane) so this view stays about browsing +
 * hand-editing the data. A small header hint links to that rail ("configure in Agents → Memory").
 *
 * Editing (issue 06) is chat-scoped and goes ENTIRELY through main via `window.api` (the IPC surface):
 * every cell edit / add row / delete row / reset becomes floor-attributed op-logged SQL on the SAME
 * write path AI writes take (`chat-tables-edit` → tableEditService). The renderer only ever sends a
 * column INDEX (never a column name) for a cell edit; main resolves it to the real column. Constraint
 * violations come back as `{ error }` and are toasted (localized `tables.*` key, else the verbatim
 * SQLite message).
 */
const api = (): any => (window as unknown as { api: any }).api

interface TableRead {
  sqlName: string
  displayName: string
  columns: string[]
  rows: unknown[][]
  rowids: number[]
}

/** ST-worldbook-style injection anchor (position + depth + order). Mirrors `Placement` main-side. */
interface Placement {
  position: string
  depth: number
  order: number
}

/** Prompt-injection settings for a table (mirrors main-side `TableExportConfig`). */
interface TableExportConfig {
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
interface TableDef {
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

interface TableTemplate {
  name: string
  tables: TableDef[]
}

/** The editable subset sent back on save. Every field but `uid` is OPTIONAL — the merge only touches
 *  provided fields, so the header frequency control sends `{ uid, updateFrequency }` while the prompt
 *  panel sends `{ uid, note, ..., exportConfig }` (manual-pass issue 04). */
interface TableDefPatch {
  uid: string
  note?: string
  initNode?: string
  insertNode?: string
  updateNode?: string
  deleteNode?: string
  updateFrequency?: number
  exportConfig?: TableExportConfig
}

export const TablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)
  // Global default cadence: the "全局 (N)" the header frequency control shows for a -1 (use-global)
  // table. Older profiles lack the group → default 3 (matches the main-side resolver fallback).
  const globalFreq = useSettingsStore((s) => s.settings?.tables?.default_update_frequency ?? 3)
  const t = useT()

  const [assigned, setAssigned] = React.useState(false)
  const [tables, setTables] = React.useState<TableRead[]>([])
  const [templateId, setTemplateId] = React.useState<string | null>(null)
  const [template, setTemplate] = React.useState<TableTemplate | null>(null)

  const loadChat = React.useCallback(async () => {
    if (!activeChatId) {
      setAssigned(false)
      setTables([])
      setTemplateId(null)
      setTemplate(null)
      return
    }
    try {
      // A cheap read tells us whether a template is assigned (→ "off" hint) vs assigned-but-empty.
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssigned(!!id)
      setTemplateId(id)
      if (!id) {
        setTables([])
        setTemplate(null)
        return
      }
      setTables((await api().readChatTables(profileId, activeChatId)) ?? [])
      // The assigned template object powers the per-table prompt editor (issue 03). A stale id → null,
      // in which case TableGrid simply hides the editor toggle.
      setTemplate(((await api().getTableTemplate(profileId, id)) as TableTemplate | null) ?? null)
    } catch {
      setAssigned(false)
      setTables([])
      setTemplateId(null)
      setTemplate(null)
    }
  }, [profileId, activeChatId])

  /** Refetch just the template object after a prompt edit (data grids are unaffected). */
  const reloadTemplate = React.useCallback(async () => {
    if (!templateId) return
    try {
      setTemplate(((await api().getTableTemplate(profileId, templateId)) as TableTemplate | null) ?? null)
    } catch {
      /* keep the current template on a transient read failure */
    }
  }, [profileId, templateId])

  React.useEffect(() => {
    void loadChat()
  }, [loadChat, floors.length])

  /** Turn a service `{ error }` into a toast: localize a `tables.*` key, else show the raw message. */
  const toastError = React.useCallback(
    (prefix: string, error: string): void => {
      const detail = error.startsWith('tables.') ? t(error) : error
      useToastStore.getState().push(`${prefix}: ${detail}`)
    },
    [t]
  )

  if (!activeChatId) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  /** Route one hand edit through main, toast any error, then refetch. */
  const applyEdit = async (edit: {
    kind: 'cell' | 'insert' | 'delete' | 'reset'
    table: string
    rowid?: number
    columnIndex?: number
    value?: string
    values?: (string | null)[]
  }): Promise<void> => {
    try {
      const res = await api().editChatTable(profileId, activeChatId, edit)
      if (res && res.error) {
        toastError(t('tables.editFailed'), res.error)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.editFailed'))
    }
    await loadChat()
  }

  /** Persist a per-table prompt patch through main, toast the outcome, then refetch the template. */
  const onSaveTemplate = async (tablePatch: TableDefPatch): Promise<void> => {
    if (!templateId) return
    try {
      const res = await api().updateTableTemplate(profileId, templateId, { tables: [tablePatch] })
      if (res && res.error) {
        toastError(t('tables.templateSaveFailed'), res.error)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.templateSaveFailed'))
      return
    }
    useToastStore.getState().push(t('tables.templateSaved'))
    await reloadTemplate()
  }

  /** Match a data-grid table to its TableDef by sqlName, falling back to displayName. */
  const findDef = (tbl: TableRead): TableDef | null => {
    if (!template) return null
    return (
      template.tables.find((d) => d.sqlName === tbl.sqlName) ??
      template.tables.find((d) => d.displayName === tbl.displayName) ??
      null
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Lightweight header: a hint that configuration (template binding / backfill) lives in the
          Memory rail, plus a Refresh for the data grid. The binding + maintenance controls are gone. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 8,
          marginBottom: 8
        }}
      >
        <span style={{ fontSize: 12, opacity: 0.7 }}>{t('tables.configHint')}</span>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          onClick={() => openWorkflowEditor()}
        >
          {t('tables.openMemory')}
        </button>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 8px', marginLeft: 'auto' }}
          onClick={() => void loadChat()}
        >
          {t('tables.refresh')}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!assigned ? (
          <div style={{ opacity: 0.5, fontSize: 12 }}>
            <em>{t('tables.noneAssigned')}</em>
          </div>
        ) : tables.length === 0 ? (
          <div style={{ opacity: 0.5, fontSize: 12 }}>
            <em>{t('tables.emptyTemplate')}</em>
          </div>
        ) : (
          tables.map((tbl) => (
            <TableGrid
              key={tbl.sqlName}
              table={tbl}
              def={findDef(tbl)}
              globalFreq={globalFreq}
              onEdit={applyEdit}
              onSaveTemplate={onSaveTemplate}
            />
          ))
        )}
      </div>
    </div>
  )
}

type EditFn = (edit: {
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

const TableGrid: React.FC<{
  table: TableRead
  def: TableDef | null
  globalFreq: number
  onEdit: EditFn
  onSaveTemplate: (patch: TableDefPatch) => Promise<void>
}> = ({ table, def, globalFreq, onEdit, onSaveTemplate }) => {
  const t = useT()
  const width = Math.max(1, table.columns.length)
  // The blank "add row" editor: one input per column, or null when not adding.
  const [adding, setAdding] = React.useState<string[] | null>(null)
  // The cell currently being edited: `${rowIndex}:${colIndex}` → draft value.
  const [editing, setEditing] = React.useState<{ key: string; value: string } | null>(null)
  // Whether the per-table prompt editor panel is expanded (collapsed by default).
  const [editingTemplate, setEditingTemplate] = React.useState(false)

  const rowIdConvention = table.columns[0] === 'row_id'

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
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
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
      {def && editingTemplate && (
        <TemplateEditPanel key={def.uid} def={def} onSave={onSaveTemplate} onClose={() => setEditingTemplate(false)} />
      )}
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            borderCollapse: 'collapse',
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
                  style={{
                    border: '1px solid var(--rpt-border)',
                    padding: '3px 6px',
                    textAlign: 'left',
                    background: 'var(--rpt-bg-secondary)',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {col}
                </th>
              ))}
              <th
                style={{
                  border: '1px solid var(--rpt-border)',
                  padding: '3px 6px',
                  background: 'var(--rpt-bg-secondary)',
                  width: 1
                }}
              />
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && !adding ? (
              <tr>
                <td colSpan={width + 1} style={{ ...cellStyle, opacity: 0.5, fontStyle: 'italic' }}>
                  {t('tables.noRows')}
                </td>
              </tr>
            ) : (
              table.rows.map((row, r) => (
                <tr key={table.rowids[r] ?? r}>
                  {table.columns.map((_, c) => {
                    const key = `${r}:${c}`
                    const raw = row[c] == null ? '' : String(row[c])
                    const isEditing = editing?.key === key
                    return (
                      <td
                        key={c}
                        style={cellStyle}
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
              ))
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
    </div>
  )
}

// ── Per-table template prompt editor (issue 03) ─────────────────────────────────────────────────
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
