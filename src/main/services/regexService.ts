import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { applyRegexRules, RegexApplyContext } from '../../shared/regexTransform'

/** A regex rule flattened to a form the renderer can compile and apply. */
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
  /** Substrings removed from each match before `{{match}}` is substituted. */
  trimStrings: string[]
}

export interface RegexScriptInfo {
  file: string
  scriptName: string
  ruleCount: number
  scope: ArtifactScope
  owner?: string
}

const regexDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'regex')

/**
 * Artifact scope (Track S, §6). A script is active for a given turn when its scope
 * matches the active context:
 *  • global  — every session (the legacy/default behavior for profile-wide regex).
 *  • world   — bound to a card (owner = character id); active when that world loads.
 *  • session — bound to one chat (owner = chat id).
 * Bundled regex from a World Card defaults to `world`, owned by the imported card, so
 * it lights up only for that world instead of polluting every session.
 */
export type ArtifactScope = 'global' | 'world' | 'session'
export interface ScopeContext {
  cardId?: string | null
  chatId?: string | null
}
export interface ScopeMeta {
  scope: ArtifactScope
  owner?: string
}

// Scope lives in a sidecar (`_meta.json`: filename → {scope, owner}) so we never
// touch the ST regex-script format itself. Files with no entry are `global`.
const metaPath = (profileId: string): string => path.join(regexDir(profileId), '_meta.json')
const readMeta = (profileId: string): Record<string, ScopeMeta> =>
  readJsonSync<Record<string, ScopeMeta>>(metaPath(profileId)) || {}
const writeMeta = (profileId: string, meta: Record<string, ScopeMeta>): void =>
  writeJsonSyncAtomic(metaPath(profileId), meta)

/** Pure scope predicate — exported for unit testing the resolution rules. */
export const isScopeActive = (meta: ScopeMeta | undefined, ctx: ScopeContext): boolean => {
  const scope = meta?.scope ?? 'global'
  if (scope === 'world') return !!ctx.cardId && meta?.owner === ctx.cardId
  if (scope === 'session') return !!ctx.chatId && meta?.owner === ctx.chatId
  return true // global (and any unknown) is always active
}

export const getScriptScope = (profileId: string, file: string): ScopeMeta =>
  readMeta(profileId)[file] ?? { scope: 'global' }

/** Assign a script's scope (and owner for world/session). global clears the entry. */
export const setScriptScope = (
  profileId: string,
  file: string,
  scope: ArtifactScope,
  owner?: string
): void => {
  if (isUnsafe(file)) return
  const meta = readMeta(profileId)
  if (scope === 'global') delete meta[file]
  else meta[file] = { scope, owner }
  writeMeta(profileId, meta)
}

/** SillyTavern stores findRegex as `/pattern/flags`; split it (default flag g). */
const parseFind = (raw: string): { source: string; flags: string } => {
  if (typeof raw === 'string' && raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const last = raw.lastIndexOf('/')
    return { source: raw.slice(1, last), flags: raw.slice(last + 1) || 'g' }
  }
  return { source: raw || '', flags: 'g' }
}

const normalizeRule = (r: any): RenderRegexRule => {
  const { source, flags } = parseFind(r.findRegex ?? r.regex ?? '')
  const placement = Array.isArray(r.placement)
    ? r.placement.map((p: any) => Number(p)).filter((n: number) => !Number.isNaN(n))
    : []
  return {
    id: r.id || randomUUID(),
    scriptName: r.scriptName || r.name || 'Unnamed script',
    source,
    flags,
    replace: r.replaceString ?? '',
    placement,
    disabled: r.disabled === true,
    markdownOnly: r.markdownOnly === true,
    promptOnly: r.promptOnly === true,
    trimStrings: Array.isArray(r.trimStrings)
      ? r.trimStrings.filter((s: any) => typeof s === 'string')
      : []
  }
}

const rulesInFile = (filePath: string): any[] => {
  const data = readJsonSync<any>(filePath)
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

/**
 * All normalized rules across the profile's regex files. When `ctx` is given, only
 * scripts whose scope is active for that context (global ⊕ world(card) ⊕ session(chat))
 * are included; with no `ctx` every script is returned (e.g. the manager listing).
 */
export const getAllRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const meta = ctx ? readMeta(profileId) : null
  const out: RenderRegexRule[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue // _meta.json is the sidecar
    if (meta && !isScopeActive(meta[file], ctx!)) continue
    for (const raw of rulesInFile(path.join(dir, file))) out.push(normalizeRule(raw))
  }
  return out
}

/** Rules that transform the AI response for *display* (placement 2, not prompt-only). */
export const getRenderRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] =>
  getAllRules(profileId, ctx).filter(
    (r) => !r.disabled && !r.promptOnly && (r.placement.length === 0 || r.placement.includes(2))
  )

