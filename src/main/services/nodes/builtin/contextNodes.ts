import { z } from 'zod'
import { stripThinking } from '../../../parsers/contentParser'
import { ChatMessage } from '../../promptBuilder'
import { GenContext } from '../../generation/types'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'

/**
 * Context-extractor nodes (extractor-nodes plan §2.3-2.5, + the decomposed-default additions):
 * slice `input.context`'s bundle into individually-wireable pieces (history / card field /
 * persona / current action / sampler params) so a graph pulls only what it needs instead of
 * the full turn context. `prompt.assemble` / the default graph are untouched; these are
 * additive — together they let a workflow author a full main prompt from components (the
 * decomposed-default example workflow) without the opaque assemble node.
 */

/** Macro+EJS-expand an extractor's text when its `expand` config is on. Card/persona fields are
 *  AUTHORED content — the same trust class the assemble path expands — unlike upstream node
 *  outputs, which `interpolate` deliberately treats as data (an LLM reply must never run as a
 *  template). That is why expansion is an extractor-side flag rather than a generic
 *  expand-anything node. */
const maybeExpand = (text: string, expand: boolean | undefined, gen: GenContext): string =>
  expand ? interpolate(text, {}, gen) : text

const historyConfig = z.object({
  count: z.number().int().min(1).max(50).optional(),
  include: z.enum(['both', 'user', 'assistant']).optional()
})

/** The last N floors as a transcript text block and a role-tagged message list. Assistant
 *  content has thinking stripped (`stripThinking`); both sides are trimmed and empty strings
 *  are skipped. `include` narrows BOTH outputs to one side.
 *
 *  Optional `span` input (table-maintenance cadence fix): a wired `{ from, to }` (0-based,
 *  inclusive floor indices — the shape `table.gate` emits) selects EXACTLY that floor range
 *  instead of the trailing `count`, so a maintenance pass that runs every N floors covers
 *  precisely the aged-in span with no gaps or overlap. A dead/absent/malformed span falls back
 *  to `count` (the edge is dead on turns the gate doesn't fire — `Any`, not `Signal`, so it
 *  never gates this node off; the same convention as context.refresh's `after`). Indices are
 *  clamped to the available floors. */
export const contextHistory: NodeImpl = {
  type: 'context.history',
  title: 'History',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'span', type: 'Any' }
  ],
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
    const span = inputs.span as { from?: unknown; to?: unknown } | undefined
    const hasSpan =
      span != null && typeof span.from === 'number' && typeof span.to === 'number'
    const selected = hasSpan
      ? gen.floors.slice(
          Math.max(0, Math.trunc(span.from as number)),
          Math.max(0, Math.trunc(span.to as number)) + 1
        )
      : gen.floors.slice(-count)
    const lines: string[] = []
    const messages: ChatMessage[] = []
    for (const f of selected) {
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
  field: z.enum(['description', 'personality', 'scenario', 'first_mes', 'name', 'all']).optional(),
  /** Run context macros ({{user}}/{{char}}/{{getvar}}) + EJS over the field text, like the
   *  assemble path does. Off by default (raw field). */
  expand: z.boolean().optional()
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
      return { outputs: { text: maybeExpand(text, cfg.expand, gen) } }
    }
    return { outputs: { text: maybeExpand(gen.card.data[field] ?? '', cfg.expand, gen) } }
  }
}

const personaConfig = z.object({
  /** Same knob as context.card: macro+EJS-expand the description. */
  expand: z.boolean().optional()
})

/** The active persona's name + description. */
export const contextPersona: NodeImpl = {
  type: 'context.persona',
  title: 'Persona',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [
    { name: 'name', type: 'Text' },
    { name: 'text', type: 'Text' }
  ],
  configSchema: personaConfig,
  run: (_ctx, inputs, node) => {
    const cfg = (node.config ?? {}) as z.infer<typeof personaConfig>
    const gen = inputs.gen as GenContext
    return {
      outputs: {
        name: gen.userName,
        text: maybeExpand(gen.settings.persona?.description || '', cfg.expand, gen)
      }
    }
  }
}

/** The user's CURRENT pending action (the message being answered this turn) — the one piece of
 *  the turn a decomposed prompt cannot get anywhere else: history nodes only see persisted
 *  floors, and template constants deliberately exclude it. */
export const contextAction: NodeImpl = {
  type: 'context.action',
  title: 'User Action',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'text', type: 'Text' }],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    return { outputs: { text: gen.userAction } }
  }
}

/** The active preset's sampler parameters, with the same FSM-mode output cap the assemble path
 *  applies (agentic mode clamps max_tokens to the mode's limit, never above the preset's own).
 *  Wire this into llm.sample's `params` when the prompt is composed WITHOUT prompt.assemble —
 *  the providers dereference params, so a composed main path must not leave it unwired. */
export const contextParams: NodeImpl = {
  type: 'context.params',
  title: 'Preset Params',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'params', type: 'Any' }],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const presetMax = gen.preset.parameters.max_tokens
    const maxTokens = gen.fsmEnabled
      ? presetMax != null
        ? Math.min(presetMax, gen.modeConfig.max_output_tokens)
        : gen.modeConfig.max_output_tokens
      : presetMax
    return { outputs: { params: { ...gen.preset.parameters, max_tokens: maxTokens } } }
  }
}
