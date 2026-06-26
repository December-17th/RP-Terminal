import React from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useT } from '../i18n'

/**
 * Long-Term Memory — its own Settings category. Surfaces the everyday knobs of the episodic memory
 * engine: the master toggle, the summarizer connection, and the recall / compaction cadence. The
 * full collection registry stays in settings (advanced); this is the curated front.
 */
export const MemoryPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { settings, updateSettings } = useSettingsStore()
  const t = useT()
  if (!settings) return null

  const mem = settings.memory
  const eventsCount = mem?.collections?.find((c) => c.id === 'events')?.retrieval?.count ?? 5
  const streamMode = mem?.collections?.find((c) => c.id === 'events')?.retrieval?.mode ?? 'keyword'

  const patch = (over: Partial<NonNullable<typeof mem>>): void => {
    updateSettings(profileId, { memory: { ...mem, ...over } })
  }

  // The recall mode applies to all stream collections (events, facts…); entity collections stay 'always'.
  const setStreamMode = (mode: string): void => {
    const collections = (mem?.collections ?? []).map((c) =>
      c.shape === 'stream'
        ? { ...c, retrieval: { ...c.retrieval, mode: mode as typeof c.retrieval.mode } }
        : c
    )
    patch({ collections })
  }

  const hint = (text: string): React.ReactElement => (
    <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
      {text}
    </div>
  )

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('prefs.memory')}</h3>
      </div>
      <div className="panel-body">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={mem?.enabled ?? false}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          {t('prefs.memoryEnable')}
        </label>
        {hint(t('prefs.memoryHint'))}

        {mem?.enabled && (
          <>
            <label className="field-label" style={{ marginTop: 16 }}>
              {t('prefs.memoryUtility')}
            </label>
            <select
              value={mem?.utility_api_preset_id ?? ''}
              onChange={(e) => patch({ utility_api_preset_id: e.target.value })}
              style={{ width: '100%' }}
            >
              <option value="">{t('prefs.memoryUtilityActive')}</option>
              {(settings.api_presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {hint(t('prefs.memoryUtilityHint'))}

            <label className="field-label" style={{ marginTop: 16 }}>
              {t('prefs.memoryMode')}
            </label>
            <select
              value={streamMode}
              onChange={(e) => setStreamMode(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="keyword">{t('prefs.memoryModeKeyword')}</option>
              <option value="hybrid">{t('prefs.memoryModeHybrid')}</option>
              <option value="vector">{t('prefs.memoryModeVector')}</option>
            </select>
            {hint(t('prefs.memoryModeHint'))}

            {streamMode !== 'keyword' ? (
              <>
                <label className="field-label" style={{ marginTop: 16 }}>
                  {t('prefs.memoryEmbedding')}
                </label>
                <select
                  value={mem?.embedding_api_preset_id ?? ''}
                  onChange={(e) => patch({ embedding_api_preset_id: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">{t('prefs.memoryEmbeddingNone')}</option>
                  {(settings.api_presets ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {hint(t('prefs.memoryEmbeddingHint'))}
              </>
            ) : null}

            <label className="field-label" style={{ marginTop: 16 }}>
              {t('prefs.memoryRecall')}
            </label>
            <input
              type="number"
              min={1}
              value={eventsCount}
              onChange={(e) => {
                const n = Math.max(1, Number(e.target.value) || 1)
                const collections = (mem?.collections ?? []).map((c) =>
                  c.id === 'events' ? { ...c, retrieval: { ...c.retrieval, count: n } } : c
                )
                patch({ collections })
              }}
            />

            <label className="field-label" style={{ marginTop: 16 }}>
              {t('prefs.memoryKeepRecent')}
            </label>
            <input
              type="number"
              min={1}
              value={mem?.keep_recent ?? 10}
              onChange={(e) => patch({ keep_recent: Math.max(1, Number(e.target.value) || 1) })}
            />
            {hint(t('prefs.memoryKeepRecentHint'))}

            <label className="field-label" style={{ marginTop: 16 }}>
              {t('prefs.memoryCheckpoint')}
            </label>
            <input
              type="number"
              min={1}
              value={mem?.checkpoint_turns ?? 6}
              onChange={(e) =>
                patch({ checkpoint_turns: Math.max(1, Number(e.target.value) || 1) })
              }
            />
            {hint(t('prefs.memoryCheckpointHint'))}
          </>
        )}
      </div>
    </div>
  )
}
