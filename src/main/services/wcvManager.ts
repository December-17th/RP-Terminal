import { WebContentsView, BrowserWindow, session, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
import { log } from './logService'
import { serveAssetRequest, ASSET_SCHEME } from './worldAssetProtocol'
import { getGrants } from './pluginService'
import { cardCodeRoot } from './cardCodeService'
import {
  serveCardCode,
  originTokenFor,
  type CardOrigin,
  type CardServeDeps
} from './cardCodeProtocol'
import { makePanelGeometry, PanelGeometry } from './wcvGeometry'
import { createFreezeController, type FreezeTarget } from './wcvFreezeFrame'
import { createOverlayController, type OverlayDecl } from './wcvOverlay'
import { shouldOpenWcvDevTools } from './wcvDevTools'
import type { VarsOrigin, CardChatScope } from '../../shared/thRuntime/types'
import { CARD_CSP } from '../../shared/cardCsp'

// Card UI panels run in their own session partition. jsDelivr serves `/gh/` HTML as text/plain (to
// stop it being used to host pages), so Chromium shows it as raw text; the card's UI is meant to be
// loaded AS HTML (its regex does `$('body').load(...)`). We force text/html on the .html document so
// the WebContentsView renders it + runs its module script. Narrow: jsDelivr host + .html only, so JS
// modules (served as application/javascript) are untouched.
// `persist:` → the session is written to disk under the app's user-data dir, so a card's localStorage
// (and other DOM storage) survives app restarts. Without the prefix it would be in-memory and wiped on
// quit. All inline cards share this one origin (rpt-card://card), so they share this store.
const WCV_PARTITION = 'persist:wcv-cards'
// Custom scheme the inline card documents load from (registered privileged in main/index.ts). It gives
// each card a real, storage-enabled origin — a data: URL is opaque-origin, where Chromium disables
// localStorage/etc. and a storage-using card throws. The per-slot HTML is served from `slot.html`.
export const CARD_SCHEME = 'rpt-card'
// The trusted-card WCV CSP is the single source of truth in `shared/cardCsp` — the inline-message path
// (WcvMessageFrame / CardScriptWcvHost) imports the SAME constant so the policy can't drift. Re-exported
// for existing `wcvManager.CARD_CSP` import sites.
export { CARD_CSP }
let sessionReady = false
const ensureSession = (): void => {
  if (sessionReady) return
  sessionReady = true
  const ses = session.fromPartition(WCV_PARTITION)
  // rpt-card:// routing (A2). Host `card` → the legacy shared-origin per-slot inline doc (unchanged);
  // any other host → a per-card origin token: trust-gated, traversal-guarded file serving from that
  // card's extracted cartridge code. `serveCardCode` decides; this glue turns the decision into a
  // Response — file bodies stream via `net.fetch` but with the MIME FORCED to §5 (net.fetch's file
  // content-type is unreliable, and a wrong type hard-fails ES module loads).
  ses.protocol.handle(CARD_SCHEME, async (req) => {
    const r = serveCardCode(req.url, cardServeDeps)
    if (r.kind === 'inline') {
      return new Response(r.html, {
        headers: { 'content-type': r.contentType, 'content-security-policy': r.csp }
      })
    }
    if (r.kind === 'error') return new Response(r.message, { status: r.status })
    try {
      const resp = await net.fetch(pathToFileURL(r.absPath).toString())
      const headers = new Headers()
      headers.set('content-type', r.contentType)
      if (r.csp) headers.set('content-security-policy', r.csp)
      return new Response(resp.body, { status: resp.status, headers })
    } catch (e) {
      log('error', '[card-code] serve failed', String(e))
      return new Response('Error', { status: 500 })
    }
  })
  ses.protocol.handle(ASSET_SCHEME, (req) => serveAssetRequest(req))
  ses.webRequest.onHeadersReceived({ urls: ['https://*.jsdelivr.net/*'] }, (details, cb) => {
    if (!/\.html(\?|$)/i.test(details.url)) return cb({})
    const headers: Record<string, string[]> = { ...details.responseHeaders }
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase()
      if (lk === 'content-type' || lk === 'content-security-policy') delete headers[k]
    }
    headers['content-type'] = ['text/html; charset=utf-8']
    // Card-UI CSP (trusted-card): allow https code/styles/fonts/media — cards pull fonts from Google,
    // audio from CDNs, images from anywhere. Process isolation (separate WCV process, nodeIntegration
    // off, no host/Node reach) is the real boundary here, not the CSP.
    headers['content-security-policy'] = [CARD_CSP]
    cb({ responseHeaders: headers })
  })
}

