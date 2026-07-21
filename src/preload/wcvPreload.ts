/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports --
   spike shim: it bridges the untyped ST / TavernHelper / MVU host globals into the card page; jQuery
   is lazily require()'d on first use (importing it at preload load crashes — see below). */

// CANONICAL card-facing TavernHelper / MVU / EjsTemplate surface (ROADMAP Track C0). The surface itself
// now lives ONCE in src/shared/thRuntime (createThRuntime over a Host); this file is the WCV transport:
// it builds a preload Host (wcvHost.ts) and spreads the runtime onto the card window. New card-facing
// TH/MVU helpers land in shared/thRuntime — NOT in the iframe shim plugin/shims/tavern.ts, which is
// frozen for card use (it backs plugins + app UI only).
import { ipcRenderer } from 'electron'
import _ from 'lodash'
import { cardZod } from '../shared/cardZod'
import variant from '@jitl/quickjs-singlefile-browser-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import {
  initEngine,
  evalTemplate as ejsEval,
  evalTemplateDetailed as ejsEvalDetailed,
  setEngineDeps,
  buildTemplateContext,
  TemplateContext
} from '../shared/templateEngine'
import { createThRuntime } from '../shared/thRuntime'
import { createWcvHost } from './wcvHost'
import { WCV_CHANNELS } from '../shared/thRuntime/wcvChannelSpec'

/**
 * SHIM for a card's own frontend running in a WebContentsView — e.g. 命定之诗's React status UI, which
 * reads `window.Mvu.getMvuData()` + the bare TavernHelper globals. Runs in the page's MAIN world
 * (contextIsolation:false) so it can DEFINE those globals. The TH/MVU/SillyTavern/EjsTemplate surface is
 * supplied by the shared runtime; this file only owns the transport (IPC bridge), the inline-card layout
 * bridge, the quickjs EJS engine instance, and the card's externalized library globals.
 *
 * Trusted-card only: a main-world shim + a remote page sharing the bridge. The WCV is still a separate
 * process with nodeIntegration:false (no host/Node reach); production vendors assets + hardens.
 *
 * Diagnostics are OFF by default; add `#rptdebug` to the panel URL to log every host call + subscription.
 */
const w = window as any
const DEBUG = typeof location !== 'undefined' && /rptdebug/i.test(location.hash + location.search)

// --- panel geometry (seam-slicing primitive) ---
// This page's slot rect in window-content coords + the window content size, so it can draw a
// full-viewport background offset by its own x (adjacent stage surfaces then compose into one image).
// Seeded synchronously at preload load; refreshed by main on every bounds change (wcv-panel-geometry).
type PanelGeometry = {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}
const ZERO_GEOMETRY: PanelGeometry = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  viewportWidth: 0,
  viewportHeight: 0
}
let panelGeometry: PanelGeometry = ZERO_GEOMETRY
try {
  panelGeometry = ipcRenderer.sendSync('wcv-get-panel-geometry-sync') || ZERO_GEOMETRY
} catch {
  panelGeometry = ZERO_GEOMETRY
}
const geometryListeners = new Set<(g: PanelGeometry) => void>()
ipcRenderer.on('wcv-panel-geometry', (_e: any, g: PanelGeometry) => {
  panelGeometry = g || ZERO_GEOMETRY
  for (const cb of geometryListeners) {
    try {
      cb(panelGeometry)
    } catch {
      /* a listener throwing must not break the others */
    }
  }
  // Also surface as a DOM event so a card that doesn't hold the rptHost ref can still react.
  try {
    window.dispatchEvent(new CustomEvent('rpt:panelgeometry', { detail: panelGeometry }))
  } catch {
    /* ignore */
  }
})

