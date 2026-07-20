import { useEffect, useState } from 'react'
import { WcvPanel } from '../workspace/WcvPanel'

/**
 * MVP Yuzu takeover surface. The card owns the entire play-area rectangle through the existing,
 * unrestricted card WCV preload. Its explicit generation flag is applied before the page mounts.
 */
export function YuzuCardSurface({
  profileId,
  chatId,
  entry,
  enableVnMode
}: {
  profileId: string
  chatId: string
  entry: string
  enableVnMode: boolean
}): React.ReactElement {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    void window.api.setVnMode(profileId, chatId, enableVnMode).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [profileId, chatId, enableVnMode])

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
      {ready ? <WcvPanel slotId={`yuzu:${chatId}`} url={entry} /> : null}
    </div>
  )
}
