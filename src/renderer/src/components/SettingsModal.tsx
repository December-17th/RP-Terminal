import { useState } from 'react'
import { Modal } from './Modal'
import { SettingsPanel } from './SettingsPanel'
import { MemoryPanel } from './MemoryPanel'
import { RegexPanel } from './RegexPanel'
import { ScriptsPanel } from './ScriptsPanel'
import { useUiStore } from '../stores/uiStore'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useT } from '../i18n'

type Section = 'app' | 'memory' | 'regex' | 'scripts'

/**
 * The single Settings popup, VS Code-style: a category rail (App / World) on the LEFT and the
 * selected section's content on the RIGHT. One trigger (useUiStore.openSettings), reachable from the
 * launcher gear and the play "Settings" button; rendered once at the App level.
 */
export function SettingsModal({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [section, setSection] = useState<Section>('app')
  const t = useT()
  if (!open) return null

  const cardId = activeCharacter?.id ?? null
  const cardName = activeCharacter?.card?.data?.name ?? null
  const railItem = (key: Section, label: string): React.ReactElement => (
    <button
      className={`settings-rail-item ${section === key ? 'active' : ''}`}
      onClick={() => setSection(key)}
    >
      {label}
    </button>
  )

  return (
    <Modal title={t('settings.title')} onClose={close}>
      <div className="settings-shell">
        <div className="settings-rail">
          <div className="settings-rail-group">{t('settings.groupApp')}</div>
          {railItem('app', t('settings.preferences'))}
          {railItem('memory', t('settings.memory'))}
          <div className="settings-rail-group">
            {t('settings.groupWorld')}
            {cardName ? ` · ${cardName}` : ''}
          </div>
          {railItem('regex', t('settings.regex'))}
          {railItem('scripts', t('settings.scripts'))}
        </div>
        <div className="settings-content">
          {section === 'app' ? (
            <div className="settings-modal-content">
              <SettingsPanel profileId={profileId} />
            </div>
          ) : section === 'memory' ? (
            <div className="settings-modal-content">
              <MemoryPanel profileId={profileId} />
            </div>
          ) : (
            <div className="world-settings">
              {section === 'scripts' ? (
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
        </div>
      </div>
    </Modal>
  )
}
