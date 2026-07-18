import fs from 'fs'
import path from 'path'
import { randomUUID, createHash } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { log } from './logService'
import { Preset, PresetSchema, PresetEnvelope, PromptBlock, getDefaultPreset } from '../types/preset'
import type { HostPresetView, HostPresetPrompt } from '../../shared/thRuntime/hostPrimitives'
import { parseStPreset, selectPromptOrder } from '../parsers/stPresetParser'
import * as regexService from './regexService'
import * as scriptService from './scriptService'
import {
  parseSPresetConfig,
  spresetBoundRegexes,
  spresetUnsupportedCapabilities
} from '../../shared/spreset'

/** Identifies the importer that produced an envelope (ADR 0018), for future migrations. */
const IMPORTER_VERSION = 'rpt-st-preset/1'

export interface PresetSummary {
  id: string
  name: string
}

/**
 * A capability INVENTORY of an imported preset (WP-0.3 / ADR 0017), computed from the
 * lossless envelope's parsed JSON — not a trust gate. Import is the trust act: content runs
 * by default. The one exception is remote-code scripts (`remoteCodeScripts`), which stay inert
 * until a per-preset high-trust opt-in exists (issue 19). Counts are what the preset CONTAINS,
 * so they can differ from what actually got installed (e.g. remote-code scripts aren't run).
 */
export interface PresetInventory {
  /** Prompt blocks defined in the preset. */
  prompts: number
  /** Of those, how many resolve to enabled (via `prompt_order`, else the block's own flag). */
  promptsEnabled: number
  /** Core `extensions.regex_scripts[]` rules. */
  regexScripts: number
  /** `extensions.SPreset.RegexBinding.regexes[]` — kept DISTINCT from core; never merged. */
  spresetRegex: number
  /** SPreset ChatSquash features RPT does NOT execute when the preset enables them (issue 16): e.g.
   *  `post-script` (arbitrary `eval` — forbidden), `parse-clewd`, `re-split`, `separate-history`.
   *  Surfaced like a remote-code capability (ADR 0017) — inventoried, never run. */
  unsupportedSpreset: string[]
  /** `extensions.tavern_helper.scripts[]` bundled scripts (total, incl. remote-code). */
  tavernHelperScripts: number
  /** Of those, how many load remote code — kept INERT at import, flagged for high-trust (ADR 0017). */
  remoteCodeScripts: number
  /** Prompt blocks whose content carries an EJS / ST-Prompt-Template opener (`<%`). */
  ejsPrompts: number
  /** `extensions.*` namespaces the importer doesn't understand (surfaced, never dropped). */
  unknownExtensions: string[]
  /** Prompt identifiers defined more than once in `prompts[]`. */
  duplicateIdentifiers: string[]
  /** `prompt_order` entries referencing an identifier with no matching prompt definition. */
  orphanIdentifiers: string[]
}

/** What `importPresetFromFile` installed: the preset, the artifacts it ran, and the inventory. */
export interface PresetImportResult {
  name: string
  /** Core regex rules actually installed (preset-scoped). */
  regexScripts: number
  /** TH scripts actually installed to run (remote-code ones are excluded — they stay inert). */
  scripts: number
  /** Full capability inventory of the imported preset (counts + flags). */
  inventory: PresetInventory
}

/** Extension namespaces the importer understands; every other `extensions.*` key is "unknown". */
const KNOWN_EXTENSION_NAMESPACES = new Set(['regex_scripts', 'tavern_helper', 'SPreset'])

/** An ST-Prompt-Template / EJS opener (`<%`, `<%=`, `<%_`, `<%-`) anywhere in prompt content. */
const EJS_OPENER = /<%[=_-]?/

/** Raw script source from a TH/native script object (`content` is TH's key; `code` is ours). */
const scriptSource = (s: any): string =>
  typeof s?.content === 'string' ? s.content : typeof s?.code === 'string' ? s.code : ''

/**
 * Compute the capability inventory (ADR 0017 / WP-0.3) from an envelope's parsed JSON — the
 * nothing-dropped raw, which retains every `prompt_order` list and full `extensions.*`. Pure;
 * tolerant of the top-level-array-wrapping-a-preset shape seen in the wild. The SPreset regex
 * count is kept strictly DISTINCT from the core `regex_scripts` count (never merged).
 */
