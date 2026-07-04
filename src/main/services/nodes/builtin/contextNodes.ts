import { z } from 'zod'
import { stripThinking } from '../../../parsers/contentParser'
import { ChatMessage } from '../../promptBuilder'
import { GenContext } from '../../generation/types'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { getProgress } from '../../tableProgressService'
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
    const hasSpan = span != null && typeof span.from === 'number' && typeof span.to === 'number'
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

// ── context.trimProcessed — the async-memory INLINE history trimmer (agent-packs plan WP2.4) ─────
//
// The flagship async-memory pack (ADR 0009's motivating case) attaches this INLINE at `context-ready`:
// the main message flow is wired THROUGH it (compose.ts inline reroute), so its OUTPUT Context replaces
// the anchor value for every downstream consumer (assemble/llm/parse/write). It transforms the Context
// so the assembled prompt carries only the exchanges AFTER the committed maintenance progress pointer —
// the aged-in floors have already been folded into the memory tables (which rejoin as the table export),
// so re-sending their raw transcript would be redundant. This is the "inline history trimming against
// the committed pointer" of ADR 0003's coordination story.
//
// WHERE THE TRIM ACTUALLY BITES. `prompt.assemble` builds the sent history from `gen.floors`
// (assemble.ts:148-216 `buildPrompt({... floors ...})` + the `data.messages` map, assemble.ts:203-206),
// and every message-index/`lastCharMessage` macro is derived from `gen.floors` too. So trimming the
// history the prompt carries == replacing `gen.floors` with a suffix slice. We rebuild the Context with
// a sliced `floors` (and re-pin `lastFloor` to the new last element); NOTHING ELSE about the Context
// changes (workingVars, scanText, lorebooks, preset — all still reflect the full committed state). We do
// NOT re-run buildGenContext: it would re-read the FULL floor set from disk and undo the trim.
//
// THE POINTER (fail-soft — ADR 0003). The pointer is the committed per-table maintenance progress
// (`tableProgressService.getProgress` → `Record<sqlName, lastFloor>`), the SAME pointer the headless
// compactor advances (table.gate.advanceProgress) and the Tables view reads. Floors at index ≤ pointer
// are "processed" (already summarized) and get trimmed; floors > pointer are kept verbatim.
//   · No template / no progress rows / pointer < 0 (nothing processed, or compaction hasn't landed yet)
//     → the pointer is -1 → NOTHING is trimmed → the prompt carries the FULL history (fail-soft: a
//     mid-flight or never-run compaction means the pointer has NOT advanced, so we never drop floors the
//     tables don't yet cover — ADR 0003's "if the run hasn't landed, the next prompt simply carries the
//     untrimmed history").
//   · The SAFE pointer across a multi-table template is the MINIMUM last-processed floor over the
//     tables in scope: trimming past ANY table's pointer would drop floors that table has not yet folded
//     in. A never-processed table (absent from getProgress) counts as -1 and therefore pins the minimum
//     to -1 → no trim — the strictest fail-soft reading of "NEVER trim past the pointer".
//   · Config `table` (optional): narrow the pointer to ONE table's sqlName instead of the min over all.
//     Unset = the min over every template table (the safe default). A v0 note: WHICH table (or the whole
//     set) a pack watches will become a System trigger-param once override materialization exists
//     (agentPackService overrides are stored+resolved but not yet fed into fragment docs — see
//     agentPackService.ts v0 NOTE); for now the pack hard-codes its binding in the fragment.
//
// It runs before ANY model call and never writes state — a pure Context→Context transform, exactly like
// context.refresh's shape. Fail-open: an empty/absent history, or a pointer beyond the history, yields
// an unchanged (or empty) `floors` and NEVER throws.
const trimProcessedConfig = z.object({
  /** Restrict the pointer to ONE table's sqlName; unset = the MINIMUM last-processed floor over every
   *  template table (the safe default — never trims past any table's un-summarized backlog). */
  table: z.string().optional()
})

/** Resolve the committed progress pointer (the highest floor index safely trimmable) for a chat: the
 *  min last-processed floor over the in-scope template tables, treating a never-processed table as -1.
 *  Returns -1 (⇒ no trim) when there is no template, no tables, or a table has never been processed. */
const resolveProcessedPointer = (gen: GenContext, only?: string): number => {
  const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
  const template = templateId ? getTableTemplateById(gen.profileId, templateId) : null
  if (!template) return -1 // no table memory on this chat → nothing is "processed" → carry full history

  const scopeNames = only
    ? template.tables.filter((t) => t.sqlName === only).map((t) => t.sqlName)
    : template.tables.map((t) => t.sqlName)
  if (!scopeNames.length) return -1 // named table not in this template (or empty template) → no trim

  const progress = getProgress(gen.profileId, gen.chatId)
  // MIN over the scope; a table absent from the store has never been processed → -1 pins the min to -1.
  let min = Infinity
  for (const name of scopeNames) min = Math.min(min, progress[name] ?? -1)
  return min === Infinity ? -1 : min
}

export const contextTrimProcessed: NodeImpl = {
  type: 'context.trimProcessed',
  title: 'Trim Processed History',
  inputs: [{ name: 'gen', type: 'Context' }],
  outputs: [{ name: 'gen', type: 'Context' }],
  configSchema: trimProcessedConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = (node.config ?? {}) as z.infer<typeof trimProcessedConfig>

    const pointer = resolveProcessedPointer(gen, cfg.table)
    // pointer < 0 → nothing processed / no template / compaction not landed → carry the FULL history
    // (fail-soft, ADR 0003). Also a no-op when there is nothing to drop.
    if (pointer < 0 || gen.floors.length === 0) return { outputs: { gen } }

    // Floors at index ≤ pointer are already folded into the tables → drop them; keep index > pointer.
    // slice(pointer + 1) never trims PAST the pointer, and clamps naturally when the pointer is beyond
    // the history (→ empty tail). lastFloor is re-pinned so every lastFloor-derived read stays coherent.
    const kept = gen.floors.slice(pointer + 1)
    if (kept.length === gen.floors.length) return { outputs: { gen } } // nothing to drop
    return {
      outputs: {
        gen: { ...gen, floors: kept, lastFloor: kept[kept.length - 1] }
      }
    }
  }
}
