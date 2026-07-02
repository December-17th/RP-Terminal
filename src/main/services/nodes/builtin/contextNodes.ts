import { z } from 'zod'
import { stripThinking } from '../../../parsers/contentParser'
import { ChatMessage } from '../../promptBuilder'
import { GenContext } from '../../generation/types'
import { NodeImpl } from '../types'

/**
 * Context-extractor nodes (extractor-nodes plan §2.3-2.5): slice `input.context`'s bundle into
 * individually-wireable pieces (history / card field / persona) so a side branch pulls only
 * what it needs instead of the full turn context — the token-saving decomposition the plan asks
 * for. `prompt.assemble` / the default graph are untouched; these are additive.
 */

const historyConfig = z.object({
  count: z.number().int().min(1).max(50).optional(),
  include: z.enum(['both', 'user', 'assistant']).optional()
})

/** The last N floors as a transcript text block and a role-tagged message list. Assistant
 *  content has thinking stripped (`stripThinking`); both sides are trimmed and empty strings
 *  are skipped. `include` narrows BOTH outputs to one side. */
export const contextHistory: NodeImpl = {
  type: 'context.history',
  title: 'History',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [
    { name: 'transcript', type: 'Text' },
    { name: 'messages', type: 'Messages' }
  ],
  configSchema: historyConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof historyConfig>
    const gen = inputs.gen as GenContext
    const count = cfg.count ?? 4
    const include = cfg.include ?? 'both'
    const lines: string[] = []
    const messages: ChatMessage[] = []
    for (const f of gen.floors.slice(-count)) {
      if (include !== 'assistant') {
        const user = (f.user_message?.content ?? '').trim()
        if (user) {
          lines.push(`User: ${user}`)
          messages.push({ role: 'user', content: user })
        }
      }
      if (include !== 'user') {
        const assistant = stripThinking(f.response?.content ?? '').trim()
        if (assistant) {
          lines.push(`Assistant: ${assistant}`)
          messages.push({ role: 'assistant', content: assistant })
        }
      }
    }
    return { outputs: { transcript: lines.join('\n'), messages } }
  }
}

const cardFieldConfig = z.object({
  field: z.enum(['description', 'personality', 'scenario', 'first_mes', 'name', 'all']).optional()
})

/** narrative field order for `field: 'all'`. */
const ALL_FIELDS = ['name', 'description', 'personality', 'scenario'] as const

/** One (or all) character-card narrative field(s), read-only. `all` joins the non-empty
 *  narrative fields (name/description/personality/scenario) as labelled `[field]\ncontent`
 *  blocks separated by blank lines. */
export const contextCard: NodeImpl = {
  type: 'context.card',
  title: 'Card Field',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'text', type: 'Text' }],
  configSchema: cardFieldConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof cardFieldConfig>
    const gen = inputs.gen as GenContext
    const field = cfg.field ?? 'description'
    if (field === 'all') {
      const text = ALL_FIELDS.map((f) => [f, gen.card.data[f] ?? ''] as const)
        .filter(([, v]) => v)
        .map(([f, v]) => `[${f}]\n${v}`)
        .join('\n\n')
      return { outputs: { text } }
    }
    return { outputs: { text: gen.card.data[field] ?? '' } }
  }
}

/** The active persona's name + description (no config). */
export const contextPersona: NodeImpl = {
  type: 'context.persona',
  title: 'Persona',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [
    { name: 'name', type: 'Text' },
    { name: 'text', type: 'Text' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    return { outputs: { name: gen.userName, text: gen.settings.persona?.description || '' } }
  }
}
