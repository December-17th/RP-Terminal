// src/renderer/src/components/InlineCardFrame.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { buildCardDoc } from './cardDoc'
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
    // It pulls the bridge globals from the parent realm and copies the bridge's own-enumerable keys
    // onto the iframe window (guarding undefined), then loads the realm-bound DOM libs.
    const boot =
      `<meta charset="utf-8">` +
      `<script>(function(){try{` +
      `var ctx=${JSON.stringify(ctx)};` +
      `var g=window.parent.__rptCardBridge(ctx);` +
      `for(var k in g){try{if(g[k]!==undefined)window[k]=g[k];}catch(e){}}` +
      `}catch(e){console.error('[rpt card bridge]',e);}})();</script>` +
      libTags
    return buildCardDoc(html, { headInject: boot })
  }, [html, profileId, chatId, characterId])

  // Auto-height (same-origin: read contentDocument) + right-click forwarding. Mirrors HtmlFrame.
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    const measure = (): void => {
      try {
        const doc = frame.contentDocument
        if (doc?.documentElement) setHeight(doc.documentElement.scrollHeight + 4)
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
          observer.observe(doc!.documentElement)
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
    }
  }, [srcDoc])

  return (
    <iframe
      ref={ref}
      className="card-frame"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block' }}
      title="card content"
    />
  )
}
