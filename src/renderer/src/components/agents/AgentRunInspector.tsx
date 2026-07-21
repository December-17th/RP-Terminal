// Structured Run Record viewer (Microscope-lite D5) — replaces the raw JSON.stringify <pre> dump in the
// Agent Workspace runs tab. One component serves BOTH a finished run record and a dry-run Prompt Preview.
//
// Data-source pin (plan D5 / QA open question 1): the Context section renders `AgentRunRecord.renderedPrompt`
// (the step-0 snapshot that carries `origin` badges) — NEVER `attempt.messages`. The Attempts section
// renders `attempt.messages` / tool evidence, badged by role/position only (the tool loop has no origin).
import React, { useState } from 'react'
import type {
  AgentRunRecord,
  AgentRunMessage,
  AgentRunAttempt,
  AgentRunContextBudget,
  AgentPromptOrigin
} from '../../../../shared/agentRuntime'
import type { AgentPromptPreview } from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'
import { estimateTokens } from '../../lib/estimateTokens'

type PreviewOk = Extract<AgentPromptPreview, { ok: true }>
type Translate = (key: string, vars?: Record<string, string | number>) => string

export type InspectorSource =
  | { mode: 'run'; record: AgentRunRecord }
  | { mode: 'preview'; preview: PreviewOk }

/** Coarse origin badges have a fixed, known set; friendly labels come from i18n. */
const ORIGIN_KEYS: Record<AgentPromptOrigin, string> = {
  'harness-policy': 'agents.inspector.origin.harness-policy',
  'agent-prompt': 'agents.inspector.origin.agent-prompt',
  'assembled-preset': 'agents.inspector.origin.assembled-preset',
  input: 'agents.inspector.origin.input',
  addendum: 'agents.inspector.origin.addendum'
}

/** Map a known budget region prefix (`immutable-prompt:3`, `tool-result:x`) to a friendly i18n label. */
function regionLabel(t: Translate, region: string): string {
  const prefix = region.split(':', 1)[0]
  const key = `agents.inspector.region.${prefix}`
  const label = t(key)
  // Unknown/dynamic prefixes fall back to the raw region string so nothing is hidden.
  return label === key ? region : label
}

function CollapsibleContent({ content, t }: { content: string; t: Translate }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const lines = content ? content.split('\n').length : 0
  return (
    <div className="agent-inspector__msg-body">
      <button
        type="button"
        className="agent-inspector__disclosure"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('agents.inspector.collapse') : t('agents.inspector.expand', { lines })}
      </button>
      {open ? (
        <pre className="agent-inspector__mono">{content || t('agents.inspector.empty')}</pre>
      ) : null}
    </div>
  )
}

/** Ordered message list with role, origin badge, per-message ~token estimate, and a prefix divider. */
function ContextSection({
  messages,
  prefixCount,
  t
}: {
  messages: AgentRunMessage[]
  prefixCount: number
  t: Translate
}): React.ReactElement {
  return (
    <section className="agent-inspector__section">
      <h5>{t('agents.inspector.context')}</h5>
      <p className="agent-inspector__note">{t('agents.inspector.contextNote')}</p>
      <ol className="agent-inspector__messages">
        {messages.map((message, index) => (
          <React.Fragment key={index}>
            {index === prefixCount ? (
              <li className="agent-inspector__prefix-divider" aria-hidden={false}>
                <span>{t('agents.inspector.prefixBoundary')}</span>
                <span
                  className="agent-inspector__prefix-hint"
                  title={t('agents.inspector.prefixBoundaryHint')}
                >
                  ?
                </span>
              </li>
            ) : null}
            <li className="agent-inspector__message">
              <div className="agent-inspector__msg-head">
                <span className={`agent-inspector__role agent-inspector__role--${message.role}`}>
                  {t(`agents.inspector.role.${message.role}`)}
                </span>
                {message.origin ? (
                  <span className="agent-inspector__origin">{t(ORIGIN_KEYS[message.origin])}</span>
                ) : null}
                <span
                  className="agent-inspector__tokens"
                  title={t('agents.inspector.estimateHint')}
                >
                  {t('agents.inspector.tokens', { count: estimateTokens(message.content) })}
                </span>
              </div>
              <CollapsibleContent content={message.content} t={t} />
            </li>
          </React.Fragment>
        ))}
        {messages.length === prefixCount ? (
          <li className="agent-inspector__prefix-divider" aria-hidden={false}>
            <span>{t('agents.inspector.prefixBoundary')}</span>
          </li>
        ) : null}
      </ol>
    </section>
  )
}

