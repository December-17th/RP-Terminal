import { useState } from 'react'
import { Modal } from './Modal'
import { SettingsPanel } from './SettingsPanel'
import { RegexPanel } from './RegexPanel'
import { ScriptsPanel } from './ScriptsPanel'
import { useUiStore } from '../stores/uiStore'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'

/**
 * The single Settings popup (VS Code's User/Workspace model): an **App** tab for global preferences
 * and a **World** tab for the active world's Regex/Scripts. One trigger (useUiStore.openSettings),
 * reachable from the launcher gear and the play "Settings" button. Rendered once at the App level.
 */
export function SettingsModal({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [tab, setTab] = useState<'app' | 'world'>('app')
  const [worldTab, setWorldTab] = useState<'regex' | 'scripts'>('regex')
  if (!open) return null

  const cardId = activeCharacter?.id ?? null
  const cardName = activeCharacter?.card?.data?.name ?? null
  return (
    <Modal title="Settings" onClose={close}>
      <div className="ws-tabs">
        <button className={`ws-tab ${tab === 'app' ? 'active' : ''}`} onClick={() => setTab('app')}>
          App
        </button>
        <button
          className={`ws-tab ${tab === 'world' ? 'active' : ''}`}
          onClick={() => setTab('world')}
        >
          World{cardName ? ` · ${cardName}` : ''}
        </button>
      </div>

      {tab === 'app' ? (
        <div className="settings-modal-content">
          <SettingsPanel profileId={profileId} />
        </div>
      ) : (
        <div className="world-settings">
          <div className="ws-tabs ws-subtabs">
            <button
              className={`ws-tab ${worldTab === 'regex' ? 'active' : ''}`}
              onClick={() => setWorldTab('regex')}
            >
              Regex
            </button>
            <button
              className={`ws-tab ${worldTab === 'scripts' ? 'active' : ''}`}
              onClick={() => setWorldTab('scripts')}
            >
              Scripts
            </button>
          </div>
          {worldTab === 'scripts' ? (
            <ScriptsPanel
              profileId={profileId}
              activeCardId={cardId}
              activeCardName={cardName}
              activeChatId={activeChatId ?? null}
              card={activeCharacter?.card ?? null}
            />
          ) : (
            <RegexPanel
              profileId={profileId}
              activeCardId={cardId}
              activeChatId={activeChatId ?? null}
            />
          )}
        </div>
      )}
    </Modal>
  )
}
