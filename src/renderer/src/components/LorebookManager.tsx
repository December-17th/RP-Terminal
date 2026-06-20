import React, { useEffect, useState } from 'react'
import { useLorebookStore, LorebookEntry } from '../stores/lorebookStore'

interface Props {
  profileId: string
  characterId: string
  characterName: string
}

const splitKeys = (value: string): string[] => value.split(',').map((s) => s.trim())

export const LorebookManager: React.FC<Props> = ({
  profileId,
  characterId,
  characterName
}) => {
  const { lorebook, dirty, load, save, setName, addEntry, updateEntry, toggleEntry, deleteEntry } =
    useLorebookStore()
  const [expanded, setExpanded] = useState<number | null>(0)

  useEffect(() => {
    load(profileId, characterId)
  }, [profileId, characterId])

  const toggleExpand = (i: number): void => setExpanded((cur) => (cur === i ? null : i))

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 title={`Lorebook — ${characterName}`}>Lorebook · {characterName}</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>unsaved</span>}
          <button onClick={addEntry}>+ Entry</button>
          <button
            className="btn-accent"
            disabled={!dirty}
            onClick={() => save(profileId, characterId)}
          >
            Save
          </button>
        </div>
      </div>
      <div className="panel-body">
        <label className="field-label">Lorebook Name</label>
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
          </div>
        </div>
      )}
    </div>
  )
}
