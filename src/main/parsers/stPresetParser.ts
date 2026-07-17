import { PromptMarker } from '../types/preset'

/**
 * Maps SillyTavern's built-in prompt identifiers onto our dynamic markers.
 * Identifiers not listed here are treated as literal prompt blocks (their
 * `content` is used verbatim).
 */
const MARKER_MAP: Record<string, PromptMarker> = {
  chatHistory: 'chat_history',
  dialogueExamples: 'mes_example',
  charDescription: 'char_description',
  worldInfoBefore: 'world_info',
  worldInfoAfter: 'world_info',
  personaDescription: 'persona_description'
}

// ST marker prompts whose content we already fold into char_description.
const SKIP_IDENTIFIERS = new Set(['charPersonality', 'scenario'])

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && !Number.isNaN(v) ? v : undefined

/**
 * Normalize a parsed SillyTavern chat-completion preset into our Preset shape
 * ({ name, parameters, prompts }). Honors `prompt_order` if present, otherwise
 * falls back to the raw `prompts` order. Returns null if it isn't a preset.
 */
export const parseStPreset = (raw: any, fallbackName: string): any | null => {
  if (!raw || typeof raw !== 'object') return null
  if (!Array.isArray(raw.prompts)) return null

  const promptsById = new Map<string, any>()
  for (const p of raw.prompts) {
    if (p && p.identifier) promptsById.set(p.identifier, p)
  }

  // prompt_order is an array of { character_id, order: [{ identifier, enabled }] }.
  // Use the first defined order list; otherwise use the prompts array order.
  let order: Array<{ identifier: string; enabled?: boolean }>
  const orderBlock = Array.isArray(raw.prompt_order)
    ? raw.prompt_order.find((o: any) => Array.isArray(o?.order)) || raw.prompt_order[0]
    : null
  if (orderBlock && Array.isArray(orderBlock.order)) {
    order = orderBlock.order
  } else {
    order = raw.prompts.map((p: any) => ({ identifier: p.identifier, enabled: p.enabled }))
  }

  const seenMarkers = new Set<PromptMarker>()
  const prompts: any[] = []

  for (const item of order) {
    const id = item.identifier
    if (!id || SKIP_IDENTIFIERS.has(id)) continue

    const src = promptsById.get(id)
    const marker = MARKER_MAP[id] || 'none'

    if (marker !== 'none') {
      if (seenMarkers.has(marker)) continue // dedupe duplicate dynamic markers
      seenMarkers.add(marker)
      prompts.push({
        identifier: id,
        name: src?.name || id,
        role: src?.role || 'system',
        content: '',
        enabled: item.enabled !== false,
        marker
      })
      continue
    }

    // Literal block — keep only if it actually carries content.
    if (!src || !src.content) continue
    // ST injection_position: 1 = absolute (in-chat at depth), else relative (inline).
    const atDepth = src.injection_position === 1
    prompts.push({
      identifier: id,
      name: src.name || id,
      role: src.role || 'system',
      content: src.content,
      enabled: item.enabled !== false && src.enabled !== false,
      marker: 'none',
      injection_depth: atDepth ? (num(src.injection_depth) ?? 4) : null
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
