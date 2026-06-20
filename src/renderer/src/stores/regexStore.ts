import { create } from 'zustand'

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

export interface RegexScriptInfo {
  file: string
  scriptName: string
  ruleCount: number
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

export interface RegexApplyContext {
  user?: string
  char?: string
}

interface RegexState {
  rules: RenderRegexRule[]
  scripts: RegexScriptInfo[]
  load: (profileId: string) => Promise<void>
  loadScripts: (profileId: string) => Promise<void>
  importScripts: (profileId: string) => Promise<number>
  remove: (profileId: string, file: string) => Promise<void>
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

export const useRegexStore = create<RegexState>((set, get) => ({
  rules: [],
  scripts: [],

  load: async (profileId) => {
    const rules = await window.api.getRenderRegex(profileId)
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

  updateRule: async (profileId, file, index, patch) => {
    await window.api.updateRegexRule(profileId, file, index, patch)
    // Refresh the compiled display rules so the chat re-renders with the change.
    await get().load(profileId)
  },

  apply: (content, ctx) => {
    let out = content
    for (const rule of get().rules) {
      try {
        const re = getRe(rule)
        re.lastIndex = 0
        out = out.replace(re, (...args) => {
          // String.replace fn args: (match, p1..pN, offset, string [, namedGroups])
          const rest = [...args]
          if (typeof rest[rest.length - 1] === 'object') rest.pop() // drop named-groups obj
          rest.pop() // drop the whole `string`
          rest.pop() // drop `offset`
          const match: string = rest[0]
          const groups = rest.slice(1) as Array<string | undefined>

          // {{match}} = the match with trimStrings stripped out.
          let trimmed = match
          for (const t of rule.trimStrings) if (t) trimmed = trimmed.split(t).join('')

          return rule.replace
            .replace(/\{\{match\}\}/gi, trimmed)
            .replace(/\{\{user\}\}/gi, ctx?.user ?? '')
            .replace(/\{\{char\}\}/gi, ctx?.char ?? '')
            .replace(/\$&/g, match)
            .replace(/\$(\d{1,2})/g, (_, n) => groups[Number(n) - 1] ?? '')
            .replace(/\\n/g, '\n')
        })
      } catch {
        // skip a rule that fails to compile/apply
      }
    }
    return out
  }
}))