// --- app light/dark mode (WCV mode sync) ---
// RPT's IN-APP theme (not the OS `prefers-color-scheme`) is the mode authority for card surfaces: the
// renderer pushes its light/dark axis to main, which snapshots it + pushes changes here. We stamp
// `data-rpt-mode` on <html> at boot and re-stamp + dispatch a `rpt:colorscheme` window event on change,
// so a card's mode controller follows the app theme. Mirrors the panel-geometry relay above (sync boot
// read + push channel + DOM event) with the renderer as the source of truth (like the play-theme cache).
let colorScheme: 'light' | 'dark' = 'dark'
try {
  colorScheme = ipcRenderer.sendSync('wcv-get-colorscheme-sync') === 'light' ? 'light' : 'dark'
} catch {
  colorScheme = 'dark'
}
const colorSchemeListeners = new Set<(s: 'light' | 'dark') => void>()
// Stamp the current mode on <html> so a controller can resolve it from the attribute. documentElement can
// be null at preload load (before the page parses — see the jQuery note below), so guard + re-stamp on
// DOMContentLoaded; the card's mode controller runs well after that.
const stampMode = (): void => {
  try {
    document.documentElement?.setAttribute('data-rpt-mode', colorScheme)
  } catch {
    /* documentElement not ready — re-stamped on DOMContentLoaded */
  }
}
stampMode()
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', stampMode)
ipcRenderer.on('wcv-colorscheme', (_e: any, s: 'light' | 'dark') => {
  colorScheme = s === 'light' ? 'light' : 'dark'
  stampMode()
  for (const cb of colorSchemeListeners) {
    try {
      cb(colorScheme)
    } catch {
      /* a listener throwing must not break the others */
    }
  }
  // Also surface as a DOM event so a card that doesn't hold the rptHost ref can still re-skin.
  try {
    window.dispatchEvent(new CustomEvent('rpt:colorscheme', { detail: colorScheme }))
  } catch {
    /* ignore */
  }
})

// --- host bridge (IPC) ---
const rptHost = {
  getVariables: (): Promise<any> => ipcRenderer.invoke('wcv-host-get-vars'),
  applyVariableOps: (ops: any[]): Promise<any> =>
    ipcRenderer.invoke(WCV_CHANNELS.applyVariableOps, ops),
  setVariables: (sd: any): Promise<any> => ipcRenderer.invoke(WCV_CHANNELS.setVariables, sd),
  setInput: (text: any) => ipcRenderer.send(WCV_CHANNELS.setInput, text),
  // Broadcast a card-authored coordination event to the SIBLING card panels on this chat (not back to
  // this page). Received there via `eventOn(name, cb)`. The poem stage uses it for `self:fold` /
  // `stage:cast-changed`; the name is the card's own — RPT doesn't interpret it.
  broadcastEvent: (name: string, payload?: any) =>
    ipcRenderer.send('wcv-host-broadcast-event', name, payload),
  onVarsChanged: (cb: (v: any) => void) => {
    const l = (_e: any, v: any): void => cb(v)
    ipcRenderer.on('wcv-vars-changed', l)
    return () => ipcRenderer.removeListener('wcv-vars-changed', l)
  },
  // The page's current slot geometry (for seam-sliced backgrounds). Synchronous — always the latest
  // value main pushed. `onPanelGeometry` subscribes to changes and returns an unsubscribe.
  getPanelGeometry: (): PanelGeometry => panelGeometry,
  onPanelGeometry: (cb: (g: PanelGeometry) => void) => {
    geometryListeners.add(cb)
    return () => geometryListeners.delete(cb)
  },
  // The app's IN-APP light/dark axis (WCV mode sync). Synchronous — the latest value main pushed (seeded
  // at boot); `onColorSchemeChanged` subscribes to changes and returns an unsubscribe. RPT stamps the
  // same value on <html> as `data-rpt-mode` and dispatches a `rpt:colorscheme` window event, so a card's
  // mode controller follows the app theme instead of the OS `prefers-color-scheme`.
  getColorScheme: (): 'light' | 'dark' => colorScheme,
  onColorSchemeChanged: (cb: (s: 'light' | 'dark') => void) => {
    colorSchemeListeners.add(cb)
    return () => colorSchemeListeners.delete(cb)
  },
  // Card→app: SET the app's effective light/dark scheme for THIS session (the getColorScheme mirror). The
  // override is SESSION-SCOPED + ephemeral — it never persists and resets on session/profile change, so a
  // card can't permanently change the user's app theme. Pass 'auto'/null to revert to the app theme. Main
  // relays to the renderer (the effective-scheme authority), which repaints the chrome AND pushes the
  // effective axis back here (getColorScheme / the `data-rpt-mode` stamp / rpt:colorscheme event all
  // report the effective scheme). Resolves true when accepted. Bound to this slot's own session in main.
  setColorScheme: (scheme: 'light' | 'dark' | 'auto' | null): Promise<boolean> =>
    ipcRenderer.invoke('wcv-host-set-colorscheme', scheme)
}
w.rptHost = rptHost

