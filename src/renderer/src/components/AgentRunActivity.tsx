import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRunSummary } from '../../../shared/agentRuntime'
import { useT } from '../i18n'
import {
  agentRunIndicatorState,
  latestRunPerAgent,
  recentAgentRuns,
  useAgentRunStore
} from '../stores/agentRunStore'

type Translate = (key: string, vars?: Record<string, string | number>) => string

interface AgentRunActivityListViewProps {
  runs: AgentRunSummary[]
  loading: boolean
  loadError: boolean
  cancelError: boolean
  stoppingIds: ReadonlySet<string>
  onStop: (run: AgentRunSummary) => void
  t: Translate
}

const number = (value: number): string => new Intl.NumberFormat().format(value)
const latency = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s` : `${value}ms`

export function AgentRunActivityListView({
  runs,
  loading,
  loadError,
  cancelError,
  stoppingIds,
  onStop,
  t
}: AgentRunActivityListViewProps): React.ReactElement {
  return (
    <section className="agent-run-activity" aria-labelledby="agent-run-activity-title">
      <div className="agent-run-activity__heading">
        <h2 id="agent-run-activity-title">{t('agentRuns.activity.heading')}</h2>
        {runs.length > 0 ? (
          <span>{t('agentRuns.activity.recentCount', { count: runs.length })}</span>
        ) : null}
      </div>

      {loading && runs.length === 0 ? (
        <p className="agent-run-activity__empty" role="status">
          {t('agentRuns.activity.loading')}
        </p>
      ) : loadError && runs.length === 0 ? (
        <p className="agent-run-activity__empty" role="alert">
          {t('agentRuns.activity.loadFailed')}
        </p>
      ) : runs.length === 0 ? (
        <p className="agent-run-activity__empty">{t('agentRuns.activity.empty')}</p>
      ) : (
        <ol className="agent-run-list" aria-live="polite">
          {runs.map((run) => {
            const stopping = stoppingIds.has(run.invocationId)
            return (
              <li className={`agent-run-row agent-run-row--${run.status}`} key={run.invocationId}>
                <div className="agent-run-row__identity">
                  <strong>{run.agentName}</strong>
                  <span>{t('agentRuns.activity.floor', { floor: run.floor })}</span>
                </div>
                <div className="agent-run-row__details">
                  <span className="agent-run-status">
                    <span className="agent-run-status__dot" aria-hidden="true" />
                    {t(`agentRuns.status.${run.status}`)}
                  </span>
                  <span title={t('agentRuns.activity.model')}>
                    {t('agentRuns.activity.modelValue', {
                      model: run.model ?? t('agentRuns.activity.notAvailable')
                    })}
                  </span>
                  <span title={t('agentRuns.activity.tokens')}>
                    {t('agentRuns.activity.tokenValue', {
                      input: number(run.metrics.inputTokens),
                      output: number(run.metrics.outputTokens)
                    })}
                  </span>
                  <span title={t('agentRuns.activity.cache')}>
                    {t('agentRuns.activity.cacheValue', {
                      read: number(run.metrics.cacheReadTokens),
                      write: number(run.metrics.cacheWriteTokens)
                    })}
                  </span>
                  <span title={t('agentRuns.activity.latency')}>
                    {t('agentRuns.activity.latencyValue', {
                      latency: latency(run.metrics.latencyMs)
                    })}
                  </span>
                </div>
                {run.status === 'running' ? (
                  <button
                    type="button"
                    className="agent-run-stop"
                    disabled={stopping}
                    aria-label={t('agentRuns.activity.stopLabel', {
                      agent: run.agentName,
                      floor: run.floor
                    })}
                    onClick={() => onStop(run)}
                  >
                    {stopping ? t('agentRuns.activity.stopping') : t('agentRuns.activity.stop')}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
      {loadError && runs.length > 0 ? (
        <p className="agent-run-activity__error" role="alert">
          {t('agentRuns.activity.loadFailed')}
        </p>
      ) : null}
      {cancelError ? (
        <p className="agent-run-activity__error" role="alert">
          {t('agentRuns.activity.stopFailed')}
        </p>
      ) : null}
    </section>
  )
}

export const requestAgentRunCancel = (
  profileId: string,
  chatId: string,
  invocationId: string
): Promise<{ invocationId: string; cancelled: boolean }> =>
  window.api.cancelAgentRun(profileId, chatId, invocationId)

export function AgentRunActivity({
  profileId,
  chatId
}: {
  profileId: string
  chatId: string
}): React.ReactElement {
  const t = useT()
  // Each subscription must return a value React can compare with Object.is across renders:
  // `byChat` is a stable reference between store writes, and the other two are primitives. Deriving
  // `runs` inside the selector instead would hand useSyncExternalStore a fresh array every call,
  // which re-renders forever and tears the tree down (blank screen on entering a session).
  const byChat = useAgentRunStore((state) => state.byChat)
  const loading = useAgentRunStore((state) => state.loadingByChat[chatId] ?? false)
  const loadError = useAgentRunStore((state) => state.errorByChat[chatId] ?? false)
  const runs = useMemo(() => recentAgentRuns(byChat, chatId), [byChat, chatId])
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set())
  const [cancelError, setCancelError] = useState(false)

  const stop = async (run: AgentRunSummary): Promise<void> => {
    setCancelError(false)
    setStoppingIds((ids) => new Set(ids).add(run.invocationId))
    try {
      const result = await requestAgentRunCancel(profileId, chatId, run.invocationId)
      if (!result.cancelled) setCancelError(true)
    } catch {
      setCancelError(true)
    } finally {
      setStoppingIds((ids) => {
        const next = new Set(ids)
        next.delete(run.invocationId)
        return next
      })
    }
  }

  return (
    <AgentRunActivityListView
      runs={runs}
      loading={loading}
      loadError={loadError}
      cancelError={cancelError}
      stoppingIds={stoppingIds}
      onStop={(run) => void stop(run)}
      t={t}
    />
  )
}

export function AgentRunActivityToggle({
  chatId,
  open,
  onOpenChange
}: {
  chatId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  const t = useT()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const byChat = useAgentRunStore((state) => state.byChat)
  const revisionByChat = useAgentRunStore((state) => state.revisionByChat)
  const runs = useMemo(() => latestRunPerAgent(byChat, chatId), [byChat, chatId])
  const runningCount = runs.filter((run) => run.status === 'running').length
  const indicator = useMemo(
    () => agentRunIndicatorState(byChat, revisionByChat, chatId),
    [byChat, revisionByChat, chatId]
  )
  const indicatorLabel = t(
    indicator.running
      ? `agentRuns.indicator.running.${indicator.tone}`
      : `agentRuns.indicator.${indicator.tone}`
  )
  const toggleLabel = t(open ? 'agentRuns.activity.hide' : 'agentRuns.activity.show')
  const accessibleLabel =
    runningCount > 0
      ? `${toggleLabel} · ${indicatorLabel} · ${t('agentRuns.activity.runningCount', { count: runningCount })}`
      : `${toggleLabel} · ${indicatorLabel}`

  useEffect(() => {
    if (!open) return

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      onOpenChange(false)
      toggleRef.current?.focus()
    }

    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, onOpenChange])

  return (
    <div className="tstrip-agent-runs">
      <button
        ref={toggleRef}
        type="button"
        className={`tmenu-btn tstrip-agent-runs__toggle${open ? ' open' : ''}`}
        title={accessibleLabel}
        aria-label={accessibleLabel}
        aria-expanded={open}
        aria-controls="agent-run-status-strip"
        onClick={() => onOpenChange(!open)}
      >
        <span
          className={`tstrip-agent-runs__indicator tone-${indicator.tone}${indicator.running ? ' is-running' : ''}`}
          aria-hidden="true"
        />
        <span className="tstrip-agent-runs__label">{t('agentRuns.activity.toggle')}</span>
        {runningCount > 0 ? (
          <span className="tstrip-agent-runs__count" aria-hidden="true">
            {runningCount}
          </span>
        ) : null}
      </button>
    </div>
  )
}

export function AgentRunStatusStrip({ chatId }: { chatId: string }): React.ReactElement {
  const t = useT()
  const byChat = useAgentRunStore((state) => state.byChat)
  const loading = useAgentRunStore((state) => state.loadingByChat[chatId] ?? false)
  const loadError = useAgentRunStore((state) => state.errorByChat[chatId] ?? false)
  const runs = useMemo(() => latestRunPerAgent(byChat, chatId), [byChat, chatId])
  const visibleRuns = runs.slice(0, 3)
  const hiddenCount = runs.length - visibleRuns.length
  const runningCount = runs.filter((run) => run.status === 'running').length
  const summary =
    runningCount > 0
      ? `${t('agentRuns.activity.agentCount', { count: runs.length })} · ${t('agentRuns.activity.runningCount', { count: runningCount })}`
      : t('agentRuns.activity.agentCount', { count: runs.length })

  return (
    <div
      className="tstrip-agent-status"
      id="agent-run-status-strip"
      role="status"
      aria-live="polite"
      aria-label={summary}
    >
      {loading && runs.length === 0 ? (
        <span className="tstrip-agent-status__message">{t('agentRuns.activity.loading')}</span>
      ) : loadError && runs.length === 0 ? (
        <span className="tstrip-agent-status__message">{t('agentRuns.activity.loadFailed')}</span>
      ) : runs.length === 0 ? (
        <span className="tstrip-agent-status__message">{t('agentRuns.activity.empty')}</span>
      ) : (
        <>
          <span className="tstrip-agent-status__items">
            {visibleRuns.map((run) => (
              <span
                className={`tstrip-agent-status__item tstrip-agent-status__item--${run.status}`}
                key={run.invocationId}
                title={`${run.agentName} · ${t(`agentRuns.status.${run.status}`)} · ${t('agentRuns.activity.floor', { floor: run.floor })}`}
              >
                <span className="tstrip-agent-status__dot" aria-hidden="true" />
                <span className="tstrip-agent-status__name">{run.agentName}</span>
                <span className="tstrip-agent-status__state">
                  {t(`agentRuns.status.${run.status}`)}
                </span>
                <span className="tstrip-agent-status__floor">
                  {t('agentRuns.activity.floor', { floor: run.floor })}
                </span>
              </span>
            ))}
            {hiddenCount > 0 ? (
              <span className="tstrip-agent-status__more">
                {t('agentRuns.activity.more', { count: hiddenCount })}
              </span>
            ) : null}
          </span>
          <span className="tstrip-agent-status__compact">
            {runningCount > 0
              ? t('agentRuns.activity.runningCount', { count: runningCount })
              : t('agentRuns.activity.agentCount', { count: runs.length })}
          </span>
        </>
      )}
    </div>
  )
}
