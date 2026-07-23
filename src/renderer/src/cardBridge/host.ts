// src/renderer/src/cardBridge/host.ts
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useComposerStore } from '../stores/composerStore'
import { useLorebookStore } from '../stores/lorebookStore'
import { onCardHostEvent } from './cardHostEvents'
import { applyRuntimeTheme, getEffectivePlayTheme } from './playTheme'
import { evalTemplate, evalTemplateDetailed } from '../../../shared/templateEngine'
import { buildRenderContext } from '../plugin/renderTemplate'
import { storeRuleToTavernRegex } from '../../../shared/thRuntime/tavernRegex'
import { floorLocalVars } from '../../../shared/thRuntime/shapes'
import { categoryForType } from '../../../shared/worldAssets/types'
import type { AssetType } from '../../../shared/worldAssets/types'
import { localFirstRemoteAssetUrl } from '../../../shared/worldAssets/remote'
import type { Host, CardCtx, FloorLike, HostPresetView } from '../../../shared/thRuntime/types'
import type { VarOp } from '../../../shared/thRuntime/ops'
import {
  createAgentHostFacet,
  type AgentToolCompletion,
  type AgentToolRequest,
  type CardAgentToolBinding,
  type CardFloorCommit
} from '../../../shared/thRuntime/agentHostFacet'

// Global vars are per-PROFILE, so ALL inline card hosts in this renderer realm share ONE cache per profile
// (each card iframe builds its own createInlineHost, but they all run in the same parent renderer realm).
// A global-var write in one card is then visible to every OTHER open card immediately — and survives a
// card iframe reload mid-change — instead of only after a fresh floor re-seeds from disk (the reported lag).
// Coherence events (window CustomEvents, so nothing crosses a module boundary):
//   - a card write emits `rpt-globals-refetch` so the Variables panel re-reads (cards share the map below);
//   - the Variables panel (which writes globals straight to disk) emits `rpt-globals-invalidate` so open
//     cards drop the cache and re-read disk on next access.
export const GLOBALS_REFETCH_EVENT = 'rpt-globals-refetch'
export const GLOBALS_INVALIDATE_EVENT = 'rpt-globals-invalidate'
const globalVarCaches = new Map<string, Record<string, any>>()
if (typeof window !== 'undefined')
  window.addEventListener(GLOBALS_INVALIDATE_EVENT, (e: Event) => {
    const pid = (e as CustomEvent).detail?.profileId
    if (pid) globalVarCaches.delete(pid)
    else globalVarCaches.clear()
  })

const floorsOf = (): FloorLike[] => useChatStore.getState().floors as any
const latestVars = (): any => {
  const f = floorsOf()
  return f.length ? ((f[f.length - 1] as any).variables ?? {}) : {}
}
const statOf = (): any => {
  const v = latestVars()
  return v && typeof v === 'object' && 'stat_data' in v ? v.stat_data : v
}
const cardOf = (): any => useCharacterStore.getState().activeCharacter?.card?.data ?? null
const floorIndex = (): number => {
  const f = floorsOf()
  return f.length ? ((f[f.length - 1] as any).floor ?? f.length - 1) : 0
}

