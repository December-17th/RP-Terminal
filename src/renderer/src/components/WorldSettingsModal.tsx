import { useState } from 'react'
import { Modal } from './Modal'
import { RegexPanel } from './RegexPanel'
import { ScriptsPanel } from './ScriptsPanel'
import { useUiStore } from '../stores/uiStore'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'

/**
 * Per-world settings popup — the active world's Regex and Scripts, moved out of the top-nav tabs.
 * Mirrors the app Settings popup (a Modal); the hosted managers are the same components the side
 * panel used, so scope (Global/World/Session) + editing behave identically. Tab is local state.
 */
export function WorldSettingsModal({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.worldSettingsOpen)
  const close = useUiStore((s) => s.closeWorldSettings)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [tab, setTab] = useState<'regex' | 'scripts'>('regex')
  if (!open) return null

  const cardId = activeCharacter?.id ?? null
  const cardName = activeCharacter?.card?.data?.name ?? null
  return (
    <Modal title={cardName ? `World — ${cardName}` : 'World'} onClose={close}>
      <div className="world-settings">
        <div className="ws-tabs">
          <button
            className={`ws-tab ${tab === 'regex' ? 'active' : ''}`}
            onClick={() => setTab('regex')}
          >
            Regex
          </button>
          <button
            className={`ws-tab ${tab === 'scripts' ? 'active' : ''}`}
            onClick={() => setTab('scripts')}
          >
            Scripts
          </button>
        </div>
        {tab === 'scripts' ? (
          <ScriptsPanel
            profileId={profileId}
            activeCardId={cardId}
            activeCardName={cardName}
            activeChatId={activeChatId ?? null}
            card={activeCharacter?.card ?? null}
          />
        ) : (
          <RegexPanel profileId={profileId} activeCardId={cardId} activeChatId={activeChatId ?? null} />
        )}
      </div>
    </Modal>
  )
}