// A renderer-built inline document arrives as a data:text/html URL; decode it so we can serve it from
// the storage-enabled rpt-card origin. Returns null for any other URL (e.g. a remote https card UI).
const decodeDataHtml = (url: string): string | null => {
  const m = /^data:text\/html[^,]*,/i.exec(url)
  if (!m) return null
  try {
    return decodeURIComponent(url.slice(m[0].length))
  } catch {
    return url.slice(m[0].length)
  }
}

/**
 * SPIKE — out-of-process card-UI panels via `WebContentsView`.
 *
 * Each panel slot gets one WebContentsView added to the main window's contentView, so it runs
 * in its own process (hang/crash-isolated) and paints OVER the React UI at the pixel bounds the
 * renderer reports for that slot. Each carries a (profileId, chatId) context so the host-bridge
 * IPC (read/write message variables) can resolve the right session from the calling view's
 * webContents id. Bounds are window-content-relative (same origin as getBoundingClientRect).
 */

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface Slot {
  view: WebContentsView
  profileId: string
  chatId: string
  characterId: string
  /** The inline card document served to this slot via rpt-card://card/<id> (when loaded from a data: URL). */
  html?: string
  /** Panel chat scope (general): the preload reads it (wcv-get-chat-scope-sync) and hands it to the card
   *  runtime so its chat reads reflect the panel's own messages instead of the real chat (READ-only). */
  chatScope?: CardChatScope
}

let mainWindow: BrowserWindow | null = null
const slots = new Map<string, Slot>()

// --- Per-card code-serving origins (A2) ---
// The rpt-card:// handler receives only `req.url` (NOT the sender webContents), so it cannot read slot
// ctx directly. This registry maps a per-card origin token → the card's {profileId, characterId,
// codeDir}, populated at `ensure()` time (where profileId + characterId are known). The token is stable
// per card so all its surfaces + overlays share one origin (⇒ shared localStorage / BroadcastChannel —
// the settings recipe). A `card-code:<path>` entry is rewritten to `rpt-card://<token>/<path>`.
const originRegistry = new Map<string, CardOrigin>()

/** Stable DNS-safe origin token for a characterId (sha1 injected to keep cardCodeProtocol fs/path-only). */
const originTokenOf = (characterId: string): string =>
  originTokenFor(characterId, (s) => createHash('sha1').update(s).digest('hex'))

/** Register (idempotently) a card's origin token → code dir, and return the token. */
const registerCardOrigin = (profileId: string, characterId: string): string => {
  const token = originTokenOf(characterId)
  originRegistry.set(token, {
    profileId,
    characterId,
    codeDir: cardCodeRoot(profileId, characterId)
  })
  return token
}

/** Main-side trust gate for card-code serving: served only when the grant is decided ∧ trusted (fail-closed). */
const cardIsTrusted = (origin: CardOrigin): boolean => {
  try {
    const g = getGrants(origin.profileId, origin.characterId)
    return g.decided === true && g.trusted === true
  } catch {
    return false
  }
}

const cardServeDeps: CardServeDeps = {
  cardCsp: CARD_CSP,
  slotHtml: (id) => slots.get(id)?.html,
  resolveOrigin: (token) => originRegistry.get(token) ?? null,
  isTrusted: cardIsTrusted
}

/** Card-relative split-mode entry prefix (D1): `card-code:surfaces/self.html`. */
const CODE_ENTRY_PREFIX = 'card-code:'

/** Rewrite a `card-code:<path>` entry to `rpt-card://<token>/<path>` for the given card, or null if the
 *  entry isn't a card-code entry. Percent-encodes each path segment; the handler decodes it back. */