// Surface a card script's runtime errors (uncaught + unhandled rejections) to the MAIN log, so a card
// author / maintainer sees them without opening the WCV devtools (parity with the inline host's pluginLog).
const reportCardError = (msg: string): void => {
  try {
    ipcRenderer.send('wcv-card-error', String(msg))
  } catch {
    /* ignore */
  }
}
window.addEventListener('error', (e: any) => {
  reportCardError((e?.message || 'error') + (e?.error?.stack ? ' | ' + e.error.stack : ''))
})
window.addEventListener('unhandledrejection', (e: any) => {
  const r = e?.reason
  reportCardError('unhandledrejection: ' + ((r && r.message) || r))
})

// --- Card-script modal detection (card-scripts host only) ---
// A button-launched card UI (e.g. the 创意工坊 workshop) appends a full-screen `position:fixed; inset:0`
// overlay to the body. The card-scripts WCV is normally a small/background slot, so we watch for such an
// overlay and tell main to expand this WCV to a full-window modal (and shrink back when it's removed).
// Scoped to the card-scripts host by URL so status/panel WCVs (which legitimately fill their slot) aren't
// resized. The host doc is served from rpt-card://card/card-scripts:<…>.
if (typeof location !== 'undefined' && /card-scripts/i.test(location.href)) {
  let lastOverlay = false
  const hasModalOverlay = (): boolean => {
    const body = document.body
    if (!body) return false
    const vw = window.innerWidth
    const vh = window.innerHeight
    for (const el of Array.from(body.querySelectorAll<HTMLElement>('*'))) {
      const s = getComputedStyle(el)
      if (s.position !== 'fixed' && s.position !== 'absolute') continue
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue
      const r = el.getBoundingClientRect()
      // A near-full-viewport fixed/absolute element ⇒ a modal overlay (the workshop uses inset:0).
      if (r.width >= vw * 0.6 && r.height >= vh * 0.6) return true
    }
    return false
  }
  const checkOverlay = (): void => {
    const has = hasModalOverlay()
    if (has !== lastOverlay) {
      lastOverlay = has
      try {
        ipcRenderer.send('wcv-overlay', has)
      } catch {
        /* ignore */
      }
    }
  }
  const startOverlayWatch = (): void => {
    try {
      new MutationObserver(checkOverlay).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
      })
    } catch {
      /* ignore */
    }
    checkOverlay()
  }
  if (document.readyState === 'loading')
    window.addEventListener('DOMContentLoaded', startOverlayWatch)
  else startOverlayWatch()
}

// --- inline-card layout bridge ---
// A WebContentsView is a native overlay: it has a fixed slot height and swallows wheel events. Report
// the card's real content height so the host can size its message slot to fit (no inner scrollbar), and
// forward wheel deltas so the message list scrolls when the pointer is over the card. The host applies
// both only to an inline message frame (the workspace panel ignores them), so this is safe to always run.
let lastReportedHeight = -1
const measureContentHeight = (): number =>
  // body.scrollHeight is the content height (not viewport-clamped like documentElement); +8 absorbs
  // sub-pixel rounding / a collapsed top margin so the card's bottom edge never clips.
  Math.ceil((document.body?.scrollHeight || document.documentElement?.scrollHeight || 0) + 8)
const reportHeight = (): void => {
  const h = measureContentHeight()
  if (h > 8 && h !== lastReportedHeight) {
    lastReportedHeight = h
    try {
      ipcRenderer.send('wcv-content-size', { height: h })
    } catch {
      /* ignore */
    }
  }
}
const startLayoutBridge = (): void => {
  reportHeight()
  try {
    const ro = new ResizeObserver(reportHeight)
    if (document.documentElement) ro.observe(document.documentElement)
    if (document.body) ro.observe(document.body)
  } catch {
    /* ignore */
  }
}
if (document.readyState === 'loading')
  window.addEventListener('DOMContentLoaded', startLayoutBridge)
