// src/renderer/src/cardBridge/host.ts
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useComposerStore } from '../stores/composerStore'
import { useLorebookStore } from '../stores/lorebookStore'
import { onCardHostEvent } from './cardHostEvents'
import { evalTemplate, evalTemplateDetailed } from '../../../shared/templateEngine'
import { buildRenderContext } from '../plugin/renderTemplate'
import { storeRuleToTavernRegex } from '../../../shared/thRuntime/tavernRegex'
import { categoryForType } from '../../../shared/worldAssets/types'
import type { AssetType } from '../../../shared/worldAssets/types'
import type { Host, CardCtx, FloorLike } from '../../../shared/thRuntime/types'
import type { VarOp } from '../../../shared/thRuntime/ops'

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
  // Script-scope vars (TH getVariables({type:'script'})) — a card-owned KV. getScriptVars must be SYNC, so
  // back it with a cache hydrated async from the same plugin-storage the WCV transport uses (owner card:<id>).
  const scriptVarOwner = (): string => 'card:' + cardCharacterId()
  let scriptVarCache: Record<string, any> = {}
  void window.api
    .pluginStorage(ctx.profileId, scriptVarOwner(), { op: 'all' })
    .then((all: any) => {
      scriptVarCache = all || {}
    })
    .catch(() => {})
  // Chat-scope vars (getVariables({type:'chat'})) — a per-chat card-owned KV. getChatVars must be SYNC, so
  // back it with a cache hydrated async from the same per-chat store the WCV transport reads.
  let chatVarCache: Record<string, any> = {}
  if (ctx.chatId)
    void window.api
      .chatCardVarsGet(ctx.profileId, ctx.chatId)
      .then((all: any) => {
        chatVarCache = all || {}
      })
      .catch(() => {})
  return {
    ctx,
    statData: () => statOf(),
    floors: () => floorsOf(),
    charData: () => cardOf(),
    charAvatarPath: () => null,
    preset: () => {
      const p = usePresetStore.getState().preset as any
      return p ? { name: p.name, parameters: p.parameters } : null
    },
    presetNames: () => usePresetStore.getState().presets.map((p: any) => p.name),
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
    currentChatId: () => ctx.chatId,
    getScriptVars: () => scriptVarCache,
    getChatVars: () => chatVarCache,

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
      const prevKeys = Object.keys(scriptVarCache)
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
        return await window.api.assetUrl(ctx.profileId, ids, category, name, type, mood)
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

    onVarsChanged: (cb) => {
      let last = ''
      return useChatStore.subscribe((state) => {
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
