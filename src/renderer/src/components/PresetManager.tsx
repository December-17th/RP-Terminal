import React, { useEffect, useState } from 'react'
import { usePresetStore, PresetParameters, PromptMarker } from '../stores/presetStore'

interface Props {
  profileId: string
  onImport: () => void
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

export const PresetManager: React.FC<Props> = ({ profileId, onImport }) => {
  const {
    preset,
    dirty,
    load,
    save,
    setName,
    setParam,
    updateBlock,
    toggleBlock,
    moveBlock,
    addBlock,
    deleteBlock
  } = usePresetStore()
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    load(profileId)
  }, [profileId])

  if (!preset) return <div className="panel-body">Loading preset…</div>

  const numField = (key: keyof PresetParameters, label: string, required = false): React.ReactNode => {
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

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Preset</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>unsaved</span>}
          <button className="btn-ghost" onClick={onImport} title="Import a SillyTavern preset">
            Import
          </button>
          <button onClick={addBlock}>+ Prompt</button>
          <button className="btn-accent" disabled={!dirty} onClick={() => save(profileId)}>
            Save
          </button>
        </div>
      </div>
      <div className="panel-body">
      <label className="field-label">Preset Name</label>
      <input value={preset.name} onChange={(e) => setName(e.target.value)} />

      <h4 style={{ marginBottom: 8 }}>Generation Parameters</h4>
      <div className="param-grid">
        {numField('temperature', 'Temperature', true)}
        {numField('max_tokens', 'Max Tokens', true)}
        {OPTIONAL_PARAMS.map((k) => numField(k, k.replace(/_/g, ' ')))}
      </div>

      <h4 style={{ marginTop: 16, marginBottom: 8 }}>
        Prompt Manager <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(top → bottom order)</span>
      </h4>
      {preset.prompts.map((block, i) => {
        const markerLabel = MARKER_LABEL[block.marker]
        const isDynamic = block.marker !== 'none'
        return (
          <div key={block.identifier} className={`prompt-row ${block.enabled ? '' : 'disabled'}`}>
            <div className="prompt-row-head">
              <input
                type="checkbox"
                checked={block.enabled}
                onChange={() => toggleBlock(i)}
                title="Enabled"
              />
              <span className="prompt-name" onClick={() => setExpanded(expanded === i ? null : i)}>
                {block.name || block.identifier}
              </span>
              {markerLabel ? (
                <span className="marker-badge">{markerLabel}</span>
              ) : (
                <span className="role-badge">{block.role}</span>
              )}
              <div className="prompt-actions">
                <button className="btn-ghost" disabled={i === 0} onClick={() => moveBlock(i, -1)}>
                  ▲
                </button>
                <button
                  className="btn-ghost"
                  disabled={i === preset.prompts.length - 1}
                  onClick={() => moveBlock(i, 1)}
                >
                  ▼
                </button>
                <button className="btn-ghost" onClick={() => setExpanded(expanded === i ? null : i)}>
                  {expanded === i ? '▾' : '▸'}
                </button>
                {!isDynamic && (
                  <button className="btn-ghost danger" onClick={() => deleteBlock(i)} title="Delete">
                    🗑
                  </button>
                )}
              </div>
            </div>

            {expanded === i && (
              <div className="prompt-body">
                {isDynamic ? (
                  <div className="dynamic-note">
                    Dynamic block — content is injected automatically ({markerLabel}). Toggle and
                    reorder to control where it appears.
                  </div>
                ) : (
                  <>
                    <div className="prompt-meta">
                      <label className="field-label" style={{ flex: 1 }}>
                        Name
                        <input
                          value={block.name}
                          onChange={(e) => updateBlock(i, { name: e.target.value })}
                        />
                      </label>
                      <label className="field-label">
                        Role
                        <select
                          value={block.role}
                          onChange={(e) =>
                            updateBlock(i, {
                              role: e.target.value as 'system' | 'user' | 'assistant'
                            })
                          }
                        >
                          <option value="system">system</option>
                          <option value="user">user</option>
                          <option value="assistant">assistant</option>
                        </select>
                      </label>
                    </div>
                    <textarea
                      className="entry-content"
                      value={block.content}
                      onChange={(e) => updateBlock(i, { content: e.target.value })}
                      placeholder="Prompt text. Supports {{char}} and {{user}}."
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
      </div>
    </div>
  )
}
