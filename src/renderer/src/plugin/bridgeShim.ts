/**
 * Card-script runtime (P1) — the in-iframe half.
 *
 * BRIDGE_SHIM is plain JS injected as the first <script> inside every card-script
 * iframe. The iframe runs with `sandbox="allow-scripts"` and *without*
 * `allow-same-origin`, so it gets a unique opaque origin: scripts execute but
 * cannot touch the parent window/DOM or our origin's storage/cookies. The network
 * is blocked by the CSP by default; a per-card `remoteScripts` grant relaxes it so
 * scripts can `import` remote ES modules (1B). Its only channel to the app is
 * `postMessage`, which the shim wraps into the friendly promise-based `rpt` API.
 *
 * The host (CardScriptHost) validates `event.source` and permission-checks every
 * call before dispatching it to the engine over IPC. Clean-room: this API is our
 * own design, not derived from js-slash-runner.
 */

import { BRIDGE_SHIM } from './shims/bridge'
import { TAVERN_SHIM } from './shims/tavern'
import { ST_RUNTIME_SHIM } from './shims/stRuntime'
import { JQUERY_SHIM } from './shims/jquery'
import { LIB_SHIM, LIB_LOADER } from './shims/lib'

/**
 * Content-Security-Policy for the iframe document.
 *  • Locked (default): `connect-src 'none'` + no `allow-same-origin` = "no network".
 *    fetch/XHR/WebSocket and remote `import` are blocked; assets limited to inline data.
 *  • Remote-enabled (per-card `remoteScripts` grant): adds `https:` to script/connect/etc.
 *    so user scripts can `import` ES-module graphs natively from CDNs (approach 1B). This
 *    is the documented cost of the grant — the world's scripts gain internet access.
 */
const buildCsp = (allowRemote: boolean): string => {
  const s = allowRemote ? ' https:' : ''
  return [
    "default-src 'none'",
    // data:/blob: are needed so modules the frontend-card loader serves locally (it rewrites
    // imports to data: URLs — blob:null modules can't be imported from the opaque origin)
    // can load. Both are page-created, not network, so safe even when the network is locked.
    `script-src 'unsafe-inline' data: blob:${s}`,
    `style-src 'unsafe-inline'${s}`,
    `img-src data: blob:${s}`,
    `font-src data:${s}`,
    `connect-src ${allowRemote ? 'https:' : "'none'"}`,
    "form-action 'none'"
  ].join('; ')
}