/** Rules that transform text on its way *into the prompt* (everything not display-only). */
export const getPromptRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] =>
  getAllRules(profileId, ctx).filter((r) => !r.disabled && !r.markdownOnly)

/**
 * Apply regex rules to a single string for a given placement (1 = user input,
 * 2 = AI output). Rules with an empty placement list apply everywhere. The
 * replacement transform (trimStrings + macros + capture groups) is shared with the
 * renderer's display applier via `src/shared/regexTransform`.
 */
export const applyRegex = (
  text: string,
  rules: RenderRegexRule[],
  placement: number,
  ctx: RegexApplyContext = {}
): string => applyRegexRules(text, rules, ctx, { placement })

export const listScripts = (profileId: string): RegexScriptInfo[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const meta = readMeta(profileId)
  return listFilesSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((file) => {
      const rules = rulesInFile(path.join(dir, file))
      const m = meta[file]
      return {
        file,
        scriptName: rules[0]?.scriptName || rules[0]?.name || file.replace(/\.json$/, ''),
        ruleCount: rules.length,
        scope: m?.scope ?? 'global',
        owner: m?.owner
      }
    })
}

/** Copy an imported ST regex file into the profile's regex dir. Returns its name. */
export const importRegexFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return saveRegexScript(profileId, data)
  } catch (error) {
    console.error('Failed to import regex:', error)
    return null
  }
}

/**
 * Persist in-memory ST regex rule object(s) as a new script file in the profile's
 * regex dir — used by the World Card one-click importer to route bundled
 * `extensions.regex_scripts` / `rp_terminal.regex` into the regex store. Accepts
 * a single rule object or an array; returns the script name (or null on empty).
 */
export const saveRegexScript = (
  profileId: string,
  data: any,
  scope: ArtifactScope = 'global',
  owner?: string
): string | null => {
  const rules = Array.isArray(data) ? data : [data]
  if (rules.length === 0 || !rules.some((r) => r && typeof r === 'object')) return null
  ensureDir(regexDir(profileId))
  const fileName = `${randomUUID()}.json`
  fs.writeFileSync(path.join(regexDir(profileId), fileName), JSON.stringify(rules, null, 2), 'utf-8')
  if (scope !== 'global') setScriptScope(profileId, fileName, scope, owner)
  return rules[0]?.scriptName || rules[0]?.name || 'Imported regex'
}

export const deleteScript = (profileId: string, file: string): void => {
  if (isUnsafe(file)) return
  const p = path.join(regexDir(profileId), file)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  // Drop any scope entry so the sidecar doesn't accumulate orphans.
  const meta = readMeta(profileId)
  if (meta[file]) {
    delete meta[file]
    writeMeta(profileId, meta)
  }
}

/** Guard against path traversal — only operate on a plain filename in the regex dir. */
const isUnsafe = (file: string): boolean =>
  file.includes('/') || file.includes('\\') || file.includes('..')

export interface RegexRuleDetail extends RenderRegexRule {
  file: string
  index: number
}

/** The rules in one script file, each tagged with its file + index for editing. */
export const getScriptRules = (profileId: string, file: string): RegexRuleDetail[] => {
  if (isUnsafe(file)) return []
  return rulesInFile(path.join(regexDir(profileId), file)).map((r, index) => ({
    ...normalizeRule(r),
    file,
    index
  }))
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

/** Edit one rule in place (enable/disable, find/flags, replacement, scope), preserving
 * the file's original shape and any ST fields we don't manage. */
export const updateRule = (
  profileId: string,
  file: string,
  index: number,
  patch: RegexRulePatch
): void => {
  if (isUnsafe(file)) return
  const p = path.join(regexDir(profileId), file)
  const data = readJsonSync<any>(p)
  if (!data) return
  const arr = Array.isArray(data) ? data : [data]
  const rule = arr[index]
  if (!rule || typeof rule !== 'object') return

  if (patch.source !== undefined || patch.flags !== undefined) {
    const cur = parseFind(rule.findRegex ?? rule.regex ?? '')
    rule.findRegex = `/${patch.source ?? cur.source}/${patch.flags ?? cur.flags}`
    delete rule.regex // normalize onto findRegex
  }
  if (patch.replace !== undefined) rule.replaceString = patch.replace
  if (patch.disabled !== undefined) rule.disabled = patch.disabled
  if (patch.markdownOnly !== undefined) rule.markdownOnly = patch.markdownOnly
  if (patch.promptOnly !== undefined) rule.promptOnly = patch.promptOnly
  if (patch.trimStrings !== undefined) rule.trimStrings = patch.trimStrings

  writeJsonSyncAtomic(p, Array.isArray(data) ? arr : arr[0])
}
