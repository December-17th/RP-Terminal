import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { ChatMessage } from '../../promptBuilder'
import { TableTemplate } from '../../../types/tableTemplate'
import { LorebookEntry } from '../../../types/character'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'
import {
  runLlmCall,
  llmCallConfigSchema,
  buildLlmCallConfig,
  presetParamsWithTemperature
} from './generationNodes'
import { extractTagAll } from './parseNodes'
import { chatTemplate, recentTranscript, historyText, composedPromptDebug } from './memoryCore'
import { readAllTables, TableRead } from '../../tableDbService'
import { renderCatalog, synthesizeEntries, filterEntriesByCodes } from '../../tableExportService'
import { readNotes } from '../../notesMemoryService'
import {
  parseNotesSections,
  grepSections,
  formatHits,
  SectionHit
} from '../../../../shared/memory/notesGrep'
import { RECALL_PLANNER_MESSAGES, RECALL_DIRECTIVE } from './defaultRecallPrompts'

/**
 * `memory.recall` — the PRE-turn plot-recall PLANNER node (plot-recall WP4; design
 * docs/plot-recall-memory-design.md §Approach/§Node contract). It is the READER the write side
 * (`memory.maintain` + the imported template's `AM/MT` code rules) has been missing: one side LLM
 * call picks the memory codes relevant to the pending action from the always-on catalogue, then the
 * selected chronicle rows are fetched DETERMINISTICALLY (by exact key, NOT the lexical matcher — the
 * deliberate divergence in the design) and composed into ONE tail `block` for `prompt.assemble.block`.
 *
 * It COMPOSES the shared cores — never reimplements them: `chatTemplate`/`recentTranscript`/
 * `historyText`/`composedPromptDebug` (memoryCore), `runLlmCall`/`buildLlmCallConfig`/
 * `presetParamsWithTemperature` (generationNodes), `extractTagAll` (parseNodes), `renderCatalog`/
 * `synthesizeEntries`/`filterEntriesByCodes` (tableExportService, WP3), and `parseNotesSections`/
 * `grepSections`/`formatHits` (shared/memory/notesGrep, WP1). The default `messages`/`directive`
 * CONTENT lives in a separate file (`defaultRecallPrompts.ts`) so WP5 replaces prose without touching
 * this logic.
 *
 * run() sequence (design §Approach 1–5):
 *   1. Corpus check — a bound template with an `extraIndexEnabled` table (after `recall_tables`
 *      narrowing) OR a non-empty notes file. Both empty → `{outputs:{}}`, ZERO model calls (an unwired
 *      or idle chat is byte-identical to before).
 *   2. Compose the planner prompt: catalogue (renderCatalog) + notes TOC (parseNotesSections headings)
 *      + recent transcript + pending action + the PREVIOUS plan (node state, dropped when rewind-stale).
 *      Model-derived slot data is substituted as INERT DATA (split/join AFTER interpolate), the same
 *      discipline as `composeMaintainerMessages`.
 *   3. ONE side call (`runLlmCall`, stream defaults false). Abort-with-empty → `{outputs:{}, debug}`.
 *   4. Parse `<Recall>` (codes) / `<Query>` (note greps) / `<QuestPlan>` / `<StoryEngine>`. Codes →
 *      `synthesizeEntries` → `filterEntriesByCodes` (invented codes drop out; cap `max_rows`). Queries →
 *      `grepSections`/`formatHits` (caps `max_note_sections`/`max_chars`). Compose ONE `block` from the
 *      `directive` template; `report` = counts summary.
 *   5. Persist `{floor, questPlan, storyEngine}` for next turn.
 *
 * Failure = FAIL-OPEN (design §Node contract): a side-call error throws a NodeRunFailure the engine
 * routes on the wired `error` port (matching `memory.maintain`); wired as a branch fragment (WP5's
 * example workflow) it fails open even in the pre-phase, so the turn is never blocked by recall.
 */

const recallMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
})

