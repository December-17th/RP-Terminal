import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useT } from '../i18n'

/** Left-panel 'sessions' tab: the chat sessions for the active character. */
export function SessionsPanel({ profileId }: { profileId: string }): React.ReactElement {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const { chats, activeChatId, createChat, setActiveChat, deleteChat } = useChatStore()
  const t = useT()

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('sessions.heading')}</h3>
        {activeCharacter && (
          <div className="panel-header-actions">
            <button onClick={() => createChat(profileId, activeCharacter.id)}>
              {t('common.new')}
            </button>
          </div>
        )}
      </div>
      <div className="panel-body">
        {!activeCharacter ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('sessions.selectChar')}</div>
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
              <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('sessions.empty')}</div>
            )}
            {chats
              .filter((c) => c.character_id === activeCharacter.id)
              .map((c) => {
                const last = c.floor_index?.[c.floor_index.length - 1]
                const previewText = last?.response_preview || t('launcher.emptySession')
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
                        title={t('sessions.deleteTitle')}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm(t('sessions.confirmDelete'))) {
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
