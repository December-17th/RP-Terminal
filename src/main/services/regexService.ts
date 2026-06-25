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
import { log } from './logService'
import { applyRegexRules, RegexApplyContext } from '../../shared/regexTransform'
import {
  storeRuleToTavernRegex,
  tavernRegexToStoreObject,
  type TavernRegex
} from '../../shared/thRuntime/tavernRegex'
import { ArtifactScope, ScopeContext, ScopeMeta, isScopeActive } from '../../shared/artifactScope'
import {
  RenderRegexRule,
  RegexScriptInfo,
  RegexRuleDetail,
  RegexRulePatch
} from '../../shared/regexTypes'
import {
  readScopeMeta,
  getScopeMeta,
  setScope,
  setDisabled,
  setRenderMode,
  removeScopeEntry
} from './scopeMeta'
import type { CardRenderMode } from '../../shared/cardRenderMode'

// Re-export the shared types + predicate so existing importers (tests, the renderer store)
// keep their import path while src/shared is the single source of truth.
export { isScopeActive }
export type {
  ArtifactScope,
  ScopeContext,
  ScopeMeta,
  RenderRegexRule,
  RegexScriptInfo,
  RegexRuleDetail,
  RegexRulePatch
}

const regexDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'regex')

// Scope/owner/disabled live in a `_meta.json` sidecar (shared scopeMeta helper) so we
// never touch the ST regex-script format itself. Files with no entry are `global`.
const readMeta = (profileId: string): Record<string, ScopeMeta> =>
  readScopeMeta(regexDir(profileId))

export const getScriptScope = (profileId: string, file: string): ScopeMeta =>
  getScopeMeta(regexDir(profileId), file)

/** Assign a regex script's scope (and owner for world/session), preserving its disabled flag. */
export const setScriptScope = (
  profileId: string,
  file: string,
  scope: ArtifactScope,
  owner?: string
): void => {
  if (isUnsafe(file)) return
  setScope(regexDir(profileId), file, scope, owner)
}

/** Enable/disable a whole regex script (independent of its scope). */
export const setScriptDisabled = (profileId: string, file: string, disabled: boolean): void => {
  if (isUnsafe(file)) return
  setDisabled(regexDir(profileId), file, disabled)
}

/** Set/clear a regex script's per-card render-mode override (null = follow global default). */
export const setScriptRenderMode = (
  profileId: string,
  file: string,
  renderMode: CardRenderMode | null
): void => {
  if (isUnsafe(file)) return
  setRenderMode(regexDir(profileId), file, renderMode)
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
  const meta = readMeta(profileId)
  const out: RenderRegexRule[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue // _meta.json is the sidecar
    if (meta[file]?.disabled) continue // a disabled script contributes nothing
    if (ctx && !isScopeActive(meta[file], ctx)) continue
    const mode = meta[file]?.renderMode
    for (const raw of rulesInFile(path.join(dir, file))) {
      const rule = normalizeRule(raw)
      if (mode) rule.renderMode = mode
      out.push(rule)
    }
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
 * Raw ST regex-script objects belonging to one world (scope=world, owner=cardId), in
 * their original on-disk shape — used by World Card export to repopulate the canonical
 * `extensions.regex_scripts`. Round-trips with the importer (which reads that key).
 */
export const getRawScriptsForExport = (profileId: string, cardId: string): any[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const meta = readMeta(profileId)
  const out: any[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const m = meta[file]
    if (m?.scope === 'world' && m.owner === cardId) {
      for (const raw of rulesInFile(path.join(dir, file))) out.push(raw)
    }
  }
  return out
}

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
        owner: m?.owner,
        disabled: m?.disabled === true,
        renderMode: m?.renderMode
      }
    })
}

/** Copy an imported ST regex file into the profile's regex dir. Returns its name. */
export const importRegexFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return saveRegexScript(profileId, data)
  } catch (error) {
    log('error', 'Failed to import regex:', error)
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
  fs.writeFileSync(
    path.join(regexDir(profileId), fileName),
    JSON.stringify(rules, null, 2),
    'utf-8'
  )
  if (scope !== 'global') setScriptScope(profileId, fileName, scope, owner)
  return rules[0]?.scriptName || rules[0]?.name || 'Imported regex'
}

export const deleteScript = (profileId: string, file: string): void => {
  if (isUnsafe(file)) return
  const p = path.join(regexDir(profileId), file)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  removeScopeEntry(regexDir(profileId), file) // keep the sidecar free of orphans
}

/**
 * Delete every regex script bound to a given scope+owner (e.g. all `preset`-scoped
 * scripts a preset bundled), so deleting that owner doesn't leave orphans. Returns
 * the number removed.
 */
export const deleteScriptsByOwner = (
  profileId: string,
  scope: ArtifactScope,
  owner: string
): number => {
  let removed = 0
  for (const s of listScripts(profileId)) {
    if (s.scope === scope && s.owner === owner) {
      deleteScript(profileId, s.file)
      removed++
    }
  }
  return removed
}

// --- TavernHelper regex bridge (getTavernRegexes / replaceTavernRegexes for card scripts) ---
//
// JSR's `getTavernRegexes({type})` / `replaceTavernRegexes(regexes, {type})` operate on a SCOPE:
// `character` ⇒ this card's world-scoped regexes (owner = cardId), `global` ⇒ global, `preset` ⇒ the
// active preset's. We map that onto the file+scope store, converting rule shapes via shared/thRuntime.

/** Every rule in the given scope (+owner for non-global), as TavernHelper `TavernRegex` objects. */
export const getTavernRegexesByScope = (
  profileId: string,
  scope: ArtifactScope,
  owner?: string
): TavernRegex[] => {
  const out: TavernRegex[] = []
  for (const s of listScripts(profileId)) {
    if ((s.scope ?? 'global') !== scope) continue
    if (scope !== 'global' && owner && s.owner !== owner) continue
    for (const r of getScriptRules(profileId, s.file)) out.push(storeRuleToTavernRegex(r))
  }
  return out
}

/**
 * Completely replace the regexes in a scope with `tavernRegexes` (TH `replaceTavernRegexes`): drop the
 * existing files for that scope (+owner), then persist the new set as one script file. Faithful to TH's
 * "replace everything"; for `character` scope this only touches the card's own bucket (owner = cardId).
 */
export const replaceTavernRegexes = (
  profileId: string,
  scope: ArtifactScope,
  owner: string | undefined,
  tavernRegexes: unknown[]
): void => {
  if (scope === 'global') {
    for (const s of listScripts(profileId)) {
      if ((s.scope ?? 'global') === 'global') deleteScript(profileId, s.file)
    }
  } else if (owner) {
    deleteScriptsByOwner(profileId, scope, owner)
  }
  const objs = (Array.isArray(tavernRegexes) ? tavernRegexes : []).map(tavernRegexToStoreObject)
  if (objs.length) saveRegexScript(profileId, objs, scope, owner)
}

/** Guard against path traversal — only operate on a plain filename in the regex dir. */
const isUnsafe = (file: string): boolean =>
  file.includes('/') || file.includes('\\') || file.includes('..')

/** The rules in one script file, each tagged with its file + index for editing. */
export const getScriptRules = (profileId: string, file: string): RegexRuleDetail[] => {
  if (isUnsafe(file)) return []
  return rulesInFile(path.join(regexDir(profileId), file)).map((r, index) => ({
    ...normalizeRule(r),
    file,
    index
  }))
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
