import { WebContentsView, BrowserWindow, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { log } from './logService'

// Card UI panels run in their own session partition. jsDelivr serves `/gh/` HTML as text/plain (to
// stop it being used to host pages), so Chromium shows it as raw text; the card's UI is meant to be
// loaded AS HTML (its regex does `$('body').load(...)`). We force text/html on the .html document so
// the WebContentsView renders it + runs its module script. Narrow: jsDelivr host + .html only, so JS
// modules (served as application/javascript) are untouched.
const WCV_PARTITION = 'wcv-cards'
// Shared with the inline-message path (WcvMessageFrame sets the same policy via a <meta> tag).
export const CARD_CSP =
  "default-src 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  'img-src * data: blob:; media-src * data: blob:; connect-src * data: blob:'
let sessionReady = false
const ensureSession = (): void => {
  if (sessionReady) return
  sessionReady = true
  const ses = session.fromPartition(WCV_PARTITION)
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
}

let mainWindow: BrowserWindow | null = null
const slots = new Map<string, Slot>()

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

/** Create the view for `id` (once) loading `url` with the locked-down shim preload, bind its
 *  session context, then position it at `bounds`. */
export const ensure = (
  id: string,
  bounds: Bounds,
  url: string,
  ctx: { profileId: string; chatId: string; characterId?: string } = {
    profileId: '',
    chatId: ''
  }
): void => {
  if (!mainWindow) return
  // Defensive: a fire-and-forget IPC call with a missing/garbled ctx must never crash main.
  if (!ctx || typeof ctx !== 'object') ctx = { profileId: '', chatId: '' }
  ensureSession()
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
    slot = {
      view,
      profileId: ctx.profileId,
      chatId: ctx.chatId,
      characterId: ctx.characterId || ''
    }
    slots.set(id, slot)
    mainWindow.contentView.addChildView(view)
    view.webContents.loadURL(url)
    // Spike: surface the card's console so its missing-API log is visible.
    if (is.dev) view.webContents.openDevTools({ mode: 'detach' })
    log('info', `wcv: created '${id}'`)
  } else {
    slot.profileId = ctx.profileId
    slot.chatId = ctx.chatId
    slot.characterId = ctx.characterId || ''
  }
  slot.view.setBounds(round(bounds))
}

export const setBounds = (id: string, bounds: Bounds): void => {
  slots.get(id)?.view.setBounds(round(bounds))
}

/** Hide without destroying (e.g. while a modal is open over it, or its tab is hidden). */
export const setVisible = (id: string, visible: boolean): void => {
  slots.get(id)?.view.setVisible(visible)
}

export const destroy = (id: string): void => {
  const slot = slots.get(id)
  if (!slot) return
  slots.delete(id)
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

/** Push updated variables to the host renderer so native panels reflect a WCV write. */
export const pushHostVars = (chatId: string, variables: unknown): void => {
  mainWindow?.webContents.send('wcv-host-vars', { chatId, variables })
}

/** Push a "set the chat input box" request to the host renderer (card onboarding / a card UI). */
export const pushHostInput = (chatId: string, text: string): void => {
  mainWindow?.webContents.send('wcv-host-input', { chatId, text })
}

/** Ask the host renderer to reload a chat's floors (a card UI changed message content via saveChat). */
export const pushHostReload = (chatId: string): void => {
  mainWindow?.webContents.send('wcv-host-reload', { chatId })
}

/** Notify sibling WCVs on the same chat that the variables changed. */
export const notifyVarsChanged = (chatId: string, statData: unknown): void => {
  for (const s of slots.values()) {
    if (s.chatId === chatId) s.view.webContents.send('wcv-vars-changed', statData)
  }
}

/** Broadcast a TavernHelper lifecycle/mutation event (generation_started, message_received, …) to the
 *  card WCVs on a chat, so their `eventOn(tavern_events.X, …)` listeners fire. */
export const notifyEvent = (chatId: string, name: string, payload: unknown): void => {
  for (const s of slots.values()) {
    if (s.chatId === chatId) s.view.webContents.send('wcv-event', { name, payload })
  }
}
