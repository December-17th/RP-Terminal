// src/renderer/src/cardBridge/topSurface.ts
//
// Expose the card API surface on the RENDERER's top window so an INLINE full-page card resolves
// `window.top.SillyTavern` / `.TavernHelper` / `.Mvu` / `.EjsTemplate`. An inline card iframe is nested
// in the renderer, so its `window.top` is the renderer app frame — which only had `__rptCardBridge`, not
// the surface itself. Full-page apps (命定之诗 home / 角色查看器) read `window.top.SillyTavern...` at boot
// and got `undefined` inline, so they only worked Isolated/WCV (where the card IS its own top page). This
// closes that gap (mirrors JSR predefine.js merging the parent surface — here onto our top frame).
//
// Scope: only the NAMESPACED objects below — NOT window.api, NOT the libs (a full-page card loads its own
// Vue/jQuery), and NOT the ~50 bare TH helpers (those reach the card's OWN window via the InlineCardFrame
// bootstrap; window.top is only the namespaced fallback). The surface is bound to the ACTIVE session and
// rebuilt (disposing the prior runtime) on a session change, so it always reflects the open chat.
import { createCardBridge, type CardCtx } from './createCardBridge'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'

// The card-facing objects a full-page card reaches via window.top.
const EXPOSE = ['SillyTavern', 'TavernHelper', 'Mvu', 'EjsTemplate', 'tavern_events', 'toastr'] as const

const activeCtx = (): CardCtx => ({
  profileId: useProfileStore.getState().activeProfile?.id ?? '',
  chatId: useChatStore.getState().activeChatId ?? '',
  characterId: useCharacterStore.getState().activeCharacter?.id ?? ''
})

const ctxKey = (c: CardCtx): string => `${c.profileId}|${c.chatId}|${c.characterId}`

let current: Record<string, unknown> | null = null

const rebuild = (): void => {
  const w = window as any
  // Dispose the previous runtime's store subscription before replacing it (avoids a leak on session switch).
  try {
    ;(current as any)?.__rptDispose?.()
  } catch {
    /* ignore */
  }
  const g = createCardBridge(activeCtx()) as Record<string, unknown>
  current = g
  for (const k of EXPOSE) {
    try {
      if (g[k] !== undefined) w[k] = g[k]
    } catch {
      /* ignore */
    }
  }
}

/**
 * Install the top-window card surface (idempotent; no-op outside a browser window for test/SSR safety).
 * Builds once against the active session, then rebinds when the active profile/chat/character changes.
 */
export function installCardTopSurface(): void {
  if (typeof window === 'undefined') return
  const w = window as any
  if (w.__rptTopSurfaceInstalled) return
  w.__rptTopSurfaceInstalled = true
  rebuild()
  // One-time visible marker so the renderer console confirms the window.top surface is live (an inline
  // full-page card reads window.top.SillyTavern...). If you don't see this, no inline card has mounted.
  try {
    console.info(
      '[rpt] card top surface on window.top:',
      EXPOSE.filter((k) => w[k] !== undefined).join(', ') || '(none!)'
    )
  } catch {
    /* ignore */
  }
  let key = ctxKey(activeCtx())
  const onChange = (): void => {
    const k = ctxKey(activeCtx())
    if (k !== key) {
      key = k
      rebuild()
    }
  }
  // Cheap on every store fire (a string compare); only rebuilds on an actual session change. These
  // subscriptions live for the app's lifetime (the surface tracks the open session) — intentionally not torn down.
  useProfileStore.subscribe(onChange)
  useChatStore.subscribe(onChange)
  useCharacterStore.subscribe(onChange)
}
