import React, { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { usePresetStore, PresetParameters, PromptMarker } from '../stores/presetStore'

interface Props {
  profileId: string
}

const MARKER_LABEL: Record<PromptMarker, string> = {
  none: '',
  char_description: 'Character',
  mes_example: 'Examples',
  world_info: 'World Info',
  chat_history: 'Chat History',
  post_history: 'Post-History'
}

const OPTIONAL_PARAMS: Array<keyof PresetParameters> = [
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'min_p',
  'top_a'
]

export const PresetManager: React.FC<Props> = ({ profileId }) => {
  const {
    presets,
    activeId,
    preset,
    dirty,
    load,
    select,
    createNew,
    importPreset,
    remove,
    save,
    setName,
    setParam,
    updateBlock,
    toggleBlock,
    moveBlock,
    addBlock,
    deleteBlock
  } = usePresetStore()
  const [editing, setEditing] = useState<number | null>(null)

  useEffect(() => {
    load(profileId)
  }, [profileId])

  const numField = (
    key: keyof PresetParameters,
    label: string,
    required = false
  ): React.ReactNode => {
    if (!preset) return null
    const v = preset.parameters[key]
    return (
      <label className="param-field" key={key}>
        <span>{label}</span>
        <input
          type="number"
          step="0.01"
          value={v ?? ''}
          placeholder={required ? '' : 'unset'}
          onChange={(e) =>
            setParam(key, e.target.value === '' ? undefined : Number(e.target.value))
          }
        />
      </label>
    )
  }

  const editingBlock = editing !== null ? preset?.prompts[editing] : undefined

  // Switching/creating/importing a preset replaces the editor — confirm first if
  // there are unsaved edits so a stray change can't silently discard them.
  const guardDirty = (): boolean => !dirty || confirm('Discard unsaved changes to this preset?')

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Preset</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>unsaved</span>}
          <button className="btn-accent" disabled={!dirty} onClick={() => save(profileId)}>
            Save
          </button>
        </div>
      </div>

      <div className="panel-body">
        {/* Preset selector */}
        <label className="field-label">Active Preset</label>
        <div className="preset-select-row">
          <select
            value={activeId ?? ''}
            onChange={(e) => guardDirty() && select(profileId, e.target.value)}
            disabled={presets.length === 0}
          >
            {presets.length === 0 && <option value="">(no presets)</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-actions">
          <button onClick={() => guardDirty() && createNew(profileId)}>+ New</button>
          <button className="btn-ghost" onClick={() => guardDirty() && importPreset(profileId)}>
            Import ST
          </button>
          <button
            className="btn-ghost danger"
            disabled={!activeId}
            onClick={() => {
              if (confirm('Delete this preset? This cannot be undone.')) remove(profileId)
            }}
          >
            Delete
          </button>
        </div>

        {!preset ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic', marginTop: 16 }}>
            No preset selected. Create a new one or import a SillyTavern preset.
          </div>
        ) : (
          <>
            <label className="field-label" style={{ marginTop: 16 }}>
              Preset Name
            </label>
            <input value={preset.name} onChange={(e) => setName(e.target.value)} />

            <h4 style={{ marginBottom: 8 }}>Generation Parameters</h4>
            <div className="param-grid">
              {numField('temperature', 'Temperature', true)}
              {numField('max_tokens', 'Max Tokens', true)}
              {OPTIONAL_PARAMS.map((k) => numField(k, k.replace(/_/g, ' ')))}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 16
              }}
            >
              <h4 style={{ margin: 0 }}>
                Prompt Manager{' '}
                <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(top → bottom)</span>
              </h4>
              <button onClick={addBlock}>+ Prompt</button>
            </div>

            {preset.prompts.length === 0 && (
              <div style={{ opacity: 0.6, fontStyle: 'italic', marginTop: 8 }}>
                Empty preset — add prompt blocks, or just send chat history as-is.
              </div>
            )}

            {preset.prompts.map((block, i) => {
              const markerLabel = MARKER_LABEL[block.marker]
              const isDynamic = block.marker !== 'none'
              return (
                <div
                  key={block.identifier}
                  className={`prompt-row ${block.enabled ? '' : 'disabled'}`}
                >
                  <div className="prompt-row-head">
                    <input
                      type="checkbox"
                      checked={block.enabled}
                      onChange={() => toggleBlock(i)}
                      title="Enabled"
                    />
                    <span className="prompt-name" onClick={() => setEditing(i)} title="Edit">
                      {block.name || block.identifier}
                    </span>
                    {markerLabel ? (
                      <span className="marker-badge">{markerLabel}</span>
                    ) : (
                      <span className="role-badge">{block.role}</span>
                    )}
                    {block.injection_depth != null && (
                      <span
                        className="marker-badge"
                        title="Injected into chat history at this depth"
                      >
                        @{block.injection_depth}
                      </span>
                    )}
                    <div className="prompt-actions">
                      <button
                        className="btn-ghost"
                        disabled={i === 0}
                        onClick={() => moveBlock(i, -1)}
                      >
                        ▲
                      </button>
                      <button
                        className="btn-ghost"
                        disabled={i === preset.prompts.length - 1}
                        onClick={() => moveBlock(i, 1)}
                      >
                        ▼
                      </button>
                      <button className="btn-ghost" onClick={() => setEditing(i)} title="Edit">
                        ✎
                      </button>
                      {!isDynamic && (
                        <button
                          className="btn-ghost danger"
                          onClick={() => deleteBlock(i)}
                          title="Delete"
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Roomy entry editor as a popup over the center panel */}
      {editing !== null && editingBlock && (
        <Modal
          title={`Edit Prompt — ${editingBlock.name || editingBlock.identifier}`}
          onClose={() => setEditing(null)}
          headerActions={
            <button className="btn-accent" onClick={() => save(profileId)} disabled={!dirty}>
              Save
            </button>
          }
        >
          <label className="field-label">Name</label>
          <input
            value={editingBlock.name}
            onChange={(e) => updateBlock(editing, { name: e.target.value })}
          />

          {editingBlock.marker !== 'none' ? (
            <div className="dynamic-note">
              Dynamic block — content is injected automatically ({MARKER_LABEL[editingBlock.marker]}
              ). Toggle and reorder it in the list to control where it appears.
            </div>
          ) : (
            <>
              <label className="field-label">Role</label>
              <select
                value={editingBlock.role}
                onChange={(e) =>
                  updateBlock(editing, { role: e.target.value as 'system' | 'user' | 'assistant' })
                }
              >
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>

              <label className="field-label">Content</label>
              <textarea
                className="modal-textarea"
                value={editingBlock.content}
                onChange={(e) => updateBlock(editing, { content: e.target.value })}
                placeholder="Prompt text. Supports {{char}} and {{user}}."
              />

              <label className="field-label">Injection Depth</label>
              <input
                type="number"
                min={0}
                placeholder="inline"
                value={editingBlock.injection_depth ?? ''}
                onChange={(e) =>
                  updateBlock(editing, {
                    injection_depth: e.target.value === '' ? null : Number(e.target.value)
                  })
                }
              />
              <div className="dynamic-note">
                Blank = inline, in preset order. A number injects this block into the chat history
                that many messages up from the bottom (like a depth lorebook entry).
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
