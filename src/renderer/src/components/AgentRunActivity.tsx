import { useEffect, useMemo, useRef } from 'react'
import { useT } from '../i18n'
import {
  agentRunIndicatorState,
  latestRunPerAgent,
  useAgentRunStore
} from '../stores/agentRunStore'

// The detailed run list (AgentRunActivityListView / AgentRunActivity) was removed in the Agent Runtime
// cutover: nothing mounted it, and run inspectability lives in the Agent Workspace's own list. The two
// surfaces here are the live ones — the title-strip disclosure toggle and its compact status strip.

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
        // The controlled status strip is only in the DOM while open; only then does the id resolve.
        aria-controls={open ? 'agent-run-status-strip' : undefined}
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
