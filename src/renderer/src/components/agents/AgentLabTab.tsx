// Agent Lab tab (design: `.scratch/agent-lab/plan.md`, Renderer Slice B). A **case** is a saved
// fixture belonging to the selected Agent. Captured cases (carry a `sourceRecord`) can be REPLAYED
// for free against the current definition and DIFFED against the capture; authored cases (input only)
// are live-only. Running a case — replay or live — produces an ordinary run record in the per-chat
// store; this tab fetches those records by reference for inspection/diff. It never mutates Slice A's
// shapes: it consumes the preload surface and AgentRunInspector / AgentRunDiff as-is.
import React, { useCallback, useEffect, useState } from 'react'
import type {
  AgentCatalogSummary,
  AgentLabCaseSummary,
  AgentLabRunRef,
  AgentRunRecord
} from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'
import { agentErrorMessage } from '../../i18n/errorMessages'
import { ConfirmDialog } from '../ConfirmDialog'
import { AgentRunInspector } from './AgentRunInspector'
import { AgentRunDiff } from './AgentRunDiff'

const shortHash = (hash: string): string => (hash.length > 10 ? `${hash.slice(0, 10)}…` : hash)

export function AgentLabTab({
  profileId,
  agent,
  chatId,
  refreshToken,
  onNotice
}: {
  profileId: string
  agent: AgentCatalogSummary
  chatId: string | null
  refreshToken: number
  onNotice: (message: string) => void
}): React.ReactElement {
  const t = useT()
  const [cases, setCases] = useState<AgentLabCaseSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [spendGate, setSpendGate] = useState<AgentLabCaseSummary | null>(null)
  const [deleteGate, setDeleteGate] = useState<AgentLabCaseSummary | null>(null)
  const [openRun, setOpenRun] = useState<AgentRunRecord | null>(null)
  const [diff, setDiff] = useState<{ before: AgentRunRecord; after: AgentRunRecord } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const list = await window.api.listAgentLabCases(profileId, agent.id)
    setCases(list)
  }, [profileId, agent.id])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.api
      .listAgentLabCases(profileId, agent.id)
      .then((list) => {
        if (cancelled) return
        setCases(list)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setCases([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [profileId, agent.id, refreshToken])

  const replay = async (c: AgentLabCaseSummary): Promise<void> => {
    if (!chatId) return
    setBusy(true)
    const result = await window.api.replayAgentLabCase(profileId, chatId, c.id)
    setBusy(false)
    if (result.ok) {
      onNotice(t('agents.lab.replayed', { status: result.status }))
      await refresh()
    } else {
      onNotice(agentErrorMessage(t, result.code))
    }
  }

  const runLive = async (c: AgentLabCaseSummary): Promise<void> => {
    if (!chatId) return
    setBusy(true)
    const result = await window.api.runAgentLabCaseLive(profileId, chatId, c.id)
    setBusy(false)
    if (result.ok) {
      onNotice(t('agents.lab.ranLive', { status: result.status }))
      await refresh()
    } else {
      onNotice(agentErrorMessage(t, result.code))
    }
  }

  const commitRename = async (c: AgentLabCaseSummary): Promise<void> => {
    const name = renameText.trim()
    setRenamingId(null)
    if (!name || name === c.name) return
    setBusy(true)
    const result = await window.api.renameAgentLabCase(profileId, c.id, name)
    setBusy(false)
    if (result.ok) {
      onNotice(t('agents.lab.renamed'))
      await refresh()
    } else {
      onNotice(agentErrorMessage(t, result.code))
    }
  }

  const remove = async (c: AgentLabCaseSummary): Promise<void> => {
    setDeleteGate(null)
    setBusy(true)
    const result = await window.api.deleteAgentLabCase(profileId, c.id)
    setBusy(false)
    if (result.ok) {
      onNotice(t('agents.lab.deleted'))
      await refresh()
    } else {
      onNotice(agentErrorMessage(t, result.code))
    }
  }

  const openRunRef = async (ref: AgentLabRunRef): Promise<void> => {
    setDiff(null)
    const record = await window.api.getAgentLabRun(profileId, ref.chatId, ref.invocationId)
    if (record) setOpenRun(record)
    else onNotice(t('agents.lab.runMissing'))
  }

  const diffAgainstCapture = async (c: AgentLabCaseSummary, ref: AgentLabRunRef): Promise<void> => {
    setOpenRun(null)
    const [full, record] = await Promise.all([
      window.api.getAgentLabCase(profileId, c.id),
      window.api.getAgentLabRun(profileId, ref.chatId, ref.invocationId)
    ])
    if (full?.sourceRecord && record) setDiff({ before: full.sourceRecord, after: record })
    else onNotice(t('agents.lab.diffMissing'))
  }

  return (
    <div className="agent-lab">
      <div className="agent-lab__intro">
        <h4>{t('agents.lab.title')}</h4>
        <p className="agents-panel__hint">{t('agents.lab.hint')}</p>
        {chatId ? null : <p className="agents-panel__hint">{t('agents.lab.needsChat')}</p>}
      </div>

      {loading ? (
        <p className="agents-panel__empty">{t('agents.lab.loading')}</p>
      ) : cases.length === 0 ? (
        <p className="agents-panel__empty">{t('agents.lab.empty')}</p>
      ) : (
        <ul className="agent-lab__cases">
          {cases.map((c) => {
            const replayDisabled = !c.hasSource || !chatId || busy
            const replayTitle = !c.hasSource
              ? t('agents.lab.replayDisabledNoSource')
              : !chatId
                ? t('agents.lab.replayDisabledNoChat')
                : undefined
            return (
              <li key={c.id} className="agent-lab__case">
                <div className="agent-lab__case-head">
                  {renamingId === c.id ? (
                    <input
                      type="text"
                      className="agent-lab__rename"
                      autoFocus
                      value={renameText}
                      aria-label={t('agents.lab.namePrompt')}
                      onChange={(event) => setRenameText(event.target.value)}
                      onBlur={() => void commitRename(c)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitRename(c)
                        if (event.key === 'Escape') setRenamingId(null)
                      }}
                    />
                  ) : (
                    <strong className="agent-lab__case-name">{c.name}</strong>
                  )}
                  <span className="agent-lab__case-meta">
                    {c.hasSource
                      ? t('agents.lab.capturedAgainst', {
                          hash: c.agentHash ? shortHash(c.agentHash) : '—',
                          run: c.sourceInvocationId ?? '—'
                        })
                      : t('agents.lab.authored')}
                  </span>
                  <span className="agent-lab__case-meta">
                    {t('agents.lab.created', { date: c.createdAt })}
                  </span>
                </div>

                <div className="agent-lab__case-actions">
                  <button
                    type="button"
                    disabled={replayDisabled}
                    title={replayTitle}
                    onClick={() => void replay(c)}
                  >
                    {t('agents.lab.replay')}
                  </button>
                  <button
                    type="button"
                    disabled={!chatId || busy}
                    title={chatId ? undefined : t('agents.lab.runLiveDisabledNoChat')}
                    onClick={() => setSpendGate(c)}
                  >
                    {t('agents.lab.runLive')}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      setRenamingId(c.id)
                      setRenameText(c.name)
                    }}
                  >
                    {t('agents.lab.rename')}
                  </button>
                  <button
                    type="button"
                    className="agents-row__delete"
                    disabled={busy}
                    onClick={() => setDeleteGate(c)}
                  >
                    {t('agents.delete')}
                  </button>
                </div>

                <div className="agent-lab__runs">
                  <span className="agents-panel__hint">
                    {t('agents.lab.runs', { count: c.runs.length })}
                  </span>
                  {c.runs.length === 0 ? (
                    <p className="agents-panel__empty">{t('agents.lab.noRuns')}</p>
                  ) : (
                    <ul className="agent-lab__run-list">
                      {c.runs.map((ref) => (
                        <li key={`${ref.chatId}:${ref.invocationId}`} className="agent-lab__run">
                          <button
                            type="button"
                            className="agent-lab__run-open"
                            onClick={() => void openRunRef(ref)}
                          >
                            <span>{t(`agents.lab.mode.${ref.mode}`)}</span>
                            <span>{t(`agentRuns.status.${ref.status}`)}</span>
                            <span>{ref.startedAt}</span>
                          </button>
                          {c.hasSource ? (
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => void diffAgainstCapture(c, ref)}
                            >
                              {t('agents.lab.diffVsCapture')}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {openRun ? (
        <div className="agent-runs__detail">
          <div className="agent-runs__detail-head">
            <strong>{t('agents.lab.runDetailTitle')}</strong>
            <button type="button" onClick={() => setOpenRun(null)}>
              {t('common.close')}
            </button>
          </div>
          <AgentRunInspector source={{ mode: 'run', record: openRun }} />
        </div>
      ) : null}

      {diff ? (
        <div className="agent-runs__detail">
          <div className="agent-runs__detail-head">
            <strong>{t('agents.lab.diffTitle')}</strong>
            <button type="button" onClick={() => setDiff(null)}>
              {t('common.close')}
            </button>
          </div>
          <AgentRunDiff before={diff.before} after={diff.after} />
        </div>
      ) : null}

      {spendGate ? (
        <ConfirmDialog
          title={t('agents.lab.spend.title', { name: spendGate.name })}
          body={t('agents.lab.spend.body')}
          confirmLabel={t('agents.lab.runLive')}
          onConfirm={() => {
            const target = spendGate
            setSpendGate(null)
            void runLive(target)
          }}
          onCancel={() => setSpendGate(null)}
        />
      ) : null}

      {deleteGate ? (
        <ConfirmDialog
          title={t('agents.lab.confirmDelete.title', { name: deleteGate.name })}
          body={t('agents.lab.confirmDelete.body')}
          confirmLabel={t('agents.delete')}
          danger
          onConfirm={() => void remove(deleteGate)}
          onCancel={() => setDeleteGate(null)}
        />
      ) : null}
    </div>
  )
}