const resolveCodeEntry = (url: string, profileId: string, characterId: string): string | null => {
  if (!url.startsWith(CODE_ENTRY_PREFIX)) return null
  if (!characterId) {
    log('error', '[card-code] card-code: entry with no characterId ctx — cannot resolve origin', url)
    return null
  }
  const token = registerCardOrigin(profileId, characterId)
  const rel = url
    .slice(CODE_ENTRY_PREFIX.length)
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `${CARD_SCHEME}://${token}/${rel}`
}

export const init = (win: BrowserWindow): void => {
  mainWindow = win
  // Tear every guest view down with the window so we don't leak guest processes.
  win.on('closed', () => destroyAll())
}

const round = (b: Bounds): Bounds => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})

// The window content size (the full stage width a seam-sliced background spans). Falls back to a
// sane default before the window reports (matches contentRect's fallback).
const contentSize = (): [number, number] => {
  const [w, h] = mainWindow?.getContentSize() ?? [1280, 800]
  return [w, h]
}

const geometryOf = (slot: Slot): PanelGeometry =>
  makePanelGeometry(slot.view.getBounds(), contentSize())

// Hand a page its own slot geometry so it can slice a full-viewport background to its x-range. Pushed
// after every bounds change; the page also does a sync read at preload load for its initial value.
const pushGeometry = (slot: Slot): void => {
  try {
    if (!slot.view.webContents.isDestroyed())
      slot.view.webContents.send('wcv-panel-geometry', geometryOf(slot))
  } catch {
    /* a page mid-teardown can't receive — ignore */
  }
}

/** Current geometry for the WCV whose page is `webContentsId` (the sync-read resolver). */
export const geometryFor = (webContentsId: number): PanelGeometry | null => {
  for (const s of slots.values()) {
    if (s.view.webContents.id === webContentsId) return geometryOf(s)
  }
  return null
}

/** Create the view for `id` (once) loading `url` with the locked-down shim preload, bind its
 *  session context, then position it at `bounds`. */
export const ensure = (
  id: string,
  bounds: Bounds,
  url: string,
  ctx: {
    profileId: string
    chatId: string
    characterId?: string
    chatScope?: CardChatScope
  } = {
    profileId: '',
    chatId: ''
  }
): void => {
  if (!mainWindow) return
  // Defensive: a fire-and-forget IPC call with a missing/garbled ctx must never crash main.
  if (!ctx || typeof ctx !== 'object') ctx = { profileId: '', chatId: '' }
  ensureSession()
  // Entry resolution:
  //  - `card-code:<path>` (split-mode panel_ui/overlay entry, D1) → the card's per-card origin
  //    `rpt-card://<token>/<path>` (registers the origin so its sub-resources resolve + trust-gate).
  //  - a data: URL (inline document, opaque origin → no storage) → the shared `rpt-card://card` origin;
  //    the HTML is stashed on the slot and served by the scheme handler.
  //  - anything else (a remote https card UI) already has a real origin → load as-is.
  const codeUrl = resolveCodeEntry(url, ctx.profileId, ctx.characterId || '')
  const inlineHtml = codeUrl ? null : decodeDataHtml(url)
  const loadUrl = codeUrl
    ? codeUrl
    : inlineHtml !== null
      ? `${CARD_SCHEME}://card/${encodeURIComponent(id)}`
      : url
  let slot = slots.get(id)
  if (!slot) {
    const view = new WebContentsView({
      webPreferences: {
        partition: WCV_PARTITION,
        // Trusted-card main-world shim (spike): the preload defines window.SillyTavern/Mvu/… in the
        // page world, so contextIsolation is off. Still a separate process with nodeIntegration:false
        // → no host/Node reach. Production vendors assets + hardens (contextBridge / CSP).
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false,
        preload: join(__dirname, '../preload/wcvPreload.js')
      }
    })
    // Transparent backing so a card's `html,body{background:transparent}` composites over the message
    // bubble behind it instead of painting an opaque white rectangle.
    view.setBackgroundColor('#00000000')
    slot = {
      view,
      profileId: ctx.profileId,
      chatId: ctx.chatId,
      characterId: ctx.characterId || '',
      html: inlineHtml ?? undefined,
      chatScope: ctx.chatScope
    }
    slots.set(id, slot)
    // A full-screen overlay may be up (chat re-render under an open menu) — start hidden so a fresh
    // view doesn't paint over it. No freeze-frame: it wasn't on screen to capture.
    freezeController.onTargetCreated(freezeTargetFor(id, slot))
    mainWindow.contentView.addChildView(view)
    view.webContents.loadURL(loadUrl) // html must be on the slot first — the scheme handler reads it
    // Pre-cache this view's freeze-frame once it has painted, so the first menu-open can hide it
    // instantly (freeze-precache). Slight delay lets the initial frame land before capture; the
    // controller throttles + skips-while-suppressed, so an early/redundant call is cheap.
    view.webContents.on('did-finish-load', () => {
      const s = slots.get(id)
      if (s) setTimeout(() => freezeController.warmTarget(freezeTargetFor(id, s)), 400)
    })
    // Each isolated card gets its own WebContentsView. Keep DevTools opt-in so
    // opening several panels never creates a stack of detached console windows.
    if (shouldOpenWcvDevTools(process.env)) view.webContents.openDevTools({ mode: 'detach' })
    log('info', `wcv: created '${id}'`)
  } else {
    slot.profileId = ctx.profileId
    slot.chatId = ctx.chatId
    slot.characterId = ctx.characterId || ''
    slot.chatScope = ctx.chatScope
    if (inlineHtml !== null) slot.html = inlineHtml // keep the served doc fresh (no reload here)
  }
  slot.view.setBounds(round(bounds))
  pushGeometry(slot)
}

