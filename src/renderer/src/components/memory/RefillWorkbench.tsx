// The Refill workbench (table-refill WS6 Phase A) — the Maintenance tab's core, replacing the two
// competing manual-fill mechanisms (the retired run-now pass + BackfillPanel) with ONE surface built
// around the chunk-committed refill engine (tableRefillService, WS2).
//
// Shape per the confirmed design brief (.scratch/rpt-table-memory-replica/ws6-design-brief-2026-07-13.md):
// a single vertical column — resume banner (conditional) → workbench section (table picker with the
// sheet-rail's badge vocabulary · range row with a LIVE consequence line · collapsed Advanced ·
// Run button behind a themed ConfirmDialog) → run rail (a merge-box-style card whose segmented
// per-batch progress bar IS the state machine; terminal states, Resume, and the baseline-gate explain
// all render inside it — never a bare toast). All derivations live in refillModel.ts (pure, tested);
// the progress events (`kind:'refill'`) drive everything — no polling, no remount nonces.
import React from 'react'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { ConfirmDialog } from '../ConfirmDialog'
import type { TableRead } from '../workspace/TableGrid'
import type { TableStatusLike } from '../workspace/tableGridModel'
import {
  computeRange,
  countEditOpsInRange,
  idleRail,
  applyRailEvent,
  railFromSnapshot,
  segmentDisplay,
  okFraction,
  RailState,
  RailEvent,
  RefillRange
} from './refillModel'

const api = (): any => (window as unknown as { api: any }).api

interface ApiPresetSummary {
  id: string
  name: string
}

/** The persisted resume row (`getTableRefillState().persisted`). */
interface PersistedRefill {
  selected: string[]
  fromFloor: number
  completedUntil: number
  status: string
}

