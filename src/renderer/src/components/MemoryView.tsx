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
  salience: number
  pinned: boolean
  turnStart: number | null
  turnEnd: number | null
}

const secondary = { color: 'var(--rpt-text-secondary)' }

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

  const refresh = useCallback(async () => {
    if (!activeChatId) {
      setEntries([])
      return
    }
    setLoading(true)
    try {
      const rows = await api().memoryList(profileId, activeChatId)
      setEntries(Array.isArray(rows) ? rows : [])
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
    await api().memoryUpdate(profileId, activeChatId, id, {
      summary: draftSummary.trim(),
      keywords
    })
    setEditingId(null)
    await refresh()
  }

  const togglePin = async (e: MemoryEntry): Promise<void> => {
    await api().memoryUpdate(profileId, activeChatId, e.id, { pinned: !e.pinned })
    await refresh()
  }

  const remove = async (e: MemoryEntry): Promise<void> => {
    if (!window.confirm(t('memory.confirmDelete'))) return
    await api().memoryDelete(profileId, activeChatId, e.id)
    await refresh()
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
    await api().memoryAdd(profileId, activeChatId, summary, keywords)
    cancelAdd()
    await refresh()
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
                      <span style={{ ...secondary, fontSize: '0.72em' }}>
                        {e.turnStart != null
                          ? t('memory.turns', { a: e.turnStart, b: e.turnEnd ?? e.turnStart })
                          : ''}
                        {e.entityKey ? ` · ${e.entityKey}` : ''}
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
