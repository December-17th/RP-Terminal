import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { SettingsPanel } from './SettingsPanel'
import { RegexPanel } from './RegexPanel'
import { ScriptsPanel } from './ScriptsPanel'
import { ApiSettingsPanel } from './ApiSettingsPanel'
import { PersonaPanel } from './PersonaPanel'
import { PresetManager } from './PresetManager'
import { LorebookManager } from './LorebookManager'
import { WorldPanel } from './WorldPanel'
import { useUiStore, type SettingsSection } from '../stores/uiStore'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useT } from '../i18n'

/**
 * The single Settings popup — the app's config hub. Since the tab nav was retired (panels are now
 * game + debug only), every config/authoring surface lives here: App prefs + Connection, the active
 * world's editable pieces (Preset / Lorebook / Persona / Assets / Regex / Scripts), and the Workflow
 * editor launcher. A VS Code-style category rail (grouped App / World / Automation) on the LEFT,
 * the selected section on the RIGHT. Opened via useUiStore.openSettings(section) — the TopStrip
 * dropdowns deep-link straight to a section; the launcher gear opens it at App.
 */
export function SettingsModal({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  const initialSection = useUiStore((s) => s.settingsSection)
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)
  const openAssetsPopup = useUiStore((s) => s.openAssetsPopup)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const t = useT()

  // Sync to the section the opener requested each time the popup opens (deep-link from a dropdown).
  useEffect(() => {
    if (open) setSection(initialSection)
  }, [open, initialSection])

  if (!open) return null

  const cardId = activeCharacter?.id ?? null
  const cardName = activeCharacter?.card?.data?.name ?? null

  const railItem = (key: SettingsSection, label: string): React.ReactElement => (
    <button
      className={`settings-rail-item ${section === key ? 'active' : ''}`}
      onClick={() => setSection(key)}
    >
      {label}
    </button>
  )

  // World-scoped section shown when no world is loaded.
  const needWorld = (
    <div className="settings-empty">{t('settings.selectWorldFirst')}</div>
  )

  const content = (): React.ReactNode => {
    switch (section) {
      case 'app':
        return (
          <div className="settings-modal-content">
            <SettingsPanel profileId={profileId} />
          </div>
        )
      case 'connection':
        return <ApiSettingsPanel profileId={profileId} />
      case 'worlds':
        return <WorldPanel profileId={profileId} onSelectPanel={() => {}} />
      case 'preset':
        return <PresetManager profileId={profileId} />
      case 'persona':
        return <PersonaPanel profileId={profileId} />
      case 'assets':
        return (
          <div className="settings-launch">
            <div className="settings-launch-icon" aria-hidden>
              🖼
            </div>
            <h3 className="settings-launch-title">{t('settings.assetsTitle')}</h3>
            <p className="settings-launch-body">{t('settings.assetsBody')}</p>
            <button
              className="btn-accent"
              disabled={!activeCharacter}
              onClick={() => {
                close()
                openAssetsPopup()
              }}
            >
              {t('settings.assetsOpen')}
            </button>
          </div>
        )
      case 'lorebook':
        return activeCharacter ? (
          <LorebookManager
            key={activeCharacter.id}
            profileId={profileId}
            characterId={activeCharacter.id}
            characterName={activeCharacter.card.data.name}
            chatId={activeChatId}
          />
        ) : (
          needWorld
        )
      case 'regex':
        return (
          <RegexPanel profileId={profileId} activeCardId={cardId} activeChatId={activeChatId ?? null} />
        )
      case 'scripts':
        return (
          <ScriptsPanel
            profileId={profileId}
            activeCardId={cardId}
            activeCardName={cardName}
            activeChatId={activeChatId ?? null}
            card={activeCharacter?.card ?? null}
          />
        )
      case 'workflow':
        return (
          <div className="settings-launch">
            <div className="settings-launch-icon" aria-hidden>
              ⧉
            </div>
            <h3 className="settings-launch-title">{t('settings.workflowTitle')}</h3>
            <p className="settings-launch-body">{t('settings.workflowBody')}</p>
            <button
              className="btn-accent"
              onClick={() => {
                close()
                openWorkflowEditor()
              }}
            >
              {t('settings.workflowOpen')}
            </button>
          </div>
        )
    }
  }

  return (
    <Modal title={t('settings.title')} onClose={close}>
      <div className="settings-shell">
        <div className="settings-rail">
          <div className="settings-rail-group">{t('settings.groupApp')}</div>
          {railItem('app', t('settings.preferences'))}
          {railItem('connection', t('settings.connection'))}
          {railItem('worlds', t('settings.worlds'))}
          <div className="settings-rail-group">
            {t('settings.groupWorld')}
            {cardName ? ` · ${cardName}` : ''}
          </div>
          {railItem('preset', t('settings.preset'))}
          {railItem('lorebook', t('settings.lorebook'))}
          {railItem('persona', t('settings.persona'))}
          {railItem('assets', t('settings.assets'))}
          {railItem('regex', t('settings.regex'))}
          {railItem('scripts', t('settings.scripts'))}
          <div className="settings-rail-group">{t('settings.groupAutomation')}</div>
          {railItem('workflow', t('settings.workflow'))}
        </div>
        <div className="settings-content">
          {section === 'app' ? content() : <div className="world-settings">{content()}</div>}
        </div>
      </div>
    </Modal>
  )
}
