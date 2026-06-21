/** Clean-room Tavern-Helper compatibility shim — maps the common TH surface onto
 * `rpt`. JS-as-a-string for the sandbox. NO js-slash-runner code (see bridgeShim.ts). */

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