export const setBounds = (id: string, bounds: Bounds): void => {
  const slot = slots.get(id)
  if (!slot) return
  slot.view.setBounds(round(bounds))
  pushGeometry(slot)
}

// The main window's content rect (0,0 → content size) — a full-window modal fills this.
const contentRect = (): Bounds => {
  const [w, h] = mainWindow?.getContentSize() ?? [1280, 800]
  return { x: 0, y: 0, width: w, height: h }
}

/**
 * Show/hide the off-screen card-script engine WCV as a full-window modal. ON slides it on-screen (and raises
 * it above any panel WCVs); OFF parks it off-screen at the SAME full size — so its page keeps running and the
 * overlay detector keeps a real viewport (a 0-size view would break detection). Driven by the engine's
 * overlay detector (`wcv-overlay`); the engine WCV is created off-screen by `CardScriptWcvHost`.
 */
export const setModal = (id: string, on: boolean): void => {
  const slot = slots.get(id)
  if (!slot) return
  const r = contentRect()
  if (on) {
    mainWindow?.contentView.addChildView(slot.view) // re-add → raise to the top of the z-order
    slot.view.setBounds(r)
  } else {
    slot.view.setBounds({ x: -(r.width + 2000), y: 0, width: r.width, height: r.height })
  }
}

/** Notify the renderer that a lorebook changed (a card wrote/created/deleted a worldbook), so the lorebook
 *  store can refresh its library + reload the open editor (it would otherwise show a stale view). */
export const pushLorebookChanged = (id: string): void => {
  mainWindow?.webContents.send('wcv-lorebook-changed', { id })
}

/** Push a card script's action buttons to the renderer toolbar (the menu above the input). */
export const pushCardButtons = (
  slotId: string,
  chatId: string,
  characterId: string,
  buttons: { name: string; visible: boolean }[]
): void => {
  mainWindow?.webContents.send('wcv-card-buttons', { slotId, chatId, characterId, buttons })
}

/** Hide without destroying (e.g. while a modal is open over it, or its tab is hidden). */
export const setVisible = (id: string, visible: boolean): void => {
  slots.get(id)?.view.setVisible(visible)
}

