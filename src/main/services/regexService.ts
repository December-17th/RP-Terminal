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
  RegexRulePatch,
  appliesToDisplay,
  appliesToPrompt,
  scriptRunsInPhase,
  REGEX_PLACEMENT
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
    // ST depth-scoping: carried through so prompt-time application can honor it (e.g. the
    // "keep only the latest user input → <|placeholder|>" rule has minDepth:1). number | null.
    minDepth: typeof r.minDepth === 'number' ? r.minDepth : null,
    maxDepth: typeof r.maxDepth === 'number' ? r.maxDepth : null,
    // ST substitute_find_regex (0 NONE / 1 RAW / 2 ESCAPED) + runOnEdit — carried so the shared
    // transform can honor find-macro expansion and edit gating (regexTransform).
    substituteRegex:
      typeof r.substituteRegex === 'number' ? r.substituteRegex : Number(r.substituteRegex) || 0,
    runOnEdit: r.runOnEdit === true,
    trimStrings: Array.isArray(r.trimStrings)
      ? r.trimStrings.filter((s: any) => typeof s === 'string')
      : [],
    // SPreset provenance (issue 16): a rule installed from `extensions.SPreset.RegexBinding.regexes[]`
    // is persisted with `rptOrigin:'spreset'` so it stays DISTINCT from core regex in attribution.
    ...(r.rptOrigin === 'spreset' ? { origin: 'spreset' as const } : {})
  }
}

