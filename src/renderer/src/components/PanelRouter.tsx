import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { ApiSettingsPanel } from './ApiSettingsPanel'
import { PersonaPanel } from './PersonaPanel'
import { PresetManager } from './PresetManager'
import { LorebookManager } from './LorebookManager'
import { ScriptsPanel } from './ScriptsPanel'
import { RegexPanel } from './RegexPanel'
import { SettingsPanel } from './SettingsPanel'
import { LogsPanel } from './LogsPanel'
import { WorldPanel } from './WorldPanel'
import { SessionsPanel } from './SessionsPanel'
import type { PanelTab } from './panelTabs'

/** The left sidebar: routes the active tab to its panel component. */
export function PanelRouter({
  panel,
  profileId,
  onSelectPanel
}: {
  panel: PanelTab
  profileId: string
  onSelectPanel: (p: PanelTab) => void
}): React.ReactNode {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activeChatId = useChatStore((s) => s.activeChatId)

  switch (panel) {
    case 'api':
      return <ApiSettingsPanel profileId={profileId} />

    case 'persona':
      return <PersonaPanel profileId={profileId} />

    case 'world':
      return <WorldPanel profileId={profileId} onSelectPanel={onSelectPanel} />

    case 'sessions':
      return <SessionsPanel profileId={profileId} />

    case 'preset':
      return <PresetManager profileId={profileId} />

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
        <div className="panel">
          <div className="panel-header">
            <h3>Lorebook</h3>
          </div>
          <div className="panel-body">
            <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a World first.</div>
          </div>
        </div>
      )

    case 'scripts':
      return (
        <ScriptsPanel
          profileId={profileId}
          activeCardId={activeCharacter?.id ?? null}
          activeCardName={activeCharacter?.card.data.name ?? null}
          activeChatId={activeChatId ?? null}
          card={activeCharacter?.card ?? null}
        />
      )

    case 'regex':
      return (
        <RegexPanel
          profileId={profileId}
          activeCardId={activeCharacter?.id ?? null}
          activeChatId={activeChatId ?? null}
        />
      )

    case 'settings':
      return <SettingsPanel profileId={profileId} />

    case 'logs':
      return <LogsPanel />
  }
}
