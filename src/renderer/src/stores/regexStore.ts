import { create } from 'zustand'
import { applyRegexRules, type RegexApplyContext } from '../../../shared/regexTransform'

export type { RegexApplyContext }

export interface RenderRegexRule {
  id: string
  scriptName: string
  source: string
  flags: string
  replace: string
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  trimStrings: string[]
}

export type ArtifactScope = 'global' | 'world' | 'session'

export interface ScopeContext {
  cardId?: string | null
  chatId?: string | null
}

export interface RegexScriptInfo {
  file: string
  scriptName: string
  ruleCount: number
  scope: ArtifactScope
  owner?: string
}

export interface RegexRuleDetail extends RenderRegexRule {
  file: string
  index: number
}

export interface RegexRulePatch {
  source?: string
  flags?: string
  replace?: string
  disabled?: boolean
  markdownOnly?: boolean
  promptOnly?: boolean
  trimStrings?: string[]
}

interface RegexState {
  rules: RenderRegexRule[]
  scripts: RegexScriptInfo[]
  /** Display rules resolved for the active world/session (global ⊕ world ⊕ session). */
  load: (profileId: string, ctx?: ScopeContext) => Promise<void>
  loadScripts: (profileId: string) => Promise<void>
  importScripts: (profileId: string) => Promise<number>
  remove: (profileId: string, file: string) => Promise<void>
  setScope: (
    profileId: string,
    file: string,
    scope: ArtifactScope,
    owner?: string
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

  updateRule: async (profileId, file, index, patch) => {
    await window.api.updateRegexRule(profileId, file, index, patch)
    // Refresh the compiled display rules so the chat re-renders with the change.
    await get().load(profileId)
  },

  // Display rules are pre-filtered (placement 2) by getRenderRegex, so no placement
  // filter here; pass the compiled-RegExp cache. Transform shared with the main path.
  apply: (content, ctx) => applyRegexRules(content, get().rules, ctx ?? {}, { compile: getRe })
}))