const rulesInFile = (filePath: string): any[] => {
  const data = readJsonSync<any>(filePath)
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

/** SillyTavern's regex script priority (regex/engine.js SCRIPT_TYPES — "ORDER MATTERS"):
 *  GLOBAL → PRESET → SCOPED (character). Our world/session scopes are the SCOPED tier.
 *  Application order is part of the card contract: cards chain cleanup (global/preset)
 *  BEFORE beautification (character/world), and a cleanup regex re-scanning a
 *  beautification rule's huge HTML paste can stall a render for tens of seconds. */
const SCOPE_TIER: Record<ArtifactScope, number> = { global: 0, preset: 1, world: 2, session: 3 }

/**
 * Regex tier ORDERING MODE (issue 16 / SPreset RegexBinding). Selecting a mode is how RPT honors
 * SPreset's tier reorder — an explicit ordering choice, NOT the upstream `Object.values` monkeypatch.
 *  - `st-default` (RPT's standing order): global → preset → world → session.
 *  - `preset-first` (SPreset RegexBinding default `[2,0,1]`): preset → global → world → session
 *    (spec §RegexBinding). RPT's scoped tier (world/session ≈ character) follows the two ST tiers.
 */
export type RegexTierOrder = 'st-default' | 'preset-first'
const TIER_ORDERS: Record<RegexTierOrder, Record<ArtifactScope, number>> = {
  'st-default': SCOPE_TIER,
  'preset-first': { preset: 0, global: 1, world: 2, session: 3 }
}
const scopeTier = (m: ScopeMeta | undefined, order: Record<ArtifactScope, number>): number =>
  order[m?.scope ?? 'global'] ?? 0 // ?? 0: corrupt sidecar scope

/**
 * All normalized rules across the profile's regex files, in ST APPLICATION order:
 * scope tier (global → preset → world → session), file order within a tier. When `ctx`
 * is given, only scripts whose scope is active for that context (global ⊕ world(card) ⊕
 * session(chat)) are included; with no `ctx` every script is returned (e.g. the manager listing).
 *
 * `order` selects the tier ordering mode (issue 16): default `st-default`; `preset-first` runs
 * preset-bound regex ahead of global/character when a preset's SPreset RegexBinding is active.
 */
export const getAllRules = (
  profileId: string,
  ctx?: ScopeContext,
  order: RegexTierOrder = 'st-default'
): RenderRegexRule[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const meta = readMeta(profileId)
  const tierOrder = TIER_ORDERS[order] ?? SCOPE_TIER
  const out: RenderRegexRule[] = []
  const files = listFilesSync(dir)
    .filter((file) => file.endsWith('.json') && !file.startsWith('_')) // _meta.json is the sidecar
    .sort((a, b) => scopeTier(meta[a], tierOrder) - scopeTier(meta[b], tierOrder)) // stable: file order within a tier
  for (const file of files) {
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

/** Rules that transform the AI response for *display* (placement 2, display destination enabled).
 *  A rule the user PROMOTED to a panel (renderMode 'panel') still runs inline but STRIPS its match
 *  (replace → '') — the UI moves to a docked panel, so the message shouldn't show its marker or the
 *  inline frame. */
export const getRenderRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] =>
  getAllRules(profileId, ctx)
    .filter(
      (r) => !r.disabled && appliesToDisplay(r) && (r.placement.length === 0 || r.placement.includes(2))
    )
    .map((r) => (r.renderMode === 'panel' ? { ...r, replace: '' } : r))

/** Display rules for the plot-recall PLOT BLOCK panel (data layer: `FloorFile.plot_block`). The block
 *  carries the recall planner's USER-INPUT beautification, whose regex is placement 1 — which
 *  getRenderRules deliberately drops (it keeps only placement 2 / empty, the AI-output destination).
 *  So this selector is getRenderRules with placement 1 ALSO admitted: enabled display rules (same
 *  `appliesToDisplay` filter) whose placement includes 1 OR 2 (empty = applies everywhere). A
 *  'panel'-promoted rule still strips its match, matching the display path. */
export const getPlotBlockRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] =>
  getAllRules(profileId, ctx)
    .filter(
      (r) =>
        !r.disabled &&
        appliesToDisplay(r) &&
        (r.placement.length === 0 || r.placement.includes(1) || r.placement.includes(2))
    )
    .map((r) => (r.renderMode === 'panel' ? { ...r, replace: '' } : r))

/** Rules that transform text on its way *into the prompt* (prompt destination enabled, not panel-promoted).
 *  `order` selects the tier ordering mode (issue 16 — `preset-first` for SPreset RegexBinding). */
export const getPromptRules = (
  profileId: string,
  ctx?: ScopeContext,
  order: RegexTierOrder = 'st-default'
): RenderRegexRule[] =>
  getAllRules(profileId, ctx, order).filter(
    (r) => !r.disabled && appliesToPrompt(r) && r.renderMode !== 'panel'
  )

/**
 * World Info regex (ST placement 5). WI content is generated FRESH each turn and never committed, so
 * unlike chat messages there is no commit pass to fold — apply the ST phase test STRICTLY for the
 * isPrompt call (world-info.js:5086 passes `{isMarkdown:false, isPrompt:true}`). Net: a `promptOnly`
 * (or both-true) WI rule fires; a BOTH-FALSE rule does NOT (the fixed divergence). Placement 5 is
 * matched by the applier (empty placement = everywhere, per RPT convention). Panel rules excluded. */
export const getWorldInfoRules = (
  profileId: string,
  ctx?: ScopeContext,
  order: RegexTierOrder = 'st-default'
): RenderRegexRule[] =>
  getAllRules(profileId, ctx, order).filter(
    (r) => !r.disabled && r.renderMode !== 'panel' && scriptRunsInPhase(r, { isPrompt: true })
  )

/**
 * Reasoning regex (ST placement 6), DISPLAY phase. Reasoning is committed + stored like a message in
 * ST (reasoning.js:409 `getRegexedString(reasoning, REASONING)` — a neither/commit call), then rendered;
 * RPT strips reasoning from the prompt (promptBuilder), so the display of the reasoning panel is the
 * only faithful application point. Same commit-fold as chat display (`appliesToDisplay`); a
 * 'panel'-promoted rule strips its match. Placement 6 is enforced here (empty = everywhere). */
export const getReasoningRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] =>
  getAllRules(profileId, ctx)
    .filter(
      (r) =>
        !r.disabled &&
        appliesToDisplay(r) &&
        (r.placement.length === 0 || r.placement.includes(REGEX_PLACEMENT.REASONING))
    )
    .map((r) => (r.renderMode === 'panel' ? { ...r, replace: '' } : r))

/**
 * Slash-command regex (ST placement 3). ST only ever runs this on a NEITHER call (slash-commands.js),
 * so `scriptRunsInPhase(r, {})` → only BOTH-FALSE rules fire. RPT has no ST-style slash-command chat
 * pipeline yet, so this selector is currently unwired at runtime — it exists for model completeness,
 * the TavernHelper `source.slash_command` mapping, and the conformance fixtures. */
export const getSlashCommandRules = (profileId: string, ctx?: ScopeContext): RenderRegexRule[] =>
  getAllRules(profileId, ctx).filter(
    (r) =>
      !r.disabled &&
      r.renderMode !== 'panel' &&
      scriptRunsInPhase(r, {}) &&
      (r.placement.length === 0 || r.placement.includes(REGEX_PLACEMENT.SLASH_COMMAND))
  )

