// src/renderer/src/cardBridge/playTheme.ts
//
// The RENDERER-side authority for the runtime play-theme API (runtime-theme-api-design §3B/§5). Both card
// transports funnel HERE: the inline Host calls these directly; the WCV Host round-trips through main,
// which pushes the call to App.tsx (which calls applyRuntimeTheme) and relays the boolean back. Keeping
// derivation in ONE place (renderer, over cardTheme.ts) is why WCV routes here instead of validating in
// main — the effective base tokens only exist in the renderer.
import { THEMES, DEFAULT_THEME_ID, type ThemeTokens } from '../theme'
import { deriveCardTheme, resolveRuntimeTheme } from '../cardTheme'
import { useUiStore, type RuntimeTheme } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCharacterStore } from '../stores/characterStore'
import { broadcastHostEvent } from './hostBroadcast'
import type { CardCtx } from '../../../shared/thRuntime/types'

/** The host event a card's sibling panels listen for to re-read getPlayTheme() after a runtime change. */
export const PLAY_THEME_CHANGED = 'PLAY_THEME_CHANGED'
/** Persisted-store keys (namespaced) holding the raw override so it survives reload/remount. ONE KEY PER
 *  TARGET (design §3B) so a persisted shell theme and a persisted message theme survive independently —
 *  they occupy separate uiStore slots and must not overwrite each other in the chat/global bag. */
const PERSIST_KEY: Record<'shell' | 'message', string> = {
  shell: 'rpt.playTheme',
  message: 'rpt.msgTheme'
}

export type PlayThemeOpts = { target?: 'shell' | 'message'; persist?: 'session' | 'chat' | 'global' }
export type PlayThemeSource = 'user' | 'card' | 'runtime'

const allowCardThemes = (): boolean =>
  (useSettingsStore.getState().settings?.ui as { allow_card_themes?: boolean } | undefined)
    ?.allow_card_themes !== false

const cardThemeRaw = (): Record<string, unknown> | undefined =>
  useCharacterStore.getState().activeCharacter?.card?.data?.extensions?.rp_terminal?.theme as
    | Record<string, unknown>
    | undefined

const userThemeId = (): string | undefined => useSettingsStore.getState().settings?.ui?.theme

/** The static base tokens the runtime layer composes over: the derived static card theme (when allowed),
 *  else the user's app-theme token set. Always a FULL map (so getPlayTheme returns a resolved map). */
function staticBaseTokens(): { tokens: ThemeTokens; hasCard: boolean } {
  const uid = userThemeId()
  const fallback = THEMES[uid && THEMES[uid] ? uid : DEFAULT_THEME_ID].tokens
  if (!allowCardThemes()) return { tokens: fallback, hasCard: false }
  const card = deriveCardTheme(cardThemeRaw(), uid)
  return { tokens: card ?? fallback, hasCard: !!card }
}

/** Merge the runtime layers over a base map (the static play tokens). Returns the base unchanged when no
 *  runtime layer is set, or null when there is neither a base nor a runtime layer (CSS falls back). */
export function mergeRuntimeTokens(
  base: ThemeTokens | null,
  runtime: RuntimeTheme | null
): ThemeTokens | null {
  if (!runtime || (!runtime.shell && !runtime.message)) return base
  return { ...(base ?? {}), ...(runtime.shell ?? {}), ...(runtime.message ?? {}) }
}

/** The fully-resolved effective play theme + a source tag (getPlayTheme's return, §7 decision 2). */
export function getEffectivePlayTheme(): { tokens: ThemeTokens; source: PlayThemeSource } {
  const { tokens: base, hasCard } = staticBaseTokens()
  const runtime = useUiStore.getState().runtimeTheme
  const active = runtime && (runtime.shell || runtime.message)
  return {
    tokens: mergeRuntimeTokens(base, runtime) ?? base,
    source: active ? 'runtime' : hasCard ? 'card' : 'user'
  }
}

const isClear = (theme: unknown): boolean =>
  theme == null ||
  (typeof theme === 'object' &&
    Object.keys((theme as { tokens?: object }).tokens ?? (theme as object)).length === 0)

/** Persist the raw override (or clear it) in the chat / global store, under the TARGET's namespaced key.
 *  Read-modify-write so sibling card vars — and the other target's slot — in the same bag are preserved.
 *  'session' persists nothing (uiStore only). */
