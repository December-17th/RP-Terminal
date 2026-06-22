import { useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { cleanForDisplay } from '../../../shared/responseView'
import { renderTemplate } from '../plugin/renderTemplate'

/**
 * Isolated streaming view — subscribes only to streamingText so the high-frequency
 * per-frame updates re-render just this tiny node, not the whole chat (which would
 * reconcile every prior message + card iframe each frame and tank the FPS).
 */
export function StreamingView({ pendingUserMsg }: { pendingUserMsg: string }): React.ReactElement {
  const streamingText = useChatStore((s) => s.streamingText)
  const templates = useSettingsStore((s) => s.settings?.templates)
  // Hide reasoning/state tags live, the same way the committed floor will render — so the view
  // doesn't flash raw <thinking> before swapping to the clean floor. (Card beautification regex
  // still only runs on the final floor.)
  const cleaned = cleanForDisplay(streamingText)

  const liveOn =
    templates?.enabled !== false &&
    templates?.render?.enabled !== false &&
    templates?.render?.live !== false
  const rateChars = Math.max(1, (templates?.render?.rate_tokens || 500) * 4) // ~4 chars per token

  // Live render-time EJS eval (Phase C), RATE-LIMITED: re-eval only when the text crosses another
  // rate-limit boundary (every rateChars), keyed off `checkpoint` — per-token WASM eval would tank
  // streaming. `cleaned` is deliberately NOT a dep so the eval doesn't run every frame.
  const checkpoint = Math.floor(cleaned.length / rateChars)
  const live = useMemo(() => {
    if (!liveOn || cleaned.length < rateChars || !cleaned.includes('<%')) return null
    // Pre-turn state: the in-flight floor isn't committed yet, so use the latest committed vars.
    const vars = useChatStore.getState().floors.slice(-1)[0]?.variables || {}
    return { text: renderTemplate(cleaned, vars, 'live'), atLen: cleaned.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rate-limited: re-eval only on a new checkpoint
  }, [checkpoint, liveOn, rateChars])
  // Rendered head (up to the last checkpoint) + the still-raw tail, so the text keeps flowing.
  const display = live ? live.text + cleaned.slice(live.atLen) : cleaned

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
