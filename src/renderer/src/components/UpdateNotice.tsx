import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import {
  dismissUpdate,
  UPDATE_DISMISSAL_KEY,
  type UpdateNoticeInfo,
  visibleUpdate
} from './updateNoticeModel'

function readDismissedVersion(): string | null {
  try {
    return sessionStorage.getItem(UPDATE_DISMISSAL_KEY)
  } catch {
    return null
  }
}

function storeDismissedVersion(version: string): void {
  try {
    sessionStorage.setItem(UPDATE_DISMISSAL_KEY, version)
  } catch {
    // Session storage is a convenience only; local state still dismisses the current banner.
  }
}

export function UpdateNotice(): React.ReactElement | null {
  const t = useT()
  const [update, setUpdate] = useState<UpdateNoticeInfo | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState(readDismissedVersion)

  useEffect(() => {
    let active = true
    void window.api
      .checkForUpdate()
      .then((result) => {
        if (active) setUpdate(result)
      })
      .catch(() => {
        // Checks are deliberately fail-soft: the normal launcher remains unchanged.
      })
    return () => {
      active = false
    }
  }, [])

  const visible = visibleUpdate(update, dismissedVersion)
  if (!visible) return null

  return (
    <section className="update-notice" aria-labelledby="update-notice-title">
      <div className="update-notice-copy" role="status" aria-live="polite">
        <div className="update-notice-title" id="update-notice-title">
          {t('updates.availableTitle')}
        </div>
        <div className="update-notice-body">
          {t('updates.availableBody', {
            current: visible.currentVersion,
            latest: visible.latestVersion
          })}
        </div>
      </div>
      <div className="update-notice-actions">
        <button
          type="button"
          className="update-notice-view"
          onClick={() => {
            void window.api.openUpdateRelease().catch(() => {})
          }}
        >
          {t('updates.viewRelease')}
        </button>
        <button
          type="button"
          className="update-notice-later"
          onClick={() => {
            const version = dismissUpdate(visible)
            if (!version) return
            storeDismissedVersion(version)
            setDismissedVersion(version)
          }}
        >
          {t('updates.later')}
        </button>
      </div>
    </section>
  )
}
