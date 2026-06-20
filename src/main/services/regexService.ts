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
}

const regexDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'regex')

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

/** All normalized rules across every regex file in the profile. */
export const getAllRules = (profileId: string): RenderRegexRule[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const out: RenderRegexRule[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json')) continue
    for (const raw of rulesInFile(path.join(dir, file))) out.push(normalizeRule(raw))
  }
  return out
}

/** Rules that transform the AI response for *display* (placement 2, not prompt-only). */
export const getRenderRules = (profileId: string): RenderRegexRule[] =>
  getAllRules(profileId).filter(
    (r) => !r.disabled && !r.promptOnly && (r.placement.length === 0 || r.placement.includes(2))
  )

/** Rules that transform text on its way *into the prompt* (everything not display-only). */
export const getPromptRules = (profileId: string): RenderRegexRule[] =>
  getAllRules(profileId).filter((r) => !r.disabled && !r.markdownOnly)

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
  return listFilesSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const rules = rulesInFile(path.join(dir, file))
      return {
        file,
        scriptName: rules[0]?.scriptName || rules[0]?.name || file.replace(/\.json$/, ''),
        ruleCount: rules.length
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
export const saveRegexScript = (profileId: string, data: any): string | null => {
  const rules = Array.isArray(data) ? data : [data]
  if (rules.length === 0 || !rules.some((r) => r && typeof r === 'object')) return null
  ensureDir(regexDir(profileId))
  const dest = path.join(regexDir(profileId), `${randomUUID()}.json`)
  fs.writeFileSync(dest, JSON.stringify(rules, null, 2), 'utf-8')
  return rules[0]?.scriptName || rules[0]?.name || 'Imported regex'
}

export const deleteScript = (profileId: string, file: string): void => {
  if (isUnsafe(file)) return
  const p = path.join(regexDir(profileId), file)
  if (fs.existsSync(p)) fs.unlinkSync(p)
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