export const computePresetInventory = (parsed: any): PresetInventory => {
  const root = presetRoot(parsed)
  const prompts: any[] = Array.isArray(root?.prompts) ? root.prompts : []
  const ext = root?.extensions && typeof root.extensions === 'object' ? root.extensions : {}

  // Enabled state lives in prompt_order entries, not on the prompt object. Resolve it from the
  // SAME single order list the parser assembles from (`selectPromptOrder` — the 100001 record,
  // NOT a union across every list), so the inventory's enabled/orphan counts match what actually
  // gets built. A union over all lists over-reports enablement on dual-order-list presets.
  const orderEnabled = new Map<string, boolean>()
  for (const e of selectPromptOrder(root) ?? []) {
    if (!e || typeof e.identifier !== 'string') continue
    if (!orderEnabled.has(e.identifier)) orderEnabled.set(e.identifier, e.enabled !== false)
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const definedIds = new Set<string>()
  let promptsEnabled = 0
  let ejsPrompts = 0
  for (const p of prompts) {
    const id = typeof p?.identifier === 'string' ? p.identifier : ''
    if (id) {
      if (seen.has(id)) duplicates.add(id)
      seen.add(id)
      definedIds.add(id)
    }
    const enabled = orderEnabled.has(id) ? orderEnabled.get(id)! : p?.enabled !== false
    if (enabled) promptsEnabled++
    if (typeof p?.content === 'string' && EJS_OPENER.test(p.content)) ejsPrompts++
  }

  // Orphans: order entries pointing at an identifier that has no prompt definition (dangling).
  const orphanIdentifiers = [...orderEnabled.keys()].filter((id) => !definedIds.has(id))

  const regexScripts = Array.isArray(ext.regex_scripts) ? ext.regex_scripts.length : 0
  const spresetArr = ext?.SPreset?.RegexBinding?.regexes
  const spresetRegex = Array.isArray(spresetArr) ? spresetArr.length : 0
  const thScripts: any[] = Array.isArray(ext?.tavern_helper?.scripts) ? ext.tavern_helper.scripts : []
  const remoteCodeScripts = thScripts.filter((s) =>
    scriptService.hasRemoteCodeLoad(scriptSource(s))
  ).length
  // SPreset ChatSquash capabilities RPT won't run (issue 16 / ADR 0017). Config source of truth is the
  // extensions namespace; the disabled SPresetSettings block is a mirror fallback.
  const spresetBlock = prompts.find(
    (p: any) => p && (p.identifier === 'SPresetSettings' || p.name === 'SPreset配置')
  )
  const spresetConfig = parseSPresetConfig(
    ext,
    typeof spresetBlock?.content === 'string' ? spresetBlock.content : undefined
  )
  const unsupportedSpreset = spresetUnsupportedCapabilities(spresetConfig?.ChatSquash)

  return {
    prompts: prompts.length,
    promptsEnabled,
    regexScripts,
    spresetRegex,
    unsupportedSpreset,
    tavernHelperScripts: thScripts.length,
    remoteCodeScripts,
    ejsPrompts,
    unknownExtensions: Object.keys(ext).filter((k) => !KNOWN_EXTENSION_NAMESPACES.has(k)),
    duplicateIdentifiers: [...duplicates],
    orphanIdentifiers
  }
}

/**
 * ST chat-completion presets can bundle regex + Tavern Helper scripts under
 * `extensions` (`regex_scripts[]`, `tavern_helper.scripts[]`). These collectors pull
 * those out so the importer can route them into the regex/script stores, scoped to the
 * imported preset. Pure; tolerant of the non-standard exports we've seen in the wild
 * (top-level array wrapping a single preset object).
 */
const presetRoot = (raw: any): any =>
  Array.isArray(raw) ? (raw.find((x) => x && typeof x === 'object') ?? {}) : (raw ?? {})

export const collectPresetRegex = (raw: any): any[] => {
  const ext = presetRoot(raw)?.extensions
  const arr = ext?.regex_scripts
  return Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object') : []
}

export const collectPresetScripts = (raw: any): any[] => {
  const ext = presetRoot(raw)?.extensions
  const arr = ext?.tavern_helper?.scripts
  return Array.isArray(arr) ? arr.filter((s) => s && typeof s === 'object') : []
}

/**
 * SPreset RegexBinding regex records (issue 16), core-ST-shaped, gated on the feature's own boolean.
 * Kept DISTINCT from `collectPresetRegex` (core `regex_scripts`) so the SPreset namespace never merges
 * into core. Config source of truth is `extensions.SPreset`; the disabled `SPresetSettings` prompt block
 * is a mirror fallback (spec §Activation). Each returned rule is tagged `rptOrigin:'spreset'` so it is
 * persisted + attributed distinctly.
 */
export const collectSpresetRegex = (raw: any): any[] => {
  const root = presetRoot(raw)
  const spresetBlock = Array.isArray(root?.prompts)
    ? root.prompts.find(
        (p: any) => p && (p.identifier === 'SPresetSettings' || p.name === 'SPreset配置')
      )
    : undefined
  const config = parseSPresetConfig(
    root?.extensions,
    typeof spresetBlock?.content === 'string' ? spresetBlock.content : undefined
  )
  return spresetBoundRegexes(config).map((rule) => ({ ...rule, rptOrigin: 'spreset' }))
}

const presetsDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'presets')
const presetPath = (profileId: string, id: string): string =>
  path.join(presetsDir(profileId), `${id}.json`)
