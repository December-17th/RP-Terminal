// Run drawer for the one-canvas editor (one-canvas rebuild WP6.4a). A collapsible strip along the
// bottom of the canvas column: collapsed by default (a one-line header = the last run's outcome +
// count + expand chevron), expanded to ~40vh with its own scroll. Reuses the WP2.3 listAgentPackRuns
// IPC (page 1 only — no infinite scroll here, that is a NON-GOAL) and the IMPORTED pure runTimeline.ts
// helpers (runFacts / outcomeSentence) so the per-run sentence is derived identically to the Agents
// workspace timeline. Clicking an entry replays its trace onto the canvas (via onReplay); a "live"
// affordance clears the replay.
import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useOptionalT, useT } from '../../i18n'
import { runFacts, outcomeSentence } from '../workspace/runTimeline'
import { formatTraceSeconds, type StoredRunRecord, type WorkflowRunTrace } from '../../../../shared/workflow/trace'
import './workflowEditor.css'

/** HH:mm for a run's start (mirrors AgentsView's formatClockTime — kept local so the drawer needs no
 *  cross-import from the workspace view). */
const formatClockTime = (epochMs: number): string => {
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Render an OutcomeSentence to text: when it names a failed node TYPE, localize it to a title and pass
 *  it as the {{node}} var, then translate the key (same shape as the workspace timeline's helper). */
function useOutcomeText(): (record: StoredRunRecord) => string {
  const t = useT()
  const tOpt = useOptionalT()
  return (record) => {
    const sentence = outcomeSentence(runFacts(record.trace))
    const vars: Record<string, string | number> = { ...sentence.vars }
    if (sentence.failedNodeType) {
      vars.node = tOpt(`workflowEditor.nodeTitle.${sentence.failedNodeType}`) || sentence.failedNodeType
    }
    return t(sentence.key, vars)
  }
}

interface RunDrawerProps {
  profileId: string
  /** Bumped by the parent after a save so the drawer refetches page 1. */
  refreshToken: number
  /** Called with a run's trace to replay it on the canvas, or null to return to the live overlay. */
  onReplay: (trace: WorkflowRunTrace | null) => void
  /** The trace currently being replayed (drives the selected-row highlight + the "live" affordance). */
  replayTrace: WorkflowRunTrace | null
}

export default function RunDrawer({
  profileId,
  refreshToken,
  onReplay,
  replayTrace
}: RunDrawerProps): React.JSX.Element {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [expanded, setExpanded] = React.useState(false)
  const [records, setRecords] = React.useState<StoredRunRecord[]>([])
  const [loading, setLoading] = React.useState(false)
  const outcomeText = useOutcomeText()

  const load = React.useCallback(async (): Promise<void> => {
    if (!activeChatId) {
      setRecords([])
      return
    }
    setLoading(true)
    try {
      // Page 1 only (newest-first). No cursor paging in the drawer (NON-GOAL: no infinite scroll here).
      const page = (await window.api.listAgentPackRuns(profileId, activeChatId)) as StoredRunRecord[]
      setRecords(page ?? [])
    } finally {
      setLoading(false)
    }
  }, [profileId, activeChatId])

  // Fetch on chat switch + after a save (refreshToken) + on expand. A chat switch also clears any replay.
  React.useEffect(() => {
    onReplay(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onReplay stable enough; refetch on these deps
  }, [activeChatId])

  React.useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when the parent bumps the token
  }, [refreshToken])

  const last = records[0]
  const headerText = !activeChatId
    ? t('runDrawer.noChat')
    : last
      ? outcomeText(last)
      : t('runDrawer.empty')

  return (
    <div className={`rpt-run-drawer${expanded ? ' expanded' : ''}`}>
      <div className="rpt-run-drawer-header">
        <button
          type="button"
          className="rpt-run-drawer-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="rpt-run-drawer-chevron" aria-hidden>
            {expanded ? '▾' : '▸'}
          </span>
          <span className="rpt-run-drawer-title">{t('runDrawer.title')}</span>
          <span className="rpt-run-drawer-count">({records.length})</span>
          <span className="rpt-run-drawer-headline">{headerText}</span>
        </button>
        {replayTrace && (
          <button
            type="button"
            className="rpt-run-drawer-live"
            title={t('runDrawer.liveTitle')}
            onClick={() => onReplay(null)}
          >
            {t('runDrawer.live')}
          </button>
        )}
        {expanded && (
          <button
            type="button"
            className="rpt-run-drawer-refresh"
            title={t('runDrawer.refresh')}
            onClick={() => void load()}
          >
            ⟳
          </button>
        )}
      </div>

      {expanded && (
        <div className="rpt-run-drawer-body">
          {loading && records.length === 0 ? (
            <div className="rpt-run-drawer-empty">{t('runDrawer.loading')}</div>
          ) : records.length === 0 ? (
            <div className="rpt-run-drawer-empty">
              {activeChatId ? t('runDrawer.empty') : t('runDrawer.noChat')}
            </div>
          ) : (
            <ul className="rpt-run-drawer-list">
              {records.map((r) => {
                const selected = replayTrace === r.trace
                const tone = !r.trace.ok ? 'failed' : 'ok'
                return (
                  <li key={r.runId}>
                    <button
                      type="button"
                      className={`rpt-run-drawer-entry tone-${tone}${selected ? ' selected' : ''}`}
                      onClick={() => onReplay(r.trace)}
                    >
                      <span
                        className={`rpt-run-drawer-origin ${r.origin}`}
                        title={t(`runs.origin.${r.origin}Title`)}
                        aria-label={t(`runs.origin.${r.origin}`)}
                      >
                        {t(`runs.origin.${r.origin}`)}
                      </span>
                      <span className="rpt-run-drawer-entry-body">
                        <span className="rpt-run-drawer-entry-outcome">{outcomeText(r)}</span>
                        <span className="rpt-run-drawer-entry-meta">
                          {formatClockTime(r.trace.startedAt)} ·{' '}
                          {formatTraceSeconds(r.trace.durationMs)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
