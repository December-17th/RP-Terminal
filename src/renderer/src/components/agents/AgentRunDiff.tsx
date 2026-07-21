// Two-run prompt diff (Microscope-lite D5). Aligns two runs' `renderedPrompt` message lists by index
// (with add/remove detection at the tail) and shows a per-message unified line diff via the in-repo LCS
// util (no diff dependency). Comparing runs of different agents is prevented by the caller.
import React from 'react'
import type { AgentRunRecord, AgentRunMessage } from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'
import { diffLines } from '../../lib/lineDiff'

type Translate = (key: string, vars?: Record<string, string | number>) => string

function MessageDiff({
  before,
  after,
  index,
  t
}: {
  before?: AgentRunMessage
  after?: AgentRunMessage
  index: number
  t: Translate
}): React.ReactElement {
  // Whole-message add/remove when a message exists on only one side.
  if (!before && after) {
    return (
      <div className="agent-diff__message agent-diff__message--added">
        <div className="agent-diff__msg-head">
          {t('agents.diff.messageAdded', {
            n: index + 1,
            role: t(`agents.inspector.role.${after.role}`)
          })}
        </div>
        <pre className="agent-inspector__mono">{after.content}</pre>
      </div>
    )
  }
  if (before && !after) {
    return (
      <div className="agent-diff__message agent-diff__message--removed">
        <div className="agent-diff__msg-head">
          {t('agents.diff.messageRemoved', {
            n: index + 1,
            role: t(`agents.inspector.role.${before.role}`)
          })}
        </div>
        <pre className="agent-inspector__mono">{before.content}</pre>
      </div>
    )
  }
  if (!before || !after) return <></>

  const identical = before.content === after.content && before.role === after.role
  const rows = diffLines(before.content, after.content)
  return (
    <div className="agent-diff__message">
      <div className="agent-diff__msg-head">
        {t('agents.diff.message', { n: index + 1, role: t(`agents.inspector.role.${after.role}`) })}
        {identical ? (
          <span className="agent-diff__unchanged">{t('agents.diff.unchanged')}</span>
        ) : null}
      </div>
      {identical ? null : (
        <pre className="agent-inspector__mono agent-diff__rows">
          {rows.map((row, i) => (
            <div key={i} className={`agent-diff__row agent-diff__row--${row.kind}`}>
              <span className="agent-diff__sign">
                {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}
              </span>
              {row.text || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

export function AgentRunDiff({
  before,
  after
}: {
  before: AgentRunRecord
  after: AgentRunRecord
}): React.ReactElement {
  const t = useT()
  const beforeMessages = before.renderedPrompt ?? []
  const afterMessages = after.renderedPrompt ?? []
  const count = Math.max(beforeMessages.length, afterMessages.length)
  const indices = Array.from({ length: count }, (_, i) => i)
  return (
    <div className="agent-diff">
      <p className="agent-inspector__note">
        {t('agents.diff.legend', {
          before: `${before.agentName} · ${before.startedAt}`,
          after: `${after.agentName} · ${after.startedAt}`
        })}
      </p>
      {count === 0 ? (
        <p className="agents-panel__empty">{t('agents.diff.empty')}</p>
      ) : (
        indices.map((index) => (
          <MessageDiff
            key={index}
            index={index}
            before={beforeMessages[index]}
            after={afterMessages[index]}
            t={t}
          />
        ))
      )}
    </div>
  )
}
