import React, { useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import {
  DEFAULT_SCORING_PARAMS,
  type RetrievalPreviewResponse,
  type RetrievalTraceRow,
  type ScoredKeyHit,
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

/** One entry joined across the ST-keyword baseline, the +pins RPT retrieval, and the deterministic
 *  scorer — the unit of a comparison-table row. Joined on `bookName + entryIndex`. */
interface JoinedRow {
  key: string
  bookName: string
  entryIndex: number
  comment: string
  constant: boolean
  baseFired: boolean
  baseKey?: string
  rptFired: boolean
  rptKey?: string
  score: number
  scoreShare: number // score / max non-constant score (bar width)
  scoredFired: boolean // top-K (non-constant)
  disqualified: boolean
  rank: number | null
  keyHits: ScoredKeyHit[]
  linkBonus: number
  linkFrom?: string
  probabilityFactor: number
}

const rowKey = (r: { bookName: string; entryIndex: number }): string =>
  `${r.bookName} ${r.entryIndex}`

function RetrievalResult({
  result
}: {
  result: Extract<RetrievalPreviewResponse, { ok: true }>
}): React.ReactElement {
  const t = useT()
  const [showInert, setShowInert] = useState(false)
  const multiBook = result.lorebookNames.length > 1

  const { rows, constants, inertCount, summary } = useMemo(() => {
    const baseMap = new Map<string, RetrievalTraceRow>(result.baseline.map((r) => [rowKey(r), r]))
    const rptMap = new Map<string, RetrievalTraceRow>(result.rpt.map((r) => [rowKey(r), r]))
    // Rank (1-based) among the fired, non-constant scored rows — they appear in rank order in `scored`.
    const rankMap = new Map<string, number>()
    let rk = 0
    for (const s of result.scored) {
      if (s.fired && !s.constant) rankMap.set(rowKey(s), ++rk)
    }
    const maxScore = result.scored.reduce((m, s) => (!s.constant && s.score > m ? s.score : m), 0)

    const nonConstant: JoinedRow[] = []
    const constants: JoinedRow[] = []
    for (const s of result.scored) {
      const k = rowKey(s)
      const base = baseMap.get(k)
      const rpt = rptMap.get(k)
      const jr: JoinedRow = {
        key: k,
        bookName: s.bookName,
        entryIndex: s.entryIndex,
        comment: s.comment || s.keyHits[0]?.key || `#${s.entryIndex}`,
        constant: s.constant,
        baseFired: !!base?.fired,
        baseKey: base?.matchedKey,
        rptFired: !!rpt?.fired,
        rptKey: rpt?.matchedKey,
        score: s.score,
        scoreShare: maxScore > 0 ? s.score / maxScore : 0,
        scoredFired: s.fired && !s.constant,
        disqualified: !!s.disqualified,
        rank: rankMap.get(k) ?? null,
        keyHits: s.keyHits,
        linkBonus: s.linkBonus,
        linkFrom: s.linkFrom,
        probabilityFactor: s.probabilityFactor
      }
      ;(s.constant ? constants : nonConstant).push(jr)
    }
    // Order: score>0 (scorer's deterministic desc order) → zero-score keyword-fired → inert (hidden).
    const kw = (r: JoinedRow): boolean => r.baseFired || r.rptFired
    const scored = nonConstant.filter((r) => r.score > 0)
    const zeroFired = nonConstant.filter((r) => r.score === 0 && kw(r))
    const inert = nonConstant.filter((r) => r.score === 0 && !kw(r))
    const rows = [...scored, ...zeroFired, ...inert]

    const summary = {
      N: result.baseline.filter((r) => r.fired).length,
      M: result.rpt.filter((r) => r.fired).length,
      K: nonConstant.filter((r) => r.scoredFired).length,
      // Keyword-reference = the +pins RPT retrieval (a superset of the baseline).
      X: nonConstant.filter((r) => r.rptFired && !r.scoredFired).length,
      Y: nonConstant.filter((r) => r.scoredFired && !r.rptFired).length
    }
    return { rows, constants, inertCount: inert.length, summary }
  }, [result])

  const visible = showInert ? rows : rows.slice(0, rows.length - inertCount)
  const p = result.scoringParams

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

      <p className="rt-legend">{t('debug.retrievalTableLegend')}</p>
      <p className="rt-scored-params">
        {t('debug.scoreParams', { lambda: p.lambda, hop: p.hopDecay, pin: p.pinBoost, topK: p.topK })}
      </p>
      <p className="rt-summary">
        {t('debug.retrievalSummary', {
          n: summary.N,
          m: summary.M,
          k: summary.K,
          x: summary.X,
          y: summary.Y
        })}
      </p>

      {constants.length > 0 && (
        <details className="rt-const-strip" open={constants.length <= 10}>
          <summary>{t('debug.retrievalConstantStrip', { n: constants.length })}</summary>
          <div className="rt-const-list">
            {constants.map((c) => (
              <span key={c.key} className="rt-const-chip">
                {c.comment}
                {multiBook && <span className="rt-const-book"> · {c.bookName}</span>}
              </span>
            ))}
          </div>
        </details>
      )}

      {result.scored.length === 0 ? (
        <p className="rt-empty">{t('debug.retrievalNothingFired')}</p>
      ) : (
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead>
              <tr>
                <th className="rt-th-entry">{t('debug.retrievalTableEntry')}</th>
                <th>{t('debug.retrievalTableKeyword')}</th>
                <th>{t('debug.retrievalTablePins')}</th>
                <th>{t('debug.retrievalTableScored')}</th>
                <th className="rt-th-score">{t('debug.retrievalTableScore')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <RtRow key={row.key} row={row} multiBook={multiBook} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inertCount > 0 && (
        <button className="rt-inert-toggle" onClick={() => setShowInert((s) => !s)}>
          {showInert
            ? t('debug.retrievalHideInert')
            : t('debug.retrievalShowInert', { n: inertCount })}
        </button>
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

/** A fired/not cell for the ST-keyword and +Pins columns, with the matched key as tiny sub-text. */
function FiredMark({ fired, matchedKey }: { fired: boolean; matchedKey?: string }): React.ReactElement {
  if (!fired) return <span className="rt-mark-no">—</span>
  return (
    <span className="rt-mark-yes" title={matchedKey}>
      ✓{matchedKey && <span className="rt-mark-sub">{matchedKey}</span>}
    </span>
  )
}

/** Strongest-2 keyHits + link/probability as a compact, truncatable evidence line. */
const compactEvidence = (row: JoinedRow): string => {
  const parts: string[] = []
  for (const h of [...row.keyHits].sort((a, b) => b.weight - a.weight).slice(0, 2)) {
    parts.push(h.pin ? `${h.key}·PIN` : `${h.key}·d${h.depth ?? 0}`)
  }
  if (row.linkBonus > 0) parts.push('+link')
  if (row.probabilityFactor < 1) parts.push(`×p${row.probabilityFactor}`)
  return parts.join('  ')
}

/** The full click-to-expand chip breakdown (reuses the original PoC chip rendering). */
function ScoredChips({ row }: { row: JoinedRow }): React.ReactElement {
  const t = useT()
  return (
    <div className="rt-entry-meta">
      <span className="rt-chip rt-chip-score">{t('debug.scoreValue', { n: row.score })}</span>
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
  )
}

/** One comparison-table row. The whole row toggles the full evidence breakdown; the tint encodes the
 *  scorer-vs-retrieval delta (added = scorer-only fire, dropped = keyword-only fire). */
function RtRow({ row, multiBook }: { row: JoinedRow; multiBook: boolean }): React.ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const tint = row.scoredFired && !row.rptFired
    ? 'rt-row-added'
    : row.rptFired && !row.scoredFired
      ? 'rt-row-dropped'
      : ''
  return (
    <>
      <tr className={`rt-row ${tint}`} onClick={() => setOpen((o) => !o)}>
        <td className="rt-td-entry">
          <span className="rt-td-caret">{open ? '▾' : '▸'}</span>
          <span className="rt-td-name">{row.comment}</span>
          {multiBook && <span className="rt-td-book">{row.bookName}</span>}
        </td>
        <td className="rt-td-mark">
          <FiredMark fired={row.baseFired} matchedKey={row.baseKey} />
        </td>
        <td className={`rt-td-mark${row.rptFired !== row.baseFired ? ' rt-cell-delta' : ''}`}>
          <FiredMark fired={row.rptFired} matchedKey={row.rptKey} />
        </td>
        <td className="rt-td-scored">
          {row.rank !== null ? (
            <span className="rt-scored-yes">✓ {t('debug.retrievalScoredRank', { n: row.rank })}</span>
          ) : row.disqualified ? (
            <span className="rt-scored-gate">{t('debug.retrievalScoredGate')}</span>
          ) : (
            <span className="rt-mark-no">—</span>
          )}
        </td>
        <td className="rt-td-score">
          <div className="rt-score-num">{row.score}</div>
          <div className="rt-bar">
            <div className="rt-bar-fill" style={{ width: `${Math.round(row.scoreShare * 100)}%` }} />
          </div>
          <div className="rt-evidence" title={compactEvidence(row)}>
            {compactEvidence(row)}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="rt-row-detail">
          <td colSpan={5}>
            <ScoredChips row={row} />
          </td>
        </tr>
      )}
    </>
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
