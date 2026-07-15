// One-time new-session nudge to assign a memory-table template.
//
// Table memory binds PER-CHAT (chats.table_template_id) and assignment is destructive (it wipes +
// re-instantiates the sandbox), so a card's bundled template is dropped into the library on import
// but never auto-assigned. This popup nudges the user to pick one for the new session. It is opened by
// chatStore.createChat when the reminder setting is on (a brand-new session never carries a template);
// the primary action surfaces the Tables view, and "don't remind me" flips the global setting off.
import React from 'react'
import { Modal } from './Modal'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useT } from '../i18n'

export function TableTemplateReminderModal({
  profileId
}: {
  profileId: string
}): React.JSX.Element | null {
  const open = useChatStore((s) => s.templateReminderOpen)
  const dismiss = useChatStore((s) => s.dismissTemplateReminder)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const ensureLeftPanel = useWorkspaceStore((s) => s.ensureLeftPanel)
  const t = useT()

  if (!open) return null

  // Surface the Tables view (injects a left panel across modes — the same path Assets/Variables use).
  const openTables = (): void => {
    ensureLeftPanel('tables')
    dismiss()
  }

  // Global opt-out: flip the setting off (preserving the other tables fields), then close.
  const dontRemind = (): void => {
    void updateSettings(profileId, {
      tables: {
        default_update_frequency: settings?.tables?.default_update_frequency ?? 3,
        ...settings?.tables,
        remind_set_template: false
      }
    })
    dismiss()
  }

  return (
    <Modal title={t('tableReminder.title')} onClose={dismiss}>
      <div style={{ maxWidth: 460 }}>
        <p style={{ marginTop: 0, color: 'var(--rpt-text-secondary)', lineHeight: 1.5 }}>
          {t('tableReminder.body')}
        </p>
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: 20,
            flexWrap: 'wrap'
          }}
        >
          <button className="btn-ghost" onClick={dontRemind}>
            {t('tableReminder.dontRemind')}
          </button>
          <button className="btn-ghost" onClick={dismiss}>
            {t('tableReminder.notNow')}
          </button>
          <button className="btn-accent" onClick={openTables}>
            {t('tableReminder.openTables')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