// A full-screen DOM overlay (a TopStrip dropdown, the workflow editor) can't cover native views —
// they always paint above the renderer — so the host ducks ALL card WCVs while it's open. Rather
// than blanking the panels, we FREEZE-FRAME them: capture each visible view, hide the live view,
// and paint the bitmap into its DOM placeholder (PM-A4). The controller owns the orchestration
// (capture → hide → push, with cancel-on-close); this module supplies the Electron effects.
//
// A hidden WebContentsView keeps webContents focus — keystrokes would go to the invisible card view
// instead of the overlay's DOM inputs (workflow rename box) — so hand focus back when hiding.
const freezeTargetFor = (id: string, slot: Slot): FreezeTarget => ({
  id,
  capture: async () => {
    try {
      if (slot.view.webContents.isDestroyed()) return null
      const img = await slot.view.webContents.capturePage()
      // A view mid-load / zero-size captures empty — no usable freeze-frame, fall back to blank.
      if (img.isEmpty()) return null
      const size = img.getSize()
      if (size.width === 0 || size.height === 0) return null
      return img.toDataURL()
    } catch {
      return null
    }
  },
  setVisible: (visible) => {
    try {
      if (!slot.view.webContents.isDestroyed()) slot.view.setVisible(visible)
    } catch {
      /* mid-teardown — ignore */
    }
    if (!visible) mainWindow?.webContents.focus()
  }
})

const freezeController = createFreezeController({
  visibleTargets: () =>
    [...slots.entries()].map(([id, slot]) => freezeTargetFor(id, slot)),
  showFreeze: (frames) => mainWindow?.webContents.send('wcv-freeze-show', frames),
  clearFreeze: () => mainWindow?.webContents.send('wcv-freeze-clear')
})

export const setAllVisible = (visible: boolean): void => {
  if (visible) freezeController.restore()
  else freezeController.suppress()
}

// --- Full-play-area overlay surfaces (PM-A7) ---
// The overlay is a normal card WCV: the renderer mounts a WcvPanel (slot id `overlay:<id>`) over the
// play-area container, so it lands in the `slots` map like any other view — freeze-frame and
// setAllVisible suppression apply to it automatically. This controller only orchestrates the
// one-at-a-time raise/dismiss + the undeclared-id reject; the caller (wcvIpc) resolves the id against
// the active card's `panel_ui.overlays` and hands the resolved surface in.
const overlayController = createOverlayController({
  open: (overlayId, decl) =>
    mainWindow?.webContents.send('wcv-open-overlay', {
      overlayId,
      entry: decl.entry,
      title: decl.title
    }),
  close: (overlayId) => mainWindow?.webContents.send('wcv-close-overlay', { overlayId }),
  warn: (overlayId) =>
    log(
      'error',
      'wcv overlay',
      `rejected overlay '${overlayId}' — not declared in the active card's panel_ui.overlays`
    )
})

/** Raise a declared overlay surface (`decl` = the resolved `panel_ui.overlays` entry, null ⇒ undeclared).
 *  Returns whether an overlay is open for that id afterward. Closes any currently-open overlay first. */
export const requestOverlay = (overlayId: string, decl: OverlayDecl | null): boolean =>
  overlayController.request(String(overlayId ?? ''), decl)

/** Close whatever overlay is open (card ✕/Esc, app-side Esc, session/card switch). No-op when none. */
export const closeOverlay = (): void => overlayController.dismiss()

export const destroy = (id: string): void => {
  const slot = slots.get(id)
  if (!slot) return
  slots.delete(id)
  // Drop this id's freeze-frame still + throttle stamp — message-WCV ids are monotonically unique, so
  // without this the captured screenshot for every destroyed surface leaks for the process lifetime.
  freezeController.dropTarget(id)
  try {
    mainWindow?.contentView.removeChildView(slot.view)
    if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close()
  } catch (err) {
    log('error', `wcv: destroy '${id}' failed`, String(err))
  }
  log('info', `wcv: destroyed '${id}'`)
}

export const destroyAll = (): void => {
  for (const id of [...slots.keys()]) destroy(id)
  // Belt-and-suspenders: empty the freeze cache + cancel any pending refresh on full teardown.
  freezeController.clear()
}

/** Resolve a view's slot context from its webContents id (for the host-bridge IPC). */
export const contextFor = (
  webContentsId: number
): { slotId: string; profileId: string; chatId: string; characterId: string } | null => {
  for (const [slotId, s] of slots) {
    if (s.view.webContents.id === webContentsId) {
      return { slotId, profileId: s.profileId, chatId: s.chatId, characterId: s.characterId }
    }
  }
  return null
}

/** The panel chat scope for the WCV whose page is `webContentsId` (the preload's sync-read resolver), or
 *  null when the slot is unscoped. Kept separate from `contextFor` so the many ctx call sites are untouched. */
