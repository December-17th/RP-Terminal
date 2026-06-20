/**
 * Card-script runtime (P1) — the in-iframe half.
 *
 * BRIDGE_SHIM is plain JS injected as the first <script> inside every card-script
 * iframe. The iframe runs with `sandbox="allow-scripts"` and *without*
 * `allow-same-origin`, so it gets a unique opaque origin: scripts execute but
 * cannot touch the parent window/DOM, our origin's storage/cookies, or
 * (enforced by the CSP below) the network. Its only channel to the app is
 * `postMessage`, which the shim wraps into the friendly promise-based `rpt` API.
 *
 * The host (CardScriptHost) validates `event.source` and permission-checks every
 * call before dispatching it to the engine over IPC. Clean-room: this API is our
 * own design, not derived from js-slash-runner.
 */

/** Content-Security-Policy for the iframe document. `connect-src 'none'` (plus
 * the lack of `allow-same-origin`) is what makes "no network in v1" real:
 * fetch/XHR/WebSocket are blocked, and images/fonts are limited to inline data. */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'"
].join('; ')

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

export const BRIDGE_SHIM = `
(function () {
  var __seq = 0;
  var __pending = {};
  var __handlers = {};

  function __rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++__seq;
      __pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __rpt: 1, id: id, method: method, args: args || [] }, '*');
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__rptres) {
      var p = __pending[d.id];
      if (!p) return;
      delete __pending[d.id];
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'rpt error'));
    } else if (d.__rptevent) {
      var hs = __handlers[d.name] || [];
      for (var i = 0; i < hs.length; i++) {
        try { hs[i](d.payload); } catch (err) { console.error(err); }
      }
    }
  });

  function vars(scope) {
    return {
      get: function (k) { return __rpc('vars', [{ op: 'get', scope: scope, key: k }]); },
      all: function () { return __rpc('vars', [{ op: 'get', scope: scope }]); },
      set: function (k, v) { return __rpc('vars', [{ op: 'set', scope: scope, key: k, value: v }]); },
      inc: function (k, v) { return __rpc('vars', [{ op: 'inc', scope: scope, key: k, value: v }]); },
      dec: function (k, v) { return __rpc('vars', [{ op: 'dec', scope: scope, key: k, value: v }]); },
      del: function (k) { return __rpc('vars', [{ op: 'del', scope: scope, key: k }]); }
    };
  }

  var rpt = {
    version: 'rpt.v1',
    vars: vars('local'),
    global: vars('global'),
    chat: {
      getMessages: function () { return __rpc('chat.getMessages', []); },
      getLastMessage: function () { return __rpc('chat.getLastMessage', []); }
    },
    generate: function (text) { return __rpc('generate', [String(text == null ? '' : text)]); },
    ui: {
      toast: function (msg) { return __rpc('ui.toast', [String(msg)]); },
      // Standalone plugins only: request a visible, titled panel in the shell.
      // Render your UI into document.body; the host shows this frame in the panel.
      registerPanel: function (def) { return __rpc('ui.registerPanel', [def || {}]); }
    },
    slash: {
      // Register a /command; the handler runs here when the command is invoked.
      registerCommand: function (name, handler) {
        rpt.on('slash:' + String(name).toLowerCase(), function (p) {
          try { if (typeof handler === 'function') handler((p && p.args) || [], (p && p.raw) || ''); }
          catch (e) { console.error(e); }
        });
        return __rpc('slash.register', [String(name)]);
      },
      // Run a slash line (built-in or another plugin's command); resolves output.
      runCommand: function (line) { return __rpc('slash.run', [String(line)]); }
    },
    log: function () {
      var a = Array.prototype.slice.call(arguments).map(String).join(' ');
      console.log('[card-script]', a);
      // One-way (no reply) — also surface in the app's Logs panel.
      parent.postMessage({ __rptlog: 1, msg: a }, '*');
    },
    on: function (name, cb) {
      if (typeof cb !== 'function') return;
      (__handlers[name] = __handlers[name] || []).push(cb);
    }
  };
  window.rpt = rpt;

  // Report content height so the host can size the (opaque-origin) frame.
  function reportHeight() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    parent.postMessage({ __rptresize: 1, height: h }, '*');
  }
  window.addEventListener('load', function () {
    reportHeight();
    if (window.ResizeObserver && document.body) {
      try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) {}
    }
    parent.postMessage({ __rptready: 1 }, '*');
  });
})();
`

/**
 * Best-effort, clean-room Tavern-Helper / js-slash-runner compatibility shim.
 * Maps the *common* TH surface onto `rpt.v1` so many community scripts run with
 * little change. Written from public docs / observed behavior only — NO code is
 * copied from js-slash-runner (AGPL). Differences from ST: everything here is
 * async (returns Promises), and only the mapped subset exists; deeply
 * ST-coupled calls (jQuery DOM surgery, full STScript, ST internals) are out of
 * scope and simply won't be present.
 */
export const TAVERN_SHIM = `
(function () {
  if (typeof rpt === 'undefined') return;
  function vstore(opt) { return opt && opt.type === 'global' ? rpt.global : rpt.vars; }
  var TH = {
    getVariables: function (opt) { return vstore(opt).all(); },
    setVariables: function (vars, opt) {
      var s = vstore(opt), keys = Object.keys(vars || {});
      return Promise.all(keys.map(function (k) { return s.set(k, vars[k]); })).then(function () { return vars; });
    },
    insertOrAssignVariables: function (vars, opt) { return TH.setVariables(vars, opt); },
    getChatMessages: function () { return rpt.chat.getMessages(); },
    getLastMessage: function () { return rpt.chat.getLastMessage(); },
    triggerSlash: function (cmd) { return rpt.slash.runCommand(cmd); },
    triggerSlashWithResult: function (cmd) { return rpt.slash.runCommand(cmd); },
    generate: function (arg) {
      var t = typeof arg === 'string' ? arg : (arg && (arg.user_input || arg.userInput || arg.prompt)) || '';
      return rpt.generate(t);
    },
    generateRaw: function (arg) { return TH.generate(arg); },
    eventOn: function (name, cb) { return rpt.on(name, cb); },
    eventOnce: function (name, cb) {
      var fired = false;
      rpt.on(name, function (p) { if (!fired) { fired = true; cb(p); } });
    },
    registerSlashCommand: function (name, cb) { return rpt.slash.registerCommand(name, cb); },
    toastr: {
      info: function (m) { return rpt.ui.toast(String(m)); },
      success: function (m) { return rpt.ui.toast(String(m)); },
      warning: function (m) { return rpt.ui.toast(String(m)); },
      error: function (m) { return rpt.ui.toast(String(m)); }
    }
  };
  window.TavernHelper = TH;
  // A few loose globals that some scripts call unqualified.
  window.getVariables = TH.getVariables;
  window.setVariables = TH.setVariables;
  window.triggerSlash = TH.triggerSlash;
})();
`

export interface CardScript {
  name: string
  code: string
}

/** Build the full sandboxed-iframe document: CSP + base style + shim + each
 * script wrapped in try/catch so one bad script can't break the others. */
export const buildScriptSrcDoc = (scripts: CardScript[]): string => {
  const userCode = scripts
    .map(
      (s) =>
        `try {\n${s.code}\n} catch (e) { console.error(${JSON.stringify(s.name || 'script')}, e); }`
    )
    .join('\n;\n')

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${HOST_STYLE}</style></head><body>` +
    `<script>${BRIDGE_SHIM}</script>` +
    `<script>${TAVERN_SHIM}</script>` +
    `<script>${userCode}</script>` +
    `</body></html>`
  )
}
