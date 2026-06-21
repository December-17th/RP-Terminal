/** Clean-room Tavern-Helper compatibility shim — maps the common TH surface onto
 * `rpt`. JS-as-a-string for the sandbox. NO js-slash-runner code (see bridgeShim.ts). */

import { TAVERN_EVENTS_LITERAL } from '../events'

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
  // Canonical ST/TH event-name enum (single source of truth in plugin/events.ts).
  var tavern_events = ${TAVERN_EVENTS_LITERAL};
  // --- Variable scopes (TH-2): chat(local)/global/message/character/script. ---
  function scopeOf(opt) {
    var t = opt && opt.type;
    if (t === 'global' || t === 'message' || t === 'character' || t === 'script') return t;
    return 'local';
  }
  function mid(opt) { return opt && (opt.message_id != null ? opt.message_id : opt.messageId); }
  function writeVars(op, vars, opt) {
    var scope = scopeOf(opt), keys = Object.keys(vars || {});
    if (scope === 'script') {
      // script scope ≈ this owner's isolated storage KV.
      if (op === 'del') return Promise.all(keys.map(function (k) { return rpt.storage.remove(k); }));
      return Promise.all(keys.map(function (k) { return rpt.storage.set(k, vars[k]); })).then(function () { return vars; });
    }
    return Promise.all(keys.map(function (k) {
      return rpt.var({ op: op, scope: scope, key: k, value: vars[k], messageId: mid(opt) });
    })).then(function () { return vars; });
  }
  // Slice a transcript by a TH range: number (one), "a-b" string, or {start,end}.
  function sliceRange(all, range) {
    if (range == null) return all;
    if (typeof range === 'number') return all.slice(range, range + 1);
    if (typeof range === 'string') {
      var p = range.split('-'), a = parseInt(p[0], 10) || 0;
      var b = p.length > 1 ? parseInt(p[1], 10) : a;
      return all.slice(a, b + 1);
    }
    if (typeof range === 'object') {
      var s = range.start || 0, e = range.end != null ? range.end : all.length - 1;
      return all.slice(s, e + 1);
    }
    return all;
  }
  var TH = {
    getVariables: function (opt) {
      return scopeOf(opt) === 'script' ? rpt.storage.all()
        : rpt.var({ op: 'get', scope: scopeOf(opt), messageId: mid(opt) });
    },
    setVariables: function (vars, opt) { return writeVars('set', vars, opt); },
    insertOrAssignVariables: function (vars, opt) { return writeVars('set', vars, opt); },
    insertVariables: function (vars, opt) { return writeVars('insert', vars, opt); },
    replaceVariables: function (vars, opt) { return writeVars('set', vars, opt); },
    deleteVariable: function (key, opt) {
      var o = {}; o[key] = 1; return writeVars('del', o, opt);
    },
    updateVariablesWith: function (updater, opt) {
      return TH.getVariables(opt).then(function (vars) {
        var next = typeof updater === 'function' ? updater(vars || {}) : vars;
        return TH.setVariables(next || vars || {}, opt).then(function () { return next || vars; });
      });
    },
    getChatMessages: function (range) {
      return rpt.chat.getMessages().then(function (all) { return sliceRange(all || [], range); });
    },
    setChatMessages: function (messages) {
      var arr = Array.isArray(messages) ? messages : [messages];
      return Promise.all(arr.map(function (m) {
        var id = m && (m.message_id != null ? m.message_id : m.floor);
        var patch = {};
        if (m && m.message != null) patch.response = m.message;
        if (m && m.user != null) patch.user = m.user;
        return rpt.chat.setMessage(id, patch);
      }));
    },
    createChatMessages: function (messages) {
      var arr = Array.isArray(messages) ? messages : [messages];
      return Promise.all(arr.map(function (m) {
        return rpt.chat.createMessage({ user: m && m.user, response: m && (m.message != null ? m.message : m.response) });
      }));
    },
    deleteChatMessages: function (ids) {
      var from = Array.isArray(ids) ? Math.min.apply(Math, ids) : ids;
      return rpt.chat.deleteMessages(Number(from));
    },
    getLastMessage: function () { return rpt.chat.getLastMessage(); },
    getLastMessageId: function () {
      return rpt.chat.getMessages().then(function (m) { return m && m.length ? m.length - 1 : -1; });
    },
    // --- TH-3 read/CRUD: card, worldbook, preset, regex. ---
    getCharData: function () { return rpt.card.getData(); },
    getCharAvatarPath: function () { return rpt.card.getAvatarPath(); },
    getWorldbookNames: function () { return rpt.lore.list(); },
    getCharWorldbookNames: function () { return rpt.lore.list(); },
    getWorldbook: function (id) { return rpt.lore.get(id); },
    getChatWorldbook: function () { return rpt.lore.get(); },
    replaceWorldbookEntries: function (id, entries) {
      // Accept (id, entries) or (entries) — the latter targets the active card's book.
      if (Array.isArray(id)) { entries = id; id = undefined; }
      return rpt.lore.setEntries(id, entries);
    },
    getPreset: function () { return rpt.preset.get(); },
    getPresetNames: function () { return rpt.preset.list(); },
    getTavernRegexes: function () { return rpt.regex.list(); },
    formatAsTavernRegexedString: function (text, ctx) { return rpt.regex.format(text, ctx); },
    getCurrentMessageId: function () { return TH.getLastMessageId(); },
    triggerSlash: function (cmd) { return rpt.slash.runCommand(cmd); },
    triggerSlashWithResult: function (cmd) { return rpt.slash.runCommand(cmd); },
    generate: function (arg) {
      var t = typeof arg === 'string' ? arg : (arg && (arg.user_input || arg.userInput || arg.prompt)) || '';
      return rpt.generate(t);
    },
    // generateRaw: a one-off custom generation (returns text, NOT added to the chat).
    generateRaw: function (arg) {
      var c = (typeof arg === 'string') ? { userInput: arg } : (arg || {});
      return rpt.generateRaw({
        userInput: c.user_input || c.userInput || c.prompt || '',
        systemPrompt: c.system_prompt || c.systemPrompt,
        maxChatHistory: c.max_chat_history != null ? c.max_chat_history : c.maxChatHistory,
        maxTokens: c.max_tokens != null ? c.max_tokens : c.maxTokens,
        overrides: c.overrides || c.generation_config || {}
      });
    },
    stopGeneration: function () { return rpt.stopGeneration(); },
    generateImage: function (prompt) { return rpt.generateImage(prompt); },
    // TH-7 audio. audioPlay(url, type, opts) — type 'bgm' (default) or 'sfx'.
    audioPlay: function (url, type, opts) {
      return type === 'sfx' ? rpt.audio.playSfx(url, opts) : rpt.audio.playBgm(url, opts);
    },
    audioPause: function () { return rpt.audio.pauseBgm(); },
    audioResume: function () { return rpt.audio.resumeBgm(); },
    audioStop: function () { return rpt.audio.stopBgm(); },
    audioSetVolume: function (v) { return rpt.audio.setVolume(v); },
    eventOn: function (name, cb) { return rpt.on(name, cb); },
    eventOnce: function (name, cb) { return rpt.once(name, cb); },
    eventMakeFirst: function (name, cb) { return rpt.onFirst(name, cb); },
    eventMakeLast: function (name, cb) { return rpt.on(name, cb); },
    eventWaitFor: function (name) { return rpt.waitFor(name); },
    // Dispatch to this frame's own eventOn listeners (e.g. declarative button clicks).
    eventEmit: function (name, payload) { rpt.emit(name, payload); return Promise.resolve(); },
    eventRemoveListener: function (name, cb) { rpt.off(name, cb); return Promise.resolve(); },
    eventClearEvent: function (name) { rpt.off(name); return Promise.resolve(); },
    registerSlashCommand: function (name, cb) { return rpt.slash.registerCommand(name, cb); },
    toastr: {
      info: function (m) { return rpt.ui.toast(String(m)); },
      success: function (m) { return rpt.ui.toast(String(m)); },
      warning: function (m) { return rpt.ui.toast(String(m)); },
      error: function (m) { return rpt.ui.toast(String(m)); }
    }
  };
  TH.tavern_events = tavern_events;
  window.TavernHelper = TH;
  // Loose globals that TH / MVU scripts call unqualified.
  window.tavern_events = tavern_events;
  window.getVariables = TH.getVariables;
  window.setVariables = TH.setVariables;
  window.insertVariables = TH.insertVariables;
  window.insertOrAssignVariables = TH.insertOrAssignVariables;
  window.deleteVariable = TH.deleteVariable;
  window.updateVariablesWith = TH.updateVariablesWith;
  window.getChatMessages = TH.getChatMessages;
  window.setChatMessages = TH.setChatMessages;
  window.createChatMessages = TH.createChatMessages;
  window.deleteChatMessages = TH.deleteChatMessages;
  window.getCharData = TH.getCharData;
  window.getWorldbook = TH.getWorldbook;
  window.getWorldbookNames = TH.getWorldbookNames;
  window.replaceWorldbookEntries = TH.replaceWorldbookEntries;
  window.getPreset = TH.getPreset;
  window.getTavernRegexes = TH.getTavernRegexes;
  window.formatAsTavernRegexedString = TH.formatAsTavernRegexedString;
  window.generateRaw = TH.generateRaw;
  window.stopGeneration = TH.stopGeneration;
  window.generateImage = TH.generateImage;
  window.triggerSlash = TH.triggerSlash;
  // TH runtime probes used by frontend cards' environment checks. We report our TH-compat
  // level; waitGlobalInitialized resolves once a named global appears (else times out).
  window.getTavernHelperVersion = function(){ return '4.3.17'; };
  TH.getTavernHelperVersion = window.getTavernHelperVersion;
  window.waitGlobalInitialized = function(name){
    return new Promise(function(resolve, reject){
      if (window[name]) return resolve(window[name]);
      var n = 0, t = setInterval(function(){
        if (window[name]) { clearInterval(t); resolve(window[name]); }
        else if (++n > 50) { clearInterval(t); reject(new Error(name + ' not initialized')); }
      }, 100);
    });
  };
  window.eventOn = TH.eventOn;
  window.eventOnce = TH.eventOnce;
  window.eventMakeFirst = TH.eventMakeFirst;
  window.eventMakeLast = TH.eventMakeLast;
  window.eventWaitFor = TH.eventWaitFor;
  window.eventEmit = TH.eventEmit;
  window.eventRemoveListener = TH.eventRemoveListener;
  window.eventClearEvent = TH.eventClearEvent;
  if (!window.toastr) window.toastr = TH.toastr;
  // jQuery ($) is provided by the separate JQUERY_SHIM (a real DOM-backed mini-jQuery).
})();
`
