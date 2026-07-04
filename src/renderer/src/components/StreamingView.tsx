import { useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { useSettingsStore } from '../stores/settingsStore'
import { splitReasoning } from '../../../shared/responseView'
import { renderTemplate } from '../plugin/renderTemplate'
import { ReasoningPanel } from './ReasoningPanel'
import { useT } from '../i18n'

/**
 * Isolated streaming view — subscribes only to streamingText so the high-frequency
 * per-frame updates re-render just this tiny node, not the whole chat (which would
 * reconcile every prior message + card iframe each frame and tank the FPS).
 *
 * Reasoning lifecycle (the live UX): while the model is emitting `<think>…` the reasoning streams
 * into the (card-customizable) ReasoningPanel and the body is withheld; once `</think>` lands the
 * body streams into the main box. See splitReasoning.
 */
export function StreamingView({ pendingUserMsg }: { pendingUserMsg: string }): React.ReactElement {
  const t = useT()
  const streamingText = useChatStore((s) => s.streamingText)
  const templates = useSettingsStore((s) => s.settings?.templates)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const ext = activeCharacter?.card.data.extensions?.rp_terminal
  const cardCss = ext?.css as string | undefined
  const reasoningTemplate = ext?.reasoning_template as string | undefined

  // Split the in-flight text the SAME way the committed floor will, so the view doesn't flash raw
  // <thinking> and the streaming/settled looks match. `body` is '' until </think> closes.
  const { reasoning, body, state } = splitReasoning(streamingText)

  const liveOn =
    templates?.enabled !== false &&
    templates?.render?.enabled !== false &&
    templates?.render?.live !== false
  const rateChars = Math.max(1, (templates?.render?.rate_tokens || 500) * 4) // ~4 chars per token

  // Live render-time EJS eval (Phase C), RATE-LIMITED: re-eval only when the text crosses another
  // rate-limit boundary (every rateChars), keyed off `checkpoint` — per-token WASM eval would tank
  // streaming. `body` is deliberately NOT a dep so the eval doesn't run every frame.
  const checkpoint = Math.floor(body.length / rateChars)
  const live = useMemo(() => {
    if (!liveOn || body.length < rateChars || !body.includes('<%')) return null
    // Pre-turn state: the in-flight floor isn't committed yet, so use the latest committed vars.
    const vars = useChatStore.getState().floors.slice(-1)[0]?.variables || {}
    return { text: renderTemplate(body, vars, 'live'), atLen: body.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rate-limited: re-eval only on a new checkpoint
  }, [checkpoint, liveOn, rateChars])
  // Rendered head (up to the last checkpoint) + the still-raw tail, so the text keeps flowing.
  const display = live ? live.text + body.slice(live.atLen) : body

  const endRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  // "Stuck to bottom" state: only auto-scroll while the user is already at (or near) the bottom. If
  // they scroll UP to re-read earlier text mid-stream, don't yank them back down on every new token.
  // A scroll listener flips this off when the user scrolls away from the bottom and back on when they
  // return — programmatic scroll-to-bottom (below) also lands within the threshold, so it stays on.
  const stickRef = useRef(true)
  useEffect(() => {
    const scroller = endRef.current?.closest('.floor-viewport') as HTMLElement | null
    scrollerRef.current = scroller
    if (!scroller) return
    const onScroll = (): void => {
      stickRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
  // Keep the latest streamed text in view as it grows — but only when stuck to the bottom (scoped to
  // this node so the high-frequency updates don't re-render the rest of the chat).
  useEffect(() => {
    if (!stickRef.current) return
    const s = scrollerRef.current
    if (s) s.scrollTop = s.scrollHeight
    else endRef.current?.scrollIntoView({ block: 'end' })
  }, [streamingText])
  return (
    <div className="floor-block">
      {pendingUserMsg && <div className="user-action">&gt; {pendingUserMsg}</div>}
      {state !== 'none' && (
        <ReasoningPanel
          reasoning={reasoning}
          body={body}
          state={state}
          template={reasoningTemplate}
          css={cardCss}
        />
      )}
      {display ? (
        <div className="streaming-text">{display}</div>
      ) : state === 'none' ? (
        <em className="generating-pulse">
          {streamingText ? t('chat.thinking') : t('chat.generating')}
        </em>
      ) : null}
      <div ref={endRef} />
    </div>
  )
}
