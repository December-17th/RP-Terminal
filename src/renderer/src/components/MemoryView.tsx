import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useT } from '../i18n'

/**
 * Memory data-management view (docs/episodic-memory-design.md §11.F / §17): browse the stored
 * long-term memories for the active chat, grouped by collection, and correct them — **pin**
 * (always-recall), **edit** (fix a bad summary / keywords), or **delete** (kill a continuity
 * error). This is what makes memory trustworthy: the player can see and fix what the AI remembers.
 */

// window.api is the untyped preload bridge (combatStore-style). Memory rows mirror the main
// `MemoryEntry` (camelCase).
const api = (): any => (window as unknown as { api: any }).api

interface MemoryEntry {
  id: string
  collection: string
  entityKey: string | null
  summary: string
  keywords: string[]
  /** Entity rows: aliases. */
  entities: string[]
  /** Entity rows: the sheet { aliases, fields, log }. */
  payload: unknown
  salience: number
  pinned: boolean
  turnStart: number | null
  turnEnd: number | null
}

/** An entity row's parsed sheet (loose — the payload is whatever was stored). */
interface EntitySheetView {
  fields?: Record<string, string>
  log?: { turn: string; note: string }[]
}

const secondary = { color: 'var(--rpt-text-secondary)' }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function MemoryView({ profileId }: { profileId: string }): React.ReactElement {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const t = useT()
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftSummary, setDraftSummary] = useState('')
  const [draftKeywords, setDraftKeywords] = useState('')
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [newSummary, setNewSummary] = useState('')
  const [newKeywords, setNewKeywords] = useState('')
  // The "why recalled" set is tagged with its chat so a previous chat's highlights never bleed
  // through after switching (we filter by chatId at render rather than resetting on switch).
  const [recalled, setRecalled] = useState<{ chatId: string; ids: Set<string> }>({
    chatId: '',
    ids: new Set()
  })
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!activeChatId) {
      setEntries([])
      return
    }
    setLoading(true)
    try {
      const rows = await api().memoryList(profileId, activeChatId)
      setEntries(Array.isArray(rows) ? rows : [])
      setError(null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [profileId, activeChatId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Live-refresh when the writer appends a batch (or another panel edits) for this chat.
  useEffect(() => {
    const unsub = api().onMemoryChanged?.((payload: { chatId: string }) => {
      if (payload?.chatId === activeChatId) void refresh()
    })
    return () => unsub?.()
  }, [activeChatId, refresh])

  // Transient "why recalled" highlight: which memories the latest turn pulled in, tagged with the
  // originating chat. Filtered to the active chat at render, so no reset-on-switch is needed.
  useEffect(() => {
    const unsub = api().onMemoryRecalled?.((payload: { chatId: string; ids: string[] }) => {
      if (payload?.chatId) setRecalled({ chatId: payload.chatId, ids: new Set(payload.ids ?? []) })
    })
    return () => unsub?.()
  }, [])

  if (!activeChatId) return <div style={{ opacity: 0.5 }}>{t('memory.waiting')}</div>

  const startEdit = (e: MemoryEntry): void => {
    setEditingId(e.id)
    setDraftSummary(e.summary)
    setDraftKeywords(e.keywords.join(', '))
  }

  const saveEdit = async (id: string): Promise<void> => {
    const keywords = draftKeywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    try {
      await api().memoryUpdate(profileId, activeChatId, id, {
        summary: draftSummary.trim(),
        keywords
      })
      setEditingId(null) // keep the editor open on failure so the draft isn't lost
      setError(null)
      await refresh()
    } catch (e) {
      setError(errText(e))
    }
  }

  const togglePin = async (e: MemoryEntry): Promise<void> => {
    try {
      await api().memoryUpdate(profileId, activeChatId, e.id, { pinned: !e.pinned })
      setError(null)
      await refresh()
    } catch (err) {
      setError(errText(err))
    }
  }

  const remove = async (e: MemoryEntry): Promise<void> => {
    if (!window.confirm(t('memory.confirmDelete'))) return
    try {
      await api().memoryDelete(profileId, activeChatId, e.id)
      setError(null)
      await refresh()
    } catch (err) {
      setError(errText(err))
    }
  }

  const cancelAdd = (): void => {
    setAdding(false)
    setNewSummary('')
    setNewKeywords('')
  }

  const addMemory = async (): Promise<void> => {
    const summary = newSummary.trim()
    if (!summary) return
    const keywords = newKeywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    try {
      await api().memoryAdd(profileId, activeChatId, summary, keywords)
      cancelAdd() // leave the form open on failure so the input isn't lost
      setError(null)
      await refresh()
    } catch (e) {
      setError(errText(e))
    }
  }

  // Render an entity record (character / location) as a sheet: name + aliases + fields + history.
  const entitySheet = (e: MemoryEntry): React.ReactElement => {
    const sheet = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as EntitySheetView
    const fields = sheet.fields && typeof sheet.fields === 'object' ? sheet.fields : {}
    const log = Array.isArray(sheet.log) ? sheet.log : []
    return (
      <>
        <div style={{ fontWeight: 600 }}>{e.entityKey}</div>
        {e.entities.length ? (
          <div style={{ ...secondary, fontSize: '0.72em', marginTop: 2 }}>
            {t('memory.aka')} {e.entities.join(', ')}
          </div>
        ) : null}
        {Object.keys(fields).length ? (
          <div style={{ marginTop: 6 }}>
            {Object.entries(fields).map(([k, v]) => (
              <div key={k} style={{ fontSize: '0.85em', lineHeight: 1.5 }}>
                <span style={secondary}>{k}: </span>
                {v}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ lineHeight: 1.5 }}>{e.summary}</div>
        )}
        {log.length ? (
          <details style={{ marginTop: 6 }}>
            <summary style={{ ...secondary, fontSize: '0.72em', cursor: 'pointer' }}>
              {t('memory.history', { count: log.length })}
            </summary>
            <div style={{ marginTop: 4 }}>
              {log.map((l, i) => (
                <div
                  key={`${l.turn}:${i}`}
                  style={{ ...secondary, fontSize: '0.78em', lineHeight: 1.5 }}
                >
                  {l.turn ? `${l.turn}: ` : ''}
                  {l.note}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </>
    )
  }

  const q = filter.trim().toLowerCase()
  const matches = (e: MemoryEntry): boolean =>
    !q ||
    `${e.summary} ${e.keywords.join(' ')} ${e.entityKey ?? ''} ${e.collection}`
      .toLowerCase()
      .includes(q)
  const visible = entries.filter(matches)
  const collections = Array.from(new Set(visible.map((e) => e.collection)))

  return (
    <div>
      <h3
        style={{
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        {t('memory.heading')}
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ ...secondary, fontSize: '0.62em' }}>
            {t('memory.count', { count: entries.length })}
          </span>
          <button
            style={{ fontSize: '0.62em', padding: '3px 8px', fontWeight: 400 }}
            onClick={() => setAdding((v) => !v)}
          >
            {t('memory.add')}
          </button>
          <button
            className="btn-accent"
            style={{ fontSize: '0.62em', padding: '3px 8px', fontWeight: 400 }}
            onClick={() => void refresh()}
          >
            {t('memory.refresh')}
          </button>
        </span>
      </h3>

      {error ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid var(--rpt-danger, #e55)',
            color: 'var(--rpt-danger, #e55)',
            fontSize: '0.8em'
          }}
        >
          {t('memory.actionFailed')}: {error}
        </div>
      ) : null}

      {adding ? (
        <div
          style={{
            border: '1px solid var(--rpt-border)',
            borderRadius: 6,
            padding: '8px 10px',
            marginTop: 10
          }}
        >
          <textarea
            value={newSummary}
            rows={2}
            placeholder={t('memory.addSummaryPh')}
            onChange={(e) => setNewSummary(e.target.value)}
            style={{ width: '100%' }}
          />
          <input
            value={newKeywords}
            placeholder={t('memory.keywordsPh')}
            onChange={(e) => setNewKeywords(e.target.value)}
            style={{ width: '100%', marginTop: 6 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn-accent"
              disabled={!newSummary.trim()}
              onClick={() => void addMemory()}
            >
              {t('memory.add')}
            </button>
            <button onClick={cancelAdd}>{t('memory.cancel')}</button>
          </div>
        </div>
      ) : null}

      {entries.length ? (
        <input
          value={filter}
          placeholder={t('memory.filterPh')}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: '100%', marginTop: 10 }}
        />
      ) : null}

      {loading && !entries.length ? (
        <div style={{ opacity: 0.5 }}>{t('memory.loading')}</div>
      ) : null}
      {!loading && !entries.length ? (
        <div style={{ opacity: 0.6, marginTop: 12 }}>
          <em>{t('memory.empty')}</em>
        </div>
      ) : null}
      {!loading && entries.length > 0 && visible.length === 0 ? (
        <div style={{ opacity: 0.6, marginTop: 12 }}>
          <em>{t('memory.noMatches')}</em>
        </div>
      ) : null}

      {collections.map((coll) => (
        <div key={coll} style={{ marginTop: 16 }}>
          <div
            style={{
              ...secondary,
              fontSize: '0.72em',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6
            }}
          >
            {coll}
          </div>
          {visible
            .filter((e) => e.collection === coll)
            .map((e) => (
              <div
                key={e.id}
                style={{
                  border: '1px solid var(--rpt-border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 8,
                  background: e.pinned
                    ? 'var(--rpt-bg-elevated, rgba(255,255,255,0.03))'
                    : undefined
                }}
              >
                {editingId === e.id ? (
                  <>
                    <textarea
                      value={draftSummary}
                      rows={2}
                      onChange={(ev) => setDraftSummary(ev.target.value)}
                      style={{ width: '100%' }}
                    />
                    <input
                      value={draftKeywords}
                      placeholder={t('memory.keywordsPh')}
                      onChange={(ev) => setDraftKeywords(ev.target.value)}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button className="btn-accent" onClick={() => void saveEdit(e.id)}>
                        {t('common.save')}
                      </button>
                      <button onClick={() => setEditingId(null)}>{t('memory.cancel')}</button>
                    </div>
                  </>
                ) : e.entityKey ? (
                  entitySheet(e)
                ) : (
                  <>
                    <div style={{ lineHeight: 1.5 }}>{e.summary}</div>
                    {e.keywords.length ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {e.keywords.map((k) => (
                          <span
                            key={k}
                            style={{
                              ...secondary,
                              fontSize: '0.72em',
                              border: '1px solid var(--rpt-border)',
                              borderRadius: 10,
                              padding: '1px 7px'
                            }}
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginTop: 8,
                        gap: 8
                      }}
                    >
                      <span
                        style={{
                          ...secondary,
                          fontSize: '0.72em',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6
                        }}
                      >
                        {recalled.chatId === activeChatId && recalled.ids.has(e.id) ? (
                          <span
                            title={t('memory.recalledTitle')}
                            style={{ color: 'var(--rpt-accent, #6cf)', fontWeight: 600 }}
                          >
                            ● {t('memory.recalled')}
                          </span>
                        ) : null}
                        <span>
                          {e.turnStart != null
                            ? t('memory.turns', { a: e.turnStart, b: e.turnEnd ?? e.turnStart })
                            : ''}
                        </span>
                      </span>
                      <span style={{ display: 'flex', gap: 6 }}>
                        <button
                          title={e.pinned ? t('memory.unpin') : t('memory.pin')}
                          onClick={() => void togglePin(e)}
                          style={{ padding: '2px 8px' }}
                        >
                          {e.pinned ? '★' : '☆'}
                        </button>
                        <button onClick={() => startEdit(e)} style={{ padding: '2px 8px' }}>
                          {t('common.edit')}
                        </button>
                        <button onClick={() => void remove(e)} style={{ padding: '2px 8px' }}>
                          {t('common.delete')}
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}