export const RefillWorkbench: React.FC<{
  profileId: string
  chatId: string
  tables: TableRead[]
  status: Record<string, TableStatusLike>
  /** The chat's floor COUNT (latest floor index = count - 1). */
  floorsCount: number
  onReload: () => Promise<void> | void
}> = ({ profileId, chatId, tables, status, floorsCount, onReload }) => {
  const t = useT()
  const latest = floorsCount - 1

  // ── picker + range state ─────────────────────────────────────────────────────────────────────
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(tables.map((tb) => tb.sqlName)))
  const [fullRefill, setFullRefill] = React.useState(false)
  const [fromOverride, setFromOverride] = React.useState<number | null>(null)
  // ── advanced ─────────────────────────────────────────────────────────────────────────────────
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [extraHint, setExtraHint] = React.useState('')
  const [presetId, setPresetId] = React.useState('')
  const [retries, setRetries] = React.useState(0)
  const [batchSize, setBatchSize] = React.useState(3)
  const [apiPresets, setApiPresets] = React.useState<ApiPresetSummary[]>([])
  // ── run rail + flow state ────────────────────────────────────────────────────────────────────
  const [rail, setRail] = React.useState<RailState>(idleRail)
  const [starting, setStarting] = React.useState(false)
  const [persisted, setPersisted] = React.useState<PersistedRefill | null>(null)
  // The rail slot's inline notice: the baseline gate (with its full-refill escape) or a start error.
  const [notice, setNotice] = React.useState<{ kind: 'baseline' | 'error'; text: string } | null>(null)
  const [confirm, setConfirm] = React.useState<{ range: RefillRange; editCount: number } | null>(null)

  const running = starting || rail.phase === 'running'

  // Keep the selection valid across template/table changes: prune stale names; a selection that
  // empties out (or a fresh mount) defaults to select-all — the brief's default.
  React.useEffect(() => {
    setSelected((prev) => {
      const names = tables.map((tb) => tb.sqlName)
      const kept = names.filter((n) => prev.has(n))
      return new Set(kept.length ? kept : names)
    })
  }, [tables])

  // API presets for the Advanced row (same source BackfillPanel used).
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const settings = await api().getSettings(profileId)
        if (cancelled) return
        const presets = (settings?.api_presets ?? []) as ApiPresetSummary[]
        setApiPresets(presets.map((p) => ({ id: p.id, name: p.name })))
      } catch {
        if (!cancelled) setApiPresets([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profileId])

  const refreshPersisted = React.useCallback(async (): Promise<void> => {
    try {
      const state = await api().getTableRefillState(profileId, chatId)
      setPersisted((state?.persisted as PersistedRefill | null) ?? null)
      if (state?.run?.running) setRail(railFromSnapshot(state.run))
    } catch {
      setPersisted(null)
    }
  }, [profileId, chatId])

  // Mount: pick up an in-flight run (re-mount mid-run) and any interrupted-refill resume row.
  React.useEffect(() => {
    void refreshPersisted()
  }, [refreshPersisted])

  // The one event subscription that drives the rail (kind:'refill' only).
  React.useEffect(() => {
    const off = api().onTableBackfillProgress((p: RailEvent & { chatId: string; kind?: string }) => {
      if (p.chatId !== chatId || p.kind !== 'refill') return
      setStarting(false)
      setRail((r) => applyRailEvent(r, p))
      if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
        void onReload()
        void refreshPersisted()
      }
    })
    return off
  }, [chatId, onReload, refreshPersisted])

  const range = computeRange(status, [...selected], latest, {
    fullRefill,
    fromOverride,
    batchSize
  })

  const localizeError = (raw: string): string =>
    raw.startsWith('tables.') ? t(raw) : t('memoryManager.maintenance.errorFailed', { message: raw })

  // ── run flow: click → edit-loss check → ConfirmDialog → start ───────────────────────────────
  const onRunClick = async (): Promise<void> => {
    if (!range) return
    let editCount = 0
    try {
      const ops = (await api().listChatTableOps(profileId, chatId)) ?? []
      editCount = countEditOpsInRange(ops, selected, range.from)
    } catch {
      // Op-log read failed — proceed without the edit-loss count (the confirm still states the range).
    }
    setConfirm({ range, editCount })
  }

  const start = async (opts: { fromFloor: number; resume?: boolean }): Promise<void> => {
    setNotice(null)
    setStarting(true)
    setRail(idleRail())
    try {
      const call = opts.resume
        ? api().resumeTableRefill(profileId, chatId, {
            apiPresetId: presetId || null,
            retries,
            batchSize,
            extraHint: extraHint.trim() || undefined
          })
        : api().startTableRefill(profileId, chatId, {
            tables: [...selected],
            fromFloor: opts.fromFloor,
            extraHint: extraHint.trim() || undefined,
            apiPresetId: presetId || null,
            retries,
            batchSize
          })
      const res = await call
      if (res && 'error' in res && res.error) {
        setStarting(false)
        if (res.error === 'tables.refillNeedsFull') {
          setNotice({ kind: 'baseline', text: t(res.error) })
        } else {
          const msg = localizeError(res.error)
          setNotice({ kind: 'error', text: msg })
          useToastStore.getState().push(msg)
        }
      }
      // On { ok } the progress events drive the rail from here.
    } catch (err) {
      setStarting(false)
      const msg = localizeError(err instanceof Error ? err.message : String(err))
      setNotice({ kind: 'error', text: msg })
      useToastStore.getState().push(msg)
    }
  }

  const onDiscard = async (): Promise<void> => {
    try {
      const res = await api().discardTableRefill(profileId, chatId)
      if (res && 'error' in res && res.error) useToastStore.getState().push(localizeError(res.error))
    } catch {
      /* best-effort */
    }
    setRail(idleRail())
    await refreshPersisted()
  }

  // ── derived display ──────────────────────────────────────────────────────────────────────────
  const allSelected = selected.size === tables.length && tables.length > 0
  const consequence =
    !range || floorsCount === 0
      ? t('memoryManager.refill.noSelection')
      : range.firstFill
        ? t('memoryManager.refill.consequenceFirst', { n: range.floors })
        : t('memoryManager.refill.consequence', {
            from: range.from,
            to: range.to,
            n: range.floors,
            m: range.batches
          })
  // Only on a FRESH open (rail idle): after a cancelled/failed run the rail footer already carries
  // Resume + Discard — showing the banner too would offer the same actions twice.
  const showBanner = persisted?.status === 'in_progress' && rail.phase === 'idle' && !starting
  const showRail = rail.phase !== 'idle' || starting || notice !== null
  const okCount = rail.segs.filter((s) => s === 'ok').length

  const badge = (name: string): { cls: string; text: string } => {
    const st = status[name]
    return !st || st.lastFloor == null
      ? { cls: 'never', text: t('memoryManager.badgeNever') }
      : st.unprocessed > 0
        ? { cls: 'pending', text: t('memoryManager.badgePending', { n: st.unprocessed }) }
        : { cls: 'ok', text: t('memoryManager.badgeOk') }
  }

  const statusChip = (): { cls: string; text: string } | null => {
    switch (rail.phase) {
      case 'running':
        return { cls: 'running', text: t('memoryManager.refill.statusRunning') }
      case 'done':
        return { cls: 'done', text: t('memoryManager.refill.statusDone') }
      case 'cancelled':
        return { cls: 'cancelled', text: t('memoryManager.refill.statusCancelled') }
      case 'error':
        return { cls: 'error', text: t('memoryManager.refill.statusError') }
      default:
        return starting ? { cls: 'running', text: t('memoryManager.refill.statusRunning') } : null
    }
  }
  const chip = statusChip()

  return (
    <div className="rpt-mm-refill">
      {/* Resume banner — an interrupted refill found at open (crash / cancel / failed batch). */}
      {showBanner && persisted && (
        <div className="rpt-mm-refill-banner" role="status">
          <span className="rpt-mm-refill-banner-text">
            {persisted.completedUntil >= 0
              ? t('memoryManager.refill.resumeBanner', { n: persisted.completedUntil })
              : t('memoryManager.refill.resumeBannerFresh')}
          </span>
          <span className="rpt-mm-refill-banner-actions">
            <button
              className="rpt-mm-maint-run"
              disabled={running}
              onClick={() => void start({ fromFloor: 0, resume: true })}
            >
              {t('memoryManager.refill.resume')}
            </button>
            <button
              className="btn-ghost"
              disabled={running}
              title={t('memoryManager.refill.discardTip')}
              onClick={() => void onDiscard()}
            >
              {t('memoryManager.refill.discard')}
            </button>
          </span>
        </div>
      )}

      {/* The workbench. */}
      <section className="rpt-mm-maint-section rpt-mm-refill-bench">
        <h3 className="rpt-mm-maint-title">{t('memoryManager.maintenance.refillTitle')}</h3>
        <p className="rpt-mm-maint-intro">{t('memoryManager.maintenance.refillIntro')}</p>

        {/* Table picker — the sheet rail's badge vocabulary, checkbox rows, select-all header. */}
        <div className="rpt-mm-refill-picker" role="group" aria-label={t('memoryManager.refill.tablesTitle')}>
          <label className="rpt-mm-refill-pickall">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={running || tables.length === 0}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set(tables.map((tb) => tb.sqlName)) : new Set())
              }
            />
            <span>{t('memoryManager.refill.tablesAll')}</span>
          </label>
          {tables.map((tb) => {
            const b = badge(tb.sqlName)
            return (
              <label key={tb.sqlName} className="rpt-mm-refill-pickrow">
                <input
                  type="checkbox"
                  checked={selected.has(tb.sqlName)}
                  disabled={running}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(tb.sqlName)
                      else next.delete(tb.sqlName)
                      return next
                    })
                  }
                />
                <span className="rpt-mm-refill-pickname">{tb.displayName}</span>
                <span className="rpt-mm-refill-pickcount">
                  {t('memoryManager.sheetCount', { rows: tb.rows.length, cols: tb.columns.length })}
                </span>
                <span className={`rpt-mm-badge ${b.cls}`}>{b.text}</span>
              </label>
            )
          })}
        </div>

        {/* Range row + the live consequence line (the honesty mechanism). */}
        <div className="rpt-mm-maint-row">
          <label className="rpt-mm-maint-label" htmlFor="mm-refill-from">
            {t('memoryManager.refill.fromLabel')}
          </label>
          <input
            id="mm-refill-from"
            className="rpt-mm-maint-num"
            type="number"
            min={0}
            max={Math.max(0, latest)}
            value={fullRefill ? 0 : (fromOverride ?? range?.from ?? 0)}
            disabled={running || fullRefill || floorsCount === 0}
            onChange={(e) => {
              const v = Number(e.target.value)
              setFromOverride(Number.isFinite(v) ? Math.max(0, Math.min(v, Math.max(0, latest))) : null)
            }}
          />
          <label className="rpt-mm-maint-label rpt-mm-refill-fulltoggle">
            <input
              type="checkbox"
              checked={fullRefill}
              disabled={running}
              onChange={(e) => setFullRefill(e.target.checked)}
            />
            {t('memoryManager.maintenance.fullRefill')}
          </label>
        </div>
        <p className="rpt-mm-refill-consequence" aria-live="polite">
          {consequence}
        </p>

        {/* Advanced — collapsed by default; chunk internals stay hidden. */}
        <div className="rpt-mm-refill-advanced">
          <button
            type="button"
            className="rpt-mm-refill-advtoggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((s) => !s)}
          >
            {advancedOpen ? '▾' : '▸'} {t('memoryManager.refill.advanced')}
          </button>
          {advancedOpen && (
            <div className="rpt-mm-refill-advbody">
              <label className="rpt-mm-maint-label" htmlFor="mm-refill-hint">
                {t('memoryManager.maintenance.extraHint')}
              </label>
              <textarea
                id="mm-refill-hint"
                className="rpt-mm-maint-textarea"
                value={extraHint}
                disabled={running}
                placeholder={t('memoryManager.maintenance.extraHintPlaceholder')}
                onChange={(e) => setExtraHint(e.target.value)}
              />
              <div className="rpt-mm-maint-row">
                <label className="rpt-mm-maint-label" htmlFor="mm-refill-preset">
                  {t('tables.backfillPreset')}
                </label>
                <select
                  id="mm-refill-preset"
                  className="rpt-mm-select rpt-mm-refill-preset"
                  value={presetId}
                  disabled={running}
                  onChange={(e) => setPresetId(e.target.value)}
                >
                  <option value="">{t('tables.backfillPresetActive')}</option>
                  {apiPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <label className="rpt-mm-maint-label" htmlFor="mm-refill-retries">
                  {t('tables.backfillRetries')}
                </label>
                <input
                  id="mm-refill-retries"
                  className="rpt-mm-maint-num"
                  type="number"
                  min={0}
                  max={5}
                  value={retries}
                  disabled={running}
                  onChange={(e) => setRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
                />
                <label className="rpt-mm-maint-label" htmlFor="mm-refill-batch">
                  {t('tables.backfillBatchSize')}
                </label>
                <input
                  id="mm-refill-batch"
                  className="rpt-mm-maint-num"
                  type="number"
                  min={1}
                  value={batchSize}
                  disabled={running}
                  onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </div>
          )}
        </div>

        <div className="rpt-mm-refill-benchfoot">
          <button
            className="rpt-mm-maint-run"
            disabled={running || !range || floorsCount === 0}
            onClick={() => void onRunClick()}
          >
            {running
              ? t('memoryManager.maintenance.refillRunning')
              : t('memoryManager.maintenance.refillRun')}
          </button>
        </div>
      </section>

      {/* The run rail — hidden when idle; the merge-box card that IS the state machine. */}
      {showRail && (
        <section className="rpt-mm-refill-rail" aria-live="polite">
          <div className="rpt-mm-refill-railhead">
            <h3 className="rpt-mm-maint-title">{t('memoryManager.refill.railTitle')}</h3>
            {chip && (
              <span className="rpt-mm-refill-chip">
                <span className={`rpt-mm-refill-dot ${chip.cls}`} aria-hidden />
                {chip.text}
              </span>
            )}
          </div>

          {/* Baseline gate / start error render INSIDE the rail — never a bare toast. */}
          {notice && (
            <div
              className={`rpt-mm-refill-notice${notice.kind === 'baseline' ? ' baseline' : ''}`}
              role="alert"
            >
              <span>{notice.text}</span>
              {notice.kind === 'baseline' && (
                <button
                  className="rpt-duel-secondary"
                  onClick={() => {
                    setFullRefill(true)
                    setNotice(null)
                  }}
                >
                  {t('memoryManager.refill.baselineSwitch')}
                </button>
              )}
            </div>
          )}

          {rail.segs.length > 0 && (
            <>
              <div
                className="rpt-mm-refill-track"
                role="progressbar"
                aria-label={t('memoryManager.refill.progressAria')}
                aria-valuemin={0}
                aria-valuemax={rail.segs.length}
                aria-valuenow={okCount}
              >
                {segmentDisplay(rail.segs.length) === 'segments' ? (
                  rail.segs.map((s, i) => <span key={i} className={`rpt-mm-refill-seg ${s}`} />)
                ) : (
                  <span className="rpt-mm-refill-bar">
                    <span
                      className="rpt-mm-refill-barfill"
                      style={{ width: `${Math.round(okFraction(rail.segs) * 100)}%` }}
                    />
                  </span>
                )}
              </div>
              <p className="rpt-mm-refill-meta">
                {t('memoryManager.refill.batchOf', { i: okCount, n: rail.segs.length })}
                {rail.completedUntil >= 0 && (
                  <> · {t('memoryManager.refill.completedUntil', { n: rail.completedUntil })}</>
                )}
              </p>
            </>
          )}

          {rail.failures.length > 0 && (
            <ul className="rpt-mm-refill-failures">
              {rail.failures.map((f, i) => (
                <li key={i}>
                  {t('memoryManager.refill.failedSpan', { from: f.from, to: f.to, reason: f.reason })}
                </li>
              ))}
            </ul>
          )}

          {rail.phase === 'done' && (
            <p className="rpt-mm-refill-terminal">
              <span className="rpt-mm-refill-dot done" aria-hidden />
              {t('memoryManager.maintenance.refillDone')}
            </p>
          )}
          {rail.phase === 'cancelled' && (
            <p className="rpt-mm-refill-terminal">
              <span className="rpt-mm-refill-dot cancelled" aria-hidden />
              {t('memoryManager.maintenance.refillCancelled')}
            </p>
          )}
          {rail.phase === 'error' && rail.message && (
            <p className="rpt-mm-refill-terminal">
              <span className="rpt-mm-refill-dot error" aria-hidden />
              {localizeError(rail.message)}
            </p>
          )}

          {(rail.phase === 'running' || rail.phase === 'cancelled' || rail.phase === 'error') && (
            <div className="rpt-mm-refill-railfoot">
              {rail.phase === 'running' && (
                <button
                  className="rpt-duel-secondary"
                  onClick={() => void api().cancelTableRefill(profileId, chatId)}
                >
                  {t('memoryManager.refill.cancelRun')}
                </button>
              )}
              {(rail.phase === 'cancelled' || rail.phase === 'error') && persisted && (
                <>
                  <button
                    className="rpt-mm-maint-run"
                    onClick={() => void start({ fromFloor: 0, resume: true })}
                  >
                    {t('memoryManager.refill.resume')}
                  </button>
                  <button
                    className="btn-ghost"
                    title={t('memoryManager.refill.discardTip')}
                    onClick={() => void onDiscard()}
                  >
                    {t('memoryManager.refill.discard')}
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* Destructive confirm — the app's own dialog, stating exactly what will be regenerated. */}
      {confirm && (
        <ConfirmDialog
          title={t('memoryManager.refill.confirmTitle')}
          body={
            (confirm.range.firstFill
              ? t('memoryManager.refill.consequenceFirst', { n: confirm.range.floors })
              : t('memoryManager.refill.consequence', {
                  from: confirm.range.from,
                  to: confirm.range.to,
                  n: confirm.range.floors,
                  m: confirm.range.batches
                })) +
            t('memoryManager.refill.confirmBody', { k: selected.size }) +
            (confirm.editCount > 0
              ? t('memoryManager.refill.editWarning', { n: confirm.editCount })
              : '')
          }
          confirmLabel={t('memoryManager.maintenance.refillRun')}
          danger
          onConfirm={() => {
            const from = confirm.range.from
            setConfirm(null)
            void start({ fromFloor: from })
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
