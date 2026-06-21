/** In-iframe card-script runtime: the `rpt` API + lifecycle. Injected as a classic
 * <script>; talks to the host via postMessage. Clean-room (see bridgeShim.ts).
 * This is JS-as-a-string embedded into the sandbox document. */
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
    // Low-level scoped variable op (local/global/message/character) for the TH shim.
    var: function (action) { return __rpc('vars', [action || { op: 'get' }]); },
    chat: {
      getMessages: function () { return __rpc('chat.getMessages', []); },
      getLastMessage: function () { return __rpc('chat.getLastMessage', []); },
      setMessage: function (floor, patch) { return __rpc('chat.setMessage', [floor, patch || {}]); },
      createMessage: function (msg) { return __rpc('chat.createMessage', [msg || {}]); },
      deleteMessages: function (fromFloor) { return __rpc('chat.deleteMessages', [fromFloor]); }
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
    // TH-3 read/CRUD: character card, worldbook (lorebook), preset, regex.
    card: {
      getData: function () { return __rpc('card.getData', []); },
      getAvatarPath: function () { return __rpc('card.getAvatarPath', []); }
    },
    lore: {
      list: function () { return __rpc('lore.list', []); },
      get: function (id) { return __rpc('lore.get', [id]); },
      setEntries: function (id, entries) { return __rpc('lore.setEntries', [id, entries]); }
    },
    preset: {
      get: function () { return __rpc('preset.get', []); },
      list: function () { return __rpc('preset.list', []); }
    },
    regex: {
      format: function (text, ctx) { return __rpc('regex.format', [String(text == null ? '' : text), ctx]); },
      list: function () { return __rpc('regex.list', []); }
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
      if (typeof cb !== 'function') return cb;
      (__handlers[name] = __handlers[name] || []).push(cb);
      return cb;
    },
    // Register a listener at the FRONT of the queue (TH eventMakeFirst).
    onFirst: function (name, cb) {
      if (typeof cb !== 'function') return cb;
      (__handlers[name] = __handlers[name] || []).unshift(cb);
      return cb;
    },
    // Remove a listener (by identity, incl. once-wrappers). Omit cb to clear all for name.
    off: function (name, cb) {
      var hs = __handlers[name];
      if (!hs) return;
      if (typeof cb !== 'function') { __handlers[name] = []; return; }
      __handlers[name] = hs.filter(function (h) { return h !== cb && h.__orig !== cb; });
    },
    // Fire-once listener; auto-removes after the first dispatch.
    once: function (name, cb) {
      function wrap(p) { rpt.off(name, wrap); if (typeof cb === 'function') cb(p); }
      wrap.__orig = cb;
      rpt.on(name, wrap);
      return wrap;
    },
    // Resolve a promise on the next dispatch of an event (TH eventWaitFor).
    waitFor: function (name) {
      return new Promise(function (resolve) { rpt.once(name, resolve); });
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
