import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'

/**
 * Tables view for SQL-table memory. Per active chat:
 *  - a header with the assigned-template selector (list + "none"), Import, Delete-template, Export;
 *  - one section per table (display name + last-maintained indicator + an EDITABLE grid).
 *
 * Editing (issue 06) is chat-scoped and goes ENTIRELY through main via `window.api` (the IPC surface):
 * every cell edit / add row / delete row / reset becomes floor-attributed op-logged SQL on the SAME
 * write path AI writes take (`chat-tables-edit` → tableEditService). The renderer only ever sends a
 * column INDEX (never a column name) for a cell edit; main resolves it to the real column. Constraint
 * violations come back as `{ error }` and are toasted (localized `tables.*` key, else the verbatim
 * SQLite message). Assign/reassign/unassign recreate-or-drop the sandbox, so each confirms first.
 */
const api = (): any => (window as unknown as { api: any }).api

interface TemplateSummary {
  id: string
  name: string
  tableCount: number
}
interface TableRead {
  sqlName: string
  displayName: string
  columns: string[]
  rows: unknown[][]
  rowids: number[]
}
/** Per-table progress (issue 07): last-processed floor + the three derived display numbers. */
interface TableStatus {
  lastFloor: number | null
  processed: number
  nextExpected: number
  unprocessed: number
}
interface ApiPresetSummary {
  id: string
  name: string
}
interface BackfillProgressEvent {
  chatId: string
  batchIndex: number
  batchCount: number
  span: { from: number; to: number } | null
  status: 'running' | 'batch-ok' | 'batch-failed' | 'done' | 'cancelled' | 'error'
  message?: string
}
interface BackfillFailure {
  span: { from: number; to: number }
  reason: string
}

