// The control-center Memory pane (agent-packs plan WP3.8 — the de-scatter step). The owner directive:
// "settings related with workflow/agents/memory are a bit scattered." WP3.7 centralized workflow +
// pack settings; this pane centralizes MEMORY. It is the single home for memory CONFIGURATION +
// MAINTENANCE, so the Tables workspace view can stay the lean DATA surface (grid browsing/editing).
//
// What moved here from TablesView (RE-HOSTED — same logic, same IPC, relocated + re-laid-out):
//   · Template & binding — the assigned-template <select> + Import / Export / Export-with-data /
//     Delete-template controls (setChatTableTemplate / listTableTemplates / importTableTemplateDialog
//     / exportTableTemplateDialog / deleteTableTemplate).
//   · Maintenance & progress — the per-table processed/next/unprocessed line (readChatTablesStatus)
//     and the full manual BackfillPanel (startTableBackfill / cancel / getState / onProgress).
// Added here (no new IPC): a memory-packs shortcut strip (the installed writes-tables packs + their
// gate state, with a jump to the Installed detail) and a link to the Tables data view for browsing.
//
// Grounding: TablesView.tsx (the source of the moved controls, pre-WP3.8), the pure pane derivations
// in ./memoryPaneModel.ts, the writes-tables capability (shared/workflow/capabilities.ts), and the Overview
// pane's memory-template state read (getChatTableTemplate). No main-process changes.

import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useT } from '../../i18n'
import {
  memoryPaneMode,
  memoryPackRows,
  maintenanceSummary,
  type MemoryPackInput,
  type MemoryPackRow,
  type TableStatusLike
} from './memoryPaneModel'

const api = (): any => (window as unknown as { api: any }).api

interface TemplateSummary {
  id: string
  name: string
  tableCount: number
}
interface TableMeta {
  sqlName: string
  displayName: string
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

/** The memory-pack projection the pane consumes (a slice of AgentsView's PackSummary + the gate map).
 *  AgentsView passes these so the strip reuses the SAME data the Installed list already loaded. */
export interface MemoryPaneProps {
  profileId: string
  /** Installed packs (projected) + the resolved gate map, from AgentsView. Null while loading. */
  packs: MemoryPackInput[] | null
  gates: Record<string, boolean>
  /** Jump to the Installed detail for a pack (AgentsView switches rail + opens the detail panel). */
  onOpenPackDetail: (packId: string) => void
}

export const MemoryPane: React.FC<MemoryPaneProps> = ({
  profileId,
  packs,
  gates,
  onOpenPackDetail
}) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const ensureLeftPanel = useWorkspaceStore((s) => s.ensureLeftPanel)

