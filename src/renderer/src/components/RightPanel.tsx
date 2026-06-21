import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { LayoutRenderer } from './LayoutRenderer'
import { StatView } from './StatView'
import { isPlainObject } from './statViewHelpers'
import { CardScriptHost } from './CardScriptHost'
import { PluginHost } from './PluginHost'

/**
 * The right sidebar (the "game UI"): the card's declarative ui_layout + the latest
 * floor's MVU stat_data drive the RPG status panel, with the card's sandboxed script
 * runtime mounted below. The app-wide standalone-plugin runtime is kept outside the
 * session conditional so plugin iframes never reparent/reload.
 */
export function RightPanel({ profileId }: { profileId: string }): React.ReactElement {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)

  // RPG state: the latest floor's stat_data (MVU / R3) + the card's declarative
  // ui_layout (if any). Either or both drive the status panel.
  const latestVars = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = isPlainObject(latestVars?.stat_data) ? latestVars!.stat_data : undefined
  const uiLayout = activeCharacter?.card.data.extensions?.rp_terminal?.ui_layout

  return (
    <>
      {activeChatId && activeCharacter ? (
        <div>
          <h3 style={{ borderBottom: '1px solid var(--rpt-border)', paddingBottom: 10 }}>
            RPG Status
          </h3>
          <div style={{ marginTop: 20 }}>
            {uiLayout?.length ? <LayoutRenderer layoutSchema={uiLayout} /> : null}
            {statData && Object.keys(statData).length ? <StatView data={statData} /> : null}
            {!uiLayout?.length && !(statData && Object.keys(statData).length) ? (
              <div style={{ opacity: 0.6 }}>
                <em>(No RPG state for this session yet)</em>
              </div>
            ) : null}
          </div>
          <CardScriptHost
            key={`${activeCharacter.id}:${activeChatId}`}
            profileId={profileId}
            chatId={activeChatId}
            cardId={activeCharacter.id}
            cardName={activeCharacter.card.data.name}
            scripts={activeCharacter.card.data.extensions?.rp_terminal?.scripts || []}
          />
        </div>
      ) : (
        <div style={{ opacity: 0.5 }}>Waiting for session...</div>
      )}
      {/* App-wide standalone-plugin runtime: panels render here, headless plugins stay
          mounted but hidden. Kept outside the session conditional so plugin iframes
          never reparent/reload. */}
      <PluginHost profileId={profileId} />
    </>
  )
}