export const recallConfig = llmCallConfigSchema.extend({
  /** The planner scaffold (role-alternating), routed to the Prompt editor (promptFields). Defaults to
   *  the placeholder content in defaultRecallPrompts.ts (WP5 replaces that file's content). */
  messages: z.array(recallMessageSchema).default(RECALL_PLANNER_MESSAGES),
  /** Overrides the preset's temperature for THIS call when set (0..2). */
  temperature: z.number().min(0).max(2).optional(),
  /** Trailing floors of transcript in the planner prompt. Default 3 (shujuku's contextTurnCount). */
  lastNFloors: z.number().int().min(1).max(50).optional(),
  /** Hard cap on recalled chronicle rows. Default 24. An explicit 0 recalls nothing. */
  max_rows: z.number().int().min(0).optional(),
  /** Cap on note sections included from `<Query>` greps. Default 6. */
  max_note_sections: z.number().int().min(0).optional(),
  /** Optional hard character cap on the rendered note block. */
  max_chars: z.number().int().min(0).optional(),
  /** The composition template for the tail block ({{StoryEngine}}/{{QuestPlan}}/{{recalled}}/{{notes}}). */
  directive: z.string().optional(),
  /** CSV of table sqlNames to catalogue/fetch (narrowing). Empty/unset → every extraIndex table. */
  recall_tables: z.string().optional()
})

type RecallConfig = z.infer<typeof recallConfig>

const DEFAULT_LAST_N_FLOORS = 3
const DEFAULT_MAX_ROWS = 24
const DEFAULT_MAX_NOTE_SECTIONS = 6

/** The `{history}` splice marker (a whole-content row REPLACED by the history messages — memory.maintain). */
const HISTORY_MARKER = '{history}'

/** The previous-turn plan persisted in node state (design §Plan persistence). */
interface RecallPlanState {
  floor: number
  questPlan: string
  storyEngine: string
}

/** Narrow a template to the `recall_tables` subset (by sqlName). Empty/unset CSV → the whole template. */
const narrowTemplate = (template: TableTemplate, csv: string | undefined): TableTemplate => {
  const only = (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!only.length) return template
  const set = new Set(only)
  return { ...template, tables: template.tables.filter((t) => set.has(t.sqlName)) }
}

/** True when the template has an ENABLED table with an always-on index — the catalogue's source rows
 *  (exactly `renderCatalog`'s gating). No such table → the table corpus is empty. */
const hasCatalogueTable = (template: TableTemplate): boolean =>
  template.tables.some((t) => t.exportConfig.enabled && t.exportConfig.extraIndexEnabled)

/** Split `<Recall>` bodies into codes: split on commas/whitespace, trim, drop empties, dedupe
 *  (first-seen order). */
const parseCodes = (bodies: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const body of bodies) {
    for (const tok of body.split(/[\s,]+/)) {
      const code = tok.trim()
      if (code && !seen.has(code)) {
        seen.add(code)
        out.push(code)
      }
    }
  }
  return out
}

/** The notes table-of-contents the planner sees: one `## heading` line per section (with its keyword
 *  hints in parens). */
const renderNotesToc = (notes: string): string =>
  parseNotesSections(notes)
    .map((s) => (s.keywords.length ? `## ${s.heading} (${s.keywords.join(', ')})` : `## ${s.heading}`))
    .join('\n')

/** The previous plan rendered for the `{{plan}}` slot ('' when none). */
const renderPrevPlan = (prev: RecallPlanState | null): string =>
  prev ? [prev.questPlan, prev.storyEngine].filter(Boolean).join('\n\n') : ''

interface RecallSlots {
  catalogue: string
  notesToc: string
  action: string
  plan: string
}

/**
 * Compose the fully-shaped planner prompt. Interpolate the authored scaffold (macros/EJS) FIRST, then
 * substitute every model-derived slot as INERT DATA (split/join) so an LLM's previous plan, the
 * transcript, or the catalogue can never inject executable template code — the exact
 * `composeMaintainerMessages` discipline. A row that is EXACTLY `{history}` splices the transcript
 * role-preserving; an inline `{history}` flattens it into text.
 */
export const composeRecallMessages = (
  gen: GenContext,
  cfg: Pick<RecallConfig, 'messages' | 'lastNFloors'>,
  slots: RecallSlots
): ChatMessage[] => {
  const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors ?? DEFAULT_LAST_N_FLOORS })
  const rows: ChatMessage[] = []
  for (const m of cfg.messages) {
    if (m.content.trim() === HISTORY_MARKER) {
      rows.push(...history)
      continue
    }
    const interpolated = interpolate(m.content, {}, gen)
    const filled = interpolated
      .split('{{catalogue}}')
      .join(slots.catalogue)
      .split('{{notes_toc}}')
      .join(slots.notesToc)
      .split('{{action}}')
      .join(slots.action)
      .split('{{plan}}')
      .join(slots.plan)
      .split(HISTORY_MARKER)
      .join(historyText(history))
    rows.push({ role: m.role, content: filled })
  }
  return providerShape(gen.settings, rows)
}

