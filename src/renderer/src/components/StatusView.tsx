import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { useToastStore } from '../stores/toastStore'
import { LayoutRenderer } from './LayoutRenderer'
import { StatView } from './StatView'
import { isPlainObject } from './statViewHelpers'
import { useT } from '../i18n'

/**
 * The "RPG Status" view: the latest floor's MVU stat_data + the card's declarative
 * ui_layout drive a live status panel, with a Re-evaluate action that rebuilds state by
 * replaying the stored responses (no regeneration). Extracted from the old RightPanel so
 * it can be mounted as a movable workspace view; the card-script runtime and the app-wide
 * plugin dock are now separate views / app-root concerns.
 */
export function StatusView({ profileId }: { profileId: string }): React.ReactElement {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const t = useT()

  if (!activeChatId || !activeCharacter) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  const latestVars = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = isPlainObject(latestVars?.stat_data) ? latestVars!.stat_data : undefined
  const uiLayout = activeCharacter.card.data.extensions?.rp_terminal?.ui_layout

  return (
    <div>
      <h3
        style={{
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        {t('status.heading')}
        <button
          className="btn-accent"
          style={{ fontSize: '0.62em', padding: '3px 8px', fontWeight: 400 }}
          title={t('status.reevalTitle')}
          onClick={async () => {
            await useChatStore.getState().reevaluateVariables(profileId)
            useToastStore.getState().push(t('status.reevaluated'))
          }}
        >
          {t('status.reevaluate')}
        </button>
      </h3>
      <div style={{ marginTop: 20 }}>
        {uiLayout?.length ? <LayoutRenderer layoutSchema={uiLayout} /> : null}
        {statData && Object.keys(statData).length ? <StatView data={statData} /> : null}
        {!uiLayout?.length && !(statData && Object.keys(statData).length) ? (
          <div style={{ opacity: 0.6 }}>
            <em>{t('status.noState')}</em>
          </div>
        ) : null}
      </div>
    </div>
  )
}
