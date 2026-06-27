import { useEffect, useState } from 'react'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useLorebookStore } from '../stores/lorebookStore'
import { useAssetStore, lorebookIdsForWorld } from '../stores/assetStore'
import { rosterFromStatData } from '../../../shared/worldAssets/coverage'
import { useT } from '../i18n'

export function AssetManagerPanel({ profileId }: { profileId: string }): React.ReactElement {
  const t = useT()
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const sessionIds = useLorebookStore((s) => s.sessionIds)
  const floors = useChatStore((s) => s.floors)
  const rows = useAssetStore((s) => s.rows)
  const load = useAssetStore((s) => s.load)
  const refresh = useAssetStore((s) => s.refresh)

  const lorebookIds = lorebookIdsForWorld(activeCharacter?.id ?? null, sessionIds)
  const primaryId = lorebookIds[0]
  const statData = floors.length ? floors[floors.length - 1]?.variables?.stat_data : undefined
  const roster = rosterFromStatData(statData)

  useEffect(() => {
    void load(profileId, lorebookIds, roster)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, lorebookIds.join(','), roster.join(',')])

  if (!activeCharacter) {
    return (
      <div className="panel">
        <div className="panel-header"><h3>{t('assets.heading')}</h3></div>
        <div className="panel-body">
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('assets.selectWorld')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h3 style={{ flex: 1 }}>{t('assets.heading')}</h3>
        <button onClick={() => void refresh(profileId, lorebookIds, roster)}>{t('assets.refresh')}</button>
        {primaryId && (
          <button onClick={() => void window.api.assetOpenFolder(profileId, primaryId, 'character')}>
            {t('assets.openFolder')}
          </button>
        )}
      </div>
      <div className="panel-body">
        <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 8 }}>{t('assets.hint')}</div>
        {rows.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('assets.empty')}</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.map((r) => (
              <li
                key={r.name}
                style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #2a2a3a' }}
              >
                <Thumb
                  profileId={profileId}
                  lorebookIds={lorebookIds}
                  name={r.name}
                  has={r.hasAvatar}
                />
                <span style={{ flex: 1 }}>{r.name}</span>
                <Chip ok={r.hasAvatar} label={t('assets.avatar')} />
                <Chip ok={r.hasStandee} label={t('assets.standee')} />
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  {t('assets.moods')}: {r.moodVariants}
                </span>
                {!r.inRoster && (
                  <span style={{ fontSize: 11, opacity: 0.5 }}>{t('assets.notInWorld')}</span>
                )}
                {r.inRoster && !r.hasAvatar && !r.hasStandee && (
                  <span style={{ fontSize: 11, color: '#e0a0a0' }}>{t('assets.missing')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Chip({ ok, label }: { ok: boolean; label: string }): React.ReactElement {
  return (
    <span
      style={{
        fontSize: 11, padding: '1px 6px', borderRadius: 6,
        background: ok ? '#23402a' : '#3a2a2a', color: ok ? '#9fe0b0' : '#e0a0a0'
      }}
    >
      {label} {ok ? '✓' : '✗'}
    </span>
  )
}

function Thumb({
  profileId,
  lorebookIds,
  name,
  has
}: {
  profileId: string
  lorebookIds: string[]
  name: string
  has: boolean
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (has) {
      void window.api
        .assetUrl(profileId, lorebookIds, 'character', name, '头像')
        .then((u) => { if (live) setUrl(u) })
    } else {
      setUrl(null)
    }
    return () => { live = false }
  }, [profileId, lorebookIds.join(','), name, has])

  const box: React.CSSProperties = {
    width: 36, height: 36, borderRadius: 6, objectFit: 'cover',
    background: '#2a2a3a', flex: '0 0 auto'
  }
  return url ? (
    <img src={url} alt={name} loading="lazy" style={box} />
  ) : (
    <div style={{ ...box, display: 'grid', placeItems: 'center', fontSize: 14, opacity: 0.6 }}>
      {name.slice(0, 1)}
    </div>
  )
}
