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
      registerPanel: function (def) { return __rpc('ui.registerPanel', [def || {}]); },
      // Add an action button (shown in the menu above the chat input, for card scripts
      // and plugins alike). handler runs when the button is clicked.
      registerButton: function (def, handler) {
        var id = String((def && def.id) || (def && def.label) || 'button');
        if (typeof handler === 'function') rpt.on('button:' + id, handler);
        return __rpc('ui.registerButton', [def || {}]);
      }
    },
    storage: {
      get: function (k) { return __rpc('storage', [{ op: 'get', key: String(k) }]); },
      set: function (k, v) { return __rpc('storage', [{ op: 'set', key: String(k), value: v }]); },
      remove: function (k) { return __rpc('storage', [{ op: 'remove', key: String(k) }]); },
      keys: function () { return __rpc('storage', [{ op: 'keys' }]); },
      all: function () { return __rpc('storage', [{ op: 'all' }]); }
    },
    net: {
      // Opt-in, allow-listed, host-mediated fetch (standalone plugins only).
      fetch: function (url, opts) { return __rpc('net.fetch', [String(url), opts || {}]); }
    },
    slash: {
      // Register a /command; the handler runs here when the command is invoked.
      // opts.description (optional) shows in the chat-box command menu.
      registerCommand: function (name, handler, opts) {
        rpt.on('slash:' + String(name).toLowerCase(), function (p) {
          try { if (typeof handler === 'function') handler((p && p.args) || [], (p && p.raw) || ''); }
          catch (e) { console.error(e); }
        });
        return __rpc('slash.register', [String(name), opts && opts.description ? String(opts.description) : '']);
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
    },
    // Dispatch an event to this frame's own listeners (script-side emit, e.g. button clicks).
    emit: function (name, payload) {
      var hs = __handlers[name];
      if (hs) hs.slice().forEach(function (h) { try { h(payload); } catch (e) { console.error(e); } });
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
    replaceVariables: function (vars, opt) { return TH.setVariables(vars, opt); },
    updateVariablesWith: function (updater, opt) {
      return TH.getVariables(opt).then(function (vars) {
        var next = typeof updater === 'function' ? updater(vars || {}) : vars;
        return TH.setVariables(next || vars || {}, opt).then(function () { return next || vars; });
      });
    },
    getChatMessages: function () { return rpt.chat.getMessages(); },
    getLastMessage: function () { return rpt.chat.getLastMessage(); },
    getLastMessageId: function () {
      return rpt.chat.getMessages().then(function (m) { return m && m.length ? m.length - 1 : -1; });
    },
    getCurrentMessageId: function () { return TH.getLastMessageId(); },
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
    eventMakeFirst: function (name, cb) { return rpt.on(name, cb); },
    // Dispatch to this frame's own eventOn listeners (e.g. declarative button clicks).
    eventEmit: function (name, payload) { rpt.emit(name, payload); return Promise.resolve(); },
    eventRemoveListener: function () {},
    eventClearEvent: function () {},
    registerSlashCommand: function (name, cb) { return rpt.slash.registerCommand(name, cb); },
    toastr: {
      info: function (m) { return rpt.ui.toast(String(m)); },
      success: function (m) { return rpt.ui.toast(String(m)); },
      warning: function (m) { return rpt.ui.toast(String(m)); },
      error: function (m) { return rpt.ui.toast(String(m)); }
    }
  };
  window.TavernHelper = TH;
  // Loose globals that TH / MVU scripts call unqualified.
  window.getVariables = TH.getVariables;
  window.setVariables = TH.setVariables;
  window.triggerSlash = TH.triggerSlash;
  window.eventOn = TH.eventOn;
  window.eventOnce = TH.eventOnce;
  window.eventMakeFirst = TH.eventMakeFirst;
  window.eventEmit = TH.eventEmit;
  window.eventRemoveListener = TH.eventRemoveListener;
  window.eventClearEvent = TH.eventClearEvent;
  if (!window.toastr) window.toastr = TH.toastr;

  // Minimal jQuery no-op stub so ST-DOM-coupled calls ($('#x').prop('checked'), chaining)
  // don't throw. It can't reach a real ST DOM (there isn't one) — getters return undefined,
  // everything else is chainable so scripts degrade instead of crashing.
  if (!window.$) {
    var jqo = {};
    ['on','off','one','click','append','prepend','after','before','remove','detach','empty',
     'addClass','removeClass','toggleClass','css','attr','val','text','html','hide','show',
     'toggle','trigger','find','closest','parent','children','each','ready'].forEach(function (m) {
      jqo[m] = function () { return jqo; };
    });
    ['prop','data','is','hasClass'].forEach(function (m) { jqo[m] = function () { return undefined; }; });
    jqo.length = 0;
    var jq = function () { return jqo; };
    jq.fn = jqo; jq.extend = Object.assign; jq.noop = function () {};
    window.$ = window.jQuery = jq;
  }
})();
`

/**
 * Minimal, clean-room `_` (lodash subset) + `YAML` injected into the sandbox so MVU
 * front-end UI scripts — which lean on `_.get/set/cloneDeep/merge/...` and `YAML.parse`
 * — run without their CDN deps. Standard implementations, no code copied. YAML is a
 * best-effort JSON-passthrough (a full YAML parser is out of scope).
 */
export const LIB_SHIM = `
(function(){
  function parts(p){ return Array.isArray(p) ? p : String(p).replace(/\\[(\\w+)\\]/g,'.$1').split('.').filter(Boolean); }
  function getPath(o,p){ var ks=parts(p); for(var i=0;i<ks.length;i++){ if(o==null) return undefined; o=o[ks[i]]; } return o; }
  function setPath(o,p,v){ var ks=parts(p), c=o; for(var i=0;i<ks.length-1;i++){ if(typeof c[ks[i]]!=='object'||c[ks[i]]==null) c[ks[i]]={}; c=c[ks[i]]; } c[ks[ks.length-1]]=v; return o; }
  function isObj(v){ return v!==null && typeof v==='object' && !Array.isArray(v); }
  function cloneDeep(v){ return v===undefined ? v : JSON.parse(JSON.stringify(v)); }
  function merge(t){ for(var a=1;a<arguments.length;a++){ var s=arguments[a]; if(!s) continue; for(var k in s){ if(isObj(s[k])&&isObj(t[k])) merge(t[k],s[k]); else t[k]=s[k]; } } return t; }
  var _ = {
    get: function(o,p,d){ var v=getPath(o,p); return v===undefined?d:v; },
    set: setPath,
    has: function(o,p){ return getPath(o,p)!==undefined; },
    cloneDeep: cloneDeep, clone: cloneDeep,
    merge: merge,
    isEqual: function(a,b){ return JSON.stringify(a)===JSON.stringify(b); },
    isObject: function(v){ return v!==null && (typeof v==='object'||typeof v==='function'); },
    isArray: Array.isArray,
    isEmpty: function(v){ if(v==null) return true; if(Array.isArray(v)||typeof v==='string') return v.length===0; if(typeof v==='object') return Object.keys(v).length===0; return false; },
    clamp: function(n,lo,hi){ return Math.min(hi, Math.max(lo, n)); },
    pick: function(o,ks){ var r={}; (Array.isArray(ks)?ks:[ks]).forEach(function(k){ if(o&&k in o) r[k]=o[k]; }); return r; },
    omit: function(o,ks){ var r=Object.assign({},o); (Array.isArray(ks)?ks:[ks]).forEach(function(k){ delete r[k]; }); return r; },
    uniq: function(a){ return Array.isArray(a)?a.filter(function(x,i){ return a.indexOf(x)===i; }):a; },
    size: function(v){ if(v==null) return 0; if(Array.isArray(v)||typeof v==='string') return v.length; if(typeof v==='object') return Object.keys(v).length; return 0; },
    keys: function(o){ return o?Object.keys(o):[]; },
    values: function(o){ return o?Object.values(o):[]; },
    forEach: function(c,fn){ if(Array.isArray(c)) c.forEach(fn); else if(isObj(c)) Object.keys(c).forEach(function(k){ fn(c[k],k); }); return c; },
    map: function(c,fn){ if(Array.isArray(c)) return c.map(fn); if(isObj(c)) return Object.keys(c).map(function(k){ return fn(c[k],k); }); return []; },
    defaultTo: function(v,d){ return (v==null||v!==v)?d:v; }
  };
  if (!window._) window._ = _;
  if (!window.lodash) window.lodash = _;
  if (!window.YAML) window.YAML = {
    parse: function(s){ try { return JSON.parse(s); } catch(e){ return {}; } },
    stringify: function(o){ try { return JSON.stringify(o,null,2); } catch(e){ return ''; } }
  };
})();
`

/**
 * When remote scripts are allowed, load REAL lodash + zod from a CDN and expose the
 * globals that Tavern Helper / MVU scripts assume exist: a callable/chainable `_`
 * (`_(x).sortBy()…`) and `z` shaped as `{ z: <zod v4> }` (the MVU zod wrapper —
 * `z.z.object`, `z.z.coerce`, …). It's a `type="module"` with TOP-LEVEL AWAIT, so it
 * finishes setting the globals before any user module (or its imports) evaluates. Falls
 * back silently to the clean-room LIB_SHIM `_` if the CDN is unreachable. The clean-room
 * stance is intact: lodash/zod are MIT npm libs, not js-slash-runner code.
 */
const LIB_LOADER =
  `<script type="module">` +
  `try{const m=await import('https://testingcf.jsdelivr.net/npm/lodash/+esm');window._=window.lodash=(m&&m.default)||m;}catch(e){}` +
  `try{const m=await import('https://testingcf.jsdelivr.net/npm/zod/+esm');window.z={z:(m&&(m.z||m.default))||m};}catch(e){}` +
  `</script>`

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