export function createInlineHost(ctx: CardCtx): Host {
  // Resolve the card's characterId RELIABLY: ctx.characterId comes from activeCharacter, which is empty/
  // stale when a chat is opened directly — so fall back to the active chat row's character_id (the WCV path
  // resolves likewise from the chat row). The card's own lorebook is stored at id == characterId.
  const cardCharacterId = (): string =>
    ctx.characterId ||
    (useChatStore.getState().chats.find((c) => c.id === ctx.chatId)?.character_id ?? '')
  const fetchWb = async (): Promise<any> => {
    try {
      return await window.api.getLorebook(ctx.profileId, cardCharacterId())
    } catch {
      return { entries: [] }
    }
  }
  // After a chat-write, reload the card's chat floors so the edit/delete/save shows. Use refreshFloors (a
  // card-initiated floor refresh tagged card-write) — NOT setActiveChat — so the writing card's own MVU
  // events don't re-fire via the App.tsx floor rebroadcast, matching the WCV host-reload path.
  const reloadFloors = async (): Promise<boolean> => {
    if (useChatStore.getState().activeChatId === ctx.chatId) {
      await useChatStore.getState().refreshFloors(ctx.profileId, ctx.chatId)
    }
    return true
  }
  // Seed the lorebook store so the SYNC worldbook getters (listWorldbooks/chatWorldbookIds) have data even
  // if the UI hasn't opened the lorebook panel. Fire-and-forget; resolveWbId refreshes on a later miss.
  void useLorebookStore.getState().loadLibrary(ctx.profileId)
  if (ctx.chatId) void useLorebookStore.getState().loadSession(ctx.profileId, ctx.chatId)
  // Script-scope vars (TH getVariables({type:'script'})) — a card-owned KV (owner card:<id>). getScriptVars
  // must be SYNC *and correct on the FIRST read*: a card paints its settings UI at boot, and an inline frame
  // gets a brand-new host on every reload, so an async prefetch would return {} until it lands and the card
  // would render defaults over its saved state (the "settings don't persist" bug). So seed LAZILY with a
  // blocking sendSync on first access, then memoize — a card that never reads script vars pays nothing, and a
  // reader pays exactly one sync round-trip, right before it renders. Mirrors the WCV transport's sendSync.
  const scriptVarOwner = (): string => 'card:' + cardCharacterId()
  let scriptVarCache: Record<string, any> | undefined
  const loadScriptVars = (): Record<string, any> => {
    if (scriptVarCache === undefined) {
      try {
        scriptVarCache = window.api.pluginStorageAllSync(ctx.profileId, scriptVarOwner()) || {}
      } catch {
        scriptVarCache = {}
      }
    }
    return scriptVarCache ?? {}
  }
  // Chat-scope vars (getVariables({type:'chat'})) — a per-chat card-owned KV. Same lazy-sync seed + memoize.
  let chatVarCache: Record<string, any> | undefined
  const loadChatVars = (): Record<string, any> => {
    if (chatVarCache === undefined) {
      try {
        chatVarCache =
          (ctx.chatId ? window.api.chatCardVarsGetSync(ctx.profileId, ctx.chatId) : {}) || {}
      } catch {
        chatVarCache = {}
      }
    }
    return chatVarCache ?? {}
  }
  // Global-scope vars (getVariables({type:'global'})) — the per-profile template-globals bag, shared across
  // chats AND across every open card via the module-level `globalVarCaches` map. A beautification card keeps
  // its UI settings here, so the lazy sync seed is essential (an async prefetch would return {} at boot and
  // paint defaults over saved settings on every fresh frame), and the shared map is what makes a write in
  // one floor's card show up in another's without waiting for a new floor.
  const loadGlobalVars = (): Record<string, any> => {
    const existing = globalVarCaches.get(ctx.profileId)
    if (existing !== undefined) return existing
    let cache: Record<string, any>
    try {
      cache = window.api.pluginGlobalsGetSync(ctx.profileId) || {}
    } catch {
      cache = {}
    }
    globalVarCaches.set(ctx.profileId, cache)
    return cache
  }
  const scope = (): { profileId: string; chatId: string; characterId: string } => ({
    profileId: ctx.profileId,
    chatId: ctx.chatId,
    characterId: cardCharacterId()
  })
  const agentHost = createAgentHostFacet<string>({
    invocation: {
      run: ({ kind: _kind, ...command }) => window.api.cardAgentRun({ ...scope(), ...command }),
      runPlan: ({ kind: _kind, ...command }) =>
        window.api.cardAgentRunPlan({ ...scope(), ...command }),
      cancel: (requestId) => window.api.cardAgentCancel(requestId)
    },
    tools: {
      register: async (binding: CardAgentToolBinding) => {
        const registration = await window.api.cardAgentRegisterTool({ ...scope(), binding })
        if (typeof registration?.completionCapability !== 'string') {
          throw new Error('Card tool registration did not return a completion capability')
        }
        return registration.completionCapability
      },
      unregister: (name) => window.api.cardAgentUnregisterTool({ ...scope(), name }),
      complete: (completionCapability: string, completion: AgentToolCompletion) =>
        window.api.cardAgentToolResult({
          ...scope(),
          completionCapability,
          ...completion
        }),
      onRequest: (handler: (request: AgentToolRequest) => void) =>
        window.api.onCardAgentToolRequest((request: any) => {
          const requestScope = request?.scope
          if (
            requestScope?.profileId !== ctx.profileId ||
            requestScope?.chatId !== ctx.chatId ||
            requestScope?.characterId !== cardCharacterId()
          )
            return
          handler(request)
        }),
      onAbort: (handler: (requestId: string) => void) =>
        window.api.onCardAgentToolAbort((request: { requestId: string }) =>
          handler(request.requestId)
        )
    },
    floors: {
      subscribe: (handler: (event: CardFloorCommit) => void) =>
        window.api.onCardFloorCommitted(
          (payload: { profileId: string; chatId: string; event: CardFloorCommit }) => {
            if (payload.profileId === ctx.profileId && payload.chatId === ctx.chatId) {
              handler(payload.event)
            }
          }
        )
    }
  })
  return {
    ...agentHost,
    ctx,
    statData: () => statOf(),
    floors: () => floorsOf(),
    charData: () => cardOf(),
    charAvatarPath: () => null,
    // getPreset('in_use') — the envelope-backed active preset VIEW, sourced synchronously from the SAME
    // main-side projection (presetService.getActivePresetView) the WCV transport reads. Both transports
    // bottom out in getActivePresetView, so prompts_unused/extensions are identical (transport parity —
    // CLAUDE.md "two transports at parity"); the shared runtime maps this view into the TH getPreset shape.
    preset: () => {
      try {
        return (window.api.getActivePresetViewSync(ctx.profileId) as HostPresetView | null) ?? null
      } catch {
        return null
      }
    },
    presetNames: () => usePresetStore.getState().presets.map((p: any) => p.name),
    // Persist a card's preset edits (the 狐神抚 control surface). The runtime hands a full
    // normalized-preset-shaped patch (merged onto the current view). Write it through the same
    // main preset service the WCV transport uses, then refresh the store so the UI reflects it.
    savePreset: async (patch: unknown) => {
      const { activeId } = usePresetStore.getState()
      if (!activeId) return false
      try {
        await window.api.savePreset(ctx.profileId, activeId, patch as any)
        await usePresetStore.getState().load(ctx.profileId)
        return true
      } catch {
        return false
      }
    },
    worldbookNames: () => {
      // The card's OWN lorebook NAME (faithful to WCV: lb.name || characterId) — so getWorldbook(primary)
      // resolves back to its real library id. NOT activeCharacter's display name (a different value that
      // wouldn't resolve, forcing the own-book fallback).
      const charId = cardCharacterId()
      const own = useLorebookStore.getState().library.find((w) => w.id === charId)
      return { primary: own?.name || charId || null, additional: [] }
    },
    regexes: () =>
      useRegexStore.getState().rules.map((r: any) => ({ find: r.source, replace: r.replace })),
    // Best-effort: map the renderer's active (display) rules to TavernRegex. Inline cards rarely read the
    // full regex set; the workshop (which does) runs in the WCV transport with the scope-aware host.
    regexesFull: () => useRegexStore.getState().rules.map((r: any) => storeRuleToTavernRegex(r)),
    isCharacterRegexesEnabled: () => true,
    formatRegex: (t) => useRegexStore.getState().apply(t),
    personaName: () => useSettingsStore.getState().settings?.persona?.name || 'User',
    // {{persona}} is UNGATED in ST: the macro returns the bio even when prompt injection is off —
    // only the prompt INJECTION respects the inject toggle (handled in promptBuilder). See docs/rpt-api.md.
    personaDescription: () => useSettingsStore.getState().settings?.persona?.description || '',
    currentChatId: () => ctx.chatId,
    getScriptVars: () => loadScriptVars(),
    getChatVars: () => loadChatVars(),
    // The latest floor's top-level variables minus the MVU message-scope keys — the ST-Prompt-Template
    // "local variable" bag the runtime layers UNDER the per-chat KV for chat-scope reads (see
    // VarsHost.getFloorVars). Read live from the chat store (no cache): a lorebook EJS entry writes these
    // during the turn, so a memoized seed would go stale mid-session. Same pure helper as the WCV host.
    getFloorVars: () => floorLocalVars(latestVars()),

    applyVariableOps: async (ops: VarOp[]) => {
      await useChatStore.getState().applyVariableOps(ctx.profileId, ops as any, floorIndex())
    },
    setVariables: async (sd: any) => {
      // express a whole replace via applyVariableOps in the core; here just persist the given object
      await useChatStore
        .getState()
        .applyVariableOps(
          ctx.profileId,
          Object.entries(sd || {}).map(([k, v]) => ({ op: 'set', path: '/' + k, value: v })) as any,
          floorIndex()
        )
    },
    generate: async (input: string) => {
      // 'script': a card-initiated turn — refused while any turn is in flight, and preempted by
      // the player's own send (player priority in generationService.generate).
      const r: any = await window.api.generate(ctx.profileId, ctx.chatId, input, 'script')
      if (r && typeof r !== 'string' && ctx.chatId === useChatStore.getState().activeChatId) {
        useChatStore.setState((s) => ({ floors: [...s.floors, r] }))
      }
      return typeof r === 'string' ? r : { content: r?.response?.content ?? '' }
    },
    generateRaw: async (cfg) => {
      const r: any = await window.api.generateRaw(ctx.profileId, ctx.chatId, cfg)
      return typeof r === 'string' ? r : (r?.response?.content ?? '')
    },
    getWorldbook: async () => {
      const lb = await fetchWb()
      const entries = Array.isArray(lb?.entries) ? lb.entries : Array.isArray(lb) ? lb : []
      return { name: lb?.name, entries }
    },
    saveWorldbook: async (_name, entries) => {
      const lb = (await fetchWb()) || { name: '', entries: [] }
      const next = Array.isArray(entries) ? { ...lb, entries } : entries
      try {
        await window.api.saveLorebook(ctx.profileId, cardCharacterId(), next)
      } catch (e) {
        console.error('[inline saveWorldbook]', e)
      }
    },
    // Card regex-write is a WCV-transport capability (the workshop runs there). Inline cards don't get a
    // store-write path here — a documented best-effort no-op, like createChat below.
    replaceRegexes: async () => {
      console.warn(
        '[inline host] replaceTavernRegexes is a WCV-transport capability; ignored inline'
      )
    },
    // Script action buttons are a card-scripts (WCV) feature; inline MESSAGE cards don't register them.
    setButtons: () => {},
    setScriptVars: async (vars: Record<string, any>) => {
      const owner = scriptVarOwner()
      const next = vars || {}
      // Diff against the persisted state (seed it if the card writes before it ever read) so keys the card
      // dropped are removed, then write-through the memoized cache.
      const prevKeys = Object.keys(loadScriptVars())
      scriptVarCache = next
      try {
        for (const k of Object.keys(next)) {
          await window.api.pluginStorage(ctx.profileId, owner, {
            op: 'set',
            key: k,
            value: next[k]
          })
        }
        for (const k of prevKeys) {
          if (!(k in next))
            await window.api.pluginStorage(ctx.profileId, owner, { op: 'remove', key: k })
        }
      } catch (e) {
        console.error('[inline setScriptVars]', e)
      }
    },
    setChatVars: async (vars: Record<string, any>) => {
      const next = vars && typeof vars === 'object' ? vars : {}
      chatVarCache = next
      try {
        if (ctx.chatId) await window.api.chatCardVarsSet(ctx.profileId, ctx.chatId, next)
      } catch (e) {
        console.error('[inline setChatVars]', e)
      }
    },
    // Worldbook CRUD/bind — full library via window.api + the lorebook store (sync getters read the store).
    listWorldbooks: () => useLorebookStore.getState().library,
    chatWorldbookIds: () => {
      const own = cardCharacterId()
      return useLorebookStore.getState().sessionIds ?? (own ? [own] : [])
    },
    createWorldbook: async (name: string) => {
      const summary = await window.api.createLorebook(
        ctx.profileId,
        String(name ?? 'New Worldbook')
      )
      await useLorebookStore.getState().loadLibrary(ctx.profileId)
      return summary?.id ?? ''
    },
    deleteWorldbook: async (id: string) => {
      try {
        await window.api.deleteLorebook(ctx.profileId, id)
        await useLorebookStore.getState().loadLibrary(ctx.profileId)
        return true
      } catch {
        return false
      }
    },
    getWorldbookById: async (id: string) => {
      const lb = await window.api.getLorebook(ctx.profileId, id)
      return { name: lb?.name, entries: Array.isArray(lb?.entries) ? lb.entries : [] }
    },
    saveWorldbookById: async (id: string, entries: any[]) => {
      const lb = (await window.api.getLorebook(ctx.profileId, id)) || { name: '', entries: [] }
      const next = Array.isArray(entries) ? { ...lb, entries } : entries
      await window.api.saveLorebook(ctx.profileId, id, next)
    },
    bindWorldbook: async (id: string, on: boolean) => {
      const own = cardCharacterId()
      const cur = useLorebookStore.getState().sessionIds ?? (own ? [own] : [])
      const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)
      await useLorebookStore.getState().setSession(ctx.profileId, ctx.chatId, next)
    },
    setChatMessages: async (m) => {
      const ok = await window.api.setChatMessages(ctx.profileId, ctx.chatId, m)
      if (ok) await reloadFloors()
      return !!ok
    },
    deleteChatMessages: async (ids) => {
      const ok = await window.api.deleteChatMessages(ctx.profileId, ctx.chatId, ids)
      if (ok) await reloadFloors()
      return !!ok
    },
    createChat: async () => '', // deferred (real chat-create + auto-switch is a UX decision)
    saveChat: async (chat) => {
      const ok = await window.api.saveChat(ctx.profileId, ctx.chatId, chat)
      if (ok) await reloadFloors()
      return !!ok
    },
    reloadChat: async () => reloadFloors(),
    // "Press the send button" (/trigger): the Composer submits the current box content through its
    // normal path (slash handling, pending-message display, generation). Refused mid-turn like ST.
    submitInput: () => {
      if (useChatStore.getState().isGenerating) return
      useComposerStore.getState().requestSubmit()
    },
    setInput: (text) => {
      useComposerStore.getState().injectInput(String(text ?? ''))
    },
    // Global (per-profile) variables for triggerSlash's /setglobalvar / /getglobalvar — the same
    // template-globals store the renderer's chat-input slash uses (pluginVars global scope).
    getGlobalVars: async () => {
      try {
        return (await window.api.pluginGetVars(ctx.profileId, ctx.chatId))?.global || {}
      } catch {
        return {}
      }
    },
    setGlobalVar: async (key, value) => {
      await window.api.pluginVars(ctx.profileId, ctx.chatId, {
        op: 'set',
        scope: 'global',
        key,
        value
      })
      // Per-key write bypassed the shared whole-object bag — drop it so the next read re-seeds from disk.
      globalVarCaches.delete(ctx.profileId)
    },
    // Whole-object global vars (getVariables/replaceVariables({type:'global'})). Sync read off the
    // shared cache; write-through the whole bag to the shared cache (so every open card sees it at once),
    // persist, then signal the Variables panel to re-read now that disk is written.
    getGlobalVarsSync: () => loadGlobalVars(),
    setGlobalVars: async (vars) => {
      const next = vars && typeof vars === 'object' ? vars : {}
      globalVarCaches.set(ctx.profileId, next)
      try {
        await window.api.pluginGlobalsSet(ctx.profileId, next)
        window.dispatchEvent(
          new CustomEvent(GLOBALS_REFETCH_EVENT, { detail: { profileId: ctx.profileId } })
        )
      } catch (e) {
        console.error('[inline setGlobalVars]', e)
      }
    },
    // TavernHelper extensionSettings durable backing (issue 19) — a per-profile store distinct from the
    // card KV scopes. SYNC read at boot; whole-object write is what saveSettingsDebounced flushes.
    // Returns the saved bag ({} when the store is genuinely empty). On a transient IPC failure it returns
    // `undefined` — NOT `{}` — so the shared runtime can tell "read failed" from "empty" and refuse to flush
    // an unloaded bag over valid stored settings (the hydration gate in thRuntime/index.ts).
    getExtensionSettingsSync: () => {
      try {
        return window.api.extensionSettingsGetSync(ctx.profileId) || {}
      } catch {
        return undefined
      }
    },
    setExtensionSettings: async (settings) => {
      try {
        await window.api.extensionSettingsSet(
          ctx.profileId,
          settings && typeof settings === 'object' ? settings : {}
        )
      } catch (e) {
        console.error('[inline setExtensionSettings]', e)
      }
    },
    // Resolve an asset to an rptasset:// URL for this card's world, or null. The category is inferred
    // from the asset TYPE via the shared categoryForType (头像/立绘/相册 → character, 背景/全景 → location,
    // CG → cg), so location art and cutscene CGs resolve too — the card seam carries no category. Unknown
    // types fall back to character. Kept at parity with the WCV path (worldAssetService.assetUrlForWorld).
    assetUrl: async (name: string, type: string, mood?: string) => {
      try {
        const own = cardCharacterId()
        const ids = useLorebookStore.getState().sessionIds ?? (own ? [own] : [])
        const category = categoryForType(type as AssetType)
        const local = await window.api.assetUrl(ctx.profileId, ids, category, name, type, mood)
        return localFirstRemoteAssetUrl(local, type, () =>
          window.api.remoteAssetUrl(ctx.profileId, ctx.chatId, name)
        )
      } catch {
        return null
      }
    },
    sceneAssetUrl: async (location: string, type: '全景' | '背景') => {
      try {
        const own = cardCharacterId()
        const ids = useLorebookStore.getState().sessionIds ?? (own ? [own] : [])
        return await window.api.sceneAssetUrl(ctx.profileId, ids, location, type)
      } catch {
        return null
      }
    },
    // Enumerate one entry's variants for this card's world (WA-3). Resolves the session lorebook ids the
    // same way assetUrl does; main applies the id precedence + category inference. Empty array on error.
    assetList: async (name: string, type: string) => {
      try {
        const own = cardCharacterId()
        const ids = useLorebookStore.getState().sessionIds ?? (own ? [own] : [])
        return await window.api.assetList(ctx.profileId, ids, name, type)
      } catch {
        return []
      }
    },
    // Picker-backed import (WA-3): resolves the session lorebook ids like assetUrl/assetList (the write
    // target is the primary id); main opens the OS image picker, copies the pick into the world, and
    // returns the new rptasset:// URL (null on cancel/invalid). Kept at parity with the WCV path.
    requestAssetImport: async (arg: { name: string; type: string; variant?: string }) => {
      try {
        const own = cardCharacterId()
        const ids = useLorebookStore.getState().sessionIds ?? (own ? [own] : [])
        return await window.api.assetImportForCard(
          ctx.profileId,
          ids,
          arg.name,
          arg.type,
          arg.variant
        )
      } catch {
        return null
      }
    },
    getDuelPreview: async () => {
      try {
        return await window.api.duelPreview(ctx.profileId, ctx.chatId, cardCharacterId())
      } catch {
        return null
      }
    },
    // --- DisplayHost (ADR 0023) ---
    // Inline (non-WCV) DisplayHost parity is a NON-GOAL for v1 (docs/display-host-design.md §3.2): an
    // inline card already renders inside the native transcript, and a card that OWNS the transcript is
    // a WCV cartridge by definition. Inert stubs keep the flat Host intersection satisfied.
    renderFloors: async () => [],
    displayRevision: () => 0,
    setDisplayStreamEnabled: async () => {},
    // Overlay surfaces (PM-A7): the same app mechanism as the WCV transport. Inline cards pass their
    // ctx explicitly (main resolves the WCV transport's ctx from e.sender instead); main validates the
    // id against the active card's panel_ui.overlays and mounts/closes the overlay WCV over the play area.
    requestOverlay: async (id: string) => {
      try {
        return await window.api.requestOverlay(ctx.profileId, ctx.chatId, cardCharacterId(), id)
      } catch {
        return false
      }
    },
    closeOverlay: async () => {
      try {
        await window.api.closeOverlay()
      } catch {
        /* ignore */
      }
    },
    // Runtime theming (runtime-theme-api-design). Inline cards run in the renderer, so the Host applies
    // the override directly against the renderer authority (cardBridge/playTheme) — same code path the
    // WCV transport reaches via main. Returns the derive/AA verdict; getPlayThemeSync reads the resolved
    // effective tokens synchronously.
    setPlayTheme: async (theme, opts) => applyRuntimeTheme(theme, opts, ctx),
    getPlayThemeSync: () => getEffectivePlayTheme(),

    onVarsChanged: (cb) => {
      let last = ''
      let lastFloors: unknown = null
      return useChatStore.subscribe((state) => {
        // Floors are replaced immutably by every setter — same array ⇒ same latest variables.
        // Skips the per-fire stat_data serialization on streaming flushes (audit P1-2).
        if (state.floors === lastFloors) return
        lastFloors = state.floors
        const f = state.floors[state.floors.length - 1] as any
        const v = f?.variables ?? {}
        const sd = v && typeof v === 'object' && 'stat_data' in v ? v.stat_data : v
        const json = JSON.stringify(sd ?? null)
        if (json !== last) {
          last = json
          // Tag the origin so the runtime fires MVU events only for non-card-write changes (a card's own
          // write echoed back must not re-fire its events and loop — the WS-3 fix).
          cb(sd, { origin: state.lastVarsOrigin })
        }
      })
    },
    // Inline cards receive the host lifecycle/mutation/stream events App.tsx computes (parity with WCV's
    // wcv-event channel). The thRuntime feeds these into the card's bus + re-emits.
    onHostEvent: (cb) => onCardHostEvent(cb),
    evalTemplate: (tmpl) => evalTemplate(tmpl, buildRenderContext(latestVars())),
    evalTemplateError: (tmpl) => {
      const r = evalTemplateDetailed(tmpl, buildRenderContext(latestVars()))
      return r.error ?? null
    },
    // The full render context (with `enabled`, hoisted vars, etc.) — cards call prepareContext() and
    // expect a usable EJS context, not the raw input. Mirrors the old createCardBridge behavior.
    prepareContext: () => buildRenderContext(latestVars())
  }
}
