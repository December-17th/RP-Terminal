import { create } from 'zustand'
import {
  applyRegexRules,
  isCardPayload,
  type RegexApplyContext
} from '../../../shared/regexTransform'
import type { ArtifactScope, ScopeContext } from '../../../shared/artifactScope'
import type { CardRenderMode } from '../../../shared/cardRenderMode'
import type {
  RenderRegexRule,
  RegexScriptInfo,
  RegexRuleDetail,
  RegexRulePatch
} from '../../../shared/regexTypes'

// Single source of truth is src/shared; re-export so components keep importing from the store.
export type { RegexApplyContext, ArtifactScope, ScopeContext }
export type { RenderRegexRule, RegexScriptInfo, RegexRuleDetail, RegexRulePatch }

interface RegexState {
  rules: RenderRegexRule[]
  /** Plot-recall (plot-block panel): display rules that ALSO admit placement 1 (user-input
   *  beautification), which `rules` (placement 2 / empty) drops. Applied to `FloorFile.plot_block`. */
  plotRules: RenderRegexRule[]
  /** Reasoning-panel display rules (ST placement 6). Applied to the extracted <think> text. */
  reasoningRules: RenderRegexRule[]
  scripts: RegexScriptInfo[]
  /** Display rules resolved for the active world/session (global ⊕ world ⊕ session). */
  load: (profileId: string, ctx?: ScopeContext) => Promise<void>
  loadScripts: (profileId: string) => Promise<void>
  importScripts: (profileId: string) => Promise<number>
  remove: (profileId: string, file: string) => Promise<void>
  setScope: (profileId: string, file: string, scope: ArtifactScope, owner?: string) => Promise<void>
  setDisabled: (profileId: string, file: string, disabled: boolean) => Promise<void>
  setRenderMode: (
    profileId: string,
    file: string,
    renderMode: CardRenderMode | null
  ) => Promise<void>
  updateRule: (
    profileId: string,
    file: string,
    index: number,
    patch: RegexRulePatch
  ) => Promise<void>
  /** Apply all enabled display rules to an AI response, returning transformed text. */
  apply: (content: string, ctx?: RegexApplyContext) => string
  /** Apply the plot-block display rules (placement 1 admitted) to a `plot_block` string. */
  applyPlot: (content: string, ctx?: RegexApplyContext) => string
  /** Apply the reasoning display rules (ST placement 6) to extracted <think> text. */
  applyReasoning: (content: string, ctx?: RegexApplyContext) => string
}

// Compiled-RegExp cache so we don't recompile every render.
const reCache = new Map<string, RegExp>()
const getRe = (rule: RenderRegexRule): RegExp => {
  const key = `${rule.id}|${rule.flags}|${rule.source}`
  let re = reCache.get(key)
  if (!re) {
    re = new RegExp(rule.source, rule.flags)
    reCache.set(key, re)
  }
  return re
}

const modeMarker = (rule: RenderRegexRule): string | undefined =>
  rule.renderMode && isCardPayload(rule.replace) ? `<!--rpt:mode=${rule.renderMode}-->` : undefined

// Remember the active world/session context so internal reloads (after edit/delete/
// scope change) keep resolving the same active set the chat is currently showing.
let lastCtx: ScopeContext | undefined

export const useRegexStore = create<RegexState>((set, get) => ({
  rules: [],
  plotRules: [],
  reasoningRules: [],
  scripts: [],

  load: async (profileId, ctx) => {
    if (ctx !== undefined) lastCtx = ctx
    // Resolve the display rules, the plot-block rules (placement 1 admitted), and the reasoning rules
    // (placement 6) for the same context in one pass, so all panels refresh alongside the chat on
    // scope/preset changes.
    const [rules, plotRules, reasoningRules] = await Promise.all([
      window.api.getRenderRegex(profileId, lastCtx),
      window.api.getPlotBlockRegex(profileId, lastCtx),
      window.api.getReasoningRegex(profileId, lastCtx)
    ])
    set({
      rules: rules || [],
      plotRules: plotRules || [],
      reasoningRules: reasoningRules || []
    })
  },

  loadScripts: async (profileId) => {
    const scripts = await window.api.listRegex(profileId)
    set({ scripts: scripts || [] })
  },

  importScripts: async (profileId) => {
    const count = await window.api.importRegexDialog(profileId)
    if (count) {
      await get().load(profileId)
      await get().loadScripts(profileId)
    }
    return count || 0
  },

  remove: async (profileId, file) => {
    await window.api.deleteRegex(profileId, file)
    await get().load(profileId)
    await get().loadScripts(profileId)
  },

  setScope: async (profileId, file, scope, owner) => {
    await window.api.setRegexScope(profileId, file, scope, owner)
    await get().load(profileId)
    await get().loadScripts(profileId)
  },

  setDisabled: async (profileId, file, disabled) => {
    await window.api.setRegexDisabled(profileId, file, disabled)
    await get().load(profileId)
    await get().loadScripts(profileId)
  },

  setRenderMode: async (profileId, file, renderMode) => {
    await window.api.setRegexRenderMode(profileId, file, renderMode)
    await get().load(profileId)
    await get().loadScripts(profileId)
  },

  updateRule: async (profileId, file, index, patch) => {
    await window.api.updateRegexRule(profileId, file, index, patch)
    // Refresh the compiled display rules so the chat re-renders with the change.
    await get().load(profileId)
  },

  // Display rules are pre-filtered (placement 2) by getRenderRegex, so no placement
  // filter here; pass the compiled-RegExp cache. Transform shared with the main path.
  // freezePayloads: a beautifier injects a large HTML card; freezing it stops a later cleanup rule
  // from rescanning the paste (catastrophic backtracking → multi-second main-thread stall). Display
  // path only — the prompt applier (regexService) never sets it, so prompts stay byte-identical.
  apply: (content, ctx) =>
    applyRegexRules(content, get().rules, ctx ?? {}, {
      compile: getRe,
      marker: modeMarker,
      freezePayloads: true
    }),

  // Plot-block rules are pre-filtered (placement 1 ⊕ 2) by getPlotBlockRegex; same transform/marker
  // as the display path so a beautification card payload emits its render-mode marker identically.
  // Same payload-freeze as `apply` (this is the path that froze the whole app on turn-settle — the
  // plot beautifier pastes ~148KB, then same-tier cleanups rescanned it; see PlotPanel).
  applyPlot: (content, ctx) =>
    applyRegexRules(content, get().plotRules, ctx ?? {}, {
      compile: getRe,
      marker: modeMarker,
      freezePayloads: true
    }),

  // Reasoning display rules (ST placement 6) applied to the extracted <think> text. Same shared
  // transform + payload-freeze as the other display paths so a reasoning-beautification card behaves
  // consistently. Identity when no placement-6 rule is active (the common case).
  applyReasoning: (content, ctx) =>
    applyRegexRules(content, get().reasoningRules, ctx ?? {}, {
      compile: getRe,
      marker: modeMarker,
      freezePayloads: true
    })
}))
