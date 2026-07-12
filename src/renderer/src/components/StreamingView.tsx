import { useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRegexStore } from '../stores/regexStore'
import { splitReasoning } from '../../../shared/responseView'
import { renderTemplate } from '../plugin/renderTemplate'
import { buildStreamingHead } from './streamingDisplay'
import { ReasoningPanel } from './ReasoningPanel'
import { MessageContent } from './MessageContent'
import {
  useAgentActivityStore,
  currentActivityLabelKey
} from '../stores/agentActivityStore'
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
  const personaName = useSettingsStore((s) => s.settings?.persona?.name) || 'User'
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const charName = activeCharacter?.card.data.name || 'Character'
  const ext = activeCharacter?.card.data.extensions?.rp_terminal
  const cardCss = ext?.css as string | undefined
  const reasoningTemplate = ext?.reasoning_template as string | undefined
  // Subscribe so the transform memo re-runs when the display rule set loads/changes (mirrors ChatView).
  const regexRules = useRegexStore((s) => s.rules)
  // Pre-phase side-agent (memory.recall): the blocking pre-reply LLM call the user is waiting on. While
  // it runs, the reply hasn't started, so show its label in this ghost line INSTEAD of the generic
  // "Generating…" pulse — that unexplained wait is exactly the problem this indicator solves.
  const activeChatId = useChatStore((s) => s.activeChatId)
  const preLabelKey = useAgentActivityStore((s) =>
    activeChatId ? currentActivityLabelKey(s.active, activeChatId, 'pre') : null
  )

  // Split the in-flight text the SAME way the committed floor will, so the view doesn't flash raw
  // <thinking> and the streaming/settled looks match. `body` is '' until </think> closes.
  const { reasoning, body, state } = splitReasoning(streamingText)

  const liveOn =
    templates?.enabled !== false &&
    templates?.render?.enabled !== false &&
    templates?.render?.live !== false
  const rateChars = Math.max(1, (templates?.render?.rate_tokens || 500) * 4) // ~4 chars per token

  // Live display transform, RATE-LIMITED: re-run the (relatively) expensive chain — EJS eval → macros
  // → display regex (beautification) — only when the text crosses another rate-limit boundary (every
  // rateChars), keyed off `checkpoint`. Per-token WASM eval + regex would tank streaming, so the tail
  // arriving after the last checkpoint stays raw plain text (cheap) and flows in per frame. This is the
  // SAME tail of the chain the settled floor runs (ChatView currentFloor): EJS('live') → expandMacros →
  // regex; `stripThinking` is unnecessary here because `body` is already reasoning-free (splitReasoning).
  // `body` is deliberately NOT a dep so the transform doesn't run every frame.
  const checkpoint = Math.floor(body.length / rateChars)
  const rendered = useMemo(() => {
    // Pre-turn state: the in-flight floor isn't committed yet, so use the latest committed vars.
    const vars = useChatStore.getState().floors.slice(-1)[0]?.variables || {}
    return buildStreamingHead(
      body,
      { rateChars, liveOn, vars, user: personaName, char: charName },
      {
        renderLive: (text, v) => renderTemplate(text, v, 'live'),
        applyRegex: (text, ctx) => useRegexStore.getState().apply(text, ctx)
      }
    )
    // regexRules is a deliberate store-read dep: applyRegex reads useRegexStore.getState().rules, so a
    // rule change must re-run the transform though it isn't referenced directly (mirrors ChatView's memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rate-limited: re-run only on a new checkpoint
  }, [checkpoint, liveOn, rateChars, personaName, charName, regexRules])
  // Rendered head (up to the last checkpoint) + the still-raw tail, so the text keeps flowing.
  const rawTail = body.slice(rendered.atLen)

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
      {rendered.html || rawTail ? (
        <>
          {/* Beautified head (regex + markdown + inline/static HTML cards), re-rendered only at rate
              checkpoints; the still-arriving tail stays a cheap plain-text node updated per frame. */}
          {rendered.html ? (
            <MessageContent content={rendered.html} css={cardCss} streaming />
          ) : null}
          {rawTail ? <div className="streaming-text">{rawTail}</div> : null}
        </>
      ) : state === 'none' ? (
        <em className="generating-pulse">
          {preLabelKey ? t(preLabelKey) : streamingText ? t('chat.thinking') : t('chat.generating')}
        </em>
      ) : null}
      <div ref={endRef} />
    </div>
  )
}
