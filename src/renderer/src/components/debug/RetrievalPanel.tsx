import React, { useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import {
  DEFAULT_SCORING_PARAMS,
  type RetrievalPreviewResponse,
  type RetrievalTraceRow,
  type ScoredEntryRow,
  type ScoringParams
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
  const [extraPins, setExtraPins] = useState<string>('')
  // Scorer tuning knobs (PoC). Held as strings so an empty field is omitted and main applies its default.
  const [lambda, setLambda] = useState<string>(String(DEFAULT_SCORING_PARAMS.lambda))
  const [hopDecay, setHopDecay] = useState<string>(String(DEFAULT_SCORING_PARAMS.hopDecay))
  const [pinBoost, setPinBoost] = useState<string>(String(DEFAULT_SCORING_PARAMS.pinBoost))
  const [topK, setTopK] = useState<string>(String(DEFAULT_SCORING_PARAMS.topK))
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
    // Split the ad-hoc pin input on commas/newlines; the handler dedupes and drops declared paths.
    const extra = extraPins
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean)
    // Only include a knob when its field parses to a finite number; otherwise main applies the default.
    const scoring: Partial<ScoringParams> = {}
    const put = (key: keyof ScoringParams, raw: string): void => {
      const n = Number(raw.trim())
      if (raw.trim() !== '' && Number.isFinite(n)) scoring[key] = n
    }
    put('lambda', lambda)
    put('hopDecay', hopDecay)
    put('pinBoost', pinBoost)
    put('topK', topK)
    setRunning(true)
    try {
      const res: RetrievalPreviewResponse = await window.api.retrievalPreview(
        profileId,
        chatId,
        action,
        extra,
        scoring
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
        <label className="rt-field rt-field-grow">
          <span className="rt-field-label">{t('debug.retrievalExtraPins')}</span>
          <input
            className="rt-input"
            type="text"
            value={extraPins}
            placeholder={t('debug.retrievalExtraPinsPlaceholder')}
            onChange={(e) => setExtraPins(e.target.value)}
          />
        </label>
        <label className="rt-field rt-field-num">
          <span className="rt-field-label">{t('debug.scoreLambda')}</span>
          <input
            className="rt-input"
            type="number"
            step="0.05"
            value={lambda}
            onChange={(e) => setLambda(e.target.value)}
          />
        </label>
        <label className="rt-field rt-field-num">
          <span className="rt-field-label">{t('debug.scoreHopDecay')}</span>
          <input
            className="rt-input"
            type="number"
            step="0.05"
            value={hopDecay}
            onChange={(e) => setHopDecay(e.target.value)}
          />
        </label>
        <label className="rt-field rt-field-num">
          <span className="rt-field-label">{t('debug.scorePinBoost')}</span>
          <input
            className="rt-input"
            type="number"
            step="0.5"
            value={pinBoost}
            onChange={(e) => setPinBoost(e.target.value)}
          />
        </label>
        <label className="rt-field rt-field-num">
          <span className="rt-field-label">{t('debug.scoreTopK')}</span>
          <input
            className="rt-input"
            type="number"
            step="1"
            value={topK}
            onChange={(e) => setTopK(e.target.value)}
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
      <PinStatus result={result} />
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

      <ScoredSection result={result} />

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

/** The deterministic-scorer PoC ranking (debug-only; never influences generation). */
function ScoredSection({
  result
}: {
  result: Extract<RetrievalPreviewResponse, { ok: true }>
}): React.ReactElement {
  const t = useT()
  const rows = result.scored
  const p = result.scoringParams
  return (
    <section className="rt-scored">
      <h3 className="rt-group-title">
        {t('debug.scoreTitle')} <span className="rt-group-count">{rows.length}</span>
      </h3>
      <p className="rt-scored-params">
        {t('debug.scoreParams', {
          lambda: p.lambda,
          hop: p.hopDecay,
          pin: p.pinBoost,
          topK: p.topK
        })}
      </p>
      <p className="rt-legend">{t('debug.scoreLegend')}</p>
      {rows.length === 0 ? (
        <p className="rt-group-empty">{t('debug.retrievalGroupEmpty')}</p>
      ) : (
        <ul className="rt-entries">
          {rows.map((row, i) => (
            <ScoredRow key={`${row.bookName}:${row.entryId ?? row.comment}:${i}`} row={row} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ScoredRow({ row }: { row: ScoredEntryRow }): React.ReactElement {
  const t = useT()
  const cls = [
    'rt-entry',
    'rt-scored-row',
    row.fired ? 'rt-scored-fired' : '',
    row.disqualified ? 'rt-scored-dq' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <li className={cls}>
      <div className="rt-entry-head">
        <span className="rt-entry-book">{row.bookName}</span>
        <span className="rt-entry-name">{row.comment || t('debug.retrievalUnnamed')}</span>
      </div>
      <div className="rt-entry-meta">
        <span className="rt-chip rt-chip-score">{t('debug.scoreValue', { n: row.score })}</span>
        {row.constant && <span className="rt-chip rt-chip-reason">{t('debug.scoreConstant')}</span>}
        {row.disqualified && (
          <span className="rt-chip rt-chip-dq">{t('debug.scoreSecondaryGate')}</span>
        )}
        {row.keyHits.map((h, i) => (
          <span key={i} className="rt-chip rt-chip-keyhit">
            {h.pin
              ? t('debug.scoreKeyHitPin', { key: h.key, idf: h.idf })
              : t('debug.scoreKeyHitDepth', { key: h.key, idf: h.idf, depth: h.depth ?? 0 })}
          </span>
        ))}
        {row.linkBonus > 0 && row.linkFrom && (
          <span className="rt-chip rt-chip-link">
            {t('debug.scoreLink', { from: row.linkFrom, n: row.linkBonus })}
          </span>
        )}
        {row.probabilityFactor < 1 && (
          <span className="rt-chip rt-chip-prob">
            {t('debug.scoreProbFactor', { n: row.probabilityFactor })}
          </span>
        )}
      </div>
    </li>
  )
}

function PinStatus({
  result
}: {
  result: Extract<RetrievalPreviewResponse, { ok: true }>
}): React.ReactElement {
  const t = useT()
  const declared = result.pinPaths
  const extra = result.extraPinPaths
  const declaredResolved = result.resolvedPins.filter((p) => !p.adhoc)
  const adhocResolved = result.resolvedPins.filter((p) => p.adhoc)
  const declaredUnresolved = declared.filter(
    (p) => !result.resolvedPins.some((r) => r.path === p)
  )
  const pairs = (pins: { path: string; value: string }[]): string =>
    pins.map((p) => `${p.path}=${p.value}`).join(' · ')

  // Card-pin line: (a) none declared, no ad-hoc → identical-by-construction; else declared status.
  let cardLine: string
  let cardTone: 'muted' | 'ok' | 'warn'
  if (declared.length === 0 && extra.length === 0) {
    cardLine = t('debug.retrievalPinsNoneIdentical')
    cardTone = 'muted'
  } else if (declared.length === 0) {
    cardLine = t('debug.retrievalPinsNoCard')
    cardTone = 'muted'
  } else if (declaredResolved.length === 0) {
    cardLine = t('debug.retrievalPinsNoneResolved', { paths: declaredUnresolved.join(', ') })
    cardTone = 'warn'
  } else {
    cardLine = t('debug.retrievalPinsResolved', {
      count: declaredResolved.length,
      declared: declared.length,
      pairs: pairs(declaredResolved)
    })
    cardTone = 'ok'
  }

  return (
    <div className="rt-pinstatus">
      <span className={`rt-pinline rt-pinline-${cardTone}`}>{cardLine}</span>
      {extra.length > 0 && (
        <span className="rt-pinline rt-pinline-adhoc">
          {adhocResolved.length === 0
            ? t('debug.retrievalPinsAdhocNone', { paths: extra.join(', ') })
            : t('debug.retrievalPinsAdhocResolved', { pairs: pairs(adhocResolved) })}
        </span>
      )}
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
