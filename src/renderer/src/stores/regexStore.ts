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
  scripts: [],

  load: async (profileId, ctx) => {
    if (ctx !== undefined) lastCtx = ctx
    const rules = await window.api.getRenderRegex(profileId, lastCtx)
    set({ rules: rules || [] })
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
  apply: (content, ctx) =>
    applyRegexRules(content, get().rules, ctx ?? {}, { compile: getRe, marker: modeMarker })
}))
