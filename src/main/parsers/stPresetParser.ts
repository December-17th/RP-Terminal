import { PromptMarker } from '../types/preset'
import { selectPromptOrder } from '../../shared/agentPresetEnvelope'
import { parseSPresetConfig, projectSPreset } from '../../shared/spreset'

/**
 * Maps SillyTavern's built-in prompt identifiers onto our dynamic markers.
 * Identifiers not listed here are treated as literal prompt blocks (their
 * `content` is used verbatim).
 *
 * ST 1.18.0 keeps each of these as a DISTINCT default marker with its own role +
 * position (openai.js:1365-1371) — RPT no longer collapses `worldInfoBefore` +
 * `worldInfoAfter` into one `world_info`, and no longer folds `charPersonality` /
 * `scenario` into `char_description`. Imports therefore carry the full ST marker set;
 * native RPT presets still use the simpler single `world_info` + folded description
 * (see getDefaultPreset). The builder (`promptBuilder`) handles both shapes.
 */
const MARKER_MAP: Record<string, PromptMarker> = {
  chatHistory: 'chat_history',
  dialogueExamples: 'mes_example',
  charDescription: 'char_description',
  charPersonality: 'char_personality',
  scenario: 'scenario',
  worldInfoBefore: 'world_info_before',
  worldInfoAfter: 'world_info_after',
  personaDescription: 'persona_description'
}

// Literal blocks a character card's system-prompt / post-history override can target
// (openai.js:1487-1504). Kept even when contentless — the override supplies the content,
// and ST retains an (empty) `main` as a structural anchor (PromptManager.js:1531-1537).
const OVERRIDE_TARGETS = new Set(['main', 'jailbreak'])

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && !Number.isNaN(v) ? v : undefined

/**
 * Re-exported from `shared/agentPresetEnvelope` so the renderer's bundled-envelope gate resolves
 * order against the EXACT list this parser assembles from. Moved there, not copied — importers here
 * are unaffected. See that module for the selection rule and the drift hazard.
 */
export { selectPromptOrder }

/**
 * Normalize a parsed SillyTavern chat-completion preset into our Preset shape
 * ({ name, parameters, prompts }). Honors `prompt_order` if present, otherwise
 * falls back to the raw `prompts` order. Returns null if it isn't a preset.
 */
