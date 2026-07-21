// Full-window Memory Manager (Memory Manager WP1) — the SQL-table memory feature's rich full-screen
// home, mirroring the shujuku 数据库 plugin's full-takeover "Visualizer". Hosted as a centered
// full-window popup like DuelPopup / AssetsPopup so it layers above BOTH the reconfigurable Workspace
// and a card's static panel_ui layout (.modal-overlay sits in the top z-index band). Opened from the
// Memory chip in the TopStrip and from Settings.
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
import {
  TemplateEditPanel,
  type TableDef,
  type TableDefPatch,
  type TableRead
} from '../workspace/TableGrid'
import type { TableStatusLike } from '../workspace/tableGridModel'
import { TableCards, type CellChange } from './TableCards'
import { RefillWorkbench } from './RefillWorkbench'
import { ConfirmDialog } from '../ConfirmDialog'
import { MemoryPreview } from './MemoryMaintainPanel'
import { groupOpsByFloor, rewindConsequence, type HistoryOp } from './historyModel'
import {
  describeStagedOp,
  droppedTableUids,
  droppedColumns,
  canStage,
  type StructOp
} from './structureStaging'
import { codeColumnOf } from '../../../../shared/memory/codeColumn'

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
type Tab = 'data' | 'notes' | 'structure' | 'maintenance' | 'history'

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
  // Template file-ops (WS6 Phase B): the rail's ⋯ overflow menu + the themed delete confirm.
  const [templateMenuOpen, setTemplateMenuOpen] = React.useState(false)
  const [confirmDeleteTpl, setConfirmDeleteTpl] = React.useState(false)
  // Template (un)assignment confirm (WS6 Phase C — the last window.confirm in the rail is gone).
  const [pendingAssign, setPendingAssign] = React.useState<{ id: string | null } | null>(null)
  // Data tab: the active table's template-config disclosure (shared TemplateEditPanel).
  const [configOpen, setConfigOpen] = React.useState(false)

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
  // While the template ⋯ menu is up, Escape closes the MENU, not the manager: a capture-phase
  // listener runs before the manager's bubble-phase one and stops propagation.
  React.useEffect(() => {
    if (!templateMenuOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setTemplateMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [templateMenuOpen])

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

  // (Un)assignment is destructive ((re)instantiates / removes the sandbox) — themed confirm, not
  // window.confirm. Cancel re-reads the chat so the <select> snaps back to the persisted binding.
  const onAssign = (value: string): void => {
    if (!activeChatId) return
    setPendingAssign({ id: value === '' ? null : value })
  }

  const doAssign = async (id: string | null): Promise<void> => {
    if (!activeChatId) return
    try {
      const res = await api().setChatTableTemplate(profileId, activeChatId, id)
      if (res && res.error) {
        const detail = String(res.error).startsWith('tables.') ? t(res.error) : String(res.error)
        useToastStore.getState().push(`${t('tables.assignFailed')}: ${detail}`)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.assignFailed'))
      return
    }
    await loadChat()
  }

  // Template file operations (WS6 Phase B) — absorbed from the deleted MemoryPane (same IPC, same
  // error contract: parser errors come back as localizable `{ error }`, never a throw across IPC).
  const onImport = async (): Promise<void> => {
    const result = await api().importTableTemplateDialog(profileId)
    if (result === null) return
    if (result.error) {
      const detail = result.error.startsWith('tables.') ? t(result.error) : result.error
      useToastStore.getState().push(`${t('tables.importFailed')}: ${detail}`)
      return
    }
    await loadTemplates()
  }

  const onExport = async (withData: boolean): Promise<void> => {
    if (!assignedId || !activeChatId) return
    try {
      await api().exportTableTemplateDialog(profileId, assignedId, withData ? activeChatId : null)
    } catch {
      useToastStore.getState().push(t('tables.exportFailed'))
    }
  }

  const onDeleteTemplate = async (): Promise<void> => {
    if (!assignedId) return
    try {
      const res = await api().deleteTableTemplate(profileId, assignedId)
      if (res && res.error) {
        const detail = String(res.error).startsWith('tables.') ? t(res.error) : String(res.error)
        useToastStore.getState().push(`${t('tables.deleteFailed')}: ${detail}`)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.deleteFailed'))
      return
    }
    await loadTemplates()
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

  // Per-table template config (owner pass 2026-07-14): imported templates carry per-table cadence,
  // prompts, and injection settings, but every control lived in the workspace TablesView —
  // unreachable from `static`-layout cards and invisible here. The refill picker hosts the shared
  // FreqControl and the Data tab hosts the shared TemplateEditPanel; both persist through this ONE
  // patch path (same call shape as TablesView.onSaveTemplate).
  const saveTemplatePatch = async (patch: TableDefPatch): Promise<void> => {
    if (!assignedId) return
    try {
      const res = await api().updateTableTemplate(profileId, assignedId, { tables: [patch] })
      if (res && res.error) {
        toastError(t('tables.templateSaveFailed'), res.error)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.templateSaveFailed'))
      return
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
  // Plot-recall (WP7): the active table's memory-code column (RPT's MT#### convention), derived from
  // its exportConfig via the shared helper — powers the code chip TableCards renders on each row card.
  const activeDef = active ? findDef(active) : null
  const codeColumn = activeDef?.exportConfig ? codeColumnOf(activeDef.exportConfig) : null

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
                  <div className="rpt-mm-binding-row">
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
                    {/* Template file operations (WS6 Phase B): the ⋯ overflow menu — the ONE home for
                        import / export / delete now that MemoryPane (their old host) is gone. */}
                    <div className="rpt-mm-menuwrap">
                      <button
                        type="button"
                        className="rpt-duel-secondary rpt-mm-menubtn"
                        aria-haspopup="menu"
                        aria-expanded={templateMenuOpen}
                        title={t('memoryManager.templateMenu')}
                        onClick={() => setTemplateMenuOpen((s) => !s)}
                      >
                        ⋯
                      </button>
                      {templateMenuOpen && (
                        <>
                          <div
                            className="rpt-mm-menu-backdrop"
                            onClick={() => setTemplateMenuOpen(false)}
                          />
                          <div className="rpt-mm-menu" role="menu">
                            <button
                              role="menuitem"
                              className="rpt-mm-menu-item"
                              onClick={() => {
                                setTemplateMenuOpen(false)
                                void onImport()
                              }}
                            >
                              {t('tables.import')}
                            </button>
                            <button
                              role="menuitem"
                              className="rpt-mm-menu-item"
                              disabled={!assignedId}
                              onClick={() => {
                                setTemplateMenuOpen(false)
                                void onExport(false)
                              }}
                            >
                              {t('tables.export')}
                            </button>
                            <button
                              role="menuitem"
                              className="rpt-mm-menu-item"
                              disabled={!assignedId}
                              onClick={() => {
                                setTemplateMenuOpen(false)
                                void onExport(true)
                              }}
                            >
                              {t('tables.exportWithData')}
                            </button>
                            <button
                              role="menuitem"
                              className="rpt-mm-menu-item danger"
                              disabled={!assignedId}
                              onClick={() => {
                                setTemplateMenuOpen(false)
                                setConfirmDeleteTpl(true)
                              }}
                            >
                              <span className="rpt-mm-refill-dot error" aria-hidden />
                              {t('tables.deleteTemplate')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
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
                  {(['data', 'notes', 'structure', 'maintenance', 'history'] as const).map((tb) => (
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
                      <>
                        {/* Per-table template config (prompts + injection) — the SHARED
                            TemplateEditPanel, previously reachable only via the workspace Tables
                            view (owner pass 2026-07-14). */}
                        {activeDef && (
                          <div className="rpt-mm-data-config">
                            <button
                              className="rpt-duel-secondary"
                              aria-expanded={configOpen}
                              onClick={() => setConfigOpen((s) => !s)}
                            >
                              {configOpen ? '▾ ' : '▸ '}
                              {t('memoryManager.data.templateConfig')}
                            </button>
                            {configOpen && (
                              <TemplateEditPanel
                                key={activeDef.uid}
                                def={activeDef}
                                onSave={saveTemplatePatch}
                                onClose={() => setConfigOpen(false)}
                              />
                            )}
                          </div>
                        )}
                        <TableCards
                          key={active.sqlName}
                          table={active}
                          headers={activeDef?.headers}
                          codeColumn={codeColumn ?? undefined}
                          pageSize={10}
                          onSaveRow={(rowid, changes) => saveRowCells(active.sqlName, rowid, changes)}
                          onInsertRow={(values) => insertRow(active.sqlName, values)}
                          onDeleteRow={(rowid) =>
                            applyEdit({ kind: 'delete', table: active.sqlName, rowid })
                          }
                        />
                      </>
                    ))}
                  {tab === 'notes' && (
                    <NotesTab key={activeChatId} profileId={profileId} chatId={activeChatId} />
                  )}
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
                      key={`${activeChatId}:${assignedId ?? 'none'}`}
                      profileId={profileId}
                      chatId={activeChatId}
                      hasTemplate={!!assignedId}
                      tables={tables}
                      defs={template?.tables ?? []}
                      status={status}
                      floorsCount={floors.length}
                      onReload={loadChat}
                      onSetFrequency={(uid, updateFrequency) =>
                        saveTemplatePatch({ uid, updateFrequency })
                      }
                    />
                  )}
                  {tab === 'history' && (
                    <HistoryTab
                      key={`${activeChatId}:${assignedId ?? 'none'}`}
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

        {/* Template (un)assignment confirm (WS6 Phase C) — destructive: (re)builds the sandbox. */}
        {pendingAssign && (
          <ConfirmDialog
            title={t('tables.template')}
            body={pendingAssign.id ? t('tables.confirmAssign') : t('tables.confirmUnassign')}
            danger
            onConfirm={() => {
              const id = pendingAssign.id
              setPendingAssign(null)
              void doAssign(id)
            }}
            onCancel={() => {
              setPendingAssign(null)
              void loadChat()
            }}
          />
        )}

        {/* Delete-template confirm (WS6 Phase B) — the app's own dialog, never window.confirm. */}
        {confirmDeleteTpl && (
          <ConfirmDialog
            title={t('tables.deleteTemplate')}
            body={t('tables.confirmDeleteTemplate')}
            confirmLabel={t('tables.deleteTemplate')}
            danger
            onConfirm={() => {
              setConfirmDeleteTpl(false)
              void onDeleteTemplate()
            }}
            onCancel={() => setConfirmDeleteTpl(false)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Pure conflict decision for the Notes save path (B2). `baseline` is the on-disk content this tab last
 * synced with (load / successful save / reload); `disk` is a FRESH re-read taken at save time; `draft`
 * is the user's editable buffer. When the file changed under us since we synced (disk !== baseline) AND
 * the user has local edits (draft !== baseline), a blind whole-file write would silently clobber the
 * concurrent change (e.g. a notes.maintain pass) — return 'conflict' so the caller warns instead of
 * writing. Otherwise the disk copy still matches our baseline (or the draft never diverged), so a plain
 * 'save' is safe. Extracted + exported so the decision is unit-testable without the React tree.
 */
export function notesSaveDecision(
  baseline: string,
  disk: string,
  draft: string
): 'save' | 'conflict' {
  return disk !== baseline && draft !== baseline ? 'conflict' : 'save'
}

/**
 * The Notes tab (plot-recall WP7) — the per-chat freeform markdown notes store (WP2's notesGet/notesSet
 * preload surface). Notes live independently of any table template (the pane shows even with no template
 * assigned). Editing is EXPLICIT, matching the Data tab's per-card idiom: a local draft with dirty
 * tracking + Save / Reset buttons that disable when the draft is clean or a save is in flight. Saving an
 * empty/whitespace body removes the file main-side (idempotent, per the WP2 contract).
 *
 * B2 conflict guard: because notes.maintain can whole-file-write these same notes between the moment the
 * tab loads and the moment the user hits Save, a blind Save would clobber that concurrent write (and vice
 * versa). So `saved` doubles as a BASELINE (the disk content we last synced with), Save re-reads disk and
 * runs {@link notesSaveDecision} first, and a manual Refresh lets the user pull an external change in.
 */
const NotesTab: React.FC<{ profileId: string; chatId: string }> = ({ profileId, chatId }) => {
  const t = useT()
  // `saved` is BOTH the last-persisted body AND the baseline we diff disk against; `draft` = the
  // editable buffer. dirty = they differ.
  const [saved, setSaved] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  // Set when a save-time re-read finds the file changed under an edited draft (B2). Holds the disk copy
  // so "Reload" can adopt it without a second read; cleared once the user resolves the conflict.
  const [conflict, setConflict] = React.useState<{ disk: string } | null>(null)
  // Manual-Refresh-with-unsaved-edits confirm (WS6 Phase C — themed, not window.confirm).
  const [confirmReload, setConfirmReload] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const text = (await api().notesGet(profileId, chatId)) ?? ''
      setSaved(text)
      setDraft(text)
      setConflict(null)
    } catch {
      setSaved('')
      setDraft('')
      setConflict(null)
    } finally {
      setLoading(false)
    }
  }, [profileId, chatId])

  React.useEffect(() => {
    void load()
  }, [load])

  const dirty = draft !== saved

  // Persist the draft unconditionally and re-baseline. Used by the guarded Save path (once the guard
  // passes) and by the conflict "Overwrite" action.
  const persist = async (): Promise<void> => {
    try {
      await api().notesSet(profileId, chatId, draft)
      setSaved(draft)
      setConflict(null)
    } catch {
      useToastStore.getState().push(t('notes.saveFailed'))
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      let disk: string
      try {
        disk = (await api().notesGet(profileId, chatId)) ?? ''
      } catch {
        // Can't verify on-disk state — fail safe by NOT blind-writing.
        useToastStore.getState().push(t('notes.saveFailed'))
        return
      }
      if (notesSaveDecision(saved, disk, draft) === 'conflict') {
        setConflict({ disk })
        return
      }
      await persist()
    } finally {
      setBusy(false)
    }
  }

  const overwrite = async (): Promise<void> => {
    setBusy(true)
    try {
      await persist()
    } finally {
      setBusy(false)
    }
  }

  // Conflict "Reload": discard the draft, adopt the disk copy we already read. Also the manual Refresh
  // target (which re-reads disk); Refresh confirms first (themed dialog) when there are unsaved edits.
  const adoptDisk = (): void => {
    if (!conflict) return
    setSaved(conflict.disk)
    setDraft(conflict.disk)
    setConflict(null)
  }
  const refresh = (): void => {
    if (dirty) setConfirmReload(true)
    else void load()
  }

  return (
    <div className="rpt-mm-notes">
      <p className="rpt-mm-maint-intro">{t('notes.intro')}</p>
      {conflict && (
        <div className="rpt-mm-notes-conflict" role="alert">
          <span className="rpt-mm-notes-conflict-text">{t('notes.conflictWarn')}</span>
          <span className="rpt-mm-notes-conflict-actions">
            <button className="rpt-duel-secondary" disabled={busy} onClick={() => adoptDisk()}>
              {t('notes.conflictReload')}
            </button>
            <button
              className="rpt-duel-secondary rpt-mm-danger"
              disabled={busy}
              onClick={() => void overwrite()}
            >
              {t('notes.conflictOverwrite')}
            </button>
          </span>
        </div>
      )}
      {confirmReload && (
        <ConfirmDialog
          title={t('notes.refresh')}
          body={t('notes.reloadConfirm')}
          danger
          onConfirm={() => {
            setConfirmReload(false)
            void load()
          }}
          onCancel={() => setConfirmReload(false)}
        />
      )}
      <textarea
        className="rpt-mm-notes-textarea"
        value={draft}
        disabled={loading || busy}
        placeholder={t('notes.placeholder')}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="rpt-mm-notes-bar">
        <button
          className="rpt-mm-maint-run"
          disabled={!dirty || busy || loading}
          onClick={() => void save()}
        >
          {busy ? t('notes.saving') : t('common.save')}
        </button>
        <button
          className="btn-ghost"
          disabled={!dirty || busy || loading}
          onClick={() => setDraft(saved)}
        >
          {t('memoryManager.data.reset')}
        </button>
        <button
          className="btn-ghost"
          disabled={busy || loading}
          title={t('notes.refreshTip')}
          onClick={() => void refresh()}
        >
          {t('notes.refresh')}
        </button>
        {dirty && <span className="rpt-mm-notes-dirty">{t('notes.unsaved')}</span>}
      </div>
    </div>
  )
}

/**
 * Memory Maintenance Agent settings strip (execution-plan M5b2, task B). The re-home moved the OLD
 * workflow-doc memory-group settings onto the built-in Memory Maintenance Agent; this small strip is
 * their new home in the app UI: cadence (the Agent's floor-commit trigger), API preset (the Agent's
 * profile-local invocation config), and the on/off switch (the Agent's enabled flag). Reads/writes go
 * straight through the agentCatalog IPC — the Agent is identified by its stable built-in source key
 * ('memory-maintenance'), not its display name. Self-contained local state (no global store coupling)
 * keeps this off the shared agent-workspace snapshot the app-wide surfaces subscribe to.
 */
export function MemoryMaintenanceSettings({
  profileId
}: {
  profileId: string
}): React.JSX.Element | null {
  const t = useT()
  const [agentId, setAgentId] = React.useState<string | null>(null)
  const [def, setDef] = React.useState<Record<string, unknown> | null>(null)
  const [enabled, setEnabled] = React.useState(true)
  const [cadence, setCadence] = React.useState(3)
  const [presetId, setPresetId] = React.useState('')
  const [presets, setPresets] = React.useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const agents = (await api().listAgentCatalog(profileId)) ?? []
      const agent = (agents as any[]).find(
        (a) => a.sourceKind === 'builtin' && a.sourceKey === 'memory-maintenance'
      )
      if (!agent) {
        setAgentId(null)
        return
      }
      setAgentId(agent.id)
      setEnabled(agent.enabled !== false)
      const [definition, cfg, settings] = await Promise.all([
        api().getAgentDefinition(profileId, agent.id),
        api().getAgentInvocationConfig(profileId, agent.id),
        api().getSettings(profileId)
      ])
      setDef((definition as Record<string, unknown>) ?? null)
      const everyN = (definition as any)?.trigger?.onFloorCommitted?.everyNFloors
      setCadence(typeof everyN === 'number' && everyN >= 1 ? everyN : 3)
      setPresetId(typeof cfg?.apiPresetId === 'string' ? cfg.apiPresetId : '')
      setPresets(((settings?.api_presets ?? []) as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name })))
    } catch {
      setAgentId(null)
    }
  }, [profileId])

  React.useEffect(() => {
    void load()
  }, [load])

  const commitEnabled = async (next: boolean): Promise<void> => {
    if (!agentId) return
    setEnabled(next)
    setBusy(true)
    try {
      const res = await api().setAgentEnabled(profileId, agentId, next)
      if (res && res.ok === false) {
        useToastStore.getState().push(t('memoryManager.agent.saveFailed'))
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  const commitPreset = async (next: string): Promise<void> => {
    if (!agentId) return
    setPresetId(next)
    setBusy(true)
    try {
      await api().setAgentInvocationConfig(profileId, agentId, next ? { apiPresetId: next } : {})
    } finally {
      setBusy(false)
    }
  }

  // Cadence is a definition edit (customization) — persist on blur with an int>=1 clamp, patching the
  // trigger onto the last-loaded definition so no other field is disturbed.
  const commitCadence = async (): Promise<void> => {
    if (!agentId || !def) return
    const n = Math.max(1, Math.floor(cadence) || 1)
    setCadence(n)
    const currentTrigger = (def.trigger as Record<string, unknown> | undefined) ?? {}
    const currentCommit = (currentTrigger.onFloorCommitted as Record<string, unknown> | undefined) ?? {}
    if (currentCommit.everyNFloors === n) return
    setBusy(true)
    try {
      const patched = {
        ...def,
        trigger: { ...currentTrigger, onFloorCommitted: { ...currentCommit, everyNFloors: n } }
      }
      const res = await api().editAgent(profileId, agentId, patched)
      if (res && res.ok === false) {
        useToastStore.getState().push(t('memoryManager.agent.saveFailed'))
        await load()
      } else {
        setDef(patched)
      }
    } finally {
      setBusy(false)
    }
  }

  if (!agentId) return null

  return (
    <section className="rpt-mm-maint-section rpt-mm-agent-strip">
      <div className="rpt-mm-agent-strip-head">
        <strong>{t('memoryManager.agent.title')}</strong>
        <p className="rpt-mm-maint-intro">{t('memoryManager.agent.intro')}</p>
      </div>
      <div className="rpt-mm-agent-strip-row">
        <label className="rpt-mm-agent-field">
          <span className="rpt-mm-agent-label">{t('memoryManager.agent.cadence')}</span>
          <input
            className="rpt-mm-select rpt-mm-agent-cadence"
            type="number"
            min={1}
            step={1}
            value={cadence}
            disabled={busy || !enabled}
            onChange={(e) => setCadence(Number(e.target.value))}
            onBlur={() => void commitCadence()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitCadence()
            }}
          />
        </label>
        <label className="rpt-mm-agent-field">
          <span className="rpt-mm-agent-label">{t('memoryManager.agent.apiPreset')}</span>
          <select
            className="rpt-mm-select"
            value={presetId}
            disabled={busy || !enabled}
            onChange={(e) => void commitPreset(e.target.value)}
          >
            <option value="">{t('memoryManager.agent.apiPresetDefault')}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rpt-mm-agent-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void commitEnabled(e.target.checked)}
          />
          <span>{t('memoryManager.agent.enabled')}</span>
        </label>
      </div>
    </section>
  )
}

/**
 * The Maintenance tab (table-refill WS6 Phase A) — hosts the Refill workbench (the ONE manual-fill
 * surface: table multi-select + range + live consequence line + run rail + resume banner;
 * RefillWorkbench.tsx) plus the collapsible composed-prompt preview. The legacy run-now section and
 * the MemoryPane embed (per-table progress + the append BackfillPanel) are RETIRED here — the picker
 * rows carry the progress badges now, and the refill engine replaced both append paths (the
 * duplicate-rows fix, plan D7 / design brief ws6-design-brief-2026-07-13.md).
 */
const MaintenanceTab: React.FC<{
  profileId: string
  chatId: string
  hasTemplate: boolean
  tables: TableRead[]
  defs: TableDef[]
  status: Record<string, TableStatusLike>
  floorsCount: number
  onReload: () => Promise<void> | void
  onSetFrequency: (uid: string, updateFrequency: number) => Promise<void> | void
}> = ({ profileId, chatId, hasTemplate, tables, defs, status, floorsCount, onReload, onSetFrequency }) => {
  const t = useT()
  const [showPreview, setShowPreview] = React.useState(false)

  if (!hasTemplate) {
    return <p className="rpt-mm-rail-empty">{t('memoryManager.maintenance.noTemplate')}</p>
  }

  return (
    <div className="rpt-mm-maint">
      <MemoryMaintenanceSettings profileId={profileId} />

      <RefillWorkbench
        profileId={profileId}
        chatId={chatId}
        tables={tables}
        defs={defs}
        status={status}
        floorsCount={floorsCount}
        onReload={onReload}
        onSetFrequency={onSetFrequency}
      />

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
        {showPreview && <MemoryPreview profileId={profileId} config={{}} />}
      </section>
    </div>
  )
}

/**
 * The History tab (WS6 Phase C) — the per-chat op-log as a FLOOR-GROUPED timeline (the design brief's
 * Linear-activity-feed shape): one group per floor (newest first, `chat-tables-ops-list` order), each
 * op labelled by kind + table + a `source` provenance chip (WS1 column — 维护/手改/回填/重填/基线;
 * legacy NULL renders "—"; baseline is warning-tinted, the structural-migration marker). Rewind lives
 * on the floor GROUP and confirms through the app dialog with its real consequence ("drops N ops
 * across M floors" — `rewindConsequence`), never window.confirm. Rewind semantics unchanged:
 * DATA-ONLY, drops ops at/after the floor and rebuilds the sandbox.
 */
const HistoryTab: React.FC<{
  profileId: string
  chatId: string
  hasTemplate: boolean
  onReload: () => Promise<void> | void
}> = ({ profileId, chatId, hasTemplate, onReload }) => {
  const t = useT()
  const [ops, setOps] = React.useState<HistoryOp[]>([])
  const [busy, setBusy] = React.useState(false)
  const [pendingRewind, setPendingRewind] = React.useState<number | null>(null)

  const loadOps = React.useCallback(async () => {
    if (!hasTemplate) {
      setOps([])
      return
    }
    try {
      setOps(((await api().listChatTableOps(profileId, chatId)) as HistoryOp[]) ?? [])
    } catch {
      setOps([])
    }
  }, [profileId, chatId, hasTemplate])

  React.useEffect(() => {
    void loadOps()
  }, [loadOps])

  const rewind = async (fromFloor: number): Promise<void> => {
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

  const sourceChip = (source: HistoryOp['source']): { cls: string; text: string } =>
    source == null
      ? { cls: '', text: '—' }
      : {
          cls: source === 'baseline' ? 'baseline' : '',
          text: t(`memoryManager.history.source.${source}`)
        }

  if (!hasTemplate) {
    return <p className="rpt-mm-rail-empty">{t('tables.noneAssigned')}</p>
  }

  const groups = groupOpsByFloor(ops)
  const consequence = pendingRewind != null ? rewindConsequence(ops, pendingRewind) : null

  return (
    <div className="rpt-mm-history">
      <div className="rpt-mm-history-bar">
        <p className="rpt-mm-maint-intro">{t('memoryManager.history.intro')}</p>
        <button
          className="rpt-duel-secondary rpt-mm-history-undo"
          disabled={busy || ops.length === 0}
          onClick={() => setPendingRewind(ops[0].floor)}
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
        <div className="rpt-mm-hist-timeline">
          {groups.map((g) => (
            <section key={g.floor} className="rpt-mm-hist-group">
              <header className="rpt-mm-hist-ghead">
                <span className="rpt-mm-hist-floor">
                  {t('memoryManager.history.floor', { n: g.floor })}
                </span>
                <span className="rpt-mm-hist-time">{fmtTime(g.time)}</span>
                <button
                  className="rpt-duel-secondary rpt-mm-hist-rewind"
                  disabled={busy}
                  onClick={() => setPendingRewind(g.floor)}
                >
                  {t('memoryManager.history.rewindTo')}
                </button>
              </header>
              <ul className="rpt-mm-hist-ops">
                {g.ops.map((op) => {
                  const chip = sourceChip(op.source)
                  return (
                    <li key={`${op.floor}-${op.seq}`} className="rpt-mm-hist-op">
                      <span className="rpt-mm-hist-oplabel">
                        {t(`memoryManager.history.kind.${op.kind}`)}
                        {op.table ? ` · ${op.table}` : ''}
                      </span>
                      <span className={`rpt-mm-hist-chip ${chip.cls}`}>{chip.text}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {pendingRewind != null && consequence && (
        <ConfirmDialog
          title={t('memoryManager.history.confirmTitle')}
          body={
            t('memoryManager.history.confirmRewind', { n: pendingRewind }) +
            t('memoryManager.history.consequence', {
              n: consequence.opsDropped,
              m: consequence.floorsAffected
            })
          }
          confirmLabel={t('memoryManager.history.rewindTo')}
          danger
          onConfirm={() => {
            const floor = pendingRewind
            setPendingRewind(null)
            void rewind(floor)
          }}
          onCancel={() => setPendingRewind(null)}
        />
      )}
    </div>
  )
}

/**
 * The Structure tab (WS6 Phase C) — STAGED structural editing (the design brief's VS Code
 * Source-Control shape). Rename/drop/add ops STAGE locally with per-op undo; ONE 「应用迁移」 commits
 * the whole ordered batch through `applyTableStructure` (which validates all-or-nothing, migrates
 * EVERY bound chat, and re-baselines each op-log — after which the affected tables only support a
 * FULL refill, plan §0b-3). The apply confirm states the real fan-out (staged-op count + bound-chat
 * count via `boundChatsForTemplate`) and the re-baseline consequence — staging replaced the old
 * per-op window.confirm entirely. Rows staged for drop render struck-through with actions disabled
 * (`droppedTableUids`/`droppedColumns`); `failedChats` stay surfaced persistently, never toast-only.
 * The `row_id` PK is never listed; add-table stays deferred (row_id/PK convention unverified).
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
  // The staged batch (WS6 Phase C) + the apply confirm's fan-out preview.
  const [staged, setStaged] = React.useState<StructOp[]>([])
  const [confirmApply, setConfirmApply] = React.useState(false)
  const [boundChats, setBoundChats] = React.useState<number | null>(null)

  // Reset the stage when the template changes (uids would dangle), and load the fan-out count.
  React.useEffect(() => {
    setStaged([])
    setFailed([])
    setWarns([])
    if (!templateId) {
      setBoundChats(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const n = await api().boundChatsForTemplate(profileId, templateId)
        if (!cancelled) setBoundChats(typeof n === 'number' ? n : null)
      } catch {
        if (!cancelled) setBoundChats(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, templateId])

  // Real SQL column names for a table (source of truth for column ops), minus the structural row_id PK.
  const columnsOf = (d: TableDef): string[] => {
    const r = reads.find((x) => x.sqlName === d.sqlName)
    return (r?.columns ?? []).filter((c) => c.toLowerCase() !== 'row_id')
  }

  const stage = (op: StructOp): void => {
    if (!canStage(staged, op)) return
    setStaged((s) => [...s, op])
    setEditing(null)
  }

  const applyStaged = async (): Promise<void> => {
    if (!templateId || staged.length === 0) return
    setBusy(true)
    try {
      const res = await api().applyTableStructure(profileId, templateId, staged)
      if (!res || res.ok === false) {
        // Whole-batch rejection: NOTHING applied — keep the stage so the user can fix and retry.
        const raw = res?.error ? String(res.error) : ''
        const detail = raw.startsWith('tables.') ? t(raw) : raw
        useToastStore
          .getState()
          .push(`${t('memoryManager.structure.failed')}${detail ? ': ' + detail : ''}`)
        return
      }
      setStaged([])
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
    stage(op)
  }
  const submitAddCol = (uid: string): void => {
    const name = (addCol[uid] ?? '').trim()
    if (!name) return
    stage({ kind: 'addColumn', uid, name })
    setAddCol((m) => ({ ...m, [uid]: '' }))
  }

  const displayNameOf = (uid: string): string =>
    defs.find((d) => d.uid === uid)?.displayName ?? uid
  const droppedTables = droppedTableUids(staged)

  if (!templateId) {
    return <p className="rpt-mm-rail-empty">{t('tables.noneAssigned')}</p>
  }

  return (
    <div className="rpt-mm-struct">
      <div className="rpt-mm-struct-warn" role="note">
        {t('memoryManager.structure.warn')}
      </div>

      {/* The staged batch (VS Code SCM shape): pending ops with per-op undo + ONE apply. */}
      {staged.length > 0 && (
        <section className="rpt-mm-struct-staged">
          <header className="rpt-mm-struct-staged-head">
            <strong>{t('memoryManager.structure.stagedTitle', { n: staged.length })}</strong>
            <span className="rpt-mm-struct-staged-actions">
              <button className="btn-ghost" disabled={busy} onClick={() => setStaged([])}>
                {t('memoryManager.structure.undoAll')}
              </button>
              <button
                className="rpt-mm-maint-run"
                disabled={busy}
                onClick={() => setConfirmApply(true)}
              >
                {t('memoryManager.structure.apply')}
              </button>
            </span>
          </header>
          <ul className="rpt-mm-struct-staged-list">
            {staged.map((op, i) => {
              const d = describeStagedOp(op, displayNameOf(op.uid))
              return (
                <li key={i} className="rpt-mm-struct-staged-item">
                  <span className="rpt-mm-struct-staged-label">{t(d.key, d.params)}</span>
                  <button
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
                  >
                    {t('memoryManager.structure.undoOp')}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

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
                    <span
                      className={`rpt-mm-struct-tname${droppedTables.has(d.uid) ? ' staged-drop' : ''}`}
                    >
                      {d.displayName}
                    </span>
                    <span className="rpt-mm-struct-tsql">{d.sqlName}</span>
                    <span className="rpt-mm-struct-tactions">
                      <button
                        className="rpt-duel-secondary"
                        disabled={busy || droppedTables.has(d.uid)}
                        onClick={() => startEdit(d.uid, undefined, d.displayName)}
                      >
                        {t('memoryManager.structure.renameTable')}
                      </button>
                      <button
                        className="rpt-duel-secondary rpt-mm-danger"
                        disabled={busy || droppedTables.has(d.uid)}
                        onClick={() => stage({ kind: 'dropTable', uid: d.uid })}
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
                            <span
                              className={`rpt-mm-struct-cname${
                                droppedTables.has(d.uid) || droppedColumns(staged, d.uid).has(c)
                                  ? ' staged-drop'
                                  : ''
                              }`}
                            >
                              {c}
                            </span>
                            <span className="rpt-mm-struct-cactions">
                              <button
                                className="rpt-duel-secondary"
                                disabled={
                                  busy ||
                                  droppedTables.has(d.uid) ||
                                  droppedColumns(staged, d.uid).has(c)
                                }
                                onClick={() => startEdit(d.uid, c, c)}
                              >
                                {t('memoryManager.structure.renameColumn')}
                              </button>
                              <button
                                className="rpt-duel-secondary rpt-mm-danger"
                                disabled={
                                  busy ||
                                  droppedTables.has(d.uid) ||
                                  droppedColumns(staged, d.uid).has(c)
                                }
                                onClick={() => stage({ kind: 'dropColumn', uid: d.uid, name: c })}
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
                  disabled={busy || droppedTables.has(d.uid)}
                  onChange={(e) => setAddCol((m) => ({ ...m, [d.uid]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitAddCol(d.uid)
                  }}
                />
                <button
                  className="rpt-duel-secondary"
                  disabled={busy || droppedTables.has(d.uid) || !(addCol[d.uid] ?? '').trim()}
                  onClick={() => submitAddCol(d.uid)}
                >
                  {t('memoryManager.structure.addColumn')}
                </button>
              </div>
            </section>
          )
        })
      )}

      {/* The ONE confirm of the tab (staging replaced the per-op confirms): the real fan-out +
          the re-baseline consequence — partial refill is disabled for the affected tables. */}
      {confirmApply && (
        <ConfirmDialog
          title={t('memoryManager.structure.applyTitle')}
          body={t('memoryManager.structure.applyBody', {
            ops: staged.length,
            chats: boundChats ?? '?'
          })}
          confirmLabel={t('memoryManager.structure.apply')}
          danger
          onConfirm={() => {
            setConfirmApply(false)
            void applyStaged()
          }}
          onCancel={() => setConfirmApply(false)}
        />
      )}
    </div>
  )
}
