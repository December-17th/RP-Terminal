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
  const s = allowRemote ? " https:" : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${s}`,
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
export const buildScriptSrcDoc = (
  scripts: CardScript[],
  opts: { allowRemote?: boolean } = {}
): string => {
  // Defined first so each user-script tag's catch + the global handlers can use it.
  const errorReporter =
    `<script>` +
    `function __rptError(name, e){try{parent.postMessage({__rptlog:1,msg:'['+name+'] '+((e&&e.message)||e)},'*')}catch(_){}}` +
    `window.addEventListener('error',function(ev){__rptError('script', (ev.message||(ev.error&&ev.error.message)||'error')+' @'+(ev.lineno||'?')+':'+(ev.colno||'?'))});` +
    `window.addEventListener('unhandledrejection',function(ev){var r=ev.reason;__rptError('script','unhandled rejection: '+((r&&r.message)||r))});` +
    `</script>`

  const userScripts = scripts
    .map((s) =>
      isModuleScript(s.code)
        ? // Module: imports must be top-level (can't wrap in try/catch) — the global
          // error/rejection handlers above catch its failures instead.
          `<script type="module">\n${s.code}\n</script>`
        : `<script>try {\n${s.code}\n} catch (e) { __rptError(${JSON.stringify(s.name || 'script')}, e); }</script>`
    )
    .join('')

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${buildCsp(!!opts.allowRemote)}">` +
    `<style>${HOST_STYLE}</style></head><body>` +
    `<script>${BRIDGE_SHIM}</script>` +
    `<script>${LIB_SHIM}</script>` +
    `<script>${TAVERN_SHIM}</script>` +
    errorReporter +
    // Real lodash/zod (for module scripts) only when network is available for this world.
    (opts.allowRemote ? LIB_LOADER : '') +
    userScripts +
    `</body></html>`
  )
}
