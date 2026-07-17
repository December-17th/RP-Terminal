import { PromptMarker } from '../types/preset'

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
 * Select the single `prompt_order` list ST's Prompt Manager would resolve against.
 * `prompt_order` is an array of `{ character_id, order: [{ identifier, enabled }] }`;
 * ST resolves order via the dummy character id 100001, so prefer that record, else
 * the first entry that carries an `order` array, else the first entry outright.
 *
 * Returns that entry's `order` array (possibly empty), or `null` when there is no
 * usable `prompt_order` at all (caller then falls back to the raw `prompts` order).
 *
 * SHARED so `computePresetInventory` (presetService) resolves enablement from the
 * exact same list this parser assembles from — the two MUST NOT drift (a first-seen
 * union across every list reports wrong enabled counts on dual-order-list presets).
 */
export const selectPromptOrder = (
  raw: any
): Array<{ identifier: string; enabled?: boolean }> | null => {
  if (!Array.isArray(raw?.prompt_order)) return null
  const block =
    raw.prompt_order.find((o: any) => o?.character_id === 100001 && Array.isArray(o?.order)) ||
    raw.prompt_order.find((o: any) => Array.isArray(o?.order)) ||
    raw.prompt_order[0]
  return block && Array.isArray(block.order) ? block.order : null
}

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

  return { name: raw.name || fallbackName, parameters, prompts }
}
