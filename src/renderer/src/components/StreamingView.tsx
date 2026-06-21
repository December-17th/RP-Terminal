import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'

/**
 * Isolated streaming view — subscribes only to streamingText so the high-frequency
 * per-frame updates re-render just this tiny node, not the whole chat (which would
 * reconcile every prior message + card iframe each frame and tank the FPS).
 */
export function StreamingView({ pendingUserMsg }: { pendingUserMsg: string }): React.ReactElement {
  const streamingText = useChatStore((s) => s.streamingText)
  const endRef = useRef<HTMLDivElement>(null)
  // Keep the latest streamed text in view as it grows (scoped to this node so the
  // high-frequency updates don't re-render the rest of the chat).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [streamingText])
  return (
    <div className="floor-block">
      {pendingUserMsg && <div className="user-action">&gt; {pendingUserMsg}</div>}
      {streamingText ? (
        <div className="streaming-text">{streamingText}</div>
      ) : (
        <em className="generating-pulse">Generating…</em>
      )}
      <div ref={endRef} />
    </div>
  )
}
