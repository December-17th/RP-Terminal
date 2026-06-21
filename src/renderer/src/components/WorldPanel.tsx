import { useCharacterStore } from '../stores/characterStore'
import type { PanelTab } from './panelTabs'

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

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>World</h3>
        <div className="panel-header-actions">
          <button onClick={() => useCharacterStore.getState().importCharacter(profileId)}>
            Import
          </button>
          <button className="btn-ghost" onClick={() => importMockCharacter(profileId)}>
            + Mock
          </button>
        </div>
      </div>
      <div className="panel-body">
        {characters.length === 0 && (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
            No worlds yet. Import a character card or add the mock guide.
          </div>
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
              title="Export as World Card (card + lorebook + this world's regex)"
              onClick={() => useCharacterStore.getState().exportCharacter(profileId, c.id)}
            >
              ⬇
            </button>
            <button
              className="btn-ghost danger row-del"
              title="Delete character"
              onClick={() => {
                if (
                  confirm(
                    `Delete character "${c.card.data.name}" and its lorebook? This cannot be undone.`
                  )
                ) {
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