export const memoryRecall: NodeImpl = {
  type: 'memory.recall',
  title: 'Recall',
  // The planner scaffold is routed to the dedicated Prompt editor.
  promptFields: ['messages'],
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'block', type: 'Text' },
    { name: 'report', type: 'Text' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: recallConfig,
  run: async (ctx, inputs, node) => {
    const cfg = node.config as RecallConfig
    // Prefer the upstream input.context bundle; self-seed only when run headless/without it.
    const gen: GenContext =
      (inputs.gen as GenContext | undefined) ??
      buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction ?? '')

    // 1. Corpus check. A bound template with an extraIndex table (after narrowing) and/or notes.
    const bound = chatTemplate(gen)
    const template = bound ? narrowTemplate(bound, cfg.recall_tables) : null
    const hasTables = !!template && hasCatalogueTable(template)
    const notes = readNotes(gen.profileId, gen.chatId)
    const hasNotes = notes.trim().length > 0
    // Both corpora empty → no-op, NO model call (byte-identical when unwired/idle).
    if (!hasTables && !hasNotes) return { outputs: {} }

    // Rows for both the catalogue AND the deterministic code fetch (one read, reused).
    const reads: TableRead[] = template ? readAllTables(gen.profileId, gen.chatId, template) : []

    // 2. Compose the planner prompt. Previous plan is dropped when rewind-stale (stored floor is ahead
    //    of the current floor count).
    const storedPlan = ctx.getNodeState(node.id) as RecallPlanState | undefined
    const prevPlan =
      storedPlan && typeof storedPlan.floor === 'number' && storedPlan.floor <= gen.floors.length
        ? storedPlan
        : null
    const slots: RecallSlots = {
      catalogue: template ? renderCatalog(template, reads) : '',
      notesToc: renderNotesToc(notes),
      action: gen.userAction,
      plan: renderPrevPlan(prevPlan)
    }
    const sendMessages = composeRecallMessages(gen, cfg, slots)
    const promptDebug = composedPromptDebug(sendMessages)

    // 3. One side call — stream defaults to false (a planner reply is never the player-facing stream).
    const params = presetParamsWithTemperature(gen, cfg.temperature)
    const callCfg = buildLlmCallConfig(cfg)
    const r = await runLlmCall(ctx, gen, sendMessages, params, callCfg)
    // Abort-with-empty: nothing to plan; still trace the prompt so the empty result is diagnosable.
    if (r === null) return { outputs: {}, debug: promptDebug }

    // 4. Parse the reply's tag families.
    const codes = parseCodes(extractTagAll(r.raw, 'Recall'))
    const queries = extractTagAll(r.raw, 'Query')
      .map((q) => q.trim())
      .filter(Boolean)
    const questPlan = extractTagAll(r.raw, 'QuestPlan').join('\n').trim()
    const storyEngine = extractTagAll(r.raw, 'StoryEngine').join('\n').trim()

    // Codes → rows: exact-key filter over the synthesized per-row entries (invented codes drop out,
    // cap max_rows). NO SQL is built from LLM output.
    const maxRows = cfg.max_rows ?? DEFAULT_MAX_ROWS
    let recalled: LorebookEntry[] = []
    if (template && codes.length) {
      recalled = filterEntriesByCodes(synthesizeEntries(template, reads), codes, maxRows)
    }
    const recalledText = recalled.map((e) => e.content).join('\n\n')

    // Queries → note sections (CJK-safe grep). Only when the model asked.
    const sections = parseNotesSections(notes)
    const hits: SectionHit[] = []
    for (const q of queries) hits.push(...grepSections(sections, q))
    const notesBlock = queries.length
      ? formatHits(hits, {
          maxSections: cfg.max_note_sections ?? DEFAULT_MAX_NOTE_SECTIONS,
          ...(cfg.max_chars != null ? { maxChars: cfg.max_chars } : {})
        })
      : ''

    // Compose ONE tail block from the directive template (inert-data slots; empty slots collapse).
    const directive = cfg.directive ?? RECALL_DIRECTIVE
    const block = directive
      .split('{{StoryEngine}}')
      .join(storyEngine)
      .split('{{QuestPlan}}')
      .join(questPlan)
      .split('{{recalled}}')
      .join(recalledText)
      .split('{{notes}}')
      .join(notesBlock)
      .trim()

    // 5. Persist the plan for next turn (floor-keyed for rewind-staleness on read).
    ctx.setNodeState(node.id, { floor: gen.floors.length, questPlan, storyEngine })

    const report = `recalled ${recalled.length} of ${codes.length} code(s), ${hits.length} note section(s)`
    return { outputs: { block, report }, debug: promptDebug }
  }
}