export const chatScopeFor = (webContentsId: number): CardChatScope | null => {
  for (const s of slots.values()) {
    if (s.view.webContents.id === webContentsId) return s.chatScope ?? null
  }
  return null
}

/** An inline card reported its content height → host sizes that message slot to fit (no inner scroll). */
export const pushSlotSize = (slotId: string, height: number): void => {
  mainWindow?.webContents.send('wcv-slot-size', { slotId, height })
}

/** Forward a wheel delta from a card overlay to the host so the message list scrolls (the native view
 *  would otherwise swallow the wheel). Carries the slotId so only that card's host frame reacts. */
export const pushWheel = (slotId: string, dy: number): void => {
  mainWindow?.webContents.send('wcv-host-wheel', { slotId, dy })
}

/** Push updated variables to the host renderer so native panels reflect a WCV write. */
export const pushHostVars = (chatId: string, variables: unknown): void => {
  mainWindow?.webContents.send('wcv-host-vars', { chatId, variables })
}

/** Push a "set the chat input box" request to the host renderer (card onboarding / a card UI). */
export const pushHostInput = (chatId: string, text: string): void => {
  mainWindow?.webContents.send('wcv-host-input', { chatId, text })
}

/** Push a "press the send button" request to the host renderer (a card UI's /trigger). */
export const pushHostSubmit = (chatId: string): void => {
  mainWindow?.webContents.send('wcv-host-submit', { chatId })
}

/** Ask the host renderer to reload a chat's floors (a card UI changed message content via saveChat). */
export const pushHostReload = (chatId: string): void => {
  mainWindow?.webContents.send('wcv-host-reload', { chatId })
}

// --- Runtime play theme (runtime-theme-api-design §5) ---
// The renderer owns the theme authority (the effective base tokens only exist there). For a WCV card:
//  - setPlayTheme: main RELAYS the call to the host renderer (which derives + AA-checks + applies) and
//    resolves the card's invoke with the renderer's boolean verdict via a keyed reply.
//  - getPlayThemeSync: main returns the last snapshot the renderer pushed (it can't derive it itself).
let playThemeSnapshot: { tokens: Record<string, string>; source: 'user' | 'card' | 'runtime' } = {
  tokens: {},
  source: 'user'
}
let playThemeSeq = 0
const playThemePending = new Map<number, (ok: boolean) => void>()

/** The resolved effective play theme (getPlayTheme's sync-read resolver for a WCV card). */
export const playThemeSnapshotValue = (): typeof playThemeSnapshot => playThemeSnapshot

/** The renderer pushed its current effective play theme (on any static/runtime/user-theme change). */
export const setPlayThemeSnapshot = (snap: unknown): void => {
  const s = snap as { tokens?: Record<string, string>; source?: 'user' | 'card' | 'runtime' } | null
  if (s && typeof s === 'object')
    playThemeSnapshot = { tokens: s.tokens || {}, source: s.source || 'user' }
}

/** Relay a WCV card's setPlayTheme to the host renderer and await its derive/AA verdict (false on
 *  timeout / no window). The renderer replies via resolveSetPlayTheme with the same id. */
export const requestSetPlayTheme = (
  chatId: string,
  theme: unknown,
  opts: unknown
): Promise<boolean> => {
  if (!mainWindow) return Promise.resolve(false)
  return new Promise((resolve) => {
    const id = ++playThemeSeq
    playThemePending.set(id, resolve)
    // Guard: a renderer that never replies (mid-teardown) must not leave the card's promise pending.
    setTimeout(() => {
      if (playThemePending.delete(id)) resolve(false)
    }, 3000)
    mainWindow?.webContents.send('wcv-host-set-play-theme', { id, chatId, theme, opts })
  })
}

/** The renderer's verdict for a relayed setPlayTheme (keyed by the request id). */
export const resolveSetPlayTheme = (id: number, ok: boolean): void => {
  const r = playThemePending.get(id)
  if (r) {
    playThemePending.delete(id)
    r(!!ok)
  }
}

