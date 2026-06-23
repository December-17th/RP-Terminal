import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { buildCardDoc } from './cardDoc'
import { capCardHeight } from './cardFrameHeight'

/**
 * Renders a card's regex-injected "frontend card" — whatever HTML+script block the card's regex puts
 * in the message — as an out-of-process WebContentsView overlaid on its place IN THE MESSAGE. This is
 * the CARD-AGNOSTIC path: we don't pattern-match the loader; we run the block as-is in the WCV, where
 * the preload shim is the TavernHelper compatibility layer (window.TavernHelper/Mvu/SillyTavern/$/Vue/…)
 * and the card's own code does whatever loading it does — jQuery `.load`, ESM `import`, nested scripts
 * pulling in more scripts — all natively, because the WCV is a real Chromium page.
 *
 * The placeholder div reserves the space; the native view (in main) is positioned to match its
 * window-rect (re-measured on scroll / resize). Keyed per instance so flipping the floor pager remounts
 * it. (Fixed height for now; reporting the card's own content height to auto-size the slot is a follow-up.)
 */
let seq = 0
// Mirrors wcvManager.CARD_CSP (can't import a main-process module here). Trusted-card policy: allow
// https code/styles/fonts/media so the card's own assets (Google Fonts, CDN audio, images) load;
// process isolation is the real boundary.
const CSP =
  "default-src 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  'img-src * data: blob:; media-src * data: blob:; connect-src * data: blob:'

export function WcvMessageFrame({ html }: { html: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const slotId = useRef(`msg-wcv-${seq++}`).current
  const profileId = useProfileStore((s) => s.activeProfile?.id ?? '')
  const chatId = useChatStore((s) => s.activeChatId)
  const characterId = useCharacterStore((s) => s.activeCharacter?.id ?? '')
  // Slot height is driven by the card's own reported content height (auto-size); start small so a short
  // card doesn't reserve a big empty box before it reports. scrollElRef lets the wheel-forward handler
  // scroll the message list (the card's nearest scrollable ancestor).
  const [height, setHeight] = useState(120)
  const scrollElRef = useRef<HTMLElement | null>(null)

  // Build the card document (preserving its <head> CSS) and hand the whole thing to the WCV as a
  // data: URL — its scripts then run with the shim, doing their own (possibly nested) loading.
  const dataUrl = useMemo(
    () =>
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        buildCardDoc(html, {
          headInject: `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`
        })
      ),
    [html]
  )

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    // Nearest scrollable ancestor. A WebContentsView is a native overlay that does NOT clip to a div, so
    // clamp its bounds to this container — otherwise it paints over the composer / chrome when scrolled.
    let scrollEl: HTMLElement | null = el.parentElement
    while (scrollEl) {
      const oy = getComputedStyle(scrollEl).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      scrollEl = scrollEl.parentElement
    }
    scrollElRef.current = scrollEl // shared with the wheel-forward handler
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      let top = r.top
      let bottom = r.bottom
      let left = r.left
      let right = r.right
      if (scrollEl) {
        const c = scrollEl.getBoundingClientRect()
        top = Math.max(top, c.top)
        bottom = Math.min(bottom, c.bottom)
        left = Math.max(left, c.left)
        right = Math.min(right, c.right)
      }
      return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      }
    }
    window.api.wcvEnsure(slotId, rect(), dataUrl, { profileId, chatId: chatId || '', characterId })
    const onChange = (): void => window.api.wcvSetBounds(slotId, rect())
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    window.addEventListener('resize', onChange)
    // The message scrolls inside the floor viewport (a scrollable ancestor, not the window), so track
    // scroll on every ancestor to keep the overlay aligned.
    const scrollers: EventTarget[] = [window]
    for (let p = el.parentElement; p; p = p.parentElement) scrollers.push(p)
    scrollers.forEach((s) => s.addEventListener('scroll', onChange, { passive: true }))
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onChange)
      scrollers.forEach((s) => s.removeEventListener('scroll', onChange))
      window.api.wcvDestroy(slotId)
    }
  }, [slotId, dataUrl, profileId, chatId, characterId])

  // Auto-size the slot to the card's reported content height, and scroll the message list when the card
  // forwards a wheel delta (the native overlay would otherwise swallow it). Both are filtered to our slot.
  useEffect(() => {
    const offSize = window.api.onWcvSlotSize((p: { slotId: string; height: number }) => {
      // Fit the card's content, but cap it so a full-viewport-designed card (min-height:100vh, e.g. the
      // character viewer) becomes a contained, scrollable widget instead of filling the message area. A
      // native overlay clips to its bounds anyway, so the excess scrolls internally (wheel-chaining
      // forwards to the message list at the edges). 0.7 leaves surrounding chat visible for context.
      if (p.slotId === slotId && p.height > 0) {
        setHeight(capCardHeight(p.height, scrollElRef.current?.clientHeight ?? window.innerHeight))
      }
    })
    const offWheel = window.api.onWcvWheel((p: { slotId: string; dy: number }) => {
      if (p.slotId === slotId) scrollElRef.current?.scrollBy({ top: p.dy })
    })
    return () => {
      offSize()
      offWheel()
    }
  }, [slotId])

  return (
    <div ref={hostRef} style={{ width: '100%', height, minHeight: 80 }}>
      <div style={{ opacity: 0.4, padding: 12, fontSize: 12 }}>Loading card UI…</div>
    </div>
  )
}