  const [templates, setTemplates] = React.useState<TemplateSummary[]>([])
  const [assignedId, setAssignedId] = React.useState<string | null>(null)
  const [tableMeta, setTableMeta] = React.useState<TableMeta[]>([])
  const [status, setStatus] = React.useState<Record<string, TableStatusLike>>({})
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
      setTableMeta([])
      setStatus({})
      return
    }
    try {
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssignedId(id)
      if (!id) {
        setTableMeta([])
        setStatus({})
        return
      }
      // Only the table names are needed here (the grid lives in the Tables view now); readChatTables
      // still carries them as the lightest way to list the assigned template's tables.
      const tables = (await api().readChatTables(profileId, activeChatId)) ?? []
      setTableMeta(
        (tables as { sqlName: string; displayName: string }[]).map((tb) => ({
          sqlName: tb.sqlName,
          displayName: tb.displayName
        }))
      )
      setStatus((await api().readChatTablesStatus(profileId, activeChatId)) ?? {})
    } catch {
      setAssignedId(null)
      setTableMeta([])
      setStatus({})
    }
  }, [profileId, activeChatId])

  React.useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  React.useEffect(() => {
    void loadChat()
  }, [loadChat, floors.length])

  const mode = memoryPaneMode({ hasChat: !!activeChatId, hasTemplate: !!assignedId })
  const packRows: MemoryPackRow[] = React.useMemo(
    () => memoryPackRows(packs ?? [], gates),
    [packs, gates]
  )
  const summary = React.useMemo(() => maintenanceSummary(status), [status])

  // ── Template binding actions (relocated verbatim from TablesView) ─────────────────────────────────
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
    if (!assignedId || !activeChatId) return
    try {
      await api().exportTableTemplateDialog(profileId, assignedId, withData ? activeChatId : null)
    } catch {
      useToastStore.getState().push(t('tables.exportFailed'))
    }
  }

  // ── No-chat state — nothing to configure yet (invitational, matches the other panes). ─────────────
  if (mode === 'no-chat') {
    return (
      <div className="rpt-agents-empty">
        <div className="rpt-agents-placeholder-icon" aria-hidden>
          🗃
        </div>
        <h2 className="rpt-agents-placeholder-title">{t('memory.noChatTitle')}</h2>
        <p className="rpt-agents-placeholder-body">{t('memory.noChatBody')}</p>
      </div>
    )
  }

  return (
    <div className="rpt-overview">
      <header className="rpt-overview-header">
        <h2 className="rpt-overview-heading">{t('memory.heading')}</h2>
        <p className="rpt-overview-subtitle">{t('memory.subtitle')}</p>
      </header>

      {/* (1) Template & binding — the single source for assigning/importing/exporting the template. */}
      <section className="rpt-overview-section" aria-labelledby="mem-template">
        <h3 id="mem-template" className="rpt-overview-sectiontitle">
          {t('memory.templateTitle')}
        </h3>
        <div className="rpt-memory-bindingrow">
          <label className="rpt-memory-bindinglabel" htmlFor="mem-template-select">
            {t('tables.template')}
          </label>
          <select
            id="mem-template-select"
            className="rpt-memory-select"
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
          <button className="rpt-duel-secondary rpt-memory-btn" onClick={() => void onImport()}>
            {t('tables.import')}
          </button>
          <button
            className="rpt-duel-secondary rpt-memory-btn"
            disabled={!assignedId}
            onClick={() => void onExport(false)}
          >
            {t('tables.export')}
          </button>
          <button
            className="rpt-duel-secondary rpt-memory-btn"
            disabled={!assignedId}
            onClick={() => void onExport(true)}
          >
            {t('tables.exportWithData')}
          </button>
          <button
            className="rpt-duel-secondary rpt-memory-btn"
            disabled={!assignedId}
            onClick={() => void onDeleteTemplate()}
          >
            {t('tables.deleteTemplate')}
          </button>
        </div>
        {mode === 'no-template' && (
          <p className="rpt-overview-empty">{t('memory.noTemplateHint')}</p>
        )}
      </section>

      {/* (2) Maintenance & progress + backfill — only meaningful with a template assigned. */}
      {mode === 'configured' && activeChatId && (
        <section className="rpt-overview-section" aria-labelledby="mem-maint">
          <h3 id="mem-maint" className="rpt-overview-sectiontitle">
            {t('memory.maintenanceTitle')}
          </h3>
          {tableMeta.length === 0 ? (
            <p className="rpt-overview-empty">{t('tables.emptyTemplate')}</p>
          ) : (
            <>
              <p className="rpt-overview-empty">
                {summary.hasBacklog
                  ? t('memory.backlogSummary', {
                      n: summary.maxUnprocessed,
                      m: summary.tableCount
                    })
                  : t('memory.caughtUp', { m: summary.tableCount })}
              </p>
              <ul className="rpt-memory-tablelist">
                {tableMeta.map((tb) => {
                  const st = status[tb.sqlName] ?? null
                  return (
                    <li key={tb.sqlName} className="rpt-memory-tablerow">
                      <span className="rpt-memory-tablename">{tb.displayName}</span>
                      <span className="rpt-memory-tableprogress">
                        {st == null || st.lastFloor == null
                          ? t('tables.progressNever')
                          : `${t('tables.progressProcessed', { n: st.processed })} · ${t(
                              'tables.progressNext',
                              { n: st.nextExpected }
                            )} · ${t('tables.progressUnprocessed', { n: st.unprocessed })}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          <BackfillPanel
            profileId={profileId}
            chatId={activeChatId}
            apiPresets={apiPresets}
            onProgress={() => void loadChat()}
          />
        </section>
      )}

      {/* (3) Memory packs shortcut strip — the installed writes-tables packs + gate state (reuses the
          Agents gate map; jumps to the Installed detail). No new IPC. */}
      <section className="rpt-overview-section" aria-labelledby="mem-packs">
        <h3 id="mem-packs" className="rpt-overview-sectiontitle">
          {t('memory.packsTitle')}
        </h3>
        {packs === null ? (
          <p className="rpt-overview-empty">{t('memory.packsLoading')}</p>
        ) : packRows.length === 0 ? (
          <p className="rpt-overview-empty">{t('memory.packsEmpty')}</p>
        ) : (
          <ul className="rpt-overview-active">
            {packRows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="rpt-overview-activerow"
                  onClick={() => onOpenPackDetail(row.id)}
                >
                  <span className={`rpt-agents-dot ${row.enabled ? 'ok' : 'never'}`} aria-hidden />
                  <span className="rpt-overview-activename">{row.name}</span>
                  <span className="rpt-overview-activeoutcome">
                    {row.enabled ? t('memory.packOn') : t('memory.packOff')}
                  </span>
                  <span className="rpt-overview-activehealth">{t('agents.settings.open')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* (4) Browse the data — the link to the lean Tables workspace view. */}
      <section className="rpt-overview-section" aria-labelledby="mem-data">
        <h3 id="mem-data" className="rpt-overview-sectiontitle">
          {t('memory.dataTitle')}
        </h3>
        <div className="rpt-overview-links">
          <button
            type="button"
            className="rpt-overview-link"
            onClick={() => ensureLeftPanel('tables')}
          >
            {t('memory.browseData')}
          </button>
        </div>
      </section>
    </div>
  )
}

/**
 * Manual backfill panel — RE-HOSTED verbatim from TablesView (issue 07). Collapsed by default. Runs a
 * backfill over a chosen scope (last X floors or all), in batches of Y floors, optionally against a
 * saved API preset, with an optional auto-retry count. Progress streams via onTableBackfillProgress
 * (filtered by chatId); the parent refetches its progress on every event. State is re-read on mount so
 * a re-mount mid-run resumes showing progress.
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
    <div className="rpt-memory-backfill">
      <button className="rpt-duel-secondary rpt-memory-btn" onClick={() => setOpen((o) => !o)}>
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
              className="rpt-duel-secondary rpt-memory-btn"
              disabled={running}
              onClick={() => void onStart()}
            >
              {t('tables.backfillStart')}
            </button>
            <button
              className="rpt-duel-secondary rpt-memory-btn"
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
                    ? (progress.message ?? t('tables.backfillStartFailed'))
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