// --- App light/dark mode sync (WCV mode sync) ---
// The renderer owns the app theme; it pushes its light/dark axis here (set-colorscheme-cache) on every
// app-theme change. A WCV card surface reads this snapshot synchronously at boot (wcv-get-colorscheme-sync
// → the initial data-rpt-mode stamp / rptHost.getColorScheme) and receives a push (wcv-colorscheme) on
// change, so its mode controller re-skins live. Mirrors the play-theme snapshot cache (renderer → main)
// for the sync read + the geometry push (main → WCV) for live updates. Surfaces then follow RPT's in-app
// theme instead of the OS `prefers-color-scheme`.
let colorSchemeSnapshot: 'light' | 'dark' = 'dark'

/** The app's current light/dark axis (getColorScheme's sync-read resolver for a WCV card). */
export const colorSchemeSnapshotValue = (): 'light' | 'dark' => colorSchemeSnapshot

/** The renderer pushed its app theme's light/dark axis. Snapshot it + push the change to every WCV. */
export const setColorSchemeSnapshot = (scheme: unknown): void => {
  const s: 'light' | 'dark' = scheme === 'light' ? 'light' : 'dark'
  if (s === colorSchemeSnapshot) return
  colorSchemeSnapshot = s
  for (const slot of slots.values()) {
    try {
      if (!slot.view.webContents.isDestroyed()) slot.view.webContents.send('wcv-colorscheme', s)
    } catch {
      /* a page mid-teardown can't receive — ignore */
    }
  }
}

/** Relay a WCV card's setColorScheme (card→app) to the host renderer, which owns the effective-scheme
 *  resolution (override ?? app theme) and applies it as a session-scoped override. `'auto'`/`null`/any
 *  other value reverts to the app theme. Returns true when a window existed to receive it (false = no
 *  host window). Unlike setPlayTheme there is no derive/AA verdict — the value is a plain light/dark. */
export const requestSetColorScheme = (chatId: string, scheme: unknown): boolean => {
  if (!mainWindow) return false
  const s: 'light' | 'dark' | null = scheme === 'light' ? 'light' : scheme === 'dark' ? 'dark' : null
  mainWindow.webContents.send('wcv-set-colorscheme', { chatId, scheme: s })
  return true
}

/**
 * Notify sibling WCVs on the same chat that the variables changed. `exceptWebContentsId` skips one
 * slot — pass the writer's `e.sender.id` so a card's OWN write isn't echoed back to it. Without this,
 * the writer's runtime re-fires the MVU variable-update / message-updated events for a change it just
 * made; a card that recomputes derived stats on those events then writes again → infinite write-back
 * loop. (The writer already updated its runtime cache optimistically, so it doesn't need the echo.)
 */
export const notifyVarsChanged = (
  chatId: string,
  statData: unknown,
  exceptWebContentsId?: number,
  origin: VarsOrigin = 'model-fold'
): void => {
  for (const s of slots.values()) {
    if (s.chatId !== chatId) continue
    if (exceptWebContentsId != null && s.view.webContents.id === exceptWebContentsId) continue
    // The origin lets the card runtime fire MVU events only for non-card-write changes (a card's own
    // write echoed back must not re-fire its events and loop — the WS-3 fix). Extra arg is ignored by
    // consumers that don't read it (the sync EJS mirror hydrate).
    s.view.webContents.send('wcv-vars-changed', statData, origin)
  }
  // Game state moved → refresh the freeze-frame cache (throttled, skipped while suppressed) so the
  // next menu-open shows a still that reflects the change instead of a stale one (freeze-precache).
  freezeController.warmVisible()
}

/** Broadcast a TavernHelper lifecycle/mutation event (generation_started, message_received, …) to the
 *  card WCVs on a chat, so their `eventOn(tavern_events.X, …)` listeners fire. `exceptWebContentsId`
 *  skips one slot — pass a card's own `e.sender.id` when it broadcasts to siblings so its own page
 *  doesn't receive the event it just sent (the stage/HUD coordination channel). */
export const notifyEvent = (
  chatId: string,
  name: string,
  payload: unknown,
  exceptWebContentsId?: number
): void => {
  for (const s of slots.values()) {
    if (s.chatId !== chatId) continue
    if (exceptWebContentsId != null && s.view.webContents.id === exceptWebContentsId) continue
    s.view.webContents.send('wcv-event', { name, payload })
  }
}
