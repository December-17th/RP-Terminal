import { useCharacterStore } from '../stores/characterStore'
import type { PanelTab } from './panelTabs'
import { useT } from '../i18n'

/** Left-panel 'world' tab: the character/World Card library (import, mock, export, delete). */
export function WorldPanel({
  profileId,
  onSelectPanel
}: {
  profileId: string
  onSelectPanel: (p: PanelTab) => void
}): React.ReactElement {
  const { characters, activeCharacter, setActiveCharacter, importMockCharacter, deleteCharacter } =
    useCharacterStore()
  const t = useT()

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('world.heading')}</h3>
        <div className="panel-header-actions">
          <button onClick={() => useCharacterStore.getState().importCharacter(profileId)}>
            {t('common.import')}
          </button>
          <button className="btn-ghost" onClick={() => importMockCharacter(profileId)}>
            {t('world.addMock')}
          </button>
        </div>
      </div>
      <div className="panel-body">
        {characters.length === 0 && (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('world.empty')}</div>
        )}
        {characters.map((c) => (
          <div key={c.id} className="panel-list-row">
            <button
              className={`panel-list-item ${activeCharacter?.id === c.id ? 'btn-accent' : ''}`}
              onClick={() => {
                setActiveCharacter(c)
                onSelectPanel('sessions')
              }}
            >
              {c.card.data.name}
            </button>
            <button
              className="btn-ghost row-del"
              title={t('world.exportTitle')}
              onClick={() => useCharacterStore.getState().exportCharacter(profileId, c.id)}
            >
              ⬇
            </button>
            <button
              className="btn-ghost danger row-del"
              title={t('world.deleteTitle')}
              onClick={() => {
                if (confirm(t('world.confirmDelete', { name: c.card.data.name }))) {
                  deleteCharacter(profileId, c.id)
                }
              }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
