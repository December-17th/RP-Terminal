import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
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

export const TablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const openControlCenter = useUiStore((s) => s.openControlCenter)
  const t = useT()

  const [assigned, setAssigned] = React.useState(false)
  const [tables, setTables] = React.useState<TableRead[]>([])

  const loadChat = React.useCallback(async () => {
    if (!activeChatId) {
      setAssigned(false)
      setTables([])
      return
    }
    try {
      // A cheap read tells us whether a template is assigned (→ "off" hint) vs assigned-but-empty.
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssigned(!!id)
      if (!id) {
        setTables([])
        return
      }
      setTables((await api().readChatTables(profileId, activeChatId)) ?? [])
    } catch {
      setAssigned(false)
      setTables([])
    }
  }, [profileId, activeChatId])

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
          onClick={() => openControlCenter({ rail: 'memory' })}
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
          tables.map((tbl) => <TableGrid key={tbl.sqlName} table={tbl} onEdit={applyEdit} />)
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

const TableGrid: React.FC<{
  table: TableRead
  onEdit: EditFn
}> = ({ table, onEdit }) => {
  const t = useT()
  const width = Math.max(1, table.columns.length)
  // The blank "add row" editor: one input per column, or null when not adding.
  const [adding, setAdding] = React.useState<string[] | null>(null)
  // The cell currently being edited: `${rowIndex}:${colIndex}` → draft value.
  const [editing, setEditing] = React.useState<{ key: string; value: string } | null>(null)

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
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
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