// A script is run as an ES module (so its `import`/`export` work) when it uses static
// module syntax. Dynamic `import(...)` alone doesn't require a module context, so it's
// excluded — classic scripts keep their global-scope semantics.
const MODULE_SYNTAX = /^[ \t]*(?:import[\s{*'"]|export[\s{*])/m
export const isModuleScript = (code: string): boolean => MODULE_SYNTAX.test(code || '')

/** Base styling injected into the iframe so script UIs match the app shell. */
const HOST_STYLE = `
  :root { color-scheme: dark; }
  html, body { margin: 0; }
  body {
    color: #d8d8e0; background: transparent;
    font-family: 'Inter', system-ui, sans-serif; font-size: 13px; line-height: 1.45;
  }
  button {
    font: inherit; color: #e8e8ef; cursor: pointer;
    background: #2a2a3a; border: 1px solid #3a3a4d; border-radius: 6px;
    padding: 5px 10px; margin: 2px 0;
  }
  button:hover { background: #34344a; }
  a { color: #5b8def; }
  input, select, textarea {
    font: inherit; color: #e8e8ef; background: #1e1e2a;
    border: 1px solid #3a3a4d; border-radius: 6px; padding: 4px 6px;
  }
`

export interface CardScript {
  name: string
  code: string
}

/**
 * Build the full sandboxed-iframe document: CSP + base style + shims + each user script
 * in its OWN <script> tag. Per-tag is essential: a single shared tag fails to *parse* as a
 * whole, so one script's syntax error would kill the others. Scripts that use ES-module
 * syntax run as `<script type="module">` (so their `import` works — natively loading the
 * remote graph when `allowRemote`); the rest run as classic scripts wrapped in try/catch.
 * Errors (syntax, runtime, and unhandled rejections) are surfaced to the host's Logs panel.
 */
// Every card frame runs at a unique opaque origin (no `allow-same-origin`), which Chromium
// hosts in its OWN renderer process (IsolateSandboxedIframes, default since Chromium 132) —
// so a runaway frame can't freeze the host thread. The cost: opaque origins throw on Storage
// access (SecurityError). Many UI libs touch localStorage on init, so back it with an
// in-memory store. Injected before any framework/user script runs.
const STORAGE_POLYFILL =
  `<script>(function(){try{window.localStorage.getItem('__rpt');return;}catch(e){}` +
  `function mk(){var m={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},` +
  `setItem:function(k,v){m[String(k)]=String(v);},removeItem:function(k){delete m[String(k)];},` +
  `clear:function(){m={};},key:function(i){return Object.keys(m)[i]||null;},get length(){return Object.keys(m).length;}};}` +
  `try{Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});}catch(_){}` +
  `try{Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true});}catch(_){}` +
  `})();</script>`

// Surfaces syntax/runtime/unhandled-rejection errors to the host's Logs panel. Shared by
// the card-script doc and the message-HTML doc (TH-6).
const ERROR_REPORTER =
  `<script>` +
  `function __rptError(name, e){try{parent.postMessage({__rptlog:1,msg:'['+name+'] '+((e&&e.message)||e)},'*')}catch(_){}}` +
  `window.addEventListener('error',function(ev){__rptError('script', (ev.message||(ev.error&&ev.error.message)||'error')+' @'+(ev.lineno||'?')+':'+(ev.colno||'?'))});` +
  `window.addEventListener('unhandledrejection',function(ev){var r=ev.reason;__rptError('script','unhandled rejection: '+((r&&r.message)||r))});` +
  `</script>`

/** The shim/CSP/style head shared by both sandbox documents. Every frame runs at an opaque
 * origin (process-isolated) regardless of trust; `trusted` is purely a capability grant
 * (full `rpt` caps + remote fetch), enforced host-side over the RPC bridge — it no longer
 * changes the frame's origin. `window.__rptTrusted` is exposed informationally. */
const sandboxHead = (allowRemote: boolean, trusted: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="${buildCsp(allowRemote)}">` +
  `<style>${HOST_STYLE}</style></head><body>` +
  `<script>window.__rptTrusted=${trusted ? 'true' : 'false'};</script>` +
  STORAGE_POLYFILL +
  `<script>${BRIDGE_SHIM}</script>` +
  `<script>${LIB_SHIM}</script>` +
  `<script>${TAVERN_SHIM}</script>` +
  // ST/MVU runtime shim depends on TAVERN_SHIM's globals, so it loads after it.
  `<script>${ST_RUNTIME_SHIM}</script>` +
  `<script>${JQUERY_SHIM}</script>` +
  ERROR_REPORTER +
  (allowRemote ? LIB_LOADER : '')

// `scriptService.withButtons` appends a `;(function(){var __b=[…]; …registerButton…})()` IIFE
// that registers a script's declarative action buttons. Split it off into its OWN classic
// <script> so the button still registers even when the main body is a module whose remote
// import fails/defers — i.e. the button appears in the ☰ menu regardless of the bundle loading.
const BUTTON_IIFE_RE = /\n?;\(function\(\)\{var __b=/

const oneScriptTags = (s: CardScript): string => {
  const m = BUTTON_IIFE_RE.exec(s.code || '')
  const main = (m ? s.code.slice(0, m.index) : s.code || '').trim()
  const buttons = (m ? s.code.slice(m.index) : '').trim()
  const errId = (suffix: string): string => JSON.stringify((s.name || 'script') + suffix)
  // Module: imports must be top-level (can't wrap in try/catch) — the global error/rejection
  // handlers catch its failures instead. Classic scripts are try/caught for the Logs panel.
  const mainTag = main.trim()
    ? isModuleScript(main)
      ? `<script type="module">\n${main}\n</script>`
      : `<script>try {\n${main}\n} catch (e) { __rptError(${errId('')}, e); }</script>`
    : ''
  // The button IIFE only touches globals (rpt/eventEmit/getButtonEvent), so it runs standalone.
  const buttonTag = buttons.trim()
    ? `<script>try {\n${buttons}\n} catch (e) { __rptError(${errId(' buttons')}, e); }</script>`
    : ''
  return mainTag + buttonTag
}

export const buildScriptSrcDoc = (
  scripts: CardScript[],
  opts: { allowRemote?: boolean; trusted?: boolean } = {}
): string => {
  const userScripts = scripts.map(oneScriptTags).join('')
  return sandboxHead(!!opts.allowRemote, !!opts.trusted) + userScripts + `</body></html>`
}

/** Strip a full-document wrapper down to its body so model HTML inlines into our host doc. */
const extractBody = (html: string): string => {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (body) return body[1]
  // Drop a stray <!doctype>/<html>/<head> if present but no <body> tag.
  return html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
}

/**
 * Build the sandboxed document for an interactive HTML block embedded in a chat message
 * (TH-6 "frontend card"). The model-authored markup + its <script> tags run inside the
 * same opaque-origin, no-`allow-same-origin` sandbox as card scripts, with the full `rpt`
 * API available — but the host gates it at LEAST privilege (model HTML is less trusted than
 * card scripts). Network stays off by default (allowRemote=false).
 */
export const buildMessageHtmlDoc = (
  html: string,
  opts: { allowRemote?: boolean; trusted?: boolean } = {}
): string => sandboxHead(!!opts.allowRemote, !!opts.trusted) + extractBody(html) + `</body></html>`

/** True when an html block carries a <script> (→ render as an interactive sandbox, not static). */
export const isInteractiveHtml = (html: string): boolean => /<script[\s>]/i.test(html)