const activePath = (profileId: string): string => path.join(presetsDir(profileId), '_active.json')

// Envelopes live in a subdirectory so `listPresets`/`listFilesSync` (files-only) never
// mistake a `<id>.json` envelope for a preset record. One sidecar per preset id.
const envelopesDir = (profileId: string): string => path.join(presetsDir(profileId), 'envelopes')
const envelopePath = (profileId: string, id: string): string =>
  path.join(envelopesDir(profileId), `${id}.json`)

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Persist the lossless envelope sidecar for a preset id (ADR 0018). */
const writeEnvelope = (profileId: string, id: string, env: PresetEnvelope): void => {
  writeJsonSyncAtomic(envelopePath(profileId, id), env)
}

/**
 * Ensure the presets directory exists, lazily migrating the pre-multi-preset
 * single `preset.json` into it on first access.
 */
const ensurePresetsDir = (profileId: string): string => {
  const dir = presetsDir(profileId)
  if (fs.existsSync(dir)) return dir
  ensureDir(dir)

  const legacy = readJsonSync(path.join(getAppDir(), 'profiles', profileId, 'preset.json'))
  if (legacy) {
    const parsed = PresetSchema.safeParse(legacy)
    if (parsed.success) {
      const id = randomUUID()
      writeJsonSyncAtomic(presetPath(profileId, id), parsed.data)
      writeJsonSyncAtomic(activePath(profileId), { id })
    }
  }
  return dir
}

