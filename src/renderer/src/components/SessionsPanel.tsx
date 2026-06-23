import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'

/** Left-panel 'sessions' tab: the chat sessions for the active character. */
export function SessionsPanel({ profileId }: { profileId: string }): React.ReactElement {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const { chats, activeChatId, createChat, setActiveChat, deleteChat } = useChatStore()

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Sessions</h3>
        {activeCharacter && (
          <div className="panel-header-actions">
            <button onClick={() => createChat(profileId, activeCharacter.id)}>+ New</button>
          </div>
        )}
      </div>
      <div className="panel-body">
        {!activeCharacter ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a character first.</div>
        ) : (
          <>
            <div
              style={{
                fontSize: '0.85em',
                color: 'var(--rpt-text-secondary)',
                marginBottom: 8
              }}
            >
              {activeCharacter.card.data.name}
            </div>
            {chats.filter((c) => c.character_id === activeCharacter.id).length === 0 && (
              <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
                No sessions yet. Start a new one.
              </div>
            )}
            {chats
              .filter((c) => c.character_id === activeCharacter.id)
              .map((c) => {
                const last = c.floor_index?.[c.floor_index.length - 1]
                const previewText = last?.response_preview || 'Empty session'
                return (
                  <div
                    key={c.id}
                    className={`session-card ${activeChatId === c.id ? 'active' : ''}`}
                    onClick={() => setActiveChat(profileId, c.id)}
                  >
                    <div className="session-card-top">
                      <span className="session-time">
                        {new Date(c.updated_at).toLocaleString()}
                      </span>
                      <span className="session-count">{c.floor_count ?? 0} ✦</span>
                      <button
                        className="btn-ghost danger session-del"
                        title="Delete session"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm('Delete this session? This cannot be undone.')) {
                            deleteChat(profileId, c.id)
                          }
                        }}
                      >
                        🗑
                      </button>
                    </div>
                    <div className="session-preview">{previewText}</div>
                  </div>
                )
              })}
          </>
        )}
      </div>
    </div>
  )
}
