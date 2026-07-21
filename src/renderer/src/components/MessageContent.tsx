import React, { useEffect, useId, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import { isInteractiveHtml } from '../plugin/bridgeShim'
import { splitHtml } from '../../../shared/displayBlocks'
import { extractStyleBlocks, scopeCss, scopeClassFor } from './messageHtmlScope'
import { WcvMessageFrame } from './WcvMessageFrame'
import { InlineCardFrame } from './InlineCardFrame'
import { HtmlFrame } from './HtmlFrame'
import { useSettingsStore } from '../stores/settingsStore'
import { useProfileStore } from '../stores/profileStore'
import { useCharacterStore } from '../stores/characterStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { resolveScriptedHtmlRoute } from './messageCardRouting'
import { DEFAULT_CARD_RENDER_MODE, DEFAULT_CARD_SIZING } from '../../../shared/cardRenderMode'
import type { CardChatScope } from '../../../shared/thRuntime/types'
import { useT } from '../i18n'

interface Props {
  content: string
  /** Optional card-level CSS (data.extensions.rp_terminal.css), scoped to the frame. */
  css?: string
  /** Right-click anywhere in the message (incl. inside the rendered card); gives viewport coords. */
  onContextMenu?: (x: number, y: number) => void
  /**
   * True while the owning message is still streaming. Scripted/interactive HTML cards are held behind a
   * lightweight placeholder until the message settles: mounting them mid-stream would run the card
   * `<script>` (host writes / network side effects), and `FloorBlock` re-runs it at settle → double
   * execution. Static (script-free) HTML cards, inline HTML, and markdown still render live. See
   * StreamingView.
   */
  streaming?: boolean
  /**
   * Panel chat scope (general entry point): when a scripted card here is rendered inside a UI panel whose
   * content IS its chat (the plot panel; future reasoning/agent panels), pass the panel's messages as the
   * scope. Forwarded to the scripted-card frames (inline + WCV) so the card's chat reads reflect these
   * messages instead of the real chat (chat-READ-only). The static HtmlFrame path ignores it (no runtime).
   */
  chatScope?: CardChatScope
}

/**
 * Renders an AI message. SillyTavern-style beautification regex emits ```html
 * fenced documents (or bare <body>/<html> frontend cards); those segments are
 * rendered inside a sandboxed iframe — interactive (scripted) when they carry a
 * <script>, otherwise sanitized + script-free. Everything else renders as
 * GitHub-flavored markdown.
 */
export const MessageContent: React.FC<Props> = ({
  content,
  css,
  onContextMenu,
  streaming,
  chatScope
}) => {
  const t = useT()
  const parts = useMemo(() => splitHtml(content), [content])
  const globalMode =
    useSettingsStore((s) => s.settings?.cards?.renderMode) ?? DEFAULT_CARD_RENDER_MODE
  const globalSizing = useSettingsStore((s) => s.settings?.cards?.sizing) ?? DEFAULT_CARD_SIZING

  // Trust provenance = the chat's active character card. Scripted HTML executes only under that
  // card's persisted grants, NOT the render-mode setting alone (card-trust-boundary issue 01).
  const profileId = useProfileStore((s) => s.activeProfile?.id ?? '')
  const cardId = useCharacterStore((s) => s.activeCharacter?.id ?? '')
  const trusted = useCardScriptsStore((s) => (cardId ? s.trustedByCard[cardId] : undefined))
  const decided = useCardScriptsStore((s) => (cardId ? s.decidedByCard[cardId] : undefined))

  // Cold fallback: a chat opened before any script host mounted has no grants in the store yet, so
  // `decided` is undefined and the router fails CLOSED (WCV). Read the persisted grants once and
  // seed the store so a trusted card resolves to inline (and a denied one to static). `decided`
  // being undefined for the active card is the "not yet resolved" signal.
  useEffect(() => {
    if (!profileId || !cardId) return
    if (useCardScriptsStore.getState().decidedByCard[cardId] !== undefined) return
    let alive = true
    window.api.pluginGetGrants(profileId, cardId).then((g) => {
      if (!alive) return
      useCardScriptsStore.getState().seed(cardId, g?.enabled !== false)
      useCardScriptsStore.getState().seedTrust(cardId, g?.trusted === true)
      useCardScriptsStore.getState().seedDecided(cardId, g?.decided === true)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

  return (
    <div
      className="message-content"
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              onContextMenu(e.clientX, e.clientY)
            }
          : undefined
      }
    >
      {parts.map((p, i) =>
        p.type === 'html' ? (
          // A scripted html block is the card's regex-injected "frontend card". Routing is
          // trust-gated: only a card the user TRUSTED runs same-origin (InlineCardFrame, reaches
          // window.parent.api). An undecided card is forced into the process-isolated WCV; a denied
          // card — or scripted HTML with no active card (bare model output) — renders static +
          // sanitized. Script-free html always stays the static inline frame. (issue 01)
          isInteractiveHtml(p.text) ? (
            // While streaming, hold a scripted card behind a placeholder: mounting the frame now would
            // run its <script> mid-stream, and FloorBlock re-runs it at settle → double execution with
            // side effects. It materializes once, when the settled floor renders (no `streaming` prop).
            streaming ? (
              <em key={i} className="generating-pulse streaming-card-pending">
                {t('chat.streamingCard')}
              </em>
            ) : (
              (() => {
                const route = resolveScriptedHtmlRoute({
                  hasCard: !!cardId,
                  trusted,
                  decided,
                  mode: p.mode,
                  globalMode
                })
                return route === 'inline' ? (
                  <InlineCardFrame
                    key={i}
                    html={p.text}
                    sizing={globalSizing}
                    trusted
                    chatScope={chatScope}
                    onContextMenu={onContextMenu}
                  />
                ) : route === 'isolated' ? (
                  <WcvMessageFrame key={i} html={p.text} sizing={globalSizing} chatScope={chatScope} />
                ) : (
                  <HtmlFrame key={i} html={p.text} css={css} onContextMenu={onContextMenu} />
                )
              })()
            )
          ) : (
            <HtmlFrame key={i} html={p.text} css={css} onContextMenu={onContextMenu} />
          )
        ) : p.type === 'inline-html' ? (
          <InlineHtml key={i} html={p.text} />
        ) : p.text.trim() ? (
          <Markdown key={i} remarkPlugins={[remarkGfm]}>
            {p.text}
          </Markdown>
        ) : null
      )}
    </div>
  )
}

// Segmentation of a message's beautified html into markdown / inline-html / scripted-frame blocks
// now lives in the shared runtime (src/shared/displayBlocks.ts) so card panels that own the chat rect
// can reuse the EXACT routing instead of reimplementing it — ADR 0023 (DisplayHost) companion. These
// thin re-exports keep MessageContent's importers (and its tests) pointing at the same names.
export { splitHtml, stripUnknownHtmlTags } from '../../../shared/displayBlocks'
export type { Segment } from '../../../shared/displayBlocks'

// Tags barred from the card body. Scripts + event handlers + javascript: URLs are stripped by
// DOMPurify's defaults; we also bar embedders, `<form>` (submission/phishing), and `<base>`/`<meta>`/
// `<link>`. `<style>` is extracted + scoped BEFORE sanitizing (so it's gone from the body here).
// `<input>`/`<label>`/`<button>` are deliberately allowed — CSS-`:checked` cards need them, and
// without scripts/`<form>` they're inert. Scripted cards never reach here (routed to a frame).
const INLINE_HTML_FORBID_TAGS = [
  'style',
  'link',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'form'
]

/**
 * Render a model-authored card INLINE in the message DOM (no iframe) so it blends with the prose.
 * Any `<style>` is lifted out and scoped to this card's unique container class (selector-prefixing,
 * `@import` stripped — see messageHtmlScope) so its CSS can't leak into the app UI; the body is
 * DOMPurify-sanitized. `<style>` (React child, not innerHTML) keeps a stray `</style>` in CSS text
 * from breaking out. CSS-`:checked` interactivity (a `<label>` toggling a `<checkbox>`) works
 * natively. Inline-only trade-off: model HTML lives in the app document (per the deferred-hardening
 * stance) — scripts/handlers are still stripped.
 */
const InlineHtml: React.FC<{ html: string }> = ({ html }) => {
  const scope = scopeClassFor(useId())
  const { body, css } = useMemo(() => {
    const { html: bodyHtml, css: rawCss } = extractStyleBlocks(html)
    return {
      // No ADD_TAGS/ADD_ATTR loosening needed for presentational markup: DOMPurify's defaults
      // already allow phrasing tags (<span>/<ruby>/<rt>/<rp>) and the style attribute.
      body: DOMPurify.sanitize(bodyHtml, {
        FORBID_TAGS: INLINE_HTML_FORBID_TAGS,
        ADD_ATTR: ['target']
      }),
      css: scopeCss(rawCss, scope)
    }
  }, [html, scope])
  return (
    <div className={`inline-html ${scope}`}>
      {css ? <style>{css}</style> : null}
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  )
}
