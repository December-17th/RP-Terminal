// Full-window Memory Manager (Memory Manager WP1) — the SQL-table memory feature's rich full-screen
// home, mirroring the shujuku 数据库 plugin's full-takeover "Visualizer". Hosted as a centered
// full-window popup like DuelPopup / AssetsPopup so it layers above BOTH the reconfigurable Workspace
// and a card's static panel_ui layout, and above the workflow editor overlay it is launched from
// (.modal-overlay sits in the top z-index band; the editor overlay is far below it).
//
// Layout (mirrors the Visualizer): a LEFT RAIL (template-binding row + a sheet list, one entry per
// table with a row·column count and a maintenance badge, click to activate) · a MAIN AREA (a topbar +
// a segmented Data / Structure / Maintenance tab control) · a FOOTER status line. Only the Data tab is
// live this WP — it is the focused single-table grid for the ACTIVE table (the SHARED TableGrid with
// its opt-in pagination on). Structure / Maintenance are wired placeholders for WP2 / WP4.
//
// Renderer-only + existing IPC only (no main / preload changes): listTableTemplates,
// getChatTableTemplate / setChatTableTemplate, readChatTables, getTableTemplate, editChatTable,
// updateTableTemplate, readChatTablesStatus. Grounding: TablesView.tsx (the data-load + edit wiring
// reused here), MemoryPane.tsx (the template-binding call shapes), TableGrid.tsx (the shared grid).
import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import { type TableDef, type TableRead } from '../workspace/TableGrid'
import type { TableStatusLike } from '../workspace/tableGridModel'
import { TableCards, type CellChange } from './TableCards'
import { MemoryPane } from '../workspace/MemoryPane'
import { MemoryPreview } from '../workflow/MemoryMaintainPanel'

const api = (): any => (window as unknown as { api: any }).api

interface TemplateSummary {
  id: string
  name: string
  tableCount: number
}
interface TableTemplate {
  name: string
  tables: TableDef[]
}
/** One table op as projected by `chat-tables-ops-list` (Memory-Manager WP3 History surface). */
interface TableOpView {
  floor: number
  seq: number
  kind: 'insert' | 'update' | 'delete' | 'other'
  table: string | null
  createdAt: string | null
}
type Tab = 'data' | 'structure' | 'maintenance' | 'history'