export const TablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()

  const [templates, setTemplates] = React.useState<TemplateSummary[]>([])
  const [assignedId, setAssignedId] = React.useState<string | null>(null)
  const [tables, setTables] = React.useState<TableRead[]>([])
  const [status, setStatus] = React.useState<Record<string, TableStatus>>({})
  const [apiPresets, setApiPresets] = React.useState<ApiPresetSummary[]>([])

  const loadTemplates = React.useCallback(async () => {
    try {
      setTemplates((await api().listTableTemplates(profileId)) ?? [])
    } catch {
      setTemplates([])
    }
    try {
      const settings = await api().getSettings(profileId)
      const presets = (settings?.api_presets ?? []) as ApiPresetSummary[]
      setApiPresets(presets.map((p) => ({ id: p.id, name: p.name })))
    } catch {
      setApiPresets([])
    }
  }, [profileId])

  const loadChat = React.useCallback(async () => {
    if (!activeChatId) {
      setAssignedId(null)
      setTables([])
      setStatus({})
      return
    }
    try {
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssignedId(id)
      if (!id) {
        setTables([])
        setStatus({})
        return
      }
      setTables((await api().readChatTables(profileId, activeChatId)) ?? [])
      setStatus((await api().readChatTablesStatus(profileId, activeChatId)) ?? {})
    } catch {
      setAssignedId(null)
      setTables([])
      setStatus({})
    }
  }, [profileId, activeChatId])

  React.useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

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

  const onAssign = async (value: string): Promise<void> => {
    const id = value === '' ? null : value
    // Both assign and unassign drop-and-recreate the sandbox — confirm the destructive step.
    const message = id ? t('tables.confirmAssign') : t('tables.confirmUnassign')
    if (!confirm(message)) {
      void loadChat() // revert the <select> to the stored value
      return
    }
    try {
      await api().setChatTableTemplate(profileId, activeChatId, id)
    } catch {
      useToastStore.getState().push(t('tables.assignFailed'))
    }
    await loadChat()
  }

  const onImport = async (): Promise<void> => {
    const result = await api().importTableTemplateDialog(profileId)
    if (result === null) return // user cancelled the file dialog
    if (result.error) {
      const detail = result.error.startsWith('tables.') ? t(result.error) : result.error
      useToastStore.getState().push(`${t('tables.importFailed')}: ${detail}`)
      return
    }
    await loadTemplates()
  }

  const onDeleteTemplate = async (): Promise<void> => {
    if (!assignedId) return
    if (!confirm(t('tables.confirmDeleteTemplate'))) return
    try {
      await api().deleteTableTemplate(profileId, assignedId)
    } catch {
      useToastStore.getState().push(t('tables.deleteFailed'))
    }
    await loadTemplates()
    await loadChat()
  }

  const onExport = async (withData: boolean): Promise<void> => {
    if (!assignedId) return
    try {
      await api().exportTableTemplateDialog(profileId, assignedId, withData ? activeChatId : null)
    } catch {
      useToastStore.getState().push(t('tables.exportFailed'))
    }
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
        <label style={{ fontSize: 12, opacity: 0.8 }}>{t('tables.template')}</label>
        <select
          value={assignedId ?? ''}
          onChange={(e) => void onAssign(e.target.value)}
          style={{
            fontSize: 12,
            padding: '3px 8px',
            background: 'var(--rpt-bg-tertiary)',
            color: 'var(--rpt-text-primary)',
            border: '1px solid var(--rpt-border)',
            borderRadius: 4
          }}
        >
          <option value="">{t('tables.none')}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name} ({tpl.tableCount})
            </option>
          ))}
        </select>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          onClick={() => void onImport()}
        >
          {t('tables.import')}
        </button>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          disabled={!assignedId}
          onClick={() => void onExport(false)}
        >
          {t('tables.export')}
        </button>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          disabled={!assignedId}
          onClick={() => void onExport(true)}
        >
          {t('tables.exportWithData')}
        </button>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          disabled={!assignedId}
          onClick={() => void onDeleteTemplate()}
        >
          {t('tables.deleteTemplate')}
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
        {!assignedId ? (
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
              status={status[tbl.sqlName] ?? null}
              onEdit={applyEdit}
            />
          ))
        )}
      </div>

      {assignedId && (
        <BackfillPanel
          profileId={profileId}
          chatId={activeChatId}
          apiPresets={apiPresets}
          onProgress={() => void loadChat()}
        />
      )}
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
  status: TableStatus | null
  onEdit: EditFn
}> = ({ table, status, onEdit }) => {
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
        <span style={{ opacity: 0.5, fontSize: 11 }}>
          {status == null || status.lastFloor == null
            ? t('tables.progressNever')
            : `${t('tables.progressProcessed', { n: status.processed })} · ${t(
                'tables.progressNext',
                { n: status.nextExpected }
              )} · ${t('tables.progressUnprocessed', { n: status.unprocessed })}`}
        </span>
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

/**
 * Manual backfill panel (issue 07): collapsed by default. Runs a backfill over a chosen scope (last X
 * floors or all), in batches of Y floors, optionally against a saved API preset, with an optional
 * auto-retry count. Progress streams via `onTableBackfillProgress` (filtered by chatId); the parent
 * refetches its tables + status on every event. State is re-read on mount so a re-mount mid-run
 * resumes showing progress.
 */
const BackfillPanel: React.FC<{
  profileId: string
  chatId: string
  apiPresets: ApiPresetSummary[]
  onProgress: () => void
}> = ({ profileId, chatId, apiPresets, onProgress }) => {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const [allScope, setAllScope] = React.useState(false)
  const [lastFloors, setLastFloors] = React.useState(20)
  const [batchSize, setBatchSize] = React.useState(3)
  const [presetId, setPresetId] = React.useState('')
  const [retries, setRetries] = React.useState(0)

  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<BackfillProgressEvent | null>(null)
  const [failures, setFailures] = React.useState<BackfillFailure[]>([])

  // Re-read the run state on mount / chat change so a re-mounted view reflects an in-flight run.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const state = await api().getTableBackfillState(profileId, chatId)
        if (cancelled || !state) return
        setRunning(state.running)
        setFailures(state.failures ?? [])
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, chatId])

  // Subscribe to progress events (filtered by chatId).
  React.useEffect(() => {
    const off = api().onTableBackfillProgress((p: BackfillProgressEvent) => {
      if (p.chatId !== chatId) return
      setProgress(p)
      if (p.status === 'batch-failed' && p.span) {
        setFailures((prev) => [...prev, { span: p.span!, reason: p.message ?? '' }])
      }
      if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
        setRunning(false)
      } else {
        setRunning(true)
      }
      onProgress()
    })
    return off
  }, [chatId, onProgress])

  const onStart = async (): Promise<void> => {
    setFailures([])
    setProgress(null)
    setRunning(true)
    try {
      const res = await api().startTableBackfill(profileId, chatId, {
        lastFloors: allScope ? 'all' : lastFloors,
        batchSize,
        apiPresetId: presetId || null,
        retries
      })
      if (res && res.error) {
        const detail = res.error.startsWith('tables.') ? t(res.error) : res.error
        useToastStore.getState().push(`${t('tables.backfillStartFailed')}: ${detail}`)
        setRunning(false)
      }
    } catch {
      useToastStore.getState().push(t('tables.backfillStartFailed'))
      setRunning(false)
    }
  }

  const onCancel = async (): Promise<void> => {
    try {
      await api().cancelTableBackfill(profileId, chatId)
    } catch {
      /* best-effort */
    }
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '2px 6px',
    width: 64,
    background: 'var(--rpt-bg-tertiary)',
    color: 'var(--rpt-text-primary)',
    border: '1px solid var(--rpt-border)',
    borderRadius: 4
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--rpt-border)',
        marginTop: 8,
        paddingTop: 8
      }}
    >
      <button
        className="rpt-duel-secondary"
        style={{ fontSize: 12, padding: '3px 10px' }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} {t('tables.backfill')}
      </button>

      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginTop: 8,
            fontSize: 12,
            color: 'var(--rpt-text-primary)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ opacity: 0.8 }}>{t('tables.backfillScope')}</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="checkbox"
                checked={allScope}
                disabled={running}
                onChange={(e) => setAllScope(e.target.checked)}
              />
              {t('tables.backfillAll')}
            </label>
            <label style={{ opacity: 0.8 }}>{t('tables.backfillLastFloors')}</label>
            <input
              type="number"
              min={1}
              value={lastFloors}
              disabled={running || allScope}
              onChange={(e) => setLastFloors(Math.max(1, Number(e.target.value) || 1))}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ opacity: 0.8 }}>{t('tables.backfillBatchSize')}</label>
            <input
              type="number"
              min={1}
              value={batchSize}
              disabled={running}
              onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))}
              style={inputStyle}
            />
            <label style={{ opacity: 0.8 }}>{t('tables.backfillRetries')}</label>
            <input
              type="number"
              min={0}
              max={5}
              value={retries}
              disabled={running}
              onChange={(e) => setRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ opacity: 0.8 }}>{t('tables.backfillPreset')}</label>
            <select
              value={presetId}
              disabled={running}
              onChange={(e) => setPresetId(e.target.value)}
              style={{
                fontSize: 12,
                padding: '2px 6px',
                background: 'var(--rpt-bg-tertiary)',
                color: 'var(--rpt-text-primary)',
                border: '1px solid var(--rpt-border)',
                borderRadius: 4
              }}
            >
              <option value="">{t('tables.backfillPresetActive')}</option>
              {apiPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 12, padding: '3px 10px' }}
              disabled={running}
              onClick={() => void onStart()}
            >
              {t('tables.backfillStart')}
            </button>
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 12, padding: '3px 10px' }}
              disabled={!running}
              onClick={() => void onCancel()}
            >
              {t('tables.backfillCancel')}
            </button>
          </div>

          {progress && (
            <div style={{ opacity: 0.8 }}>
              {progress.status === 'done'
                ? t('tables.backfillDone')
                : progress.status === 'cancelled'
                  ? t('tables.backfillCancelled')
                  : progress.status === 'error'
                    ? progress.message ?? t('tables.backfillStartFailed')
                    : progress.span
                      ? t('tables.backfillRunning', {
                          i: progress.batchIndex + 1,
                          n: progress.batchCount,
                          from: progress.span.from,
                          to: progress.span.to
                        })
                      : ''}
            </div>
          )}

          {failures.length > 0 && (
            <div style={{ color: 'var(--rpt-danger, #c0392b)' }}>
              <div style={{ fontWeight: 600 }}>{t('tables.backfillFailures')}</div>
              {failures.map((f, i) => (
                <div key={i} style={{ opacity: 0.85 }}>
                  {t('tables.backfillFailureRow', {
                    from: f.span.from,
                    to: f.span.to,
                    reason: f.reason
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
