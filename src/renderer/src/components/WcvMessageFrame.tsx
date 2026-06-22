import { useEffect, useMemo, useRef } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'

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

  // Wrap the regex block in a minimal document (with a CSP) and hand the whole thing to the WCV as a
  // data: URL — its scripts then run with the shim, doing their own (possibly nested) loading.
  const dataUrl = useMemo(() => {
    const inner = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html
    const doc =
      '<!doctype html><html><head><meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>${inner}</body></html>`
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(doc)
  }, [html])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
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

  return (
    <div ref={hostRef} style={{ width: '100%', height: '70vh', minHeight: 360 }}>
      <div style={{ opacity: 0.4, padding: 12, fontSize: 12 }}>Loading card UI…</div>
    </div>
  )
}
