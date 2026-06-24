import { Modal } from './Modal'
import { SettingsPanel } from './SettingsPanel'
import { useUiStore } from '../stores/uiStore'

/**
 * The Settings popup — wraps the existing SettingsPanel in a Modal so settings/theme are reachable
 * from both the launcher and play (via the gear buttons → useUiStore.openSettings). Rendered once at
 * the App level so it overlays whichever screen is showing.
 */
export function SettingsModal({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  if (!open) return null
  return (
    <Modal title="Settings" onClose={close}>
      <div className="settings-modal-content">
        <SettingsPanel profileId={profileId} />
      </div>
    </Modal>
  )
}