/** Region table + a total-vs-limit bar. All figures are estimates. */
function BudgetSection({
  budget,
  t
}: {
  budget: AgentRunContextBudget
  t: Translate
}): React.ReactElement {
  const pct = budget.limit > 0 ? Math.min(100, Math.round((budget.total / budget.limit) * 100)) : 0
  const over = budget.limit > 0 && budget.total > budget.limit
  return (
    <section className="agent-inspector__section">
      <h5>{t('agents.inspector.budget')}</h5>
      <div
        className="agent-inspector__bar"
        role="img"
        aria-label={t('agents.inspector.budgetBar', { total: budget.total, limit: budget.limit })}
      >
        <span
          className={`agent-inspector__bar-fill${over ? ' agent-inspector__bar-fill--over' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="agent-inspector__note">
        {t('agents.inspector.budgetTotal', { total: budget.total, limit: budget.limit, pct })}
      </p>
      <table className="agent-inspector__regions">
        <thead>
          <tr>
            <th>{t('agents.inspector.region')}</th>
            <th>{t('agents.inspector.regionTokens')}</th>
          </tr>
        </thead>
        <tbody>
          {budget.regions.map((row, index) => (
            <tr key={`${row.region}-${index}`}>
              <td>{regionLabel(t, row.region)}</td>
              <td className="agent-inspector__num">
                {t('agents.inspector.tokens', { count: row.tokens })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

interface ToolEvidenceView {
  call?: { name?: string }
  arguments?: unknown
  durationMs?: number
  truncated?: boolean
  projectedTokens?: number
  irreversibleBoundaryCrossed?: boolean
}

function AttemptCard({
  attempt,
  t
}: {
  attempt: AgentRunAttempt
  t: Translate
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const tools = (attempt.tools ?? []) as ToolEvidenceView[]
  return (
    <li className="agent-inspector__attempt">
      <button
        type="button"
        className="agent-inspector__disclosure"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t('agents.inspector.attempt', {
          n: attempt.attempt,
          outcome: t(`agents.inspector.outcome.${attempt.outcome}`)
        })}
      </button>
      {open ? (
        <div className="agent-inspector__attempt-body">
          <p className="agent-inspector__note">
            {t('agents.inspector.providerCalls', { count: attempt.providerCalls })}
            {attempt.contextBudget
              ? ` · ${t('agents.inspector.budgetTotal', {
                  total: attempt.contextBudget.total,
                  limit: attempt.contextBudget.limit,
                  pct:
                    attempt.contextBudget.limit > 0
                      ? Math.round(
                          (attempt.contextBudget.total / attempt.contextBudget.limit) * 100
                        )
                      : 0
                })}`
              : ''}
          </p>
          {tools.length ? (
            <table className="agent-inspector__tools">
              <thead>
                <tr>
                  <th>{t('agents.inspector.tool.name')}</th>
                  <th>{t('agents.inspector.tool.duration')}</th>
                  <th>{t('agents.inspector.tool.projected')}</th>
                  <th>{t('agents.inspector.tool.flags')}</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((tool, index) => (
                  <tr key={index}>
                    <td>{tool.call?.name ?? t('agents.inspector.tool.unknown')}</td>
                    <td className="agent-inspector__num">
                      {typeof tool.durationMs === 'number'
                        ? t('agents.inspector.tool.ms', { ms: tool.durationMs })
                        : '—'}
                    </td>
                    <td className="agent-inspector__num">
                      {typeof tool.projectedTokens === 'number'
                        ? t('agents.inspector.tokens', { count: tool.projectedTokens })
                        : '—'}
                    </td>
                    <td>
                      {[
                        tool.truncated ? t('agents.inspector.tool.truncated') : null,
                        tool.irreversibleBoundaryCrossed
                          ? t('agents.inspector.tool.irreversible')
                          : null
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {attempt.repairs?.length ? (
            <p className="agent-inspector__note">
              {t('agents.inspector.repairs', { list: attempt.repairs.join(', ') })}
            </p>
          ) : null}
          {attempt.messages?.length ? (
            <ol className="agent-inspector__messages agent-inspector__messages--compact">
              {attempt.messages.map((message, index) => (
                <li className="agent-inspector__message" key={index}>
                  <div className="agent-inspector__msg-head">
                    <span
                      className={`agent-inspector__role agent-inspector__role--${message.role}`}
                    >
                      {t(`agents.inspector.role.${message.role}`)}
                    </span>
                    <span className="agent-inspector__pos">
                      {t('agents.inspector.position', { n: index + 1 })}
                    </span>
                  </div>
                  <CollapsibleContent content={message.content} t={t} />
                </li>
              ))}
            </ol>
          ) : null}
          {attempt.rejectedOutput ? (
            <div className="agent-inspector__reject">
              <strong>{t('agents.inspector.rejectedOutput')}</strong>
              <pre className="agent-inspector__mono">{attempt.rejectedOutput}</pre>
            </div>
          ) : null}
          {attempt.error ? (
            <p className="agent-inspector__error" role="alert">
              {attempt.error.code}: {attempt.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function RawJson({ value, t }: { value: unknown; t: Translate }): React.ReactElement {
  return (
    <details className="agent-inspector__raw">
      <summary>{t('agents.inspector.rawJson')}</summary>
      <pre className="agent-inspector__mono">{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

export function AgentRunInspector(props: { source: InspectorSource }): React.ReactElement {
  const t = useT()
  const { source } = props

  if (source.mode === 'preview') {
    const preview = source.preview
    const previewMessages: AgentRunMessage[] = preview.messages.map((message) => ({
      role: message.role,
      content: message.content,
      origin: message.origin
    }))
    return (
      <div className="agent-inspector">
        <p className="agent-inspector__preview-banner" role="status">
          {t('agents.inspector.previewBanner')}
        </p>
        {preview.provider ? (
          <p className="agent-inspector__note">
            {t('agents.inspector.provider', {
              preset: preview.provider.presetName,
              model: preview.provider.model
            })}
            {` · ${t('agents.inspector.cacheMode', { mode: preview.provider.cacheMode })}`}
          </p>
        ) : null}
        {preview.warnings.length ? (
          <p className="agent-inspector__degraded" role="alert">
            {preview.warnings.join(' · ')}
          </p>
        ) : null}
        <ContextSection messages={previewMessages} prefixCount={preview.prefixCount} t={t} />
        <BudgetSection budget={preview.attribution} t={t} />
      </div>
    )
  }

  const record = source.record
  const metrics = record.metrics
  // Run mode: the modeled reuse boundary is the first attempt's immutable-prefix length (plan D5).
  const prefixCount = record.attempts?.[0]?.immutablePrefix?.length ?? 0
  return (
    <div className="agent-inspector">
      <section className="agent-inspector__summary">
        <div className="agent-inspector__summary-grid">
          <span className="agent-inspector__badge">{t(`agentRuns.status.${record.status}`)}</span>
          {record.provider ? (
            <span className="agent-inspector__note">
              {t('agents.inspector.provider', {
                preset: record.provider.presetName,
                model: record.provider.model
              })}
            </span>
          ) : null}
        </div>
        <dl className="agent-inspector__metrics">
          <div>
            <dt>{t('agents.inspector.metric.tokens')}</dt>
            <dd>
              {t('agents.inspector.tokenInOut', {
                input: metrics.inputTokens,
                output: metrics.outputTokens
              })}
            </dd>
          </div>
          <div>
            <dt>{t('agents.inspector.metric.cache')}</dt>
            <dd>
              {t('agents.inspector.cacheReadWrite', {
                read: metrics.cacheReadTokens,
                write: metrics.cacheWriteTokens
              })}
            </dd>
          </div>
          <div>
            <dt>{t('agents.inspector.metric.latency')}</dt>
            <dd>{t('agents.inspector.tool.ms', { ms: metrics.latencyMs })}</dd>
          </div>
          <div>
            <dt>{t('agents.inspector.metric.retries')}</dt>
            <dd>{metrics.retries}</dd>
          </div>
          <div>
            <dt>{t('agents.inspector.metric.started')}</dt>
            <dd>{record.startedAt}</dd>
          </div>
          {record.finishedAt ? (
            <div>
              <dt>{t('agents.inspector.metric.finished')}</dt>
              <dd>{record.finishedAt}</dd>
            </div>
          ) : null}
        </dl>
        {record.warnings?.length ? (
          <p className="agent-inspector__degraded" role="alert">
            <strong>{t('agents.run.degradedTitle')}</strong> {record.warnings.join(' · ')}
          </p>
        ) : null}
      </section>

      {record.renderedPrompt?.length ? (
        <ContextSection messages={record.renderedPrompt} prefixCount={prefixCount} t={t} />
      ) : null}

      {record.contextBudget ? <BudgetSection budget={record.contextBudget} t={t} /> : null}

      {record.attempts?.length ? (
        <section className="agent-inspector__section">
          <h5>{t('agents.inspector.attempts', { count: record.attempts.length })}</h5>
          <ul className="agent-inspector__attempts">
            {record.attempts.map((attempt, index) => (
              <AttemptCard attempt={attempt} t={t} key={index} />
            ))}
          </ul>
        </section>
      ) : null}

      {record.failure ? (
        <p className="agent-inspector__error" role="alert">
          <strong>{t('agents.inspector.failure')}</strong> {record.failure.code}:{' '}
          {record.failure.message}
        </p>
      ) : record.result !== undefined ? (
        <section className="agent-inspector__section">
          <h5>{t('agents.inspector.result')}</h5>
          <pre className="agent-inspector__mono">{JSON.stringify(record.result, null, 2)}</pre>
        </section>
      ) : null}

      {/* Collapsed raw fallback keeps today's debugging power; attempts are redacted to a count so the
          dump does not re-inline the full per-attempt transcripts already shown above. */}
      <RawJson value={{ ...record, attempts: record.attempts?.length ?? 0 }} t={t} />
    </div>
  )
}