function persist(
  scope: 'session' | 'chat' | 'global',
  ctx: CardCtx,
  target: 'shell' | 'message',
  value: unknown
): void {
  if (scope === 'session') return
  const key = PERSIST_KEY[target]
  try {
    if (scope === 'chat') {
      if (!ctx.chatId) return
      const bag = { ...(window.api.chatCardVarsGetSync(ctx.profileId, ctx.chatId) || {}) }
      if (value === null) delete bag[key]
      else bag[key] = value
      void window.api.chatCardVarsSet(ctx.profileId, ctx.chatId, bag)
    } else {
      const bag = { ...(window.api.pluginGlobalsGetSync(ctx.profileId) || {}) }
      if (value === null) delete bag[key]
      else bag[key] = value
      void window.api.pluginGlobalsSet(ctx.profileId, bag)
    }
  } catch (e) {
    console.error('[playTheme persist]', e)
  }
}

/** Push the fresh effective play theme to main so a WCV card's getPlayTheme() is at inline parity right
 *  after `await setPlayTheme()` — synchronously in the write path, ahead of the relay's boolean reply
 *  (the React snapshot effect is a backstop). No-op outside Electron (test/SSR). */
function pushSnapshot(): void {
  try {
    window.api?.setPlayThemeCache?.(getEffectivePlayTheme())
  } catch {
    /* no api */
  }
}

/**
 * Apply a runtime theme override. Universal — any card, any scope. Returns false when rejected
 * (settings.ui.allow_card_themes off, or the derived colors fail WCAG-AA) — leaving prior tokens intact;
 * true when applied or cleared. When `writePersist` is false (hydration re-apply) the persisted store is
 * not re-written. Runs in the renderer for BOTH transports.
 */
export function applyRuntimeTheme(
  theme: Record<string, unknown> | null | undefined,
  opts: PlayThemeOpts | undefined,
  ctx: CardCtx,
  writePersist = true
): boolean {
  if (!allowCardThemes()) return false
  const target = opts?.target === 'message' ? 'message' : 'shell'
  const scope = opts?.persist ?? 'session'
  const cur = useUiStore.getState().runtimeTheme
  const next: RuntimeTheme = { shell: cur?.shell ?? null, message: cur?.message ?? null }

  if (isClear(theme)) {
    next[target] = null
  } else {
    const resolved = resolveRuntimeTheme(true, target, theme ?? null, staticBaseTokens().tokens)
    if (!resolved) return false // AA reject / nothing understood — keep prior tokens
    next[target] = resolved
  }

  useUiStore.getState().setRuntimeTheme(next.shell || next.message ? next : null)
  if (writePersist) persist(scope, ctx, target, isClear(theme) ? null : { theme, target, persist: scope })
  // Refresh main's snapshot synchronously (WCV getPlayTheme parity, #3) BEFORE the relay replies, then
  // broadcast so sibling panels re-read.
  pushSnapshot()
  broadcastHostEvent(ctx.chatId, PLAY_THEME_CHANGED, getEffectivePlayTheme())
  return true
}

/** Re-hydrate the session slot from the persisted stores on session/profile load (chat over global), or
 *  clear it when neither has one (an ephemeral override must not leak across sessions). Apply-only (no
 *  re-persist). Safe to call whenever the active profile/chat changes. */
export function hydratePlayTheme(profileId: string, chatId: string): void {
  useUiStore.getState().setRuntimeTheme(null)
  if (!profileId) return
  const ctx: CardCtx = { profileId, chatId, characterId: '' }
  let found = false
  try {
    const chatBag = chatId ? window.api.chatCardVarsGetSync(profileId, chatId) : null
    const globalBag = window.api.pluginGlobalsGetSync(profileId)
    // Apply global first, then chat, so the more-specific chat scope wins a given target slot. Both the
    // shell (rpt.playTheme) and message (rpt.msgTheme) slots re-hydrate independently.
    for (const bag of [globalBag, chatBag]) {
      for (const target of ['shell', 'message'] as const) {
        const rec = bag?.[PERSIST_KEY[target]] as
          | { theme?: Record<string, unknown>; target?: 'shell' | 'message' }
          | undefined
        if (rec && rec.theme) {
          applyRuntimeTheme(rec.theme, { target: rec.target ?? target }, ctx, false)
          found = true
        }
      }
    }
  } catch (e) {
    console.error('[playTheme hydrate]', e)
  }
  if (!found) useUiStore.getState().setRuntimeTheme(null)
}
