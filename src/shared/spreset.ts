/**
 * SPreset compatibility (issue 16 / WP-2.6) — a CLEAN-ROOM reimplementation of the three
 * preset-carried features of the closed-source "SPreset" ST extension, from the pinned behavioral
 * spec ONLY (`docs/research/spreset-behavior-2026-07-17.md`). SPreset ships as unlicensed remote-loaded
 * code; NO SPreset source is read into this implementation — every behavior below is cited to a spec
 * section, which itself cites the pinned `inject.js`. This module is PURE (no node/electron/DOM) and
 * lives in `src/shared` so both the parser (main) and any renderer surface can read the config shape.
 *
 * The three features:
 *  - **RegexBinding** — regex scripts stored INSIDE the preset (`extensions.SPreset.RegexBinding.regexes[]`,
 *    core-ST-shaped) + a preset-first execution ORDER across the regex tiers (spec §RegexBinding). RPT
 *    implements the ordering as an explicit MODE selection in regexService (NOT a monkeypatch of
 *    `Object.values` as upstream does). The regex records reuse the issue-14 regex path/transform.
 *  - **ChatSquash** — a final-stage role-based adjacent-merge over the outgoing message array with
 *    per-role affixes, separators, conditional-tag gating and stop-strings (spec §ChatSquash). The
 *    `squashed_post_script` key is arbitrary-JS `eval` upstream — RPT NEVER runs it; it (and the
 *    corpus-unused clewd / re-split / separate-history extras) surface as import diagnostics.
 *  - **MacroNest** — recursive innermost-first macro expansion (spec §MacroNest). Mapped onto RPT's
 *    existing multi-pass macro engine: `MacroNest:false` ⇒ a single (non-nesting) pass; true/absent ⇒
 *    RPT's default nesting cap.
 *
 * Config source of truth = `extensions.SPreset` (spec §Activation: `inject.js:636-654`). The disabled
 * `SPresetSettings` prompt block is a persistence MIRROR only — parsed iff the extensions namespace is
 * absent. Each feature gates on its OWN boolean, never on the block's presence.
 */

import { z } from 'zod'

// --- ChatSquash config (spec §ChatSquash) -----------------------------------------------------------

/**
 * ChatSquash keys we model. Permissive (`.passthrough()`) so unknown/newer keys survive round-trips
 * without being dropped. Only the keys RPT acts on are typed; the rest are carried but inert.
 */
export const ChatSquashConfigSchema = z
  .object({
    /** Feature gate (spec: `ChatSquash.enabled`, `inject.js:1018-1024`). */
    enabled: z.boolean().optional(),
    /** Target role for the merged run; `follow` = adopt the first message's role (spec:1174-1177,1314-1316). */
    role: z.enum(['follow', 'system', 'user', 'assistant']).optional(),
    /** Rewrite `system` → `user` before merging (spec:1284-1286). */
    user_role_system: z.boolean().optional(),
    // Per-role affixes wrapped around each role segment, substituteParams-expanded (spec:1185-1194,1321-1330).
    user_prefix: z.string().optional(),
    user_suffix: z.string().optional(),
    char_prefix: z.string().optional(),
    char_suffix: z.string().optional(),
    prefix_system: z.string().optional(),
    suffix_system: z.string().optional(),
    // Non-mergeable boundary markers (spec:1288-1319).
    enable_squashed_separator: z.boolean().optional(),
    squashed_separator_string: z.string().optional(),
    squashed_separator_regex: z.boolean().optional(),
    // Conditional activation: only squash when the tag is present; the tag is always stripped (spec:1088-1110).
    conditional_enabled: z.boolean().optional(),
    conditional_tag: z.string().optional(),
    // Stop strings appended to the request (spec:1150-1166).
    enable_stop_string: z.boolean().optional(),
    stop_string: z.string().optional(),
    // --- UNSUPPORTED in RPT (diagnostic only; see spresetUnsupportedCapabilities) ---
    /** Arbitrary-JS `eval` post-script (spec:1419-1427). RPT NEVER runs this. */
    squashed_post_script: z.string().optional(),
    /** "clewd" inline-<regex> + control-token transform (spec:1358-1413). Not implemented. */
    parse_clewd: z.boolean().optional(),
    /** Inverse re-split of merged content (spec:1199-1266). Not implemented. */
    re_split: z.boolean().optional(),
    /** Squash ONLY the chat-history region (spec:1044-1085). RPT applies whole-array squash; the
     *  history-region distinction is not implemented (diagnostic). */
    separate_chat_history: z.boolean().optional()
  })
  .passthrough()
