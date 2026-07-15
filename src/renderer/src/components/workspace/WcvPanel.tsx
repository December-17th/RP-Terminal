import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useProfileStore } from '../../stores/profileStore'
import { useChatStore } from '../../stores/chatStore'
import { useCharacterStore } from '../../stores/characterStore'
import { useWcvFreezeStore } from '../../stores/wcvFreezeStore'

/**
 * Renderer host for an out-of-process `WebContentsView` card-UI panel. The native view (in main) is
 * positioned to match THIS element's window-relative rect; we report the rect on mount, on size
 * change (ResizeObserver), on window resize, and whenever the workspace layout changes (a splitter
 * drag / mode switch can move us without resizing). The WebContentsView paints OVER this div, so the
 * placeholder is only visible while it loads or if unsupported.
 *
 * The loaded page talks to the host via the wcvPreload shim (`window.rptHost` + the ST/Mvu globals).
 * Callers: a user-promoted card-UI regex panel (Panel.tsx, renderMode:'panel') and a card-authored
 * static layout slot (StaticWorkspace.tsx, view:'wcv'). (The old dev round-trip test view was retired.)
 */

// A WcvPanel pushes its bounds from two paths — the ResizeObserver/window-resize effect and the
// layout effect (a splitter drag / mode switch moves the panel without resizing it). During a drag
// both fire, frequently with IDENTICAL bounds. Main rounds bounds to integer pixels and a native
// overlay only moves on integer pixels, so suppress a consecutive send whose rounded bounds match the
// last one we pushed for this slot. Keyed per slot; the entry is cleared on the panel's destroy.
type IntBounds = { x: number; y: number; width: number; height: number }
const lastSentBounds = new Map<string, IntBounds>()
function sendBounds(slotId: string, el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const bounds = { x: r.left, y: r.top, width: r.width, height: r.height }
  const rounded: IntBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  }
  const prev = lastSentBounds.get(slotId)
  if (
    prev &&
    prev.x === rounded.x &&
    prev.y === rounded.y &&
    prev.width === rounded.width &&
    prev.height === rounded.height
  ) {
    return
  }
  lastSentBounds.set(slotId, rounded)
  window.api.wcvSetBounds(slotId, bounds)
}

export function WcvPanel({ slotId, url }: { slotId: string; url: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const layouts = useWorkspaceStore((s) => s.layouts) // re-measure when the layout changes
  // Bind to the active profile from the GLOBAL store (parity with chatId/characterId below), NOT the
  // WorkspaceContext. Overlay WcvPanels (OverlayHost) mount OUTSIDE StaticWorkspace's context provider,
  // so a context read would resolve to the default '' and mis-scope the WCV's chat-vars to
  // `profiles//chat-card-vars.json` → empty surface. App.tsx only mounts the play area (and thus any
  // WcvPanel) once activeProfile is non-null, so this id is reliably populated here.
  const profileId = useProfileStore((s) => s.activeProfile?.id ?? '')
  const chatId = useChatStore((s) => s.activeChatId)
  const characterId = useCharacterStore((s) => s.activeCharacter?.id ?? '')
  // Freeze-frame bitmap for THIS slot while the native view is ducked under a DOM overlay (PM-A4).
  // Painted behind the (hidden) native view so the panel stays visually in place; empty otherwise.
  const freeze = useWcvFreezeStore((s) => s.frames[slotId])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    const initial = rect()
    window.api.wcvEnsure(slotId, initial, url, { profileId, chatId: chatId || '', characterId })
    lastSentBounds.set(slotId, {
      x: Math.round(initial.x),
      y: Math.round(initial.y),
      width: Math.max(0, Math.round(initial.width)),
      height: Math.max(0, Math.round(initial.height))
    })
    const onChange = (): void => sendBounds(slotId, el)
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    window.addEventListener('resize', onChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onChange)
      lastSentBounds.delete(slotId)
      window.api.wcvDestroy(slotId)
    }
  }, [slotId, url, profileId, chatId, characterId])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    sendBounds(slotId, el)
  }, [layouts, slotId])

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 80, position: 'relative' }}>
      {freeze ? (
        // The native view is hidden (menu open) — show its last captured frame so the panel doesn't
        // blank out. `cover` fills the slot (the capture is at the view's exact pixel size, so it
        // maps 1:1); a stale-by-a-frame bitmap is invisible against a static panel.
        <img
          src={freeze}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'top left'
          }}
        />
      ) : (
        <div style={{ opacity: 0.5, padding: 12, fontSize: 13 }}>Loading WebContentsView…</div>
      )}
    </div>
  )
}
