import React, { useEffect, useMemo, useState } from 'react'
import { useLorebookStore, LorebookEntry } from '../stores/lorebookStore'
import { useT } from '../i18n'

interface Props {
  profileId: string
  characterId: string
  characterName: string
  /** Active session, if any — enables the "active in this session" selection. */
  chatId: string | null
}

const splitKeys = (value: string): string[] => value.split(',').map((s) => s.trim())

/** Case-insensitive match of a (lowercased) query against an entry's title, keys, and content. */
const entryMatches = (e: LorebookEntry, q: string): boolean =>
  [e.comment, ...e.keys, ...e.secondary_keys, e.content].join('\n').toLowerCase().includes(q)

export const LorebookManager: React.FC<Props> = ({
  profileId,
  characterId,
  characterName,
  chatId
}) => {
  const {
    library,
    currentId,
    lorebook,
    dirty,
    sessionIds,
    loadLibrary,
    open,
    createNew,
    importLorebook,
    exportCurrent,
    removeCurrent,
    save,
    loadSession,
    setSession,
    setName,
    addEntry,
    updateEntry,
    toggleEntry,
    deleteEntry
  } = useLorebookStore()
  // Entries start collapsed; the user expands the one they want.
  const [expanded, setExpanded] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const t = useT()

  // Load the library and open the character's own lorebook (id == characterId).
  useEffect(() => {
    loadLibrary(profileId)
    open(profileId, characterId)
  }, [profileId, characterId])

  useEffect(() => {
    if (chatId) loadSession(profileId, chatId)
  }, [profileId, chatId])

  // Lorebooks selectable in the dropdown — always include the character's own book,
  // even before it's been saved to disk.
  const options = useMemo(() => {
    const map = new Map(library.map((l) => [l.id, l.name]))
    if (!map.has(characterId)) map.set(characterId, t('lore.cardSuffix', { name: characterName }))
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [library, characterId, characterName])

  // Effective active-set for the session: an explicit list, or the default (own book).
  const effective = sessionIds ?? [characterId]
  const toggleSession = (id: string): void => {
    if (!chatId) return
    const next = effective.includes(id) ? effective.filter((i) => i !== id) : [...effective, id]
    setSession(profileId, chatId, next)
  }

  const toggleExpand = (i: number): void => setExpanded((cur) => (cur === i ? null : i))

  // Entries paired with their store index (so toggle/edit/delete still target the right one),
  // shown in insertion_order (low → high) to match the order they're injected into the prompt,
  // then filtered by the search query. Sort is stable, so equal-order entries keep stored order.
  const q = query.trim().toLowerCase()
  const indexed = (lorebook?.entries ?? [])
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.insertion_order - b.entry.insertion_order)
  const visible = q ? indexed.filter(({ entry }) => entryMatches(entry, q)) : indexed

  // Switching/creating a lorebook replaces the editor — confirm first if there are
  // unsaved edits, so a stray dropdown change can't silently discard them.
  const guardDirty = (): boolean => !dirty || confirm(t('lore.confirmDiscard'))

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 title={t('lore.headingTitle', { name: characterName })}>{t('lore.heading')}</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{t('common.unsaved')}</span>}
          <button onClick={() => guardDirty() && createNew(profileId)}>{t('common.new')}</button>
          <button
            className="btn-ghost"
            title={t('lore.importTitle')}
            onClick={() => guardDirty() && importLorebook(profileId)}
          >
            {t('common.import')}
          </button>
          <button
            className="btn-ghost"
            disabled={!currentId}
            title={t('lore.exportTitle')}
            onClick={() => exportCurrent(profileId)}
          >
            {t('common.export')}
          </button>
          <button className="btn-accent" disabled={!dirty} onClick={() => save(profileId)}>
            {t('common.save')}
          </button>
        </div>
      </div>
      <div className="panel-body">
        {chatId && (
          <>
            <label className="field-label">{t('lore.activeInSession')}</label>
            <div className="lorebook-select-list">
              {options.map((o) => (
                <label key={o.id} className="lorebook-select-item">
                  <input
                    type="checkbox"
                    checked={effective.includes(o.id)}
                    onChange={() => toggleSession(o.id)}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </div>
            <div
              style={{
                fontSize: '0.76em',
                color: 'var(--rpt-text-secondary)',
                margin: '4px 0 14px'
              }}
            >
              {t('lore.activeHint')} {sessionIds === null && <em>{t('lore.activeHintDefault')}</em>}
            </div>
          </>
        )}

        <label className="field-label">{t('lore.editing')}</label>
        <div className="preset-select-row">
          <select
            value={currentId ?? ''}
            onChange={(e) => guardDirty() && open(profileId, e.target.value)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-actions">
          <button
            onClick={() => {
              // New entries prepend (index 0). Clear any search so it isn't filtered out,
              // and expand it so it's ready to edit.
              addEntry()
              setQuery('')
              setExpanded(0)
            }}
          >
            {t('lore.addEntry')}
          </button>
          <button
            className="btn-ghost danger"
            disabled={currentId === characterId}
            title={currentId === characterId ? t('lore.ownCantDelete') : t('lore.deleteThis')}
            onClick={() => {
              if (confirm(t('lore.confirmDelete'))) removeCurrent(profileId)
            }}
          >
            {t('lore.deleteLorebook')}
          </button>
        </div>

        <label className="field-label" style={{ marginTop: 14 }}>
          {t('lore.name')}
        </label>
        <input value={lorebook?.name || ''} onChange={(e) => setName(e.target.value)} />

        {lorebook && lorebook.entries.length > 0 && (
          <div className="lore-search-row">
            <input
              className="lore-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('lore.searchPlaceholder')}
            />
            {q && (
              <span className="lore-search-count">
                {t('lore.searchCount', { shown: visible.length, total: lorebook.entries.length })}
              </span>
            )}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {!lorebook || lorebook.entries.length === 0 ? (
            <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
              {t('lore.noEntries')}
            </div>
          ) : visible.length === 0 ? (
            <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
              {t('lore.noMatches', { query })}
            </div>
          ) : (
            visible.map(({ entry, i }) => (
              <EntryCard
                key={i}
                entry={entry}
                expanded={expanded === i}
                onToggleExpand={() => toggleExpand(i)}
                onToggleEnabled={() => toggleEntry(i)}
                onChange={(patch) => updateEntry(i, patch)}
                onDelete={() => deleteEntry(i)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

interface EntryCardProps {
  entry: LorebookEntry
  expanded: boolean
  onToggleExpand: () => void
  onToggleEnabled: () => void
  onChange: (patch: Partial<LorebookEntry>) => void
  onDelete: () => void
}

const EntryCard: React.FC<EntryCardProps> = ({
  entry,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onChange,
  onDelete
}) => {
  const t = useT()
  return (
    <div className={`entry-card ${entry.enabled ? '' : 'disabled'}`}>
      <div className="entry-head">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={onToggleEnabled}
          title={t('lore.enabled')}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="entry-head-main" onClick={onToggleExpand}>
          <span className="entry-title">
            {entry.comment || entry.keys[0] || t('lore.untitledEntry')}
          </span>
          <span className="entry-keys-preview">
            {entry.constant
              ? t('lore.constantBadge')
              : entry.keys.filter(Boolean).join(', ') || t('lore.noKeys')}
          </span>
        </div>
        <span className="entry-order" title={t('lore.insertionOrder')}>
          #{entry.insertion_order}
        </span>
        <button className="btn-ghost" onClick={onToggleExpand}>
          {expanded ? '▾' : '▸'}
        </button>
        <button className="btn-ghost danger" onClick={onDelete} title={t('lore.deleteEntry')}>
          🗑
        </button>
      </div>

      {expanded && (
        <div className="entry-body">
          <label className="field-label">{t('lore.titleMemo')}</label>
          <input value={entry.comment} onChange={(e) => onChange({ comment: e.target.value })} />

          <label className="field-label">{t('lore.primaryKeys')}</label>
          <input
            value={entry.keys.join(', ')}
            onChange={(e) => onChange({ keys: splitKeys(e.target.value) })}
            placeholder={t('lore.primaryKeysPh')}
          />

          <label className="field-label">{t('lore.secondaryKeys')}</label>
          <input
            value={entry.secondary_keys.join(', ')}
            onChange={(e) => onChange({ secondary_keys: splitKeys(e.target.value) })}
          />

          <label className="field-label">{t('lore.content')}</label>
          <textarea
            className="entry-content"
            value={entry.content}
            onChange={(e) => onChange({ content: e.target.value })}
            placeholder={t('lore.contentPh')}
          />

          <div className="entry-toggles">
            <label>
              <input
                type="checkbox"
                checked={entry.constant}
                onChange={(e) => onChange({ constant: e.target.checked })}
              />
              {t('lore.constantToggle')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={entry.selective}
                onChange={(e) => onChange({ selective: e.target.checked })}
              />
              {t('lore.selective')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={entry.case_sensitive}
                onChange={(e) => onChange({ case_sensitive: e.target.checked })}
              />
              {t('lore.caseSensitive')}
            </label>
            <label title={t('lore.noRecursionInTitle')}>
              <input
                type="checkbox"
                checked={entry.exclude_recursion}
                onChange={(e) => onChange({ exclude_recursion: e.target.checked })}
              />
              {t('lore.noRecursionIn')}
            </label>
            <label title={t('lore.noRecursionOutTitle')}>
              <input
                type="checkbox"
                checked={entry.prevent_recursion}
                onChange={(e) => onChange({ prevent_recursion: e.target.checked })}
              />
              {t('lore.noRecursionOut')}
            </label>
            <label className="order-field">
              {t('lore.order')}
              <input
                type="number"
                value={entry.insertion_order}
                onChange={(e) => onChange({ insertion_order: Number(e.target.value) })}
              />
            </label>
            <label className="order-field" title={t('lore.depthTitle')}>
              {t('lore.depth')}
              <input
                type="number"
                min={0}
                placeholder="top"
                value={entry.insertion_depth ?? ''}
                onChange={(e) =>
                  onChange({
                    insertion_depth: e.target.value === '' ? null : Number(e.target.value)
                  })
                }
              />
            </label>
            <label className="order-field" title={t('lore.probTitle')}>
              {t('lore.prob')}
              <input
                type="number"
                min={0}
                max={100}
                value={entry.probability}
                onChange={(e) => onChange({ probability: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
