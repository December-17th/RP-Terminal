// src/renderer/src/cardBridge/host.ts
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useComposerStore } from '../stores/composerStore'
import { useLorebookStore } from '../stores/lorebookStore'
import { evalTemplate, evalTemplateDetailed } from '../../../shared/templateEngine'
import { buildRenderContext } from '../plugin/renderTemplate'
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
  const fetchWb = async (): Promise<any> => {
    try {
      return await window.api.getLorebook(ctx.profileId, ctx.characterId)
    } catch {
      return { entries: [] }
    }
  }
  // After a chat-write, reload the card's chat floors so the edit/delete/save shows. The inline card is in
  // the active chat (the renderer IS the host), so a full reload (WCV parity) is fine — these ops are rare.
  const reloadFloors = async (): Promise<boolean> => {
    if (useChatStore.getState().activeChatId === ctx.chatId) {
      await useChatStore.getState().setActiveChat(ctx.profileId, ctx.chatId)
    }
    return true
  }
  // Seed the lorebook store so the SYNC worldbook getters (listWorldbooks/chatWorldbookIds) have data even
  // if the UI hasn't opened the lorebook panel. Fire-and-forget; resolveWbId refreshes on a later miss.
  void useLorebookStore.getState().loadLibrary(ctx.profileId)
  if (ctx.chatId) void useLorebookStore.getState().loadSession(ctx.profileId, ctx.chatId)
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
    worldbookNames: () => ({
      primary: useCharacterStore.getState().activeCharacter?.card?.data?.name || null,
      additional: []
    }),
    regexes: () =>
      useRegexStore.getState().rules.map((r: any) => ({ find: r.source, replace: r.replace })),
    formatRegex: (t) => useRegexStore.getState().apply(t),
    personaName: () => useSettingsStore.getState().settings?.persona?.name || 'User',

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
      const r: any = await window.api.generate(ctx.profileId, ctx.chatId, input)
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
        await window.api.saveLorebook(ctx.profileId, ctx.characterId, next)
      } catch (e) {
        console.error('[inline saveWorldbook]', e)
      }
    },
    // Worldbook CRUD/bind — full library via window.api + the lorebook store (sync getters read the store).
    listWorldbooks: () => useLorebookStore.getState().library,
    chatWorldbookIds: () =>
      useLorebookStore.getState().sessionIds ?? (ctx.characterId ? [ctx.characterId] : []),
    createWorldbook: async (name: string) => {
      const summary = await window.api.createLorebook(ctx.profileId, String(name ?? 'New Worldbook'))
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
      const cur =
        useLorebookStore.getState().sessionIds ?? (ctx.characterId ? [ctx.characterId] : [])
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
    triggerSlash: async () => '', // deferred to SP3.2
    setInput: (text) => {
      useComposerStore.getState().injectInput(String(text ?? ''))
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
          cb(sd)
        }
      })
    },
    onHostEvent: () => () => {},
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