export function MemoryManagerView({ profileId }: { profileId: string }): React.JSX.Element | null {
  const open = useUiStore((s) => s.memoryManagerOpen)
  const close = useUiStore((s) => s.closeMemoryManager)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()

  const [templates, setTemplates] = React.useState<TemplateSummary[]>([])
  const [assignedId, setAssignedId] = React.useState<string | null>(null)
  const [tables, setTables] = React.useState<TableRead[]>([])
  const [template, setTemplate] = React.useState<TableTemplate | null>(null)
  const [status, setStatus] = React.useState<Record<string, TableStatusLike>>({})
  const [activeTable, setActiveTable] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<Tab>('data')

  // Native card WCVs paint above the DOM (ignore z-order); duck them while the popup is up.
  useWcvSuppression(open)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const loadTemplates = React.useCallback(async () => {
    try {
      setTemplates((await api().listTableTemplates(profileId)) ?? [])
    } catch {
      setTemplates([])
    }
  }, [profileId])

  const loadChat = React.useCallback(async () => {
    if (!activeChatId) {
      setAssignedId(null)
      setTables([])
      setTemplate(null)
      setStatus({})
      return
    }
    try {
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssignedId(id)
      if (!id) {
        setTables([])
        setTemplate(null)
        setStatus({})
        return
      }
      setTables((await api().readChatTables(profileId, activeChatId)) ?? [])
      setTemplate(((await api().getTableTemplate(profileId, id)) as TableTemplate | null) ?? null)
      setStatus((await api().readChatTablesStatus(profileId, activeChatId)) ?? {})
    } catch {
      setAssignedId(null)
      setTables([])
      setTemplate(null)
      setStatus({})
    }
  }, [profileId, activeChatId])

  // Load only while open (and refetch on floor changes / chat switch, like the other memory hosts).
  React.useEffect(() => {
    if (!open) return
    void loadTemplates()
  }, [open, loadTemplates])
  React.useEffect(() => {
    if (!open) return
    void loadChat()
  }, [open, loadChat, floors.length])

  // Keep the active table valid: default to the first table; drop a selection that no longer exists.
  React.useEffect(() => {
    if (tables.length === 0) {
      if (activeTable !== null) setActiveTable(null)
      return
    }
    if (!activeTable || !tables.some((tb) => tb.sqlName === activeTable)) {
      setActiveTable(tables[0].sqlName)
    }
  }, [tables, activeTable])

  const toastError = React.useCallback(
    (prefix: string, error: string): void => {
      const detail = error.startsWith('tables.') ? t(error) : error
      useToastStore.getState().push(`${prefix}: ${detail}`)
    },
    [t]
  )

  const onAssign = async (value: string): Promise<void> => {
    if (!activeChatId) return
    const id = value === '' ? null : value
    const message = id ? t('tables.confirmAssign') : t('tables.confirmUnassign')
    if (!confirm(message)) {
      void loadChat()
      return
    }
    try {
      await api().setChatTableTemplate(profileId, activeChatId, id)
    } catch {
      useToastStore.getState().push(t('tables.assignFailed'))
    }
    await loadChat()
  }

  const applyEdit = async (edit: {
    kind: 'cell' | 'insert' | 'delete' | 'reset'
    table: string
    rowid?: number
    columnIndex?: number
    value?: string
    values?: (string | null)[]
  }): Promise<void> => {
    if (!activeChatId) return
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

  // Card Save commits only the CHANGED cells of one row (batched: N cell edits, then ONE reload) — no
  // per-keystroke or per-blur write, and no reload between the cells of a single save.
  const saveRowCells = async (
    tableName: string,
    rowid: number,
    changes: CellChange[]
  ): Promise<void> => {
    if (!activeChatId || changes.length === 0) return
    try {
      for (const ch of changes) {
        const res = await api().editChatTable(profileId, activeChatId, {
          kind: 'cell',
          table: tableName,
          rowid,
          columnIndex: ch.colIndex,
          value: ch.value
        })
        if (res && res.error) {
          toastError(t('tables.editFailed'), res.error)
          break
        }
      }
    } catch {
      useToastStore.getState().push(t('tables.editFailed'))
    }
    await loadChat()
  }

  const insertRow = async (tableName: string, values: (string | null)[]): Promise<void> => {
    if (!activeChatId) return
    try {
      const res = await api().editChatTable(profileId, activeChatId, {
        kind: 'insert',
        table: tableName,
        values
      })
      if (res && res.error) {
        toastError(t('tables.editFailed'), res.error)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.editFailed'))
    }
    await loadChat()
  }

  const findDef = (tbl: TableRead): TableDef | null => {
    if (!template) return null
    return (
      template.tables.find((d) => d.sqlName === tbl.sqlName) ??
      template.tables.find((d) => d.displayName === tbl.displayName) ??
      null
    )
  }

  if (!open) return null

  const assignedName = templates.find((tpl) => tpl.id === assignedId)?.name ?? null
  const active = tables.find((tb) => tb.sqlName === activeTable) ?? null

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="rpt-mm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('memoryManager.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rpt-mm-head">
          <strong>{t('memoryManager.title')}</strong>
          <button className="btn-ghost" title={`${t('common.close')} (Esc)`} onClick={close}>
            ✕
          </button>
        </div>

        {!activeChatId ? (
          <div className="rpt-mm-empty">
            <div className="rpt-mm-empty-icon" aria-hidden>
              🗃
            </div>
            <h2 className="rpt-mm-empty-title">{t('memory.noChatTitle')}</h2>
            <p className="rpt-mm-empty-body">{t('memory.noChatBody')}</p>
          </div>
        ) : (
          <>
            <div className="rpt-mm-body">
              {/* LEFT RAIL: template binding + the sheet list. */}
              <aside className="rpt-mm-rail">
                <div className="rpt-mm-binding">
                  <label className="rpt-mm-binding-label" htmlFor="mm-template-select">
                    {t('tables.template')}
                  </label>
                  <select
                    id="mm-template-select"
                    className="rpt-mm-select"
                    value={assignedId ?? ''}
                    onChange={(e) => void onAssign(e.target.value)}
                  >
                    <option value="">{t('tables.none')}</option>
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name} ({tpl.tableCount})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rpt-mm-sheets" role="listbox" aria-label={t('memoryManager.sheets')}>
                  {!assignedId ? (
                    <p className="rpt-mm-rail-empty">{t('tables.noneAssigned')}</p>
                  ) : tables.length === 0 ? (
                    <p className="rpt-mm-rail-empty">{t('tables.emptyTemplate')}</p>
                  ) : (
                    tables.map((tb) => {
                      const st = status[tb.sqlName]
                      const badge =
                        !st || st.lastFloor == null
                          ? { cls: 'never', text: t('memoryManager.badgeNever') }
                          : st.unprocessed > 0
                            ? {
                                cls: 'pending',
                                text: t('memoryManager.badgePending', { n: st.unprocessed })
                              }
                            : { cls: 'ok', text: t('memoryManager.badgeOk') }
                      const selected = tb.sqlName === activeTable
                      return (
                        <button
                          key={tb.sqlName}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`rpt-mm-sheet${selected ? ' active' : ''}`}
                          onClick={() => setActiveTable(tb.sqlName)}
                        >
                          <span className="rpt-mm-sheet-name">{tb.displayName}</span>
                          <span className="rpt-mm-sheet-count">
                            {t('memoryManager.sheetCount', {
                              rows: tb.rows.length,
                              cols: tb.columns.length
                            })}
                          </span>
                          <span className={`rpt-mm-badge ${badge.cls}`}>{badge.text}</span>
                        </button>
                      )
                    })
                  )}
                </div>
              </aside>

              {/* MAIN AREA: topbar + segmented tabs + content. */}
              <section className="rpt-mm-main">
                <div className="rpt-mm-topbar">
                  <span className="rpt-mm-topbar-template">
                    {assignedName ?? t('tables.none')}
                  </span>
                  {/* Dirty area — a stub for now (edits commit immediately through main). */}
                  <span className="rpt-mm-topbar-status">{t('memoryManager.clean')}</span>
                  <button
                    className="rpt-duel-secondary rpt-mm-refresh"
                    onClick={() => void loadChat()}
                  >
                    {t('tables.refresh')}
                  </button>
                </div>

                <div className="rpt-mm-tabs" role="tablist">
                  {(['data', 'structure', 'maintenance', 'history'] as const).map((tb) => (
                    <button
                      key={tb}
                      type="button"
                      role="tab"
                      aria-selected={tab === tb}
                      className={`rpt-mm-tab${tab === tb ? ' active' : ''}`}
                      onClick={() => setTab(tb)}
                    >
                      {t(`memoryManager.tab.${tb}`)}
                    </button>
                  ))}
                </div>

                <div className="rpt-mm-content">
                  {tab === 'data' &&
                    (!assignedId ? (
                      <p className="rpt-mm-rail-empty">{t('tables.noneAssigned')}</p>
                    ) : !active ? (
                      <p className="rpt-mm-rail-empty">{t('tables.emptyTemplate')}</p>
                    ) : (
                      <TableCards
                        key={active.sqlName}
                        table={active}
                        headers={findDef(active)?.headers}
                        onSaveRow={(rowid, changes) => saveRowCells(active.sqlName, rowid, changes)}
                        onInsertRow={(values) => insertRow(active.sqlName, values)}
                        onDeleteRow={(rowid) =>
                          applyEdit({ kind: 'delete', table: active.sqlName, rowid })
                        }
                      />
                    ))}
                  {tab === 'structure' && (
                    <StructureTab
                      profileId={profileId}
                      templateId={assignedId}
                      defs={template?.tables ?? []}
                      reads={tables}
                      onReload={loadChat}
                    />
                  )}
                  {tab === 'maintenance' && (
                    <MaintenanceTab
                      profileId={profileId}
                      chatId={activeChatId}
                      hasTemplate={!!assignedId}
                      onReload={loadChat}
                    />
                  )}
                  {tab === 'history' && (
                    <HistoryTab
                      profileId={profileId}
                      chatId={activeChatId}
                      hasTemplate={!!assignedId}
                      onReload={loadChat}
                    />
                  )}
                </div>
              </section>
            </div>

            {/* FOOTER: template / active table / row count status line. */}
            <div className="rpt-mm-footer">
              <span>{t('memoryManager.footTemplate', { name: assignedName ?? t('tables.none') })}</span>
              {active && (
                <>
                  <span className="rpt-mm-foot-sep" aria-hidden>
                    ·
                  </span>
                  <span>{t('memoryManager.footTable', { name: active.displayName })}</span>
                  <span className="rpt-mm-foot-sep" aria-hidden>
                    ·
                  </span>
                  <span>{t('memoryManager.footRows', { n: active.rows.length })}</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The Maintenance tab (WP2) — the shujuku 填表工作台 parity surface. Three stacked sections:
 *  1) a "Run maintenance now" workbench (lastNFloors + an optional extra hint + a Run button) that fires
 *     ONE on-demand maintenance pass through the SAME cores automatic maintenance runs
 *     (chat-tables-maintain-now → maintainNow); on success it refreshes the manager (onReload) + remounts
 *     the embedded progress pane, and routes failures through the toast store.
 *  2) a collapsible "Preview prompt" that reuses the workflow editor's MemoryPreview (passing a bare
 *     `{ lastNFloors }` override so main resolves the chat's effective memory.maintain config).
 *  3) the shared MemoryPane in `section="maintenance"` mode = the per-table progress list + the manual
 *     BackfillPanel (no reimplementation). Its own no-template hint covers the unassigned case.
 */
const MaintenanceTab: React.FC<{
  profileId: string
  chatId: string
  hasTemplate: boolean
  onReload: () => Promise<void> | void
}> = ({ profileId, chatId, hasTemplate, onReload }) => {
  const t = useT()
  const [lastNFloors, setLastNFloors] = React.useState(6)
  const [extraHint, setExtraHint] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<{ text: string; error: boolean } | null>(null)
  const [showPreview, setShowPreview] = React.useState(false)
  // Bumped after a successful run to remount MemoryPane so its progress + backfill state re-read.
  const [reloadNonce, setReloadNonce] = React.useState(0)

  const onRun = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    try {
      const res = await api().maintainTablesNow(profileId, chatId, {
        lastNFloors,
        extraHint: extraHint.trim() || undefined
      })
      if (res && res.ok) {
        setResult({
          text: res.empty
            ? t('memoryManager.maintenance.resultEmpty')
            : t('memoryManager.maintenance.resultApplied', {
                applied: res.applied,
                changes: res.changes
              }),
          error: false
        })
        await onReload()
        setReloadNonce((n) => n + 1)
      } else {
        const reason = res?.reason
        const msg =
          reason === 'no-template'
            ? t('memoryManager.maintenance.noTemplate')
            : reason === 'no-node'
              ? t('memoryManager.maintenance.errorNoNode')
              : reason === 'aborted'
                ? t('memoryManager.maintenance.errorAborted')
                : t('memoryManager.maintenance.errorFailed', { message: res?.message ?? '' })
        setResult({ text: msg, error: true })
        useToastStore.getState().push(msg)
      }
    } catch (err) {
      const msg = t('memoryManager.maintenance.errorFailed', {
        message: err instanceof Error ? err.message : String(err)
      })
      setResult({ text: msg, error: true })
      useToastStore.getState().push(msg)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rpt-mm-maint">
      {hasTemplate && (
        <>
          <section className="rpt-mm-maint-section">
            <h3 className="rpt-mm-maint-title">{t('memoryManager.maintenance.runTitle')}</h3>
            <p className="rpt-mm-maint-intro">{t('memoryManager.maintenance.runIntro')}</p>
            <div className="rpt-mm-maint-row">
              <label className="rpt-mm-maint-label" htmlFor="mm-maint-floors">
                {t('memoryManager.maintenance.lastNFloors')}
              </label>
              <input
                id="mm-maint-floors"
                className="rpt-mm-maint-num"
                type="number"
                min={1}
                max={50}
                value={lastNFloors}
                disabled={running}
                onChange={(e) =>
                  setLastNFloors(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
                }
              />
            </div>
            <label className="rpt-mm-maint-label" htmlFor="mm-maint-hint">
              {t('memoryManager.maintenance.extraHint')}
            </label>
            <textarea
              id="mm-maint-hint"
              className="rpt-mm-maint-textarea"
              value={extraHint}
              disabled={running}
              placeholder={t('memoryManager.maintenance.extraHintPlaceholder')}
              onChange={(e) => setExtraHint(e.target.value)}
            />
            <button className="rpt-mm-maint-run" disabled={running} onClick={() => void onRun()}>
              {running
                ? t('memoryManager.maintenance.running')
                : t('memoryManager.maintenance.run')}
            </button>
            {result && (
              <p className={`rpt-mm-maint-result${result.error ? ' error' : ''}`}>{result.text}</p>
            )}
          </section>

          <section className="rpt-mm-maint-section">
            <button
              className="rpt-duel-secondary"
              aria-expanded={showPreview}
              onClick={() => setShowPreview((s) => !s)}
            >
              {showPreview ? '▾' : '▸'}{' '}
              {showPreview
                ? t('memoryManager.maintenance.previewHide')
                : t('memoryManager.maintenance.previewShow')}
            </button>
            {showPreview && <MemoryPreview profileId={profileId} config={{ lastNFloors }} />}
          </section>
        </>
      )}

      {/* Progress + manual backfill — the shared pane (no reimplementation); handles no-template itself. */}
      <MemoryPane
        key={reloadNonce}
        profileId={profileId}
        packs={null}
        gates={{}}
        onOpenPackDetail={() => {}}
        hidePacksStrip
        section="maintenance"
      />
    </div>
  )
}

/**
 * The History tab (WP3) — exposes the per-chat table op-log (chat-tables-ops-list) newest-first and
 * lets the user roll the tables back to an earlier point (chat-tables-rewind). Rewind is DATA-ONLY (it
 * drops later table ops + rebuilds the sandbox; chat messages + the maintenance progress pointer are
 * untouched) and DESTRUCTIVE — both actions gate behind window.confirm (the same pattern TableGrid's
 * delete-row / reset use). On success it re-reads the manager (onReload) + the op-log, and toasts.
 */
const HistoryTab: React.FC<{
  profileId: string
  chatId: string
  hasTemplate: boolean
  onReload: () => Promise<void> | void
}> = ({ profileId, chatId, hasTemplate, onReload }) => {
  const t = useT()
  const [ops, setOps] = React.useState<TableOpView[]>([])
  const [busy, setBusy] = React.useState(false)

  const loadOps = React.useCallback(async () => {
    if (!hasTemplate) {
      setOps([])
      return
    }
    try {
      setOps(((await api().listChatTableOps(profileId, chatId)) as TableOpView[]) ?? [])
    } catch {
      setOps([])
    }
  }, [profileId, chatId, hasTemplate])

  React.useEffect(() => {
    void loadOps()
  }, [loadOps])

  const rewind = async (fromFloor: number, confirmMsg: string): Promise<void> => {
    if (!confirm(confirmMsg)) return
    setBusy(true)
    try {
      const res = await api().rewindChatTables(profileId, chatId, fromFloor)
      if (res && res.error) {
        const detail = String(res.error).startsWith('tables.') ? t(res.error) : String(res.error)
        useToastStore.getState().push(`${t('memoryManager.history.rewindFailed')}: ${detail}`)
        return
      }
      useToastStore.getState().push(t('memoryManager.history.rewound', { n: res?.dropped ?? 0 }))
      await onReload()
      await loadOps()
    } catch {
      useToastStore.getState().push(t('memoryManager.history.rewindFailed'))
    } finally {
      setBusy(false)
    }
  }

  const fmtTime = (iso: string | null): string => {
    if (!iso) return '—'
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  if (!hasTemplate) {
    return <p className="rpt-mm-rail-empty">{t('tables.noneAssigned')}</p>
  }

  return (
    <div className="rpt-mm-history">
      <div className="rpt-mm-history-bar">
        <p className="rpt-mm-maint-intro">{t('memoryManager.history.intro')}</p>
        <button
          className="rpt-duel-secondary rpt-mm-history-undo"
          disabled={busy || ops.length === 0}
          onClick={() => void rewind(ops[0].floor, t('memoryManager.history.confirmUndo'))}
        >
          {t('memoryManager.history.undoLast')}
        </button>
      </div>

      {ops.length === 0 ? (
        <div className="rpt-mm-history-empty">
          <div className="rpt-mm-soon-icon" aria-hidden>
            🕓
          </div>
          <p className="rpt-mm-empty-body">{t('memoryManager.history.empty')}</p>
        </div>
      ) : (
        <ul className="rpt-mm-history-list">
          {ops.map((op) => (
            <li key={`${op.floor}-${op.seq}`} className="rpt-mm-history-row">
              <div className="rpt-mm-history-meta">
                <span className="rpt-mm-history-floor">
                  {t('memoryManager.history.floor', { n: op.floor })}
                </span>
                <span className="rpt-mm-history-label">
                  {t(`memoryManager.history.kind.${op.kind}`)}
                  {op.table ? ` · ${op.table}` : ''}
                </span>
                <span className="rpt-mm-history-time">{fmtTime(op.createdAt)}</span>
              </div>
              <button
                className="rpt-duel-secondary rpt-mm-history-rewind"
                disabled={busy}
                onClick={() =>
                  void rewind(op.floor, t('memoryManager.history.confirmRewind', { n: op.floor }))
                }
              >
                {t('memoryManager.history.rewindTo')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One structural op sent to `applyTableStructure` (subset built by this tab; add-table is deferred —
 *  a UI-created table's row_id/PK convention for maintenance writes isn't verified yet). */
type StructOp =
  | { kind: 'addColumn'; uid: string; name: string; type?: string }
  | { kind: 'renameColumn'; uid: string; from: string; to: string }
  | { kind: 'dropColumn'; uid: string; name: string }
  | { kind: 'renameTable'; uid: string; sqlName: string; displayName?: string }
  | { kind: 'dropTable'; uid: string }

/**
 * The Structure tab (WP4b) — the shujuku 结构·参数 parity surface. Edits the ASSIGNED template's shape
 * (rename/delete tables, add/rename/delete columns) and drives `applyTableStructure`, which migrates
 * EVERY chat bound to the shared template + re-baselines each op-log (WP4a). Because that fans out to
 * all bound chats, a prominent warning sits at the top, and any `failedChats` (chats left on the old
 * schema, needing a re-sync) are surfaced persistently — never buried in a toast. Destructive ops
 * (delete table/column) gate behind window.confirm (the same pattern the Data grid + History use). The
 * `row_id` PK is never listed (it is structural, not user-editable). Add-table is intentionally deferred.
 */
const StructureTab: React.FC<{
  profileId: string
  templateId: string | null
  defs: TableDef[]
  reads: TableRead[]
  onReload: () => Promise<void> | void
}> = ({ profileId, templateId, defs, reads, onReload }) => {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState<{ chatId: string; reason: string }[]>([])
  const [warns, setWarns] = React.useState<string[]>([])
  const [addCol, setAddCol] = React.useState<Record<string, string>>({})
  const [editing, setEditing] = React.useState<{ uid: string; col?: string } | null>(null)
  const [editVal, setEditVal] = React.useState('')

  // Real SQL column names for a table (source of truth for column ops), minus the structural row_id PK.
  const columnsOf = (d: TableDef): string[] => {
    const r = reads.find((x) => x.sqlName === d.sqlName)
    return (r?.columns ?? []).filter((c) => c.toLowerCase() !== 'row_id')
  }

  const applyOps = async (ops: StructOp[]): Promise<void> => {
    if (!templateId || ops.length === 0) return
    setBusy(true)
    try {
      const res = await api().applyTableStructure(profileId, templateId, ops)
      if (!res || res.ok === false) {
        const raw = res?.error ? String(res.error) : ''
        const detail = raw.startsWith('tables.') ? t(raw) : raw
        useToastStore
          .getState()
          .push(`${t('memoryManager.structure.failed')}${detail ? ': ' + detail : ''}`)
        return
      }
      setFailed(res.failedChats ?? [])
      setWarns(res.warnings ?? [])
      useToastStore.getState().push(
        t('memoryManager.structure.applied', {
          tables: res.tablesChanged,
          cols: res.columnsChanged,
          chats: res.chatsMigrated
        })
      )
      await onReload()
    } catch {
      useToastStore.getState().push(t('memoryManager.structure.failed'))
    } finally {
      setBusy(false)
      setEditing(null)
    }
  }

  const startEdit = (uid: string, col: string | undefined, current: string): void => {
    setEditing({ uid, col })
    setEditVal(current)
  }
  const commitEdit = (op: StructOp): void => {
    if (!editVal.trim()) {
      setEditing(null)
      return
    }
    void applyOps([op])
  }
  const submitAddCol = (uid: string): void => {
    const name = (addCol[uid] ?? '').trim()
    if (!name) return
    void applyOps([{ kind: 'addColumn', uid, name }])
    setAddCol((m) => ({ ...m, [uid]: '' }))
  }

  if (!templateId) {
    return <p className="rpt-mm-rail-empty">{t('tables.noneAssigned')}</p>
  }

  return (
    <div className="rpt-mm-struct">
      <div className="rpt-mm-struct-warn" role="note">
        {t('memoryManager.structure.warn')}
      </div>

      {failed.length > 0 && (
        <div className="rpt-mm-struct-failed" role="alert">
          <strong>{t('memoryManager.structure.failedTitle')}</strong>
          <ul>
            {failed.map((f) => (
              <li key={f.chatId}>
                {t('memoryManager.structure.failedRow', { chat: f.chatId, reason: f.reason })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warns.length > 0 && (
        <div className="rpt-mm-struct-warns">
          <strong>{t('memoryManager.structure.warningsTitle')}</strong>
          <ul>
            {warns.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {defs.length === 0 ? (
        <p className="rpt-mm-rail-empty">{t('tables.emptyTemplate')}</p>
      ) : (
        defs.map((d) => {
          const editingTable = editing?.uid === d.uid && !editing.col
          const cols = columnsOf(d)
          return (
            <section key={d.uid} className="rpt-mm-struct-table">
              <header className="rpt-mm-struct-thead">
                {editingTable ? (
                  <span className="rpt-mm-struct-edit">
                    <input
                      className="rpt-mm-select"
                      autoFocus
                      value={editVal}
                      disabled={busy}
                      onChange={(e) => setEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          commitEdit({
                            kind: 'renameTable',
                            uid: d.uid,
                            sqlName: d.sqlName,
                            displayName: editVal.trim()
                          })
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                    <button
                      className="rpt-duel-secondary"
                      disabled={busy}
                      onClick={() =>
                        commitEdit({
                          kind: 'renameTable',
                          uid: d.uid,
                          sqlName: d.sqlName,
                          displayName: editVal.trim()
                        })
                      }
                    >
                      {t('common.save')}
                    </button>
                    <button className="btn-ghost" onClick={() => setEditing(null)}>
                      {t('common.cancel')}
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="rpt-mm-struct-tname">{d.displayName}</span>
                    <span className="rpt-mm-struct-tsql">{d.sqlName}</span>
                    <span className="rpt-mm-struct-tactions">
                      <button
                        className="rpt-duel-secondary"
                        disabled={busy}
                        onClick={() => startEdit(d.uid, undefined, d.displayName)}
                      >
                        {t('memoryManager.structure.renameTable')}
                      </button>
                      <button
                        className="rpt-duel-secondary rpt-mm-danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(t('memoryManager.structure.confirmDropTable', { name: d.displayName })))
                            void applyOps([{ kind: 'dropTable', uid: d.uid }])
                        }}
                      >
                        {t('memoryManager.structure.deleteTable')}
                      </button>
                    </span>
                  </>
                )}
              </header>

              <ul className="rpt-mm-struct-cols">
                {cols.length === 0 ? (
                  <li className="rpt-mm-rail-empty">{t('memoryManager.structure.noColumns')}</li>
                ) : (
                  cols.map((c) => {
                    const editingCol = editing?.uid === d.uid && editing.col === c
                    return (
                      <li key={c} className="rpt-mm-struct-col">
                        {editingCol ? (
                          <span className="rpt-mm-struct-edit">
                            <input
                              className="rpt-mm-select"
                              autoFocus
                              value={editVal}
                              disabled={busy}
                              onChange={(e) => setEditVal(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter')
                                  commitEdit({ kind: 'renameColumn', uid: d.uid, from: c, to: editVal.trim() })
                                if (e.key === 'Escape') setEditing(null)
                              }}
                            />
                            <button
                              className="rpt-duel-secondary"
                              disabled={busy}
                              onClick={() =>
                                commitEdit({ kind: 'renameColumn', uid: d.uid, from: c, to: editVal.trim() })
                              }
                            >
                              {t('common.save')}
                            </button>
                            <button className="btn-ghost" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </button>
                          </span>
                        ) : (
                          <>
                            <span className="rpt-mm-struct-cname">{c}</span>
                            <span className="rpt-mm-struct-cactions">
                              <button
                                className="rpt-duel-secondary"
                                disabled={busy}
                                onClick={() => startEdit(d.uid, c, c)}
                              >
                                {t('memoryManager.structure.renameColumn')}
                              </button>
                              <button
                                className="rpt-duel-secondary rpt-mm-danger"
                                disabled={busy}
                                onClick={() => {
                                  if (confirm(t('memoryManager.structure.confirmDropColumn', { name: c })))
                                    void applyOps([{ kind: 'dropColumn', uid: d.uid, name: c }])
                                }}
                              >
                                {t('memoryManager.structure.deleteColumn')}
                              </button>
                            </span>
                          </>
                        )}
                      </li>
                    )
                  })
                )}
              </ul>

              <div className="rpt-mm-struct-addcol">
                <input
                  className="rpt-mm-select"
                  placeholder={t('memoryManager.structure.addColumnPlaceholder')}
                  value={addCol[d.uid] ?? ''}
                  disabled={busy}
                  onChange={(e) => setAddCol((m) => ({ ...m, [d.uid]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitAddCol(d.uid)
                  }}
                />
                <button
                  className="rpt-duel-secondary"
                  disabled={busy || !(addCol[d.uid] ?? '').trim()}
                  onClick={() => submitAddCol(d.uid)}
                >
                  {t('memoryManager.structure.addColumn')}
                </button>
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
