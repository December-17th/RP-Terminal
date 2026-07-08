import { create } from 'zustand'

/**
 * Full-play-area overlay surface state (PM-A7). A card raises a `panel_ui.overlays` surface via the
 * runtime `requestOverlay(id)`; the app mounts it as a WCV covering the whole play-area container (above
 * the panel_ui slots). Main is the single source of truth — it drives `open`/`beginClose` here through
 * `onWcvOverlay`; the renderer never opens on its own (Esc / card-switch call `window.api.closeOverlay`,
 * and main echoes the close back). `phase:'closing'` keeps the WCV mounted through the fade-out before
 * `clear` unmounts it (which tears the WCV down). Card-agnostic — the surface is opaque HTML/URL.
 */
export interface OverlayState {
  overlayId: string | null
  entry: string | null
  title?: string
  phase: 'open' | 'closing'
  open: (p: { overlayId: string; entry: string; title?: string }) => void
  /** Begin the fade-out (main asked to close); `clear` finishes the unmount after the fade. */
  beginClose: () => void
  clear: () => void
}

export const useOverlayStore = create<OverlayState>((set) => ({
  overlayId: null,
  entry: null,
  title: undefined,
  phase: 'open',
  open: ({ overlayId, entry, title }) => set({ overlayId, entry, title, phase: 'open' }),
  beginClose: () => set((s) => (s.overlayId ? { phase: 'closing' } : s)),
  clear: () => set({ overlayId: null, entry: null, title: undefined, phase: 'open' })
}))