// A "frontend card" loader regex injects a page via `$('body').load('https://…')`. Pull that URL out so a
// promoted regex can be hosted as a WCV panel. Only the `.load('https://…')` form (the status/home/start
// pattern) — NOT bare CDN `import`s in beautification regexes (those are libs, not the page). Pure.
const LOADER_URL_RE = /\.load\(\s*['"](https?:\/\/[^'"]+)['"]/i
export const extractCardUiUrl = (replace: string): string | null => {
  if (typeof replace !== 'string') return null
  const m = LOADER_URL_RE.exec(replace)
  return m ? m[1] : null
}

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
  ctx: RegexApplyContext = {},
  /** Message depth (0 = latest turn) for ST depth-scoped rules; omit to disable depth-scoping. */
  depth?: number,
  /** DISPLAY callers only (see regexTransform `freezePayloads`): make injected card payloads opaque to
   *  later rules. The prompt-assembly callers (promptBuilder) omit it so prompts stay byte-identical. */
  freezePayloads?: boolean,
  /** PER-RULE LINEAGE (issue 14): fires for each rule that actually changed the text, so the forensic
   *  journal can attribute a change to the rule that fired rather than the whole turn. */
  onRuleApplied?: (rule: RenderRegexRule, before: string, after: string) => void
): string => applyRegexRules(text, rules, ctx, { placement, depth, freezePayloads, onRuleApplied })

export const listScripts = (profileId: string): RegexScriptInfo[] => {
  const dir = regexDir(profileId)
  if (!fs.existsSync(dir)) return []
  const meta = readMeta(profileId)
  return listFilesSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((file) => {
      const rules = rulesInFile(path.join(dir, file))
      const m = meta[file]
      // A loader rule's page URL marks the script as promotable to a docked WCV panel.
      const uiUrl =
        rules.map((r) => extractCardUiUrl(r.replaceString ?? r.replace ?? '')).find(Boolean) ??
        undefined
      return {
        file,
        scriptName: rules[0]?.scriptName || rules[0]?.name || file.replace(/\.json$/, ''),
        ruleCount: rules.length,
        scope: m?.scope ?? 'global',
        owner: m?.owner,
        disabled: m?.disabled === true,
        uiUrl,
        renderMode: m?.renderMode
      }
    })
}

/** Active 'panel'-promoted regex UIs for a context — `{ file, scriptName, url }` — so the renderer can
 *  offer them as selectable WCV panel views. Loader-based panels use their remote URL; inline-HTML panels
 *  are served as a `data:text/html` URL so WcvPanel can load the HTML in a bridged WCV. */
export const listPanelRegexes = (
  profileId: string,
  ctx?: ScopeContext
): Array<{ file: string; scriptName: string; url: string }> => {
  const out: Array<{ file: string; scriptName: string; url: string }> = []
  for (const s of listScripts(profileId)) {
    if (s.renderMode !== 'panel' || s.disabled) continue
    if (ctx && !isScopeActive({ scope: s.scope, owner: s.owner }, ctx)) continue
    if (s.uiUrl) {
      // Loader-form panel: use the remote URL as-is.
      out.push({ file: s.file, scriptName: s.scriptName, url: s.uiUrl })
    } else {
      // Inline-HTML panel: read the rule file to get the HTML, serve as data: URL.
      const rules = rulesInFile(path.join(regexDir(profileId), s.file))
      const html = rules[0]?.replaceString ?? rules[0]?.replace ?? ''
      if (html) {
        out.push({
          file: s.file,
          scriptName: s.scriptName,
          url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
        })
      }
    }
  }
  return out
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
  // If the first rule declares a renderMode (e.g. 'panel'), persist it to meta so an imported
  // card regex is immediately panel-promoted without a separate setScriptRenderMode call.
  const declaredMode = rules[0]?.renderMode
  const VALID_MODES = new Set<CardRenderMode>(['inline', 'isolated', 'panel'])
  if (typeof declaredMode === 'string' && VALID_MODES.has(declaredMode as CardRenderMode)) {
    setRenderMode(regexDir(profileId), fileName, declaredMode as CardRenderMode)
  }
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
  // Drop the prior set for this scope (matching the owner when one resolved; if no owner resolved — e.g.
  // 'preset' with no active preset — clear the whole scope so 'replace' never silently becomes 'append').
  for (const s of listScripts(profileId)) {
    if ((s.scope ?? 'global') !== scope) continue
    if (scope !== 'global' && owner != null && s.owner !== owner) continue
    deleteScript(profileId, s.file)
  }
  // Persist each regex as its OWN file (one rule per file) so every regex — incl. one a card/workshop
  // just downloaded — shows as a separate, named, individually-manageable script, matching ST's flat
  // per-regex model. (Saving them all in one file would bury new regexes inside a multi-rule script.)
  for (const tr of Array.isArray(tavernRegexes) ? tavernRegexes : []) {
    saveRegexScript(profileId, [tavernRegexToStoreObject(tr)], scope, owner)
  }
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