export type ChatSquashConfig = z.infer<typeof ChatSquashConfigSchema>

// --- RegexBinding config (spec §RegexBinding) -------------------------------------------------------

export const SPresetRegexBindingSchema = z
  .object({
    /** Own feature gate. Absent ⇒ treated as enabled when regexes are present (spec: the store is the feature). */
    enabled: z.boolean().optional(),
    /** Core-ST-shaped regex script records (spec: "records shaped exactly like core ST regex scripts"). */
    regexes: z.array(z.any()).optional(),
    /** User-sortable tier order (`SGlobalSettings.RegexBinding.activationOrder`, spec:1528-1530). Tier
     *  codes 0=global 1=character 2=preset. Default `[2,0,1]` = preset→global→character (spec:61). */
    activationOrder: z.array(z.number()).optional()
  })
  .passthrough()
export type SPresetRegexBinding = z.infer<typeof SPresetRegexBindingSchema>

// --- The raw extensions.SPreset namespace ----------------------------------------------------------

export const SPresetConfigSchema = z
  .object({
    RegexBinding: SPresetRegexBindingSchema.optional(),
    ChatSquash: ChatSquashConfigSchema.optional(),
    /** Recursive-macro toggle (spec §MacroNest, `inject.js:407-451`). */
    MacroNest: z.boolean().optional()
  })
  .passthrough()
export type SPresetConfig = z.infer<typeof SPresetConfigSchema>

/**
 * The lossy RUNTIME projection stored on the normalized `Preset` (mirrors how `squash_system_messages`
 * is projected). Generation reads THIS — never the envelope — so the assembly path stays envelope-free.
 * The heavy `regexes[]` are NOT stored here: they are installed into the regex store at import.
 */
export const SPresetProjectionSchema = z.object({
  /** RegexBinding is active ⇒ use the preset-first regex tier order (spec default `[2,0,1]`). */
  regexBindingEnabled: z.boolean().default(false),
  /** MacroNest tri-state: true = nest, false = single-pass (non-nesting), null = absent (RPT default). */
  macroNest: z.boolean().nullable().default(null),
  /** Full ChatSquash config, or null when the feature block is absent. */
  chatSquash: ChatSquashConfigSchema.nullable().default(null)
})
export type SPresetProjection = z.infer<typeof SPresetProjectionSchema>

/**
 * SPreset regex tier order (spec §RegexBinding, default `[2,0,1]` = preset → global → character).
 * RPT's scoped tier (character/world/session) follows the two ST tiers. Used by regexService's
 * ordering-mode selection — NOT a monkeypatch.
 */
export const SPRESET_REGEX_TIER_ORDER: Record<'global' | 'preset' | 'world' | 'session', number> = {
  preset: 0,
  global: 1,
  world: 2,
  session: 3
}

// --- Config parsing ---------------------------------------------------------------------------------

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * Parse the SPreset config from a raw preset's `extensions` (source of truth) with the disabled
 * `SPresetSettings` prompt block as a MIRROR fallback — parsed via JSON.parse ONLY when the extensions
 * namespace is absent (spec §Activation: `inject.js:636-654`). Returns null when neither is present.
 *
 * `spresetSettingsBlockContent` is the raw `content` of the `SPresetSettings` prompt block, if the
 * caller found one; ignored when `extensions.SPreset` exists.
 */
