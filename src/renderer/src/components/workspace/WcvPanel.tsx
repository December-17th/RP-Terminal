import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'

/**
 * SPIKE — renderer host for an out-of-process `WebContentsView` card-UI panel. The native view
 * (in main) is positioned to match THIS element's window-relative rect; we report the rect on
 * mount, on size change (ResizeObserver), on window resize, and whenever the workspace layout
 * changes (a splitter drag / mode switch can move us without resizing). The WebContentsView
 * paints OVER this div, so the placeholder is only visible while it loads or if unsupported.
 *
 * Bounds-sync over IPC + the overlay nature is exactly the "overlay tax" the static
 * card-determined layout is meant to remove; here it's good enough to prove the mechanism.
 */

// Minimal self-contained page so the spike needs no bundled assets yet. The real view will
// load the card's frontend build + a runtime shim preload.
const TEST_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;' +
      'justify-content:center;font-family:system-ui,sans-serif;background:#0f1420;color:#9fe1cb">' +
      '<div style="text-align:center"><div style="font-size:20px;font-weight:600">WebContentsView ✓</div>' +
      '<div style="opacity:.7;font-size:13px;margin-top:6px">out-of-process card-UI panel — spike</div></div>' +
      '</body></html>'
  )

export function WcvPanel({ slotId = 'spike' }: { slotId?: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  // Re-measure when the layout object changes (splitter resize / mode switch can shift our position).
  const layouts = useWorkspaceStore((s) => s.layouts)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    window.api.wcvEnsure(slotId, rect(), TEST_URL)
    const onChange = (): void => window.api.wcvSetBounds(slotId, rect())
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    window.addEventListener('resize', onChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onChange)
      window.api.wcvDestroy(slotId)
    }
  }, [slotId])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    window.api.wcvSetBounds(slotId, { x: r.left, y: r.top, width: r.width, height: r.height })
  }, [layouts, slotId])

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 80 }}>
      <div style={{ opacity: 0.5, padding: 12, fontSize: 13 }}>Loading WebContentsView…</div>
    </div>
  )
}
