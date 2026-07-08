import React, { useEffect, useState } from 'react'
import { WcvPanel } from './WcvPanel'
import { useOverlayStore } from '../../stores/overlayStore'
import { useChatStore } from '../../stores/chatStore'
import { useCharacterStore } from '../../stores/characterStore'

/**
 * Full-play-area overlay host (PM-A7). Mounts a card's `panel_ui.overlays` surface as a WCV covering the
 * whole play-area container (this element is `inset:0` inside the workspace wrapper, so its reported rect
 * is the panel_ui grid region — NOT the titlebar / TopStrip). The overlay is a normal `WcvPanel` under a
 * reserved `overlay:<id>` slot id, so it lands in main's slot map and inherits freeze-frame + suppression.
 *
 * Main is the single source of truth (via `onWcvOverlay`): it sends `open` / `close`, and the card's own
 * ✕ / backdrop / Esc route through `rptHost.closeOverlay()` → main → a close message here. The app also
 * closes on Esc when focus is outside the overlay (window keydown) and force-closes on session / card
 * switch (effect cleanup). Open fades the container in (240ms), close fades out (160ms) then unmounts;
 * `prefers-reduced-motion` collapses both to instant. The visible dim/scrim is card-painted (the overlay
 * WCV is transparent) — this container only manages the fade timing + the WCV lifecycle.
 */

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

export function OverlayHost(): React.ReactElement | null {
  const { overlayId, entry, phase, open, beginClose, clear } = useOverlayStore()
  const chatId = useChatStore((s) => s.activeChatId)
  const characterId = useCharacterStore((s) => s.activeCharacter?.id ?? '')
  const [visible, setVisible] = useState(false)

  // Main drives open/close; the renderer only reflects it.
  useEffect(() => {
    const unsub = window.api.onWcvOverlay((p) => {
      if ('open' in p) open(p.open)
      else beginClose()
    })
    return unsub
  }, [open, beginClose])

  // App-side Esc (focus outside the overlay WCV — the card's own Esc is handled inside its surface).
  // Route through main so its controller stays authoritative; main echoes the close back here.
  useEffect(() => {
    if (!overlayId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.api.closeOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlayId])

  // Force-close on session / card switch (and on play-area teardown): tell main to drop the overlay.
  useEffect(() => {
    return () => {
      window.api.closeOverlay()
    }
  }, [chatId, characterId])

  // Fade-in on open: start hidden, flip visible next frame so the opacity transition runs.
  useEffect(() => {
    if (!overlayId || phase !== 'open') return
    setVisible(false)
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [overlayId, phase])

  // Fade-out on close: run the transition, then unmount (which tears the WCV down).
  useEffect(() => {
    if (phase !== 'closing') return
    setVisible(false)
    const ms = prefersReducedMotion() ? 0 : 160
    const t = setTimeout(() => clear(), ms)
    return () => clearTimeout(t)
  }, [phase, clear])

  if (!overlayId || !entry) return null

  const openMs = prefersReducedMotion() ? 0 : 240
  const closeMs = prefersReducedMotion() ? 0 : 160
  return (
    <div
      className="ws-overlay-host"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        opacity: visible ? 1 : 0,
        transition: `opacity ${phase === 'closing' ? closeMs : openMs}ms ease-out`
      }}
    >
      <WcvPanel key={overlayId} slotId={`overlay:${overlayId}`} url={entry} />
    </div>
  )
}
