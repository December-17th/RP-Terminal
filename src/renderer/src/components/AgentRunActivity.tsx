import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentRunSummary } from '../../../shared/agentRuntime'
import { useT } from '../i18n'
import { recentAgentRuns, useAgentRunStore } from '../stores/agentRunStore'

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
  const { runs, loading, loadError } = useAgentRunStore(
    useShallow((state) => ({
      runs: recentAgentRuns(state.byChat, chatId),
      loading: state.loadingByChat[chatId] ?? false,
      loadError: state.errorByChat[chatId] ?? false
    }))
  )
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