export const parseStPreset = (raw: any, fallbackName: string): any | null => {
  if (!raw || typeof raw !== 'object') return null
  if (!Array.isArray(raw.prompts)) return null

  // FIRST-match wins for a duplicated identifier, matching ST's `getPromptById`
  // (PromptManager.js:1257 — `.find`, first hit). A later prompt object with the same
  // identifier is ignored, not overwritten.
  const promptsById = new Map<string, any>()
  for (const p of raw.prompts) {
    if (p && p.identifier && !promptsById.has(p.identifier)) promptsById.set(p.identifier, p)
  }

  // Resolve order via the shared selector (100001 record preferred); when no usable
  // prompt_order exists, fall back to the raw `prompts` order.
  const selectedOrder = selectPromptOrder(raw)
  const order: Array<{ identifier: string; enabled?: boolean }> =
    selectedOrder ?? raw.prompts.map((p: any) => ({ identifier: p.identifier, enabled: p.enabled }))

  // ST allow-list of generation types (lowercased) a block fires for; [] = all.
  const trigger = (src: any): string[] =>
    Array.isArray(src?.injection_trigger)
      ? src.injection_trigger.map((t: any) => String(t).toLowerCase())
      : []

  const seenMarkers = new Set<PromptMarker>()
  const prompts: any[] = []

  for (const item of order) {
    const id = item.identifier
    if (!id) continue

    const src = promptsById.get(id)
    const marker = MARKER_MAP[id] || 'none'

    if (marker !== 'none') {
      if (seenMarkers.has(marker)) continue // dedupe duplicate dynamic markers (first wins)
      seenMarkers.add(marker)
      prompts.push({
        identifier: id,
        name: src?.name || id,
        role: src?.role || 'system',
        content: '',
        enabled: item.enabled !== false,
        marker,
        injection_trigger: trigger(src),
        forbid_overrides: src?.forbid_overrides === true
      })
      continue
    }

    // Literal block — keep only if it carries content, EXCEPT the override targets
    // (`main`/`jailbreak`), retained even when empty so the card override + ST's structural
    // empty-`main` anchor still apply (PromptManager.js:1531-1537; openai.js:1487-1504).
    const isOverrideTarget = OVERRIDE_TARGETS.has(id)
    if ((!src || !src.content) && !isOverrideTarget) continue
    // ST injection_position: 1 = absolute (in-chat at depth), else relative (inline).
    const atDepth = src?.injection_position === 1
    prompts.push({
      identifier: id,
      name: src?.name || id,
      role: src?.role || 'system',
      content: src?.content || '',
      enabled: item.enabled !== false,
      marker: 'none',
      injection_depth: atDepth ? (num(src?.injection_depth) ?? 4) : null,
      // ST groups same-depth in-chat injections by injection_order (default 100); see promptBuilder
      // grouping. Carried for depth blocks; harmless (unused) on relative ones.
      injection_order: num(src?.injection_order) ?? 100,
      injection_trigger: trigger(src),
      forbid_overrides: src?.forbid_overrides === true
    })
  }

  const parameters = {
    temperature: num(raw.temperature) ?? 0.9,
    max_tokens: num(raw.openai_max_tokens) ?? num(raw.max_tokens) ?? 4000,
    top_p: num(raw.top_p),
    top_k: num(raw.top_k),
    frequency_penalty: num(raw.frequency_penalty),
    presence_penalty: num(raw.presence_penalty),
    repetition_penalty: num(raw.repetition_penalty),
    min_p: num(raw.min_p),
    top_a: num(raw.top_a)
  }

  // SPreset (`extensions.SPreset`) projection (issue 16 / WP-2.6). Source of truth is the extensions
  // namespace; the disabled `SPresetSettings` prompt block is a MIRROR fallback, parsed only when the
  // namespace is absent (spec §Activation). Present ONLY when the preset actually carries SPreset config,
  // so a native/plain ST preset never gains the key (parity — assembly stays byte-identical).
  const spresetBlock = raw.prompts.find(
    (p: any) => p && (p.identifier === 'SPresetSettings' || p.name === 'SPreset配置')
  )
  const spresetConfig = parseSPresetConfig(
    raw.extensions,
    typeof spresetBlock?.content === 'string' ? spresetBlock.content : undefined
  )
  const spreset = projectSPreset(spresetConfig)

  // ST `oai_settings.squash_system_messages` (openai.js:1599-1601). An ST chat-completion preset saves
  // the full oai_settings, so this field is present on real imports; coerce to an explicit boolean so an
  // import ALWAYS carries the flag (true → ST selective squash in providerShape; false → RPT merge-all,
  // the current behavior). A native preset never gains the key, so it keeps merge-all (parity).
  //
  // ST per-marker FORMAT strings (openai.js:106 `default_wi_format='{0}'`, :112-113
  // `default_personality_format='{{personality}}'` / `default_scenario_format='{{scenario}}'`). Real ST
  // presets save the full oai_settings, so these are present on imports; default to ST's own defaults when
  // a preset omits them so an import ALWAYS carries all three — their presence is the builder's IMPORT
  // signal (bare charDescription + ST format strings). A native preset never gains them (parity).
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)
  return {
    name: raw.name || fallbackName,
    parameters,
    prompts,
    squash_system_messages: raw.squash_system_messages === true,
    wi_format: str(raw.wi_format, '{0}'),
    personality_format: str(raw.personality_format, '{{personality}}'),
    scenario_format: str(raw.scenario_format, '{{scenario}}'),
    ...(spreset ? { spreset } : {})
  }
}