else startLayoutBridge()
window.addEventListener('load', reportHeight)
// Scroll-chaining. Walk from the element under the pointer up to the root: if ANY scroll container can
// still move in the wheel direction, let it scroll natively and don't forward. Only when nothing inside
// can scroll (every scroller is at its edge, or there are none) do we forward the delta so the host
// scrolls the message list. Checking inner containers — not just the document — is what stops a card
// whose scroll lives in an overflow:auto panel (e.g. 角色查看器) from fighting the message-box scroll.
const canScrollDir = (el: HTMLElement, dy: number): boolean => {
  const maxTop = el.scrollHeight - el.clientHeight
  if (maxTop <= 1) return false
  return (dy < 0 && el.scrollTop > 0) || (dy > 0 && el.scrollTop < maxTop - 1)
}
window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    try {
      const dy = e.deltaY
      if (!dy) return
      const root = document.scrollingElement || document.documentElement
      let node: HTMLElement | null = e.target as HTMLElement | null
      while (node && node.nodeType === 1) {
        const oy = node === root ? 'auto' : getComputedStyle(node).overflowY
        if ((oy === 'auto' || oy === 'scroll') && canScrollDir(node, dy)) return // it'll scroll
        node = node.parentElement
      }
      if (root instanceof HTMLElement && canScrollDir(root, dy)) return
      ipcRenderer.send('wcv-wheel', { dy })
    } catch {
      /* ignore */
    }
  },
  { passive: true }
)

// --- synchronous stat_data mirror for the EJS engine (hydrated async, kept fresh by push) ---
// The TH/MVU surface keeps its own cache inside the runtime; this mirror exists ONLY so the quickjs
// EjsTemplate context (buildEjsCtx) can resolve `variables` synchronously without an IPC round-trip.
let statData: any = {}
const hydrate = (v: any) => {
  statData = v || {}
}
// Sync initial read so the mirror is populated BEFORE the card's first render (an async IPC read would
// land after the React app has already rendered defaults). sendSync blocks briefly — fine once.
try {
  statData = ipcRenderer.sendSync(WCV_CHANNELS.statData) || {}
} catch {
  statData = {}
}
rptHost.onVarsChanged(hydrate)

// --- EjsTemplate engine (Phase E): the ST-Prompt-Template engine running in the card's WCV context. Its
// own quickjs singlefile instance (the card CSP allows WASM); evalTemplate strips tags as a fail-safe
// until the WASM has loaded. The runtime's EjsTemplate surface calls back into ejsEval via the host. ---
setEngineDeps({ log: (_l: any, m: any, d: any) => DEBUG && console.warn('[ejs]', m, d) })
void initEngine(() => newQuickJSWASMModuleFromVariant(variant))

const buildEjsCtx = (data?: any): TemplateContext => {
  // The WCV runtime's `statData` is the BARE stat_data; wrap it so the store is the canonical shape
  // ({ stat_data }). The engine resolves both `getvar('主角')` and `getvar('stat_data.主角')` from it
  // (WS-1 fallback), so no pre-hoist. Construction via the shared builder (canonical defaults).
  const sd = data?.variables ?? statData ?? {}
  return buildTemplateContext(
    { stat_data: sd && typeof sd === 'object' ? sd : {} },
    { constants: { ...(data?.constants || {}) }, data: data?.data || {} }
  )
}

