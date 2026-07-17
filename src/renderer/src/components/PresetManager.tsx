import React, { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { usePresetStore, PresetParameters, PromptMarker } from '../stores/presetStore'
import { useToastStore } from '../stores/toastStore'
import { useT } from '../i18n'

interface Props {
  profileId: string
}

const MARKER_KEY: Record<PromptMarker, string> = {
  none: '',
  char_description: 'preset.markerChar',
  char_personality: 'preset.markerPersonality',
  scenario: 'preset.markerScenario',
  mes_example: 'preset.markerExamples',
  world_info: 'preset.markerWorldInfo',
  world_info_before: 'preset.markerWorldInfoBefore',
  world_info_after: 'preset.markerWorldInfoAfter',
  persona_description: 'preset.markerPersona',
  chat_history: 'preset.markerChatHistory',
  post_history: 'preset.markerPostHistory'
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
  const t = useT()
  const markerText = (m: PromptMarker): string => (m === 'none' ? '' : t(MARKER_KEY[m]))

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
  const guardDirty = (): boolean => !dirty || confirm(t('preset.confirmDiscard'))

  // Import a preset and report what came with it (presets often bundle their own
  // regex + Tavern Helper scripts, installed scoped to the preset).
  const onImport = async (): Promise<void> => {
    if (!guardDirty()) return
    const res = await importPreset(profileId)
    if (!res) return
    // Surface the capability inventory (ADR 0017) — counts of what the preset carries, not a gate.
    const inv = res.inventory
    let msg = t('preset.imported', { name: res.name })
    msg +=
      ' — ' +
      t('preset.inv.summary', {
        prompts: inv.prompts,
        enabled: inv.promptsEnabled,
        regex: inv.regexScripts,
        spreset: inv.spresetRegex,
        scripts: inv.tavernHelperScripts,
        ejs: inv.ejsPrompts
      })
    if (inv.unknownExtensions.length)
      msg += t('preset.inv.unknownExt', { names: inv.unknownExtensions.join(', ') })
    if (inv.duplicateIdentifiers.length || inv.orphanIdentifiers.length)
      msg += t('preset.inv.anomalies', {
        dupes: inv.duplicateIdentifiers.length,
        orphans: inv.orphanIdentifiers.length
      })
    useToastStore.getState().push(msg)
    // Remote-code scripts stay inert until a high-trust opt-in exists — warn NOW (separate toast).
    if (inv.remoteCodeScripts)
      useToastStore.getState().push(t('preset.inv.remoteCode', { count: inv.remoteCodeScripts }))
    // SPreset ChatSquash features RPT does not execute (issue 16) — surfaced like a capability flag.
    if (inv.unsupportedSpreset?.length)
      useToastStore
        .getState()
        .push(t('preset.inv.spresetUnsupported', { features: inv.unsupportedSpreset.join(', ') }))
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('preset.heading')}</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{t('common.unsaved')}</span>}
          <button className="btn-accent" disabled={!dirty} onClick={() => save(profileId)}>
            {t('common.save')}
          </button>
        </div>
      </div>

      <div className="panel-body">
        {/* Preset selector */}
        <label className="field-label">{t('preset.active')}</label>
        <div className="preset-select-row">
          <select
            value={activeId ?? ''}
            onChange={(e) => guardDirty() && select(profileId, e.target.value)}
            disabled={presets.length === 0}
          >
            {presets.length === 0 && <option value="">{t('preset.noPresets')}</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-actions">
          <button onClick={() => guardDirty() && createNew(profileId)}>{t('common.new')}</button>
          <button className="btn-ghost" onClick={onImport}>
            {t('preset.importST')}
          </button>
          <button
            className="btn-ghost danger"
            disabled={!activeId}
            onClick={() => {
              if (confirm(t('preset.confirmDelete'))) remove(profileId)
            }}
          >
            {t('common.delete')}
          </button>
        </div>

        {!preset ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic', marginTop: 16 }}>
            {t('preset.empty')}
          </div>
        ) : (
          <>
            <label className="field-label" style={{ marginTop: 16 }}>
              {t('preset.name')}
            </label>
            <input value={preset.name} onChange={(e) => setName(e.target.value)} />

            <h4 style={{ marginBottom: 8 }}>{t('preset.genParams')}</h4>
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
                {t('preset.promptManager')}{' '}
                <span style={{ opacity: 0.5, fontWeight: 'normal' }}>
                  {t('preset.promptOrder')}
                </span>
              </h4>
              <button onClick={addBlock}>{t('preset.addPrompt')}</button>
            </div>

            {preset.prompts.length === 0 && (
              <div style={{ opacity: 0.6, fontStyle: 'italic', marginTop: 8 }}>
                {t('preset.emptyPrompts')}
              </div>
            )}

            {preset.prompts.map((block, i) => {
              const markerLabel = markerText(block.marker)
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
                      title={t('common.enabled')}
                    />
                    <span
                      className="prompt-name"
                      onClick={() => setEditing(i)}
                      title={t('common.edit')}
                    >
                      {block.name || block.identifier}
                    </span>
                    {markerLabel ? (
                      <span className="marker-badge">{markerLabel}</span>
                    ) : (
                      <span className="role-badge">{block.role}</span>
                    )}
                    {block.injection_depth != null && (
                      <span className="marker-badge" title={t('preset.injectedAtDepth')}>
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
                      <button
                        className="btn-ghost"
                        onClick={() => setEditing(i)}
                        title={t('common.edit')}
                      >
                        ✎
                      </button>
                      {!isDynamic && (
                        <button
                          className="btn-ghost danger"
                          onClick={() => deleteBlock(i)}
                          title={t('common.delete')}
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
          title={t('preset.editPromptTitle', {
            name: editingBlock.name || editingBlock.identifier
          })}
          onClose={() => setEditing(null)}
          headerActions={
            <button className="btn-accent" onClick={() => save(profileId)} disabled={!dirty}>
              {t('common.save')}
            </button>
          }
        >
          <label className="field-label">{t('common.name')}</label>
          <input
            value={editingBlock.name}
            onChange={(e) => updateBlock(editing, { name: e.target.value })}
          />

          {editingBlock.marker !== 'none' ? (
            <div className="dynamic-note">
              {t('preset.dynamicNote', { marker: markerText(editingBlock.marker) })}
            </div>
          ) : (
            <>
              <label className="field-label">{t('preset.role')}</label>
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

              <label className="field-label">{t('common.content')}</label>
              <textarea
                className="modal-textarea"
                value={editingBlock.content}
                onChange={(e) => updateBlock(editing, { content: e.target.value })}
                placeholder={t('preset.contentPh')}
              />

              <label className="field-label">{t('preset.injectionDepth')}</label>
              <input
                type="number"
                min={0}
                placeholder={t('preset.inlinePh')}
                value={editingBlock.injection_depth ?? ''}
                onChange={(e) =>
                  updateBlock(editing, {
                    injection_depth: e.target.value === '' ? null : Number(e.target.value)
                  })
                }
              />
              <div className="dynamic-note">{t('preset.depthNote')}</div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
