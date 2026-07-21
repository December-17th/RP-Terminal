// src/shared/thRuntime/nullHost.ts
//
// A complete, inert Host — every member a safe no-op returning the neutral value the runtime treats
// as "nothing here" (matching the WCV sync-getter fallbacks in ADR 0013 / the stage-2 channel spec).
// Use it as a base to spread over in tests and thin adapters (`{ ...createNullHost(ctx), foo }`) so a
// partial Host still satisfies every required member — no member needs to be optional for that.
import type { Host, CardCtx } from './types'

/** Build a Host whose every method is an inert no-op. `ctx` defaults to an empty session. */
export function createNullHost(ctx?: CardCtx): Host {
  return {
    ctx: ctx ?? { profileId: '', chatId: '', characterId: '' },

    // --- VarsHost ---
    statData: () => ({}),
    applyVariableOps: async () => {},
    setVariables: async () => {},
    getScriptVars: () => ({}),
    setScriptVars: async () => {},
    getChatVars: () => ({}),
    setChatVars: async () => {},
    getGlobalVars: async () => ({}),
    setGlobalVar: async () => {},
    getGlobalVarsSync: () => ({}),
    setGlobalVars: async () => {},
    getExtensionSettingsSync: () => ({}),
    setExtensionSettings: async () => {},
    onVarsChanged: () => () => {},

    // --- WorldbookHost ---
    worldbookNames: () => ({ primary: null, additional: [] }),
    getWorldbook: async () => ({ entries: [] }),
    saveWorldbook: async () => {},
    listWorldbooks: () => [],
    chatWorldbookIds: () => [],
    createWorldbook: async () => '',
    deleteWorldbook: async () => true,
    getWorldbookById: async () => ({ entries: [] }),
    saveWorldbookById: async () => {},
    bindWorldbook: async () => {},

    // --- ChatHost ---
    floors: () => [],
    currentChatId: () => '',
    personaName: () => 'User',
    personaDescription: () => '',
    setChatMessages: async () => true,
    deleteChatMessages: async () => true,
    createChat: async () => '',
    saveChat: async () => true,
    reloadChat: async () => true,
    charData: () => null,
    charAvatarPath: () => null,
    preset: () => null,
    presetNames: () => [],
    savePreset: async () => false,

    // --- RegexHost ---
    regexes: () => [],
    regexesFull: () => [],
    isCharacterRegexesEnabled: () => true,
    formatRegex: (text: string) => text,
    replaceRegexes: async () => {},

    // --- SurfaceHost ---
    setInput: () => {},
    submitInput: () => {},
    setButtons: () => {},
    requestOverlay: async () => false,
    closeOverlay: async () => {},
    setPlayTheme: async () => false,
    getPlayThemeSync: () => ({ tokens: {}, source: 'user' }),

    // --- AssetHost ---
    assetUrl: async () => null,
    sceneAssetUrl: async () => null,
    assetList: async () => [],
    requestAssetImport: async () => null,

    // --- GenHost ---
    generate: async () => '',
    generateRaw: async () => '',
    getDuelPreview: async () => null,

    // --- DisplayHost (ADR 0023) — inert; a real transport serves it via the render broker ---
    renderFloors: async () => [],
    displayRevision: () => 0,
    setDisplayStreamEnabled: async () => {},

    // --- EngineHost ---
    evalTemplate: () => '',
    evalTemplateError: () => null,
    prepareContext: () => ({}),
    onHostEvent: () => () => {},

    // --- AgentHost ---
    runAgent: async () => ({
      invocationId: '',
      status: 'failed',
      failure: {
        code: 'AGENT_HOST_UNAVAILABLE',
        message: 'Agent Host is unavailable',
        retryable: false
      },
      sourceRestarts: 0,
      required: true
    }),
    runAgentPlan: async () => ({ planId: '', status: 'failed', outcomes: [] }),
    registerAgentTool: () => () => {},
    onFloorCommitted: () => () => {}
  }
}
