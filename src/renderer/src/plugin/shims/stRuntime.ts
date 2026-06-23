/**
 * Clean-room SillyTavern + MagVarUpdate (MVU) runtime shim for frontend cards (task #2).
 *
 * Cards built on the Tavern-Helper template expect a SillyTavern host: a global
 * `SillyTavern.getContext()`, a global `Mvu`, and a SYNCHRONOUS `getCurrentMessageId()`. In our
 * process-isolated (opaque) frame those can't come from the parent window — so we inject them
 * FRAME-LOCAL here, mapped onto the `rpt` / TavernHelper bridge. Cross-origin reaches in card
 * code (`window.top?.SillyTavern…`) are redirected to this frame by the loader's source rewrite
 * (../sourceRewrite.ts). JS-as-a-string for the sandbox.
 *
 * NO js-slash-runner (AFPL) code — written from the public ST/TH/MVU API surface (see CLAUDE.md
 * → Licensing). This is the read/runtime surface only; the MVU *update engine* (parsing
 * `_.set(...)` out of generations into typed mutations) is separate, main-side (Track R), and may
 * adapt the MIT-licensed MagVarUpdate.
 *
 * Loads AFTER TAVERN_SHIM (it uses its `window.getVariables/setVariables/generateRaw/…` globals).
 */
import { TAVERN_EVENTS } from '../events'

export const ST_RUNTIME_SHIM = `
(function () {
  if (typeof rpt === 'undefined') return;
  var EV = ${JSON.stringify(TAVERN_EVENTS)};
  function srlog(m){ try { parent.postMessage({ __rptlog: 1, msg: '[st-runtime] ' + m }, '*'); } catch (_) {} }

  // A small SYNCHRONOUS mirror of host state. ST's getContext()/getCurrentMessageId() are sync,
  // but our data crosses an async bridge — so we self-hydrate this from existing rpt RPCs and
  // keep it fresh via the forwarded tavern_events. Starts empty; fills within a tick of mount.
  var mirror = { messageCount: 0, lastMessageId: -1, name1: 'User', name2: '', characterName: '', chatId: null, chat: [] };
  function refreshChat(){
    try { rpt.chat.getMessages().then(function (m) {
      m = m || []; mirror.chat = m; mirror.messageCount = m.length; mirror.lastMessageId = m.length - 1;
    }).catch(function (){}); } catch (_) {}
  }
  function refreshCard(){
    try { rpt.card.getData().then(function (d) {
      var data = d && (d.data || d); if (data && data.name) mirror.characterName = data.name;
    }).catch(function (){}); } catch (_) {}
  }
  refreshChat(); refreshCard();
  rpt.on(EV.CHAT_CHANGED, function (p) { if (p && p.chatId != null) mirror.chatId = p.chatId; refreshChat(); });
  rpt.on(EV.MESSAGE_RECEIVED, refreshChat);
  rpt.on(EV.MESSAGE_UPDATED, refreshChat);
  rpt.on(EV.MESSAGE_DELETED, refreshChat);
  rpt.on(EV.MESSAGE_SWIPED, refreshChat);

  function getCurrentMessageId(){ return mirror.lastMessageId; }
  window.getCurrentMessageId = getCurrentMessageId;

  // --- SillyTavern.getContext() ---------------------------------------------------------------
  // Just enough of ST's context to host template cards. extensionSettings.EjsTemplate is reported
  // enabled so their environment checks pass; the event surface maps onto rpt's bus.
  var extensionSettings = { EjsTemplate: { enabled: true } };
  var eventSource = {
    on: function (n, cb) { return rpt.on(n, cb); },
    once: function (n, cb) { return rpt.once(n, cb); },
    makeFirst: function (n, cb) { return rpt.onFirst(n, cb); },
    removeListener: function (n, cb) { rpt.off(n, cb); },
    emit: function (n) { rpt.emit(n, arguments.length > 2 ? [].slice.call(arguments, 1) : arguments[1]); return Promise.resolve(); }
  };
  function getContext(){
    return {
      chat: mirror.chat,
      chatId: mirror.chatId,
      this_chid: mirror.characterName ? 0 : undefined,
      characterId: mirror.characterName ? 0 : undefined,
      characters: mirror.characterName ? [{ name: mirror.characterName, avatar: 'none' }] : [],
      name1: mirror.name1,
      name2: mirror.name2 || mirror.characterName || '',
      extensionSettings: extensionSettings,
      extension_settings: extensionSettings,
      eventSource: eventSource,
      event_types: EV,
      eventTypes: EV,
      getCurrentMessageId: getCurrentMessageId,
      getContext: getContext,
      // Common helpers cards reach for through the context (best-effort → our async bridge).
      generateRaw: window.generateRaw,
      getChatMessages: window.getChatMessages,
      getCharData: window.getCharData
    };
  }
  window.SillyTavern = { getContext: getContext };

  // --- Mvu (MagVarUpdate) read/runtime surface ------------------------------------------------
  // MVU state is the message-scoped variable store ({ stat_data, delta_data }). getMvuData reads
  // it; replaceMvuData writes it back; events.* are the names the UI subscribes to (host emits
  // them via mvuEvents.ts). The UPDATE engine (parse _.set(...) from generations) is main-side.
  function defaultOpt(){ return { type: 'message', message_id: getCurrentMessageId() }; }
  function getMvuData(opt){
    var p = window.getVariables ? window.getVariables(opt || defaultOpt()) : Promise.resolve({});
    return p.then(function (v) {
      if (!v || typeof v !== 'object') return { stat_data: {} };
      return ('stat_data' in v) ? v : { stat_data: v };
    });
  }
  function replaceMvuData(data, opt){
    return window.setVariables ? window.setVariables(data || {}, opt || defaultOpt()) : Promise.resolve();
  }
  window.Mvu = {
    getMvuData: getMvuData,
    replaceMvuData: replaceMvuData,
    // Shallow local set + persist; full _.set semantics arrive with the main-side update engine.
    setMvuVariable: function (data, path, value, opt) {
      try {
        var seg = String(path).split('.'); var root = (data && data.stat_data) || data || {}; var cur = root;
        for (var i = 0; i < seg.length - 1; i++) { cur = cur[seg[i]] = cur[seg[i]] || {}; }
        cur[seg[seg.length - 1]] = value;
      } catch (_) {}
      return replaceMvuData(data, opt);
    },
    parseMessage: function () { return Promise.resolve(null); },
    registerMvuSchema: function () {},
    events: {
      VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
      SINGLE_VARIABLE_UPDATED: 'mag_variable_updated',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended'
    }
  };

  srlog('SillyTavern + Mvu ready (getCurrentMessageId / getContext / EjsTemplate enabled)');
})();
`