export const parseSPresetConfig = (
  extensions: unknown,
  spresetSettingsBlockContent?: string
): SPresetConfig | null => {
  const ext = asObj(extensions)
  const ns = ext ? ext.SPreset : undefined
  if (asObj(ns)) {
    const parsed = SPresetConfigSchema.safeParse(ns)
    return parsed.success ? parsed.data : null
  }
  // Fallback: parse the disabled SPresetSettings prompt block JSON (mirror), iff the namespace is absent.
  if (typeof spresetSettingsBlockContent === 'string' && spresetSettingsBlockContent.trim()) {
    try {
      const parsed = SPresetConfigSchema.safeParse(JSON.parse(spresetSettingsBlockContent))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  return null
}

/** Project a raw SPreset config to the runtime flags stored on the normalized Preset. */
export const projectSPreset = (config: SPresetConfig | null): SPresetProjection | null => {
  if (!config) return null
  const rb = config.RegexBinding
  // RegexBinding is "on" when it has regexes AND is not explicitly disabled (spec: the store IS the feature;
  // `enabled` gates the ordering behavior). No regexes + no explicit enable ⇒ off (no ordering change).
  const hasRegexes = Array.isArray(rb?.regexes) && rb!.regexes!.length > 0
  const regexBindingEnabled = !!rb && rb.enabled !== false && (hasRegexes || rb.enabled === true)
  return {
    regexBindingEnabled,
    macroNest: typeof config.MacroNest === 'boolean' ? config.MacroNest : null,
    chatSquash: config.ChatSquash ?? null
  }
}

/**
 * The core-ST-shaped regex records to install as preset-scoped regex, gated on RegexBinding's own
 * boolean (spec §RegexBinding). Empty when the feature is absent/disabled or carries no records.
 */
export const spresetBoundRegexes = (config: SPresetConfig | null): any[] => {
  const rb = config?.RegexBinding
  if (!rb || rb.enabled === false) return []
  return Array.isArray(rb.regexes) ? rb.regexes.filter((r) => r && typeof r === 'object') : []
}

// --- ChatSquash execution (spec §ChatSquash) --------------------------------------------------------

/** Minimal message shape ChatSquash operates on — structurally identical to main's `ChatMessage`. */
export interface SquashChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Build a RegExp from a separator string that may be a bare pattern or a `/pat/flags` literal. */
const separatorRegex = (raw: string): RegExp | null => {
  try {
    if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
      const last = raw.lastIndexOf('/')
      const flags = raw.slice(last + 1)
      return new RegExp(raw.slice(1, last), flags.includes('g') ? flags : flags + 'g')
    }
    return new RegExp(raw, 'g')
  } catch {
    return null
  }
}

/**
 * ChatSquash: merge adjacent messages into role-tagged runs, per the spec's verified algorithm. Runs
 * ONLY when `config.enabled`. Distinct from RPT's native merge-all (`mergeConsecutiveRoles`) and ST's
 * selective system squash (issue 15) — it is the preset's OWN role-merge when enabled.
 *
 * Implemented (spec-VERIFIED + mandated "rest"): the enabled gate; conditional-tag gating (consume the
 * tag, bypass when absent — spec:1088-1110); `user_role_system` (spec:1284-1286); target `role` incl.
 * `follow` (spec:1174-1177,1314-1316); per-role affixes, substituteParams-expanded, joined `\n`
 * (spec:1185-1194,1321-1330); separator boundaries, literal or regex, marker stripped (spec:1288-1319).
 *
 * NOT implemented (diagnostic — see spresetUnsupportedCapabilities): `squashed_post_script` (arbitrary
 * `eval`, FORBIDDEN), `parse_clewd`, `re_split`, and the `separate_chat_history` region distinction
 * (whole-array squash is applied instead). These are corpus-unused / newer-than-corpus per the spec.
 *
 * `expand` applies macro substitution to affixes (RPT's `expandMacros`); pass identity in pure tests.
 */
export const chatSquash = (
  messages: SquashChatMessage[],
  config: ChatSquashConfig | null | undefined,
  expand: (s: string) => string = (s) => s
): SquashChatMessage[] => {
  if (!config?.enabled) return messages.map((m) => ({ role: m.role, content: m.content }))

  // Conditional-tag gating: strip the tag everywhere; when it was absent, bypass the squash (spec:1088-1110).
  let work = messages.map((m) => ({ role: m.role, content: m.content }))
  if (config.conditional_enabled) {
    const tag = config.conditional_tag ?? ''
    if (!tag) return work // nothing to key on ⇒ bypass
    const present = work.some((m) => m.content.includes(tag))
    work = work.map((m) => ({ role: m.role, content: m.content.split(tag).join('') }))
    if (!present) return work
  }

  // user_role_system: rewrite system → user before merging (spec:1284-1286).
  if (config.user_role_system) {
    work = work.map((m) => (m.role === 'system' ? { role: 'user', content: m.content } : m))
  }

  // Separator boundaries (spec:1288-1319): a message carrying the marker flushes the buffer and passes
  // through un-merged, with the marker stripped.
  const sepStr = config.enable_squashed_separator ? (config.squashed_separator_string ?? '') : ''
  const sepRe = sepStr && config.squashed_separator_regex ? separatorRegex(sepStr) : null
  const isSeparate = (content: string): boolean => {
    if (!sepStr) return false
    if (sepRe) {
      sepRe.lastIndex = 0
      return sepRe.test(content)
    }
    return content.includes(sepStr)
  }
  const stripSeparator = (content: string): string => {
    if (!sepStr) return content
    if (sepRe) return content.replace(sepRe, '')
    return content.split(sepStr).join('')
  }

  const affix = (role: SquashChatMessage['role'], content: string): string => {
    if (role === 'user') return expand(config.user_prefix ?? '') + content + expand(config.user_suffix ?? '')
    if (role === 'assistant')
      return expand(config.char_prefix ?? '') + content + expand(config.char_suffix ?? '')
    return expand(config.prefix_system ?? '') + content + expand(config.suffix_system ?? '')
  }

  const out: SquashChatMessage[] = []
  let buffer: SquashChatMessage[] = []
  const flush = (): void => {
    if (!buffer.length) return
    // Group consecutive same-role messages; join within a group with '\n', wrap each group with its
    // role's affix, then concatenate the groups (spec:1185-1194,1321-1330).
    const groups: { role: SquashChatMessage['role']; parts: string[] }[] = []
    for (const m of buffer) {
      const last = groups[groups.length - 1]
      if (last && last.role === m.role) last.parts.push(m.content)
      else groups.push({ role: m.role, parts: [m.content] })
    }
    const merged = groups.map((g) => affix(g.role, g.parts.join('\n'))).join('\n')
    const targetRole =
      !config.role || config.role === 'follow' ? buffer[0].role : (config.role as SquashChatMessage['role'])
    out.push({ role: targetRole, content: merged })
    buffer = []
  }

  for (const m of work) {
    if (isSeparate(m.content)) {
      flush()
      out.push({ role: m.role, content: stripSeparator(m.content) })
    } else {
      buffer.push(m)
    }
  }
  flush()
  return out
}

/**
 * Stop strings ChatSquash appends to the request (spec:1150-1166): parse `stop_string` as JSON, falling
 * back to a single-element array. Empty unless the feature + its flag are on. RPT forwards these on the
 * OpenAI-compatible path (params.stop); other providers map params explicitly and ignore it.
 */
export const resolveStopStrings = (config: ChatSquashConfig | null | undefined): string[] => {
  if (!config?.enabled || !config.enable_stop_string || !config.stop_string) return []
  try {
    const parsed = JSON.parse(config.stop_string)
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [String(parsed)]
  } catch {
    return [config.stop_string]
  }
}

/**
 * ChatSquash features RPT does NOT execute — surfaced as import diagnostics (ADR 0017: capabilities are
 * inventoried, and a remote-code-class capability is flagged). Computed only for an ENABLED ChatSquash.
 *  - `post-script` — arbitrary-JS `eval` (FORBIDDEN; never run — RPT trust boundary).
 *  - `parse-clewd`, `re-split`, `separate-history` — verified upstream but corpus-unused/newer-than-corpus;
 *    left as diagnostics with a black-box-fixture TODO rather than guessed (issue-16 acceptance).
 */
export const spresetUnsupportedCapabilities = (
  config: ChatSquashConfig | null | undefined
): string[] => {
  if (!config?.enabled) return []
  const out: string[] = []
  if (config.squashed_post_script && String(config.squashed_post_script).trim()) out.push('post-script')
  if (config.parse_clewd) out.push('parse-clewd')
  if (config.re_split) out.push('re-split')
  if (config.separate_chat_history) out.push('separate-history')
  return out
}
