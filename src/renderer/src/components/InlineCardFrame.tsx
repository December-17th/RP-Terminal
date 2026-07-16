// src/renderer/src/components/InlineCardFrame.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { buildCardDoc } from './cardDoc'
import { fitInlineCardHeight, capCardHeight } from './cardFrameHeight'
import { installCardBridge, installCardTopSurface } from '../cardBridge'
import { buildInlineLibTags } from '../cardBridge/cardLibs'
import { buildEnvHead } from '../../../shared/cardEnv'
import { HtmlFrame } from './HtmlFrame'
import { createInlineCardLayout, normalizeInlineFitDocument } from './inlineCardLayout'
import type { CardSizing } from '../../../shared/cardRenderMode'
import type { CardChatScope } from '../../../shared/thRuntime/types'

installCardBridge() // idempotent; ensures window.__rptCardBridge exists before any frame mounts.
// Expose the namespaced card surface on the renderer top window so an inline full-page card's
// window.top.{SillyTavern,TavernHelper,Mvu,EjsTemplate} resolves. Called HERE (not nested in
// installCardBridge) so it runs unconditionally at module load, independent of the bridge's guard.
installCardTopSurface()

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
  sizing = 'fit',
  trusted = false,
  chatScope,
  onContextMenu
}: {
  html: string
  sizing?: CardSizing
  /**
   * Defensive trust gate (card-trust-boundary issue 01). This frame is same-origin and reaches
   * window.parent.api, so it must ONLY mount for a card the user trusted. The router
   * (MessageContent → resolveScriptedHtmlRoute) never sends an untrusted block here; this belt-and-
   * braces check renders the static, script-free frame instead if a future call site forgets to.
   */
  trusted?: boolean
  /**
   * Panel chat scope (general): when set, the card's chat reads reflect these messages instead of the
   * real chat (chat-READ-only — see createThRuntime). Serialized into the bridge bootstrap ctx below.
   */
  chatScope?: CardChatScope
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
    const ctx = { profileId, chatId, characterId, chatScope }
    // Classic bridge bootstrap: runs synchronously during head parse, BEFORE the card's deferred
    // modules. It pulls the bridge globals from the parent realm and copies the bridge's own enumerable
    // keys (Object.keys, since the bridge is a plain object literal) onto the iframe window (guarding
    // undefined). The ctx JSON has `<` escaped to < so a value can never break out of this inline
    // <script> (e.g. a stray "</script>").
    const boot =
      `<meta charset="utf-8">` +
      `<script>(function(){try{` +
      `var ctx=${JSON.stringify(ctx).replace(/</g, '\\u003c')};` +
      `var g=window.parent.__rptCardBridge(ctx);` +
      `Object.keys(g).forEach(function(k){try{if(g[k]!==undefined)window[k]=g[k];}catch(e){}});` +
      `}catch(e){console.error('[rpt card bridge]',e);}})();</script>`
    // The shared rendering-env: base reset + avatar CSS + the assumed-lib tags (Vue/jQuery/Pinia/Router +
    // SP2's jQuery-UI/touch-punch/FontAwesome/Tailwind) + the --TH-viewport-height bootstrap, built ONCE
    // in cardEnv so inline and WCV inject the same thing. Avatar URLs are omitted today (no sync source —
    // charAvatarPath is a stub and RPT has no persona avatar), so those rules no-op until wired.
    // Sizing: `fill` seeds --TH-viewport-height to a viewport-fraction box; `fit` uses the app viewport.
    // Both rewrite viewport minimums before mount, matching JS-Slash-Runner without changing normal minima.
    const vp =
      typeof window === 'undefined'
        ? undefined
        : sizing === 'fill'
          ? capCardHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)
          : window.innerHeight
    const layout = createInlineCardLayout(html, sizing)
    const env = buildEnvHead({
      libTags: buildInlineLibTags(),
      sizing,
      viewportHeightPx: vp,
      scrollable: layout.scrollable
    })
    return buildCardDoc(layout.html, { headInject: boot + env })
  }, [html, profileId, chatId, characterId, sizing, chatScope])

  // Auto-height (same-origin: read contentDocument) + right-click forwarding. Mirrors HtmlFrame.
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    let visibility: IntersectionObserver | undefined
    // Root `height` can still couple the card to the iframe viewport. Normalize only the two roots;
    // descendant min-heights are authored control/card constraints and must remain intact.
    const normalizeFitDocument = (): void => {
      try {
        const doc = frame.contentDocument
        if (!doc) return
        normalizeInlineFitDocument(doc)
      } catch {
        /* ignore */
      }
    }
    const measureFit = (): void => {
      try {
        const doc = frame.contentDocument
        if (!doc?.body) return
        normalizeFitDocument()
        // Fit the frame to the card's TRUE content height (with no inner scrollbar) by reading
        // `body.scrollHeight` plus body's own margins. body.scrollHeight is content-sized and — unlike
        // documentElement.scrollHeight — is NOT floored at the iframe viewport, so it still SHRINKS when a
        // sub-panel closes; it only OMITS body's margins, which we add back (else the frame ends ~16px
        // short and a scrollbar reappears). +8 absorbs sub-pixel rounding.
        //
        // This deliberately does NOT use the old "collapse the frame to height:0, read the un-floored
        // documentElement.scrollHeight, restore" trick. Forcing a 0-height viewport RACED the card's own
        // expand reflow: read at the wrong instant it reported the PRE-expand (collapsed) height, so an
        // expanded sub-panel latched the frame too small and stayed clipped — the plot-recall panel's
        // "clicking won't let me expand" bug (the card sits in a collapsed <details>, so its first measure
        // ran while off-layout, making the race reliable). A collapsible driven by a `max-height`/`height`
        // CSS TRANSITION is handled by the transitionend re-measure in onLoad below.
        const cs = frame.contentWindow?.getComputedStyle(doc.body)
        const margins = cs
          ? (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
          : 0
        setHeight(fitInlineCardHeight(doc.body.scrollHeight + margins + 8, window.innerHeight))
      } catch {
        /* cross-origin guard (shouldn't happen — same origin) */
      }
    }
    // Fill: a fixed viewport-fraction box. The card's min-height:100vh (rewritten to var(--TH-viewport-
    // height) in the srcDoc) fills it; no content measure/neutralize — set the height and keep the CSS var
    // in sync. capCardHeight's cap (~70% of the viewport) is the fill height.
    const applyFill = (): void => {
      try {
        const t = capCardHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)
        setHeight(t)
        frame.contentDocument?.documentElement.style.setProperty('--TH-viewport-height', `${t}px`)
      } catch {
        /* ignore */
      }
    }
    const refresh = (): void => (sizing === 'fill' ? applyFill() : measureFit())
    const onCtx = (e: Event): void => {
      e.preventDefault()
      const me = e as MouseEvent
      const rect = frame.getBoundingClientRect()
      // Translate iframe-local coords into the parent viewport.
      ctxRef.current?.(rect.left + me.clientX, rect.top + me.clientY)
    }
    const onLoad = (): void => {
      refresh()
      try {
        const doc = frame.contentDocument
        const body = doc?.body
        // Fit observes `body` (content-sized after the viewport rewrite/root normalization): it shrinks
        // when the card collapses
        // a sub-panel, firing a re-measure so the frame follows back DOWN. Fill is a fixed box (no observe).
        if (sizing !== 'fill' && body && 'ResizeObserver' in window) {
          observer = new ResizeObserver(measureFit)
          observer.observe(body)
        }
        // A card collapsible driven by a `max-height`/`height` CSS TRANSITION grows the body over several
        // frames, and the ResizeObserver does not reliably deliver a notification for the FINAL frame — a
        // single measure can latch a mid-animation height, so an expanded panel appears half-open. Re-fit
        // when any transition completes so the frame lands on the card's settled height. Capture-phase so
        // it catches transitions on any descendant; fit mode only (fill is a fixed box). The listener
        // lives on this load's document and dies with it on reload/unmount (same as `contextmenu` below).
        if (sizing !== 'fill') doc?.addEventListener('transitionend', measureFit, true)
        doc?.addEventListener('contextmenu', onCtx)
      } catch {
        /* ignore */
      }
    }
    frame.addEventListener('load', onLoad)
    window.addEventListener('resize', refresh)
    // A frame mounted while OFF-LAYOUT measures wrong: the plot-recall panel embeds this frame inside a
    // collapsed <details>, so `load` fires (and `measureFit` runs) while the frame has no box — it settles
    // at ~0, and the ResizeObserver above, watching a zero-box body, isn't reliably delivered when the
    // panel finally opens (Chromium skips display:none / content-visibility:hidden subtrees). So the panel
    // opened to an empty ~0-height frame. Re-run the measure whenever the frame crosses into view; cheap +
    // idempotent for always-visible cards, and it self-corrects the hidden-mount + reopen cases.
    if ('IntersectionObserver' in window) {
      visibility = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) refresh()
      })
      visibility.observe(frame)
    }
    return () => {
      frame.removeEventListener('load', onLoad)
      window.removeEventListener('resize', refresh)
      observer?.disconnect()
      visibility?.disconnect()
      try {
        ;(frame.contentWindow as any)?.__rptDispose?.()
      } catch {
        /* ignore */
      }
    }
  }, [srcDoc, sizing])

  // Defensive trust gate: never mount the same-origin, parent-reachable frame for an untrusted
  // card. The router already routes untrusted scripted HTML elsewhere; this stops any future call
  // site from reintroducing the bypass. Static (script-free, sanitized) fallback keeps content
  // visible. Placed after all hooks so the rules-of-hooks order is stable across renders.
  if (!trusted) return <HtmlFrame html={html} onContextMenu={onContextMenu} />

  // margin: 10px top/bottom breathing room between the card and the surrounding message text.
  return (
    <iframe
      ref={ref}
      className="card-frame"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      // Transparent backing (parity with the WCV path's #00000000): an iframe defaults to opaque white,
      // so a card whose doc doesn't paint its own background would otherwise show a white block over the
      // dark message area. The card's own bg composites on top; only unpainted areas fall through.
      style={{
        width: '100%',
        height,
        border: 0,
        display: 'block',
        margin: '10px 0',
        background: 'transparent',
        colorScheme: 'normal'
      }}
      title="card content"
    />
  )
}
