import React, { useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import type {
  RetrievalPreviewResponse,
  RetrievalTraceRow
} from '../../../../shared/retrievalTrace'

/**
 * WP-D2 — the Debug window's Retrieval tab. Runs a side-effect-free dry-run of lorebook retrieval for a
 * chosen chat and shows, side by side, what fires under RPT retrieval (scan text + [PINS]) vs the
 * ST-keyword baseline (same scan text WITHOUT the pin block), with per-entry reasons. No generation, no
 * API call, no state writes — every value comes from the read-only `retrieval-preview` IPC.
 *
 * It reuses the EXISTING listing IPC (getProfiles/getChats/getCharacters) for the chat picker; it adds no
 * new listing surface. Viewer state is not persisted.
 */

type Profile = { id: string; name: string }
type Chat = { id: string; character_id: string; updated_at: string; floor_count: number }
type CharacterRow = { id: string; card: { data?: { name?: string } } }

export function RetrievalPanel(): React.ReactElement {
  const t = useT()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState<string>('')
  const [chats, setChats] = useState<Chat[]>([])
  const [chatId, setChatId] = useState<string>('')
  const [charNames, setCharNames] = useState<Record<string, string>>({})
  const [action, setAction] = useState<string>('')
  const [result, setResult] = useState<RetrievalPreviewResponse | null>(null)
  const [running, setRunning] = useState(false)

  // Load profiles once; default to the first (most recently active).
  useEffect(() => {
    void (async () => {
      const list: Profile[] = (await window.api.getProfiles()) ?? []
      setProfiles(list)
      if (list.length > 0) setProfileId((prev) => prev || list[0].id)
    })()
  }, [])

  // When the profile changes, load its chats + character names; default to the most recently updated chat.
  useEffect(() => {
    if (!profileId) return
    void (async () => {
      const [chatList, chars]: [Chat[], CharacterRow[]] = await Promise.all([
        window.api.getChats(profileId).then((c: Chat[] | undefined) => c ?? []),
        window.api.getCharacters(profileId).then((c: CharacterRow[] | undefined) => c ?? [])
      ])
      // getChats already returns ORDER BY updated_at DESC — the first is the most recently updated.
      setChats(chatList)
      setCharNames(
        Object.fromEntries(chars.map((c) => [c.id, c.card?.data?.name || c.id]))
      )
      setChatId(chatList.length > 0 ? chatList[0].id : '')
      setResult(null)
    })()
  }, [profileId])

  const run = async (): Promise<void> => {
    if (!profileId || !chatId) return
    setRunning(true)
    try {
      const res: RetrievalPreviewResponse = await window.api.retrievalPreview(
        profileId,
        chatId,
        action
      )
      setResult(res)
    } finally {
      setRunning(false)
    }
  }

  const chatLabel = (c: Chat): string => {
    const name = charNames[c.character_id] || c.character_id
    return t('debug.retrievalChatLabel', { name, floors: c.floor_count })
  }

  return (
    <div className="rt-panel">
      <div className="rt-controls">
        <label className="rt-field">
          <span className="rt-field-label">{t('debug.retrievalProfile')}</span>
          <select
            className="rt-select"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {profiles.length === 0 && <option value="">{t('debug.retrievalNoProfiles')}</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rt-field">
          <span className="rt-field-label">{t('debug.retrievalChat')}</span>
          <select
            className="rt-select"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            disabled={chats.length === 0}
          >
            {chats.length === 0 && <option value="">{t('debug.retrievalNoChats')}</option>}
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {chatLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="rt-field rt-field-grow">
          <span className="rt-field-label">{t('debug.retrievalAction')}</span>
          <input
            className="rt-input"
            type="text"
            value={action}
            placeholder={t('debug.retrievalActionPlaceholder')}
            onChange={(e) => setAction(e.target.value)}
          />
        </label>
        <button className="rt-run" onClick={() => void run()} disabled={!chatId || running}>
          {running ? t('debug.retrievalRunning') : t('debug.retrievalRun')}
        </button>
      </div>

      {result === null && <p className="rt-empty">{t('debug.retrievalIdle')}</p>}
      {result?.ok === false && <p className="rt-error">{t('debug.retrievalNotFound')}</p>}
      {result?.ok === true && <RetrievalResult result={result} />}
    </div>
  )
}

function RetrievalResult({
  result
}: {
  result: Extract<RetrievalPreviewResponse, { ok: true }>
}): React.ReactElement {
  const t = useT()
  const { both, rptOnly, baselineOnly } = useMemo(() => {
    const both: RetrievalTraceRow[] = []
    const rptOnly: RetrievalTraceRow[] = []
    const baselineOnly: RetrievalTraceRow[] = []
    // The two traces cover the SAME candidates in the SAME order, so index i pairs across them.
    for (let i = 0; i < result.rpt.length; i++) {
      const r = result.rpt[i]
      const b = result.baseline[i]
      if (r.fired && b?.fired) both.push(r)
      else if (r.fired) rptOnly.push(r)
      else if (b?.fired) baselineOnly.push(b)
    }
    return { both, rptOnly, baselineOnly }
  }, [result])

  const nothingFired = both.length === 0 && rptOnly.length === 0 && baselineOnly.length === 0

  return (
    <div className="rt-result">
      <div className="rt-meta">
        <span className="rt-meta-item">
          {t('debug.retrievalScanDepth', { n: result.scanDepth })}
        </span>
        <span className="rt-meta-item">
          {t('debug.retrievalMaxRecursion', { n: result.maxRecursion })}
        </span>
        <span className="rt-meta-item">
          {result.lorebookNames.length > 0
            ? t('debug.retrievalBooks', { books: result.lorebookNames.join(', ') })
            : t('debug.retrievalNoLorebooks')}
        </span>
      </div>

      {nothingFired ? (
        <p className="rt-empty">{t('debug.retrievalNothingFired')}</p>
      ) : (
        <div className="rt-groups">
          <RetrievalGroup
            title={t('debug.retrievalFiredBoth')}
            variant="both"
            rows={both}
          />
          <RetrievalGroup
            title={t('debug.retrievalRptOnly')}
            variant="rpt"
            rows={rptOnly}
          />
          <RetrievalGroup
            title={t('debug.retrievalBaselineOnly')}
            variant="baseline"
            rows={baselineOnly}
          />
        </div>
      )}

      <details className="rt-scan-details">
        <summary>{t('debug.retrievalScanText')}</summary>
        <pre className="rt-scan">
          {result.baseScanText}
          {result.pinBlock && <span className="rt-pins">{result.pinBlock}</span>}
        </pre>
      </details>
    </div>
  )
}

function RetrievalGroup({
  title,
  variant,
  rows
}: {
  title: string
  variant: 'both' | 'rpt' | 'baseline'
  rows: RetrievalTraceRow[]
}): React.ReactElement {
  const t = useT()
  const reasonChip = (row: RetrievalTraceRow): string => {
    if (row.recursionPass > 0) return t('debug.retrievalReasonRecursion', { n: row.recursionPass })
    if (row.reason === 'constant') return t('debug.retrievalReasonConstant')
    if (row.reason === 'key')
      return t('debug.retrievalReasonKey', { key: row.matchedKey ?? '' })
    return t('debug.retrievalReasonNone')
  }
  return (
    <section className={`rt-group rt-group-${variant}`}>
      <h3 className="rt-group-title">
        {title} <span className="rt-group-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="rt-group-empty">{t('debug.retrievalGroupEmpty')}</p>
      ) : (
        <ul className="rt-entries">
          {rows.map((row, i) => (
            <li key={`${row.bookName}:${row.entryId ?? row.comment}:${i}`} className="rt-entry">
              <div className="rt-entry-head">
                <span className="rt-entry-book">{row.bookName}</span>
                <span className="rt-entry-name">
                  {row.comment || t('debug.retrievalUnnamed')}
                </span>
              </div>
              <div className="rt-entry-meta">
                <span className="rt-chip rt-chip-reason">{reasonChip(row)}</span>
                {row.probability < 100 && (
                  <span className="rt-chip rt-chip-prob">
                    {t('debug.retrievalProbability', { n: row.probability })}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
