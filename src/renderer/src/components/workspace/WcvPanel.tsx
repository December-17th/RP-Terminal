import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useWorkspaceContext } from './context'
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

export function WcvPanel({ slotId, url }: { slotId: string; url: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const layouts = useWorkspaceStore((s) => s.layouts) // re-measure when the layout changes
  const { profileId } = useWorkspaceContext()
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
    window.api.wcvEnsure(slotId, rect(), url, { profileId, chatId: chatId || '', characterId })
    const onChange = (): void => window.api.wcvSetBounds(slotId, rect())
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    window.addEventListener('resize', onChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onChange)
      window.api.wcvDestroy(slotId)
    }
  }, [slotId, url, profileId, chatId, characterId])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    window.api.wcvSetBounds(slotId, { x: r.left, y: r.top, width: r.width, height: r.height })
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
