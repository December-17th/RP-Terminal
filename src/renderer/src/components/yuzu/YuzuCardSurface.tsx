import { useEffect, useState } from 'react'
import { WcvPanel } from '../workspace/WcvPanel'

/**
 * MVP Yuzu takeover surface. The card owns the entire play-area rectangle through the existing,
 * unrestricted card WCV preload; RP Terminal only turns on VN generation before mounting it.
 */
export function YuzuCardSurface({
  profileId,
  chatId,
  entry
}: {
  profileId: string
  chatId: string
  entry: string
}): React.ReactElement {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    void window.api.setVnMode(profileId, chatId, true).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [profileId, chatId])

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
      {ready ? <WcvPanel slotId={`yuzu:${chatId}`} url={entry} /> : null}
    </div>
  )
}
