import React, { useEffect, useMemo, useState } from 'react'
import { useLorebookStore, LorebookEntry } from '../stores/lorebookStore'

interface Props {
  profileId: string
  characterId: string
  characterName: string
  /** Active session, if any — enables the "active in this session" selection. */
  chatId: string | null
}

const splitKeys = (value: string): string[] => value.split(',').map((s) => s.trim())

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
  const [expanded, setExpanded] = useState<number | null>(0)

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
    if (!map.has(characterId)) map.set(characterId, `${characterName} (card)`)
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [library, characterId, characterName])

  // Effective active-set for the session: an explicit list, or the default (own book).
  const effective = sessionIds ?? [characterId]
  const toggleSession = (id: string): void => {
    if (!chatId) return
    const next = effective.includes(id)
      ? effective.filter((i) => i !== id)
      : [...effective, id]
    setSession(profileId, chatId, next)
  }

  const toggleExpand = (i: number): void => setExpanded((cur) => (cur === i ? null : i))

  // Switching/creating a lorebook replaces the editor — confirm first if there are
  // unsaved edits, so a stray dropdown change can't silently discard them.
  const guardDirty = (): boolean => !dirty || confirm('Discard unsaved changes to this lorebook?')

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 title={`Lorebooks — ${characterName}`}>Lorebooks</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>unsaved</span>}
          <button onClick={() => guardDirty() && createNew(profileId)}>+ New</button>
          <button
            className="btn-ghost"
            title="Import an ST world-info / lorebook JSON as a new lorebook"
            onClick={() => guardDirty() && importLorebook(profileId)}
          >
            Import
          </button>
          <button
            className="btn-ghost"
            disabled={!currentId}
            title="Export this lorebook to a JSON file"
            onClick={() => exportCurrent(profileId)}
          >
            Export
          </button>
          <button className="btn-accent" disabled={!dirty} onClick={() => save(profileId)}>
            Save
          </button>
        </div>
      </div>
      <div className="panel-body">
        {chatId && (
          <>
            <label className="field-label">Active in this session</label>
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
            <div style={{ fontSize: '0.76em', color: 'var(--rpt-text-secondary)', margin: '4px 0 14px' }}>
              All checked lorebooks are scanned together each turn.{' '}
              {sessionIds === null && <em>(default: this character&apos;s own lorebook)</em>}
            </div>
          </>
        )}

        <label className="field-label">Editing</label>
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
          <button onClick={addEntry}>+ Entry</button>
          <button
            className="btn-ghost danger"
            disabled={currentId === characterId}
            title={
              currentId === characterId
                ? "A character's own lorebook can't be deleted here"
                : 'Delete this lorebook'
            }
            onClick={() => {
              if (confirm('Delete this lorebook? This cannot be undone.')) removeCurrent(profileId)
            }}
          >
            Delete Lorebook
          </button>
        </div>

        <label className="field-label" style={{ marginTop: 14 }}>
          Lorebook Name
        </label>
        <input value={lorebook?.name || ''} onChange={(e) => setName(e.target.value)} />

        <div style={{ marginTop: 12 }}>
          {!lorebook || lorebook.entries.length === 0 ? (
            <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
              No entries yet. Click “+ Entry” to create one.
            </div>
          ) : (
            lorebook.entries.map((entry, i) => (
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
  return (
    <div className={`entry-card ${entry.enabled ? '' : 'disabled'}`}>
      <div className="entry-head">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={onToggleEnabled}
          title="Enabled"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="entry-head-main" onClick={onToggleExpand}>
          <span className="entry-title">{entry.comment || entry.keys[0] || 'Untitled Entry'}</span>
          <span className="entry-keys-preview">
            {entry.constant ? '🔵 constant' : entry.keys.filter(Boolean).join(', ') || 'no keys'}
          </span>
        </div>
        <span className="entry-order" title="Insertion order">
          #{entry.insertion_order}
        </span>
        <button className="btn-ghost" onClick={onToggleExpand}>
          {expanded ? '▾' : '▸'}
        </button>
        <button className="btn-ghost danger" onClick={onDelete} title="Delete entry">
          🗑
        </button>
      </div>

      {expanded && (
        <div className="entry-body">
          <label className="field-label">Title / Memo</label>
          <input value={entry.comment} onChange={(e) => onChange({ comment: e.target.value })} />

          <label className="field-label">Primary Keywords (comma-separated)</label>
          <input
            value={entry.keys.join(', ')}
            onChange={(e) => onChange({ keys: splitKeys(e.target.value) })}
            placeholder="e.g. castle, fortress, keep"
          />

          <label className="field-label">Secondary Keywords (optional)</label>
          <input
            value={entry.secondary_keys.join(', ')}
            onChange={(e) => onChange({ secondary_keys: splitKeys(e.target.value) })}
          />

          <label className="field-label">Content</label>
          <textarea
            className="entry-content"
            value={entry.content}
            onChange={(e) => onChange({ content: e.target.value })}
            placeholder="Text injected into the prompt when this entry triggers."
          />

          <div className="entry-toggles">
            <label>
              <input
                type="checkbox"
                checked={entry.constant}
                onChange={(e) => onChange({ constant: e.target.checked })}
              />
              Constant (always on)
            </label>
            <label>
              <input
                type="checkbox"
                checked={entry.selective}
                onChange={(e) => onChange({ selective: e.target.checked })}
              />
              Selective (needs secondary)
            </label>
            <label>
              <input
                type="checkbox"
                checked={entry.case_sensitive}
                onChange={(e) => onChange({ case_sensitive: e.target.checked })}
              />
              Case sensitive
            </label>
            <label className="order-field">
              Order
              <input
                type="number"
                value={entry.insertion_order}
                onChange={(e) => onChange({ insertion_order: Number(e.target.value) })}
              />
            </label>
            <label className="order-field" title="Messages up from the bottom of the chat. Blank = top (World Info block).">
              Depth
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
            <label className="order-field" title="Chance this entry fires when matched (100 = always).">
              Prob %
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
