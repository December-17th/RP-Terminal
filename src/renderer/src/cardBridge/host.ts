// src/renderer/src/cardBridge/host.ts
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
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
    setChatMessages: async () => false,
    deleteChatMessages: async () => false,
    createChat: async () => '',
    createChatMessages: async () => '',
    saveChat: async () => true,
    reloadChat: async () => true,
    triggerSlash: async () => '',
    setInput: () => {
      // inline cards don't drive onboarding; no-op for SP1 (see spec §6).
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
    }
  }
}
