// src/renderer/src/components/InlineCardFrame.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { buildCardDoc } from './cardDoc'
import { fitInlineCardHeight } from './cardFrameHeight'
import { installCardBridge } from '../cardBridge'
import { CARD_LIB_URLS } from '../cardBridge/cardLibs'

installCardBridge() // idempotent; ensures window.__rptCardBridge exists before any frame mounts.

/**
 * Inline card renderer — the card runs in a SAME-ORIGIN srcdoc iframe embedded in the message DOM.
 * Because the iframe is same-origin (srcdoc inherits the app origin) and sandboxed with BOTH
 * allow-scripts + allow-same-origin, a parse-time bootstrap can reach window.parent.__rptCardBridge
 * SYNCHRONOUSLY for the API globals, and we can measure the content height to auto-size the element
 * (so the card grows into the message column and scrolls with the chat — no inner scrollbar).
 *
 * Trusted-card policy: allow-scripts+allow-same-origin intentionally lifts sandboxing (cards are
 * trusted). The crash-isolated alternative is Isolated (WCV) mode.
 */
export function InlineCardFrame({
  html,
  onContextMenu
}: {
  html: string
  onContextMenu?: (x: number, y: number) => void
}): React.ReactElement {
  const ref = useRef<HTMLIFrameElement>(null)
  const ctxRef = useRef(onContextMenu)
  ctxRef.current = onContextMenu
  const [height, setHeight] = useState(120)

  const profileId = useProfileStore((s) => s.activeProfile?.id ?? '')
  const chatId = useChatStore((s) => s.activeChatId ?? '')
  const characterId = useCharacterStore((s) => s.activeCharacter?.id ?? '')

  const srcDoc = useMemo(() => {
    const ctx = { profileId, chatId, characterId }
    const libTags = CARD_LIB_URLS.map((u) => `<script src="${u}"></script>`).join('')
    // Classic bootstrap: runs synchronously during head parse, BEFORE the card's deferred modules.
    // It pulls the bridge globals from the parent realm and copies the bridge's own enumerable keys
    // (Object.keys, since the bridge is a plain object literal) onto the iframe window (guarding
    // undefined), then loads the realm-bound DOM libs. The ctx JSON has `<` escaped to < so a
    // value can never break out of this inline <script> (e.g. a stray "</script>").
    const boot =
      `<meta charset="utf-8">` +
      `<script>(function(){try{` +
      `var ctx=${JSON.stringify(ctx).replace(/</g, '\\u003c')};` +
      `var g=window.parent.__rptCardBridge(ctx);` +
      `Object.keys(g).forEach(function(k){try{if(g[k]!==undefined)window[k]=g[k];}catch(e){}});` +
      `}catch(e){console.error('[rpt card bridge]',e);}})();</script>` +
      libTags
    return buildCardDoc(html, { headInject: boot })
  }, [html, profileId, chatId, characterId])

  // Auto-height (same-origin: read contentDocument) + right-click forwarding. Mirrors HtmlFrame.
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    // A card designed as a full-viewport panel pins an element's min-height to 100vh (html/body, its mount
    // root #app, OR a deeper wrapper like the character viewer's `.viewer-root`). Inside an auto-height
    // iframe that makes the element as tall as the frame, which feeds back through the ResizeObserver (the
    // runaway) and forces an inner scrollbar. Collapsing every `min-height:100vh` to 0 lets the card flow
    // to its REAL content so the frame fits it. min-height:0 is lossless — it only drops a "fill the
    // viewport" FLOOR, never clamps real content — so it's safe to apply to the whole subtree. We write
    // inline !important (the most robust — it beats the card's stylesheet rules at ANY specificity, even
    // !important class rules), skip already-neutralized nodes so repeated measures stay cheap, and re-apply
    // on every measure so a loader card's asynchronously-mounted nodes are caught too. height:auto stays on
    // html/body only (collapsing a deeper element's height could break its internal layout).
    const neutralizeViewportHeight = (): void => {
      try {
        const doc = frame.contentDocument
        if (!doc) return
        for (const el of [doc.documentElement, doc.body]) {
          if (el && el.style.height !== 'auto') el.style.setProperty('height', 'auto', 'important')
        }
        if (!doc.body) return
        for (const el of [doc.body, ...doc.body.querySelectorAll<HTMLElement>('*')]) {
          if (el.style.minHeight !== '0px') el.style.setProperty('min-height', '0', 'important')
        }
      } catch {
        /* ignore */
      }
    }
    const measure = (): void => {
      try {
        const doc = frame.contentDocument
        const root = doc?.documentElement
        if (!root || !doc.body) return
        neutralizeViewportHeight()
        // Fit the frame to the card's TRUE content height so it embeds inline with no inner scrollbar.
        // Two traps this avoids: (1) the ROOT's scrollHeight is FLOORED at the iframe's viewport height,
        // so reading it while the frame is tall can never report smaller — the frame would never shrink
        // when a sub-panel closes (a stuck gap). (2) body.scrollHeight DOES shrink but EXCLUDES body's
        // margins, so the frame ends ~16px short and a scrollbar reappears. So we momentarily collapse the
        // frame (viewport floor -> ~0), read the root scrollHeight (full content incl. margins, now not
        // floored), then restore. Both writes are synchronous, so the browser never paints the collapsed
        // state (no flicker). +8 absorbs sub-pixel rounding so a 1px scrollbar can't sneak back.
        const prev = frame.style.height
        frame.style.height = '0'
        const content = root.scrollHeight
        frame.style.height = prev
        setHeight(fitInlineCardHeight(content + 8, window.innerHeight))
      } catch {
        /* cross-origin guard (shouldn't happen — same origin) */
      }
    }
    const onCtx = (e: Event): void => {
      e.preventDefault()
      const me = e as MouseEvent
      const rect = frame.getBoundingClientRect()
      // Translate iframe-local coords into the parent viewport.
      ctxRef.current?.(rect.left + me.clientX, rect.top + me.clientY)
    }
    const onLoad = (): void => {
      measure()
      try {
        const doc = frame.contentDocument
        const body = doc?.body
        if (body && 'ResizeObserver' in window) {
          observer = new ResizeObserver(measure)
          // OBSERVE `body` (content-sized via the neutralize above): it shrinks when the card collapses a
          // sub-panel, firing a re-measure so the frame follows back DOWN. documentElement fills the
          // viewport, so observing it would never fire on shrink (and its scrollHeight can't shrink either).
          observer.observe(body)
        }
        doc?.addEventListener('contextmenu', onCtx)
      } catch {
        /* ignore */
      }
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      observer?.disconnect()
      try {
        ;(frame.contentWindow as any)?.__rptDispose?.()
      } catch {
        /* ignore */
      }
    }
  }, [srcDoc])

  // margin: 10px top/bottom breathing room between the card and the surrounding message text.
  return (
    <iframe
      ref={ref}
      className="card-frame"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block', margin: '10px 0' }}
      title="card content"
    />
  )
}