export const listPresets = (profileId: string): PresetSummary[] => {
  const dir = ensurePresetsDir(profileId)
  const out: PresetSummary[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const id = file.replace(/\.json$/, '')
    const data = readJsonSync<Preset>(path.join(dir, file))
    if (data) out.push({ id, name: data.name || 'Untitled Preset' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const getActivePresetId = (profileId: string): string | null => {
  ensurePresetsDir(profileId)
  const active = readJsonSync<{ id: string }>(activePath(profileId))
  if (active?.id && fs.existsSync(presetPath(profileId, active.id))) return active.id
  const first = listPresets(profileId)[0]
  return first?.id ?? null
}

export const setActivePreset = (profileId: string, presetId: string): void => {
  ensurePresetsDir(profileId)
  writeJsonSyncAtomic(activePath(profileId), { id: presetId })
}

export const getPresetById = (profileId: string, presetId: string): Preset | null => {
  const data = readJsonSync(presetPath(profileId, presetId))
  if (!data) return null
  const parsed = PresetSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** The active preset's data, used by generation. Falls back to a default. */
export const getActivePreset = (profileId: string): Preset => {
  const id = getActivePresetId(profileId)
  if (!id) return getDefaultPreset()
  return getPresetById(profileId, id) ?? getDefaultPreset()
}

const roleOf = (r: unknown): 'system' | 'user' | 'assistant' =>
  r === 'user' || r === 'assistant' ? r : 'system'

/** One normalized prompt block → the Host preset-view prompt shape (id === identifier). */
const toHostPrompt = (b: PromptBlock): HostPresetPrompt => ({
  id: b.identifier,
  identifier: b.identifier,
  name: b.name,
  role: b.role,
  content: b.content,
  enabled: b.enabled,
  marker: b.marker,
  injection_depth: b.injection_depth,
  injection_order: b.injection_order
})

/**
 * The active preset as a Host preset view (issue 19 / TavernHelper `getPreset('in_use')`, spec §7).
 * `prompts` = the normalized runtime view's prompts (in order, with enabled states). `prompts_unused`
 * and `extensions` are derived from the lossless envelope: unused = prompts DEFINED in the raw but NOT
 * in the active order (so they aren't in the normalized view); extensions = the raw `extensions.*` bag
 * (SPreset / tavern_helper / regex_scripts binding data). Both are `[]`/`{}` for a pre-envelope import.
 */
export const getActivePresetView = (profileId: string): HostPresetView | null => {
  const id = getActivePresetId(profileId)
  const preset = getActivePreset(profileId)
  const prompts = preset.prompts.map(toHostPrompt)
  const activeIds = new Set(preset.prompts.map((p) => p.identifier))

  let promptsUnused: HostPresetPrompt[] = []
  let extensions: Record<string, unknown> = {}
  const env = id ? readEnvelope(profileId, id) : null
  if (env) {
    const root = presetRoot(env.parsed)
    if (root && typeof root.extensions === 'object' && root.extensions) {
      extensions = root.extensions as Record<string, unknown>
    }
    const rawPrompts: any[] = Array.isArray(root?.prompts) ? root.prompts : []
    promptsUnused = rawPrompts
      .filter((p) => p && typeof p.identifier === 'string' && !activeIds.has(p.identifier))
      .map((p) => ({
        id: String(p.identifier),
        identifier: String(p.identifier),
        name: typeof p.name === 'string' ? p.name : '',
        role: roleOf(p.role),
        content: typeof p.content === 'string' ? p.content : '',
        enabled: false,
        injection_depth: null,
        injection_order: 100
      }))
  }

  return {
    name: preset.name,
    parameters: preset.parameters as Record<string, unknown>,
    prompts,
    prompts_unused: promptsUnused,
    extensions
  }
}

/**
 * Persist a card's preset edits to the ACTIVE preset (issue 19 — the 狐神抚 control surface). The runtime
 * has already merged the card's mutated view onto the current normalized view by identifier, so `patch`
 * is a full normalized-preset-shaped object; `PresetSchema.parse` fills any defaults + strips extras.
 * Returns whether it wrote. No active preset id ⇒ false (nothing to write back to).
 *
 * NOTE (F6): this writes durably + immediately (the most faithful behavior the docs support). TH's exact
 * in-chat-edit-vs-saved divergence is docs-silent (see the F6 fixture) — RPT has no un-persisted overlay.
 */
export const saveActivePreset = (profileId: string, patch: unknown): boolean => {
  const id = getActivePresetId(profileId)
  if (!id) return false
  const parsed = PresetSchema.safeParse(patch)
  if (!parsed.success) {
    log('error', 'saveActivePreset: rejected invalid preset patch', parsed.error?.message)
    return false
  }
  savePreset(profileId, id, parsed.data)
  return true
}

/** Write a preset to its own JSON file; optionally make it active. Returns its id. */
export const createPresetFromData = (
  profileId: string,
  name: string,
  data: Preset,
  makeActive = true
): string => {
  ensurePresetsDir(profileId)
  const id = randomUUID()
  const parsed = PresetSchema.parse({ ...data, name })
  writeJsonSyncAtomic(presetPath(profileId, id), parsed)
  if (makeActive) setActivePreset(profileId, id)
  return id
}

/** Create a new, empty preset (no prompt blocks) and make it active. */
export const createEmptyPreset = (profileId: string, name = 'New Preset'): PresetSummary => {
  const empty: Preset = { name, parameters: { temperature: 0.9, max_tokens: 4000 }, prompts: [] }
  const id = createPresetFromData(profileId, name, empty, true)
  return { id, name }
}

export const savePreset = (profileId: string, presetId: string, preset: Preset): void => {
  ensurePresetsDir(profileId)
  writeJsonSyncAtomic(presetPath(profileId, presetId), PresetSchema.parse(preset))
}

export const deletePreset = (profileId: string, presetId: string): void => {
  const p = presetPath(profileId, presetId)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  const env = envelopePath(profileId, presetId)
  if (fs.existsSync(env)) fs.unlinkSync(env)
  // Remove any regex/scripts the preset bundled (scope=preset, owner=presetId) so a
  // deleted preset doesn't leave orphaned artifacts firing for a preset that's gone.
  regexService.deleteScriptsByOwner(profileId, 'preset', presetId)
  scriptService.deleteScriptsByOwner(profileId, 'preset', presetId)
  const next = getActivePresetId(profileId)
  writeJsonSyncAtomic(activePath(profileId), { id: next ?? null })
}

/**
 * Install a preset bundled in a World Card (Track S §3). Accepts our native
 * `{ name, parameters, prompts }` shape directly, else normalizes an ST chat-completion
 * preset. Never hijacks the active preset, and skips (returns null) if a preset with the
 * same name already exists so re-importing a world is idempotent. Returns the name.
 */
export const installBundledPreset = (profileId: string, raw: any): string | null => {
  try {
    let preset: Preset | null = null
    // Native bundles carry a structured `parameters` object — parse those directly;
    // otherwise treat it as an ST preset and run it through the importer's normalizer.
    if (raw && typeof raw === 'object' && raw.parameters && typeof raw.parameters === 'object') {
      const direct = PresetSchema.safeParse(raw)
      if (direct.success) preset = direct.data
    }
    if (!preset) {
      const normalized = parseStPreset(raw, raw?.name || 'Bundled Preset')
      if (normalized) preset = PresetSchema.parse(normalized)
    }
    if (!preset) return null
    if (listPresets(profileId).some((p) => p.name === preset!.name)) return null // dedup by name
    const presetId = createPresetFromData(profileId, preset.name, preset, false)
    // A bundle arrives pre-parsed (no original file bytes), so the envelope stores the
    // full parsed object for losslessness but cannot offer a byte-exact re-export.
    writeEnvelope(profileId, presetId, {
      sha256: null,
      parsed: presetRoot(raw),
      originalBase64: null,
      importedAt: new Date().toISOString(),
      importerVersion: IMPORTER_VERSION
    })
    return preset.name
  } catch (error) {
    log('error', 'Failed to install bundled preset:', error)
    return null
  }
}

/**
 * Import a SillyTavern preset file as a NEW active preset, AND extract any regex /
 * Tavern Helper scripts it bundles under `extensions` into the regex/script stores,
 * scoped to this preset (so they only fire while it's the active preset — mirroring how
 * ST applies preset-bound regex). Returns the preset name + how many artifacts came with it.
 */
export const importPresetFromFile = (
  profileId: string,
  filePath: string
): PresetImportResult | null => {
  try {
    // Read the verbatim bytes (not a utf-8 string) so the envelope hashes and can later
    // re-export the exact original — BOM, key order, whitespace, duplicate keys and all.
    const bytes = fs.readFileSync(filePath)
    const raw = JSON.parse(bytes.toString('utf-8'))
    const normalized = parseStPreset(raw, path.basename(filePath, '.json'))
    if (!normalized) return null
    const preset = PresetSchema.parse(normalized)
    const presetId = createPresetFromData(profileId, preset.name, preset, true)

    // Lossless provenance envelope (ADR 0018): original bytes + hash + nothing-dropped JSON.
    writeEnvelope(profileId, presetId, {
      sha256: sha256Hex(bytes),
      parsed: raw,
      originalBase64: bytes.toString('base64'),
      importedAt: new Date().toISOString(),
      importerVersion: IMPORTER_VERSION
    })

    // Route bundled regex (each ST rule → its own script file) scoped to the preset.
    let regexScripts = 0
    for (const rule of collectPresetRegex(raw)) {
      if (regexService.saveRegexScript(profileId, rule, 'preset', presetId)) regexScripts++
    }
    // SPreset RegexBinding regex (issue 16): installed as preset-scoped regex too, but each rule carries
    // `rptOrigin:'spreset'` so it stays DISTINCT from core `regex_scripts` in storage + attribution.
    // Unblocks presets whose ONLY regex lives here (both Dramatron presets). Counted in the inventory's
    // `spresetRegex`, not in `regexScripts`.
    for (const rule of collectSpresetRegex(raw)) {
      regexService.saveRegexScript(profileId, rule, 'preset', presetId)
    }

    // Route bundled Tavern Helper scripts (declarative buttons baked in) scoped to the preset.
    // ADR 0017: import runs content by default, EXCEPT scripts that load remote code — those
    // stay INERT (not installed to run) until a per-preset high-trust opt-in exists (issue 19).
    // They remain in the envelope and are counted in the inventory as `remoteCodeScripts`.
    let scripts = 0
    for (const rawScript of collectPresetScripts(raw)) {
      if (scriptService.hasRemoteCodeLoad(scriptSource(rawScript))) continue // inert + flagged
      const [s] = scriptService.normalizeImportedScripts(rawScript)
      if (!s) continue
      const file = scriptService.saveScript(
        profileId,
        { name: s.name, code: s.code, id: s.id }, // preserve upstream TH id (issue 03)
        'preset',
        presetId
      )
      if (!s.enabled) scriptService.setScriptDisabled(profileId, file, true)
      scripts++
    }

    return { name: preset.name, regexScripts, scripts, inventory: computePresetInventory(raw) }
  } catch (error) {
    log('error', 'Failed to import preset:', error)
    return null
  }
}

/** Read a preset's lossless envelope sidecar (ADR 0018), or null if none exists. */
export const readEnvelope = (profileId: string, presetId: string): PresetEnvelope | null =>
  readJsonSync<PresetEnvelope>(envelopePath(profileId, presetId)) ?? null

/** True when a stored preset predates the envelope — its raw source is already gone. */
export const isLossyImport = (profileId: string, presetId: string): boolean =>
  fs.existsSync(presetPath(profileId, presetId)) &&
  !fs.existsSync(envelopePath(profileId, presetId))

export interface PresetProvenance {
  /** An envelope sidecar exists (imported after ADR 0018 landed). */
  hasEnvelope: boolean
  /** Imported before the envelope existed — flag for diagnostics; re-import refreshes it. */
  lossyImport: boolean
  /** Byte-exact re-export is available (envelope carries the original bytes). */
  canExportOriginal: boolean
  sha256: string | null
  importedAt: string | null
  importerVersion: string | null
}

/**
 * Provenance for a stored preset, or null if no such preset. A preset with a normalized
 * record but no envelope was imported before ADR 0018 — surfaced as `lossyImport` (no
 * migration is attempted; its raw source is gone, and re-import refreshes it).
 */
export const getPresetProvenance = (
  profileId: string,
  presetId: string
): PresetProvenance | null => {
  if (!fs.existsSync(presetPath(profileId, presetId))) return null
  const env = readEnvelope(profileId, presetId)
  return {
    hasEnvelope: !!env,
    lossyImport: !env,
    canExportOriginal: !!env?.originalBase64,
    sha256: env?.sha256 ?? null,
    importedAt: env?.importedAt ?? null,
    importerVersion: env?.importerVersion ?? null
  }
}

/**
 * The capability inventory (ADR 0017) for a STORED preset, recomputed from its lossless envelope — or
 * null when the preset predates the envelope (a lossy import has no raw to inventory). The Preset
 * Manager reads it to decide whether to surface the per-preset high-trust opt-in (issue 19): that opt-in
 * is only meaningful when the preset actually carries remote-code scripts (`remoteCodeScripts > 0`).
 */
export const getPresetInventory = (
  profileId: string,
  presetId: string
): PresetInventory | null => {
  const env = readEnvelope(profileId, presetId)
  return env ? computePresetInventory(env.parsed) : null
}

const SAMPLER_KEYS = [
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'min_p',
  'top_a'
] as const

/**
 * Overlay a view prompt's editable scalars onto a matching raw prompt object, touching ONLY keys
 * the raw already carries — exactly like the sampler overlay above. This is what keeps an *unedited*
 * export byte-equal: for an unedited prompt the view values equal the raw's, so every assignment is a
 * no-op AND no absent key (e.g. a marker prompt's missing `role`/`content`) is ever introduced. An
 * edit to a field the raw carries (a literal's `content`/`role`/`name`) is reflected; edits to a field
 * the raw lacks are out of scope (the niche depth-injection add is left to the runtime view).
 */
const overlayPromptEdits = (rawPrompt: Record<string, any>, vp: PromptBlock): void => {
  if ('name' in rawPrompt) rawPrompt.name = vp.name
  if ('role' in rawPrompt) rawPrompt.role = vp.role
  if ('content' in rawPrompt) rawPrompt.content = vp.content
  if ('injection_order' in rawPrompt && typeof vp.injection_order === 'number') {
    rawPrompt.injection_order = vp.injection_order
  }
  // Depth is editable in the Preset Manager (~PresetManager:423); overlay it like the other scalars so a
  // depth edit survives semantic export instead of reverting to the imported value (runtime kept it; export
  // dropped it). Touch only when the raw carries the key, so an unedited export stays byte-equal.
  if ('injection_depth' in rawPrompt && typeof vp.injection_depth === 'number') {
    rawPrompt.injection_depth = vp.injection_depth
  }
}

/** An ST-shaped raw prompt object for a prompt ADDED in the editor (no matching raw definition). */
const newRawPrompt = (vp: PromptBlock): Record<string, any> => {
  if (vp.marker !== 'none') {
    return { identifier: vp.identifier, name: vp.name, role: vp.role, marker: true }
  }
  const p: Record<string, any> = {
    identifier: vp.identifier,
    name: vp.name,
    role: vp.role,
    content: vp.content,
    system_prompt: false,
    marker: false
  }
  if (vp.injection_depth != null) {
    p.injection_position = 1
    p.injection_depth = vp.injection_depth
  }
  if (typeof vp.injection_order === 'number' && vp.injection_order !== 100) {
    p.injection_order = vp.injection_order
  }
  return p
}

/**
 * Reconcile the edited normalized view's PROMPTS + ORDER back onto the lossless raw (ADR 0018) so a
 * semantic export reflects the current edited state — content/role edits, reorder, enablement toggles,
 * additions AND deletions — while everything the view doesn't model (extra `prompt_order` lists,
 * `extensions.*`, parser-dropped-but-defined prompts) passes through untouched.
 *
 * Deletions are distinguished from the prompts the parser routinely DROPS (empty non-override literals,
 * duplicate markers, orphans) by re-deriving the IMPORT-TIME view from the untouched raw: an identifier
 * in the import view but no longer in the current view is a user deletion (dropped from the order); an
 * identifier never in the import view is parser-dropped (preserved for losslessness).
 */
const overlayPromptsAndOrder = (root: any, originalRoot: any, view: Preset): void => {
  if (!Array.isArray(root.prompts)) return

  const importView = ((): Preset | null => {
    try {
      return parseStPreset(originalRoot, originalRoot?.name || 'preset') as Preset | null
    } catch {
      return null
    }
  })()
  const importIds = new Set<string>((importView?.prompts ?? []).map((p) => p.identifier))
  const viewIds = new Set(view.prompts.map((p) => p.identifier))

  // 1) Overlay edits onto matching raw prompts (existing keys only, so unedited stays byte-equal).
  const rawById = new Map<string, any>()
  for (const rp of root.prompts) {
    if (rp && typeof rp.identifier === 'string' && !rawById.has(rp.identifier)) {
      rawById.set(rp.identifier, rp)
    }
  }
  for (const vp of view.prompts) {
    const rp = rawById.get(vp.identifier)
    if (rp) overlayPromptEdits(rp, vp)
  }

  // 2) Reflect order + enablement. Resolve the active `prompt_order` list via the SHARED selector
  //    (100001 record, else the first list carrying an `order`) so export selection can't drift from the
  //    list the parser assembled from — the drift hazard selectPromptOrder's own comment warns about. It
  //    returns the live `order` array (by reference), which we rebuild IN PLACE below. When a preset has
  //    NO `prompt_order`, order + enablement live on `prompts[]` (the parser's fallback) — reorder there.
  const activeOrder = selectPromptOrder(root)

  if (activeOrder) {
    // Additions need a prompt DEFINITION too (the order alone can't carry content).
    for (const vp of view.prompts) if (!rawById.has(vp.identifier)) root.prompts.push(newRawPrompt(vp))

    const existing: any[] = activeOrder
    const entryById = new Map<string, any>()
    for (const e of existing) {
      if (e && typeof e.identifier === 'string' && !entryById.has(e.identifier)) {
        entryById.set(e.identifier, e)
      }
    }
    const rebuilt: any[] = []
    for (const vp of view.prompts) {
      const e = entryById.get(vp.identifier)
      // Reuse the existing order entry (preserving any extra keys) but write the view's enabled state.
      rebuilt.push(e ? { ...e, enabled: vp.enabled } : { identifier: vp.identifier, enabled: vp.enabled })
    }
    for (const e of existing) {
      const id = e && typeof e.identifier === 'string' ? e.identifier : null
      if (!id || viewIds.has(id)) continue // view-controlled — already placed above
      if (importIds.has(id)) continue // in the import view but not now → a user DELETION, drop it
      rebuilt.push(e) // parser-dropped but defined → preserve (lossless)
    }
    // Mutate the selector's array in place (it IS the block's `order`), so the block the parser reads
    // from is the one we rewrite — no second block-selection to drift from the one above.
    activeOrder.splice(0, activeOrder.length, ...rebuilt)
  } else {
    // No `prompt_order`: reorder `prompts[]` to the view and reflect enablement, P1-safe (only write
    // `enabled` when it actually changed from import, or the raw prompt already carries the key).
    const importEnabled = new Map<string, boolean>()
    for (const ip of importView?.prompts ?? []) importEnabled.set(ip.identifier, ip.enabled !== false)
    const reordered: any[] = []
    for (const vp of view.prompts) {
      const rp = rawById.get(vp.identifier) ?? newRawPrompt(vp)
      const wasEnabled = importEnabled.has(vp.identifier) ? importEnabled.get(vp.identifier)! : true
      if (vp.enabled !== wasEnabled || 'enabled' in rp) rp.enabled = vp.enabled
      reordered.push(rp)
    }
    for (const rp of root.prompts) {
      const id = rp && typeof rp.identifier === 'string' ? rp.identifier : null
      if (!id || viewIds.has(id)) continue
      if (importIds.has(id)) continue // user deletion → drop
      reordered.push(rp) // parser-dropped but defined → preserve
    }
    root.prompts = reordered
  }
}

/**
 * Overlay the current normalized view's edits back onto the lossless raw, touching ONLY keys the raw
 * already carries. Editable scalars (`name`, temperature/max_tokens + samplers) AND the full prompt set
 * (content/role edits, reorder, enablement, additions, deletions via `overlayPromptsAndOrder`) are
 * reflected. Every other ST field (extra `prompt_order` lists, `extensions.*`, unknown top-level keys)
 * passes through untouched, and an *unedited* preset re-serializes to a JSON.parse-equal copy of its import.
 */
const overlaySemanticView = (parsed: any, view: Preset): any => {
  const clone = JSON.parse(JSON.stringify(parsed))
  const root = Array.isArray(clone) ? clone.find((x: any) => x && typeof x === 'object') : clone
  if (!root || typeof root !== 'object') return clone
  if ('name' in root) root.name = view.name
  const p = view.parameters
  if ('temperature' in root && typeof p.temperature === 'number') root.temperature = p.temperature
  if ('openai_max_tokens' in root && typeof p.max_tokens === 'number') {
    root.openai_max_tokens = p.max_tokens
  } else if ('max_tokens' in root && typeof p.max_tokens === 'number') {
    root.max_tokens = p.max_tokens
  }
  for (const k of SAMPLER_KEYS) {
    const v = (p as Record<string, unknown>)[k]
    if (k in root && typeof v === 'number') (root as Record<string, unknown>)[k] = v
  }
  overlayPromptsAndOrder(root, presetRoot(parsed), view)
  return clone
}

/**
 * Default export (ADR 0018): semantic JSON re-serialized from the envelope's
 * nothing-dropped raw with the current view's edits overlaid — losslessly preserving
 * everything the ST preset carried. Returns a pretty-printed JSON string, or null when
 * the preset has no envelope (a pre-envelope import).
 */
export const exportPresetSemantic = (profileId: string, presetId: string): string | null => {
  const env = readEnvelope(profileId, presetId)
  if (!env) return null
  const view = getPresetById(profileId, presetId)
  const merged = view ? overlaySemanticView(env.parsed, view) : env.parsed
  return JSON.stringify(merged, null, 2)
}

/**
 * Byte-exact export for a never-edited preset: the verbatim original bytes, returned only
 * when the stored SHA-256 still verifies. null when no original bytes exist (a bundled
 * preset) or the envelope is absent.
 */
export const exportPresetOriginal = (profileId: string, presetId: string): Buffer | null => {
  const env = readEnvelope(profileId, presetId)
  if (!env?.originalBase64) return null
  const bytes = Buffer.from(env.originalBase64, 'base64')
  if (env.sha256 && sha256Hex(bytes) !== env.sha256) {
    log('error', `Preset envelope SHA-256 mismatch for ${presetId}; refusing byte-exact export`)
    return null
  }
  return bytes
}
