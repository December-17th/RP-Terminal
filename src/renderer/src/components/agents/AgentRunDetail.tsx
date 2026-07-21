import type { AgentRunRecord, JsonValue } from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'
import { BudgetSection, ContextSection } from './AgentRunInspector'

export const agentRunDurationMs = (
  record: Pick<AgentRunRecord, 'startedAt' | 'finishedAt'>
): number | null => {
  if (!record.finishedAt) return null
  const started = Date.parse(record.startedAt)
  const finished = Date.parse(record.finishedAt)
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : null
}

const displayJson = (value: JsonValue | object): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

const toolName = (value: JsonValue, index: number): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `#${index + 1}`
  const call = value.call
  if (call && typeof call === 'object' && !Array.isArray(call) && typeof call.name === 'string') {
    return call.name
  }
  return `#${index + 1}`
}

export function AgentRunDetail({
  record,
  onClose,
  onCopied,
  onEditInput,
  onOpenPreset
}: {
  record: AgentRunRecord
  onClose: () => void
  onCopied: () => void
  onEditInput: (input: AgentRunRecord['input']) => void
  onOpenPreset: () => void
}): React.ReactElement {
  const t = useT()
  const duration = agentRunDurationMs(record)
  const tools = record.attempts.flatMap((attempt) => attempt.tools)
  const raw = JSON.stringify(record, null, 2)
  const canEditInput = record.failure?.code === 'INVALID_INPUT'
  const canOpenPreset = record.failure?.code.startsWith('PROVIDER_') ?? false

  return (
    <section className="agent-runs__detail" aria-labelledby="agent-run-detail-title">
      <div className="agent-runs__detail-head">
        <div>
          <strong id="agent-run-detail-title">{t('agents.run.detail')}</strong>
          <span className={`agent-runs__status agent-runs__status--${record.status}`}>
            {t(`agentRuns.status.${record.status}`)}
          </span>
        </div>
        <button type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>

      <dl className="agent-runs__summary">
        <div>
          <dt>{t('agents.run.duration')}</dt>
          <dd>
            {duration === null
              ? t('agents.run.inProgress')
              : t('agents.run.durationMs', { duration })}
          </dd>
        </div>
        <div>
          <dt>{t('agents.run.retries')}</dt>
          <dd>{record.metrics.retries}</dd>
        </div>
        <div>
          <dt>{t('agents.run.floorLabel')}</dt>
          <dd>{record.floor}</dd>
        </div>
        {record.provider?.model ? (
          <div>
            <dt>{t('agents.run.model')}</dt>
            <dd>{record.provider.model}</dd>
          </div>
        ) : null}
      </dl>

      {/* Context Microscope (plan D5): the rendered-prompt snapshot with origin badges and the token
          budget live here too, so the run drill-down keeps the same inspection depth as the preview. */}
      {record.renderedPrompt?.length ? (
        <ContextSection
          messages={record.renderedPrompt}
          prefixCount={record.attempts?.[0]?.immutablePrefix?.length ?? 0}
          t={t}
        />
      ) : null}
      {record.contextBudget ? <BudgetSection budget={record.contextBudget} t={t} /> : null}

      <ol className="agent-runs__timeline">
        <li>
          <span className="agent-runs__timeline-marker" />
          <div>
            <strong>{t('agents.run.timeline.started')}</strong>
            <time dateTime={record.startedAt}>{record.startedAt}</time>
          </div>
        </li>
        {record.attempts.map((attempt) => (
          <li
            className={attempt.outcome === 'failure' ? 'agent-runs__timeline-failure' : undefined}
            key={attempt.attempt}
          >
            <span className="agent-runs__timeline-marker" />
            <details open={attempt.outcome === 'failure' ? true : undefined}>
              <summary>
                {t('agents.run.timeline.attempt', {
                  attempt: attempt.attempt,
                  outcome: t(`agents.run.outcome.${attempt.outcome}`)
                })}
              </summary>
              <div>
                <span>
                  {t('agents.run.timeline.attemptMeta', {
                    calls: attempt.providerCalls,
                    duration: attempt.latencyMs.reduce((total, value) => total + value, 0)
                  })}
                </span>
                {attempt.repairs.length ? (
                  <span>{t('agents.run.timeline.repairs', { count: attempt.repairs.length })}</span>
                ) : null}
                {attempt.error ? <em>{attempt.error.message}</em> : null}
              </div>
            </details>
          </li>
        ))}
        {record.finishedAt ? (
          <li>
            <span className="agent-runs__timeline-marker" />
            <div>
              <strong>{t('agents.run.timeline.finished')}</strong>
              <time dateTime={record.finishedAt}>{record.finishedAt}</time>
            </div>
          </li>
        ) : null}
      </ol>

      {record.failure ? (
        <section className="agent-runs__failure" role="alert">
          <h5>{t('agents.run.failure')}</h5>
          <strong>{record.failure.code}</strong>
          <p>{record.failure.message}</p>
          {canEditInput || canOpenPreset ? (
            <div className="agent-runs__recovery">
              {canEditInput ? (
                <button type="button" onClick={() => onEditInput(record.input)}>
                  {t('agents.run.editInput')}
                </button>
              ) : null}
              {canOpenPreset ? (
                <button type="button" onClick={onOpenPreset}>
                  {t('agents.run.openPreset')}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {record.warnings.length ? (
        <section className="agent-runs__warnings">
          <h5>{t('agents.run.warnings', { count: record.warnings.length })}</h5>
          <ul>
            {record.warnings.map((warning, index) => (
              <li key={`${warning}:${index}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {tools.length ? (
        <section className="agent-runs__tools">
          <h5>{t('agents.run.toolCalls', { count: tools.length })}</h5>
          {tools.map((tool, index) => (
            <details key={index}>
              <summary>{toolName(tool, index)}</summary>
              <pre>{displayJson(tool)}</pre>
            </details>
          ))}
        </section>
      ) : null}

      {'result' in record ? (
        <section className="agent-runs__output">
          <h5>{t('agents.run.output')}</h5>
          <pre>{displayJson(record.result ?? null)}</pre>
        </section>
      ) : null}

      <details className="agent-runs__raw">
        <summary>{t('agents.run.copyJson')}</summary>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(raw).then(onCopied)
          }}
        >
          {t('agents.run.copyToClipboard')}
        </button>
        <pre>{raw}</pre>
      </details>
    </section>
  )
}
