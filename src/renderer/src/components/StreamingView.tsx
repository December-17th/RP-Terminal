import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { cleanForDisplay } from '../../../shared/responseView'

/**
 * Isolated streaming view — subscribes only to streamingText so the high-frequency
 * per-frame updates re-render just this tiny node, not the whole chat (which would
 * reconcile every prior message + card iframe each frame and tank the FPS).
 */
export function StreamingView({ pendingUserMsg }: { pendingUserMsg: string }): React.ReactElement {
  const streamingText = useChatStore((s) => s.streamingText)
  // Hide reasoning/state tags live, the same way the committed floor will render — so the view
  // doesn't flash raw <thinking> before swapping to the clean floor. (Card beautification regex
  // still only runs on the final floor.)
  const display = cleanForDisplay(streamingText)
  const endRef = useRef<HTMLDivElement>(null)
  // Keep the latest streamed text in view as it grows (scoped to this node so the
  // high-frequency updates don't re-render the rest of the chat).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [streamingText])
  return (
    <div className="floor-block">
      {pendingUserMsg && <div className="user-action">&gt; {pendingUserMsg}</div>}
      {display ? (
        <div className="streaming-text">{display}</div>
      ) : (
        <em className="generating-pulse">{streamingText ? 'Thinking…' : 'Generating…'}</em>
      )}
      <div ref={endRef} />
    </div>
  )
}