// --- the unified TH runtime over the WCV Host ---
// The WCV preload has NO per-slot ctx — main resolves the calling panel's session from `e.sender`, so the
// adapter calls IPC without passing ctx (this placeholder only satisfies the Host type). The quickjs EJS
// engine stays here and is injected so the runtime's EjsTemplate surface evaluates in this context.
const ctx = { profileId: '', chatId: '', characterId: '' }
// Panel chat scope (general): main stashed it on this slot at ensure() time; read it synchronously at
// preload load (before the card's first render) so the runtime's chat reads reflect the panel's own
// messages instead of the real chat (chat-READ-only). Undefined/absent ⇒ unscoped (real host floors).
let chatScope: any
try {
  chatScope = ipcRenderer.sendSync('wcv-get-chat-scope-sync') || undefined
} catch {
  chatScope = undefined
}
const g = createThRuntime(
  createWcvHost({
    ctx,
    evalTemplate: (tmpl, data) => ejsEval(String(tmpl ?? ''), buildEjsCtx(data)),
    evalTemplateError: (tmpl, data) => {
      const err = ejsEvalDetailed(String(tmpl ?? ''), buildEjsCtx(data)).error
      return err || null
    },
    prepareContext: (data) => buildEjsCtx(data)
  }),
  { chatScope }
)
Object.assign(w, g)
w.TavernHelper = g.TavernHelper
// PM-A7: expose the overlay API on rptHost too (the documented entry point card panel surfaces use,
// alongside rptHost.broadcastEvent). They delegate to the shared-runtime facade so behavior stays in
// ONE place (shared/thRuntime → the WCV Host → the app's overlay mechanism), never forked per transport.
;(rptHost as any).requestOverlay = (id: string): Promise<boolean> => g.requestOverlay(id)
;(rptHost as any).closeOverlay = (): Promise<void> => g.closeOverlay()
// WA-3: the picker-backed asset import is a host-privilege write, so (like requestOverlay) it is surfaced
// on rptHost too, delegating to the shared-runtime facade. The read-only `assetList` stays a bare global
// (mirrors assetUrl — Object.assign(w, g) above already exposed it), not on rptHost.
;(rptHost as any).requestAssetImport = (arg: {
  name: string
  type: string
  variant?: string
}): Promise<string | null> => g.requestAssetImport(arg)
// Runtime theming (runtime-theme-api-design §3B): a host-privilege restyle, surfaced on rptHost like
// requestOverlay/requestAssetImport. Delegates to the shared-runtime facade so behavior stays in ONE
// place (the renderer authority reached via main). Also available as bare globals + on TavernHelper.
;(rptHost as any).setPlayTheme = (
  theme: Record<string, unknown> | null,
  opts?: { target?: 'shell' | 'message'; persist?: 'session' | 'chat' | 'global' }
): Promise<boolean> => g.setPlayTheme(theme, opts)
;(rptHost as any).setMessageTheme = (
  tokens: Record<string, unknown>,
  opts?: { persist?: 'session' | 'chat' | 'global' }
): Promise<boolean> => g.setMessageTheme(tokens, opts)
;(rptHost as any).getPlayTheme = (): {
  tokens: Record<string, string>
  source: 'user' | 'card' | 'runtime'
} => g.getPlayTheme()
// DisplayHost (ADR 0023): the documented entry point cartridge panel surfaces use for beautified transcript
// rendering, alongside the bare `renderFloors`/`displayRevision`/`setDisplayStreamEnabled` globals. Each
// delegates to the shared-runtime facade so behavior stays in ONE place (shared/thRuntime → the WCV Host →
// the app display pipeline), never forked per transport.
;(rptHost as any).renderFloors = (from: number, to: number): Promise<any[]> =>
  g.renderFloors(from, to)
;(rptHost as any).displayRevision = (): number => g.displayRevision()
;(rptHost as any).setDisplayStreamEnabled = (enabled: boolean): Promise<void> =>
  g.setDisplayStreamEnabled(enabled)

// --- libraries the card bundle externalizes as bare globals (lodash `_`, Zod `z`, jQuery `$`, `toastr`) ---
// These are transport-level library injection (not part of the TH runtime). The runtime already provides
// `toastr`; the lib globals below are required()'d lazily because importing them at preload load crashes.
w._ = _
w.z = cardZod
// YAML — MVU / data_schema card scripts reference a `YAML` global (the ST host provides one). We don't ship
// a full parser; mirror the inline LIB_SHIM's clean-room best-effort (JSON passthrough) so the global exists
// — without it the script throws `YAML is not defined`. (A real YAML parser is out of scope, as in-app.)
if (!w.YAML)
  w.YAML = {
    parse: (s: any) => {
      try {
        return JSON.parse(String(s))
      } catch {
        return {}
      }
    },
    stringify: (o: any) => {
      try {
        return JSON.stringify(o, null, 2)
      } catch {
        return ''
      }
    }
  }
// jQuery: required LAZILY on first access. Requiring at preload load crashes — jQuery probes
// document.documentElement at import time, which is null before the page parses (and that failure takes
// the whole preload down). The card only touches `$` once its deferred module runs, by which point the
// DOM is ready, so a getter that requires on first access is safe.
let jqCache: any = null
const getJq = (): any => {
  if (!jqCache) {
    const m: any = require('jquery')
    jqCache = m && m.fn ? m : typeof m === 'function' ? m(w) : m
  }
  return jqCache
}
Object.defineProperty(w, '$', { configurable: true, get: getJq })
Object.defineProperty(w, 'jQuery', { configurable: true, get: getJq })
// Vue ecosystem: home/custom_start expect these as window globals. Lazy-required (defensive, like
// jQuery — only resolved when the card's deferred bundle first touches them).
const lazyGlobal = (name: string, mod: string) => {
  let cache: any = null
  Object.defineProperty(w, name, { configurable: true, get: () => (cache ||= require(mod)) })
}
lazyGlobal('Vue', 'vue')
lazyGlobal('VueRouter', 'vue-router')
lazyGlobal('Pinia', 'pinia')

if (DEBUG) console.info('[rpt-shim] starter shim installed (WebContentsView card panel)')
