// RPT Oracle Capture — SillyTavern UI extension (OUR code, clean-room).
//
// Purpose: during the one-time oracle capture (WP-0.4 / ADR 0016) this extension
// listens for CHAT_COMPLETION_PROMPT_READY and POSTs the *post-extension* mutable
// chat array plus a settings snapshot to the local capture server. That gives us
// the assembled prompt after ST's own macro/regex/injection passes but before it
// is shaped into the provider wire body — the fixture we freeze as the spec.
//
// Nothing here is copied from SillyTavern source. It uses only the public
// extension-authoring surface documented at
// https://docs.sillytavern.app/for-contributors/writing-extensions/ :
//   - SillyTavern.getContext() for eventSource + event_types
//   - the CHAT_COMPLETION_PROMPT_READY event payload { chat, dryRun }
//
// Install: copy this folder to
//   <SillyTavern>/public/scripts/extensions/third-party/rpt-oracle-capture/
// then reload ST. A toast confirms it armed.

(function () {
  'use strict'

  const CAPTURE_URL = 'http://127.0.0.1:8899/capture'

  // Set from the extension settings UI or leave as '' to capture everything.
  // We tag each capture with this so the manifest scenario can be matched later.
  let currentScenarioId = ''
  try {
    currentScenarioId = localStorage.getItem('rptOracleScenarioId') || ''
  } catch (_) {
    currentScenarioId = ''
  }

  // Operator-tagged generation type for the scenario being captured (normal / continue /
  // impersonation / group / ...). CHAT_COMPLETION_PROMPT_READY does not carry the type, so
  // the operator sets it per scenario via rptOracleGenType('continue'); defaults to 'normal'.
  let currentGenerationType = ''
  try {
    currentGenerationType = localStorage.getItem('rptOracleGenType') || ''
  } catch (_) {
    currentGenerationType = ''
  }

  function getCtx() {
    // SillyTavern exposes a global context accessor on modern builds.
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
      return SillyTavern.getContext()
    }
    return null
  }

  // Pull a compact, prose-free snapshot of the settings that actually drive
  // assembly. We deliberately avoid dumping the whole settings blob (it carries
  // ST default template strings and unrelated prose we do not want in fixtures);
  // instead we record the knobs the scenario manifest cares about.
  function settingsSnapshot(ctx) {
    const s = {}
    try {
      const oai = ctx && ctx.chatCompletionSettings ? ctx.chatCompletionSettings : {}
      const keys = [
        'chat_completion_source',
        'openai_model',
        'custom_url',
        'names_behavior',
        'wrap_in_quotes',
        'continue_prefill',
        'squash_system_messages',
        'prompt_converter',
        'new_chat_prompt',
        'new_group_chat_prompt',
        'new_example_chat_prompt',
        'continue_nudge_prompt',
        'wi_format',
        'scenario_format',
        'personality_format',
        'group_nudge_prompt',
        'impersonation_prompt'
      ]
      for (const k of keys) if (k in oai) s[k] = oai[k]
    } catch (_) {
      /* best effort */
    }
    try {
      // New macro engine flag (power_user.macro / experimental engine setting).
      const pu = ctx && ctx.powerUserSettings ? ctx.powerUserSettings : {}
      s.macro_engine = pu.macro_engine ?? pu.experimental_macro_engine ?? null
    } catch (_) {
      /* best effort */
    }
    return s
  }

  // Capture the machine-readable INPUT that produced this assembly (what was FED to ST),
  // so a fixture can later be re-driven through RPT assembly (rptAdapter). Best-effort over
  // the public context surface — anything unobservable here (e.g. pre-activated World Info,
  // token budget) the operator fills in per RUNBOOK step 5. All fields are prose we author.
  function inputSnapshot(ctx, payload) {
    var input = {
      generationType: currentGenerationType || (payload && payload.dryRun ? 'dry-run' : 'normal'),
      macroEngine: 'new',
      presetName: null,
      chatMessages: [],
      worldInfo: [],
      tokenBudget: null
    }
    try {
      var chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : []
      input.chatMessages = chat.map(function (m) {
        return {
          role: m && m.is_user ? 'user' : m && m.is_system ? 'system' : 'assistant',
          content: m && typeof m.mes === 'string' ? m.mes : ''
        }
      })
    } catch (_) {
      /* best effort */
    }
    try {
      // Active Chat Completion preset name (Prompt Manager). Shape varies across builds.
      var pm = ctx && typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager('openai') : null
      if (pm && typeof pm.getSelectedPresetName === 'function') {
        input.presetName = pm.getSelectedPresetName()
      }
    } catch (_) {
      /* best effort */
    }
    try {
      var oai = ctx && ctx.chatCompletionSettings ? ctx.chatCompletionSettings : {}
      if (typeof oai.openai_max_tokens === 'number') input.tokenBudget = oai.openai_max_tokens
    } catch (_) {
      /* best effort */
    }
    return input
  }

  function post(payload) {
    try {
      // keepalive so a capture triggered right before navigation still lands.
      fetch(CAPTURE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {
        /* capture server may be down; ignore */
      })
    } catch (_) {
      /* ignore */
    }
  }

  function onPromptReady(payload) {
    const ctx = getCtx()
    // payload.chat is the mutable array of { role, content } the extension can edit.
    const chat = payload && Array.isArray(payload.chat) ? payload.chat : null
    post({
      schemaVersion: 1,
      source: 'captured',
      scenarioId: currentScenarioId,
      dryRun: !!(payload && payload.dryRun),
      capturedAt: new Date().toISOString(),
      st: {
        version:
          (ctx && ctx.getVersion && ctx.getVersion().pkgVersion) ||
          (typeof CLIENT_VERSION !== 'undefined' ? CLIENT_VERSION : null) ||
          '1.18.0'
      },
      settings: settingsSnapshot(ctx),
      input: inputSnapshot(ctx, payload),
      promptReady: { chat: chat }
    })
  }

  function arm() {
    const ctx = getCtx()
    if (!ctx || !ctx.eventSource || !ctx.eventTypes) {
      // ST not ready yet — retry shortly.
      setTimeout(arm, 500)
      return
    }
    const evt = ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY
    if (!evt) {
      console.warn('[rpt-oracle] CHAT_COMPLETION_PROMPT_READY not found on this ST build')
      return
    }
    ctx.eventSource.on(evt, onPromptReady)
    if (typeof toastr !== 'undefined') {
      toastr.info('RPT Oracle Capture armed (scenario: ' + (currentScenarioId || 'unset') + ')')
    }
    console.log('[rpt-oracle] armed on CHAT_COMPLETION_PROMPT_READY')

    // Tiny helper on window so the operator can set the scenario id per capture
    // from the browser console: rptOracleScenario('wp-2.1-markers-basic')
    window.rptOracleScenario = function (id) {
      currentScenarioId = String(id || '')
      try {
        localStorage.setItem('rptOracleScenarioId', currentScenarioId)
      } catch (_) {
        /* ignore */
      }
      console.log('[rpt-oracle] scenario set to', currentScenarioId)
      return currentScenarioId
    }

    // Companion helper to tag the generation type recorded in the captured input:
    // rptOracleGenType('continue'). Defaults to 'normal' when unset.
    window.rptOracleGenType = function (type) {
      currentGenerationType = String(type || '')
      try {
        localStorage.setItem('rptOracleGenType', currentGenerationType)
      } catch (_) {
        /* ignore */
      }
      console.log('[rpt-oracle] generation type set to', currentGenerationType || 'normal')
      return currentGenerationType
    }
  }

  arm()
})()
