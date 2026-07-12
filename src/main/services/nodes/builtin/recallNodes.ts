import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { ChatMessage } from '../../promptBuilder'
import { TableTemplate, TableDef } from '../../../types/tableTemplate'
import { LorebookEntry } from '../../../types/character'
import { NodeError, NodeImpl, NodeRunFailure } from '../types'
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
 * Failure = FAIL-OPEN, wiring-independent (design §Node contract: "never block the turn"). This node
 * is a PRE-phase ancestor of the main output when wired ctx → recall → assemble.block, and the
 * engine's throw path is FATAL for an unwired pre-phase failure (workflowEngine runNodes — the
 * `phase === 'pre' && !state.failOpen.has(id)` rule; `state.failOpen` only fills from composed-pack
 * branch modes, so a hand-wired doc gets no fail-open shield). memory.maintain can afford to throw
 * because it is post-phase; recall must NOT. So a runtime side-call failure is CAUGHT inside run()
 * and returned as a value that MATCHES the engine's throw-path error semantics via the A2 dead-port
 * affordance (NodeResult.deadPorts / failedOpen): the NodeError is emitted on the node's OWN `error`
 * output, the NON-error ports (`block`, `report`) are declared DEAD so downstream non-error branches
 * are pruned (assemble reads its `block` input unwired — the narrator-spine shape), and `failedOpen`
 * tints the trace so the fail-open is not invisible behind a green row. On SUCCESS the reverse: the
 * `error` port is declared dead so a wired error branch fires EXACTLY when recall failed (never on a
 * good turn delivering `undefined`). The failure stays observable via `report` + the run-trace
 * `debug`. Config/schema errors keep normal semantics (the engine parses config BEFORE run()).
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
  recall_tables: z.string().optional(),
  /** Emit the display-only `plot_block` directive (plot-recall data layer) on the `plot_block` output.
   *  Default ON — only OMITTED when explicitly `false`. It is only produced when the planner actually
   *  ran (a reply exists); an empty corpus or an aborted call never yields a plot_block. */
  emit_plot_block: z.boolean().optional()
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

/**
 * Recall fetches rows by matching the planner's codes against the PER-ROW keyword entries
 * `synthesizeEntries` emits (`filterEntriesByCodes`). That only bites when a catalogue table is shaped
 * so each row becomes an individually code-keyed entry: `splitByRow` (one entry per row, not one
 * whole-table entry), `entryType: 'keyword'` (keyed, not always-on constant — a constant entry carries
 * `keys: []`), AND at least one keyword-producing column so the code actually lands in `keys` (a
 * `keywords` column, or an `extraIndex` column in `'both'` mode — the code column). A table can list
 * rows in the catalogue (`enabled + extraIndexEnabled`, so the planner SEES codes) yet satisfy none of
 * these, in which case every recalled code silently matches nothing and the report reads "recalled 0 of
 * N" with no clue why. Returns a DISTINCT reason naming the mis-shaped tables, or '' when at least one
 * catalogue table is correctly shaped. Cheap + pure over `exportConfig` — no I/O; mirrors
 * `synthesizeEntries`' keyword-key derivation so the check and the fetch never disagree.
 */
const recallShapeIssue = (template: TableTemplate): string => {
  const catalogue = template.tables.filter(
    (t) => t.exportConfig.enabled && t.exportConfig.extraIndexEnabled
  )
  const codeKeyed = (t: TableDef): boolean => {
    const ec = t.exportConfig
    const hasKeyColumn =
      ec.keywords.split(',').some((c) => c.trim()) ||
      ec.extraIndexColumns.some((c) => ec.extraIndexColumnModes[c] === 'both')
    return ec.splitByRow && ec.entryType === 'keyword' && hasKeyColumn
  }
  if (catalogue.some(codeKeyed)) return ''
  const names = catalogue.map((t) => t.sqlName).join(', ')
  return `table ${names} has no code-keyed per-row entries — recall needs splitByRow + keyword entryType + extraIndex on the code column`
}

/** Split `<Recall>` bodies into codes: split on commas/whitespace, trim, drop empties, dedupe
 *  (first-seen order). */
const parseCodes = (bodies: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const body of bodies) {
    for (const tok of body.split(/[\s,，、;；]+/)) {
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

/**
 * Compose the DISPLAY-ONLY `plot_block` directive (plot-recall data layer) from the planner's output.
 * This block is NOT part of the model prompt — it is persisted on the floor for a later renderer to
 * beautify. Its shape is dictated by the user-installed SillyTavern "剧情推进美化正则" (regex
 * 20de25c7…): its `findRegex` — `/(^\s*(?:(?:以下|以上)是(?:用户|Participant)的本轮输入|<用户本轮输入>)…$/m`
 * — must MATCH (so the block opens with the `<用户本轮输入>` marker), and its render JS re-parses the
 * matched text with `getTag(raw, tag)` = `<tag(?=[\s>])[^>]*>(…)</tag>` for `用户本轮输入`/`Recall` and
 * `renderQuestPlan` = `<QuestPlan>(…)</QuestPlan>`. So each planning family is emitted as a CLOSED tag
 * verbatim. Pure + total (never throws) so it is unit-testable against the live findRegex. A family with
 * an empty body is dropped, but the `<用户本轮输入>` marker is ALWAYS present so `findRegex` still fires.
 */
export const buildPlotBlock = (parts: {
  action: string
  questPlan: string
  recall: string
  storyEngine: string
}): string => {
  const segments: string[] = [`<用户本轮输入>\n${parts.action.trim()}\n</用户本轮输入>`]
  const closedTag = (name: string, body: string): void => {
    const b = body.trim()
    if (b) segments.push(`<${name}>\n${b}\n</${name}>`)
  }
  closedTag('QuestPlan', parts.questPlan)
  // The beautifier's recalled-rows JS extracts codes via /AM\d+/; this project's chronicle uses MT####,
  // so map MT→AM in the <Recall> body (owner decision) so the original HTML's recalled-list populates.
  closedTag('Recall', parts.recall.replace(/MT(\d+)/g, 'AM$1'))
  closedTag('StoryEngine', parts.storyEngine)
  return segments.join('\n\n')
}

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
    // Display-only directive for the beautification regex (plot-recall data layer). Emitted only when a
    // planner reply exists AND `emit_plot_block !== false`; otherwise simply absent from `outputs`.
    { name: 'plot_block', type: 'Text' },
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
    // Both corpora empty → no-op, NO model call (byte-identical when unwired/idle). Declare `error`
    // dead (A2) so a wired error edge stays inert rather than delivering `undefined`.
    if (!hasTables && !hasNotes) return { outputs: {}, deadPorts: ['error'] }

    // Rows for both the catalogue AND the deterministic code fetch (one read, reused).
    const reads: TableRead[] = template ? readAllTables(gen.profileId, gen.chatId, template) : []

    // 2. Compose the planner prompt. Previous plan is dropped when rewind-stale (stored floor is ahead
    //    of the current floor count). NOTE: persistence is FLOOR-COUNT-keyed, not message-anchored — so a
    //    SAME-LENGTH rewind/regenerate or swipe (floor count unchanged) keeps the previous plan, which is
    //    only advisory. This deliberately diverges from the reference, which anchors the plan to a specific
    //    message id and would discard it on any regenerate of that message.
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
    // FAIL-OPEN (see the module header): a runtime side-call failure must never abort the turn, and
    // this node runs PRE-phase where an uncaught throw with `error` unwired is fatal. So the failure
    // is caught HERE and returned as a value on the node's own `error` output — a wired error edge
    // receives it, an unwired one is inert, and the missing `block` output leaves assemble's `block`
    // input unwired (the narrator-spine shape). The turn always generates.
    const params = presetParamsWithTemperature(gen, cfg.temperature)
    const callCfg = buildLlmCallConfig(cfg)
    let r: Awaited<ReturnType<typeof runLlmCall>>
    try {
      r = await runLlmCall(ctx, gen, sendMessages, params, callCfg)
    } catch (err) {
      const f = err instanceof NodeRunFailure ? err : undefined
      const nodeError: NodeError = {
        kind: f?.kind ?? 'A',
        message: err instanceof Error ? err.message : String(err),
        ...(f?.code !== undefined ? { code: f.code } : {}),
        nodeId: node.id,
        attempts: f?.attempts ?? 1
      }
      // FAIL-OPEN (A2): the side call failed but the turn must NOT abort. Emit the error on the `error`
      // port and mark the node failed-open (trace warning tint, A3). Declare the NON-error ports dead so
      // downstream non-error branches don't fire — mirroring the throw path, which kills all non-error
      // edges — while the turn STILL proceeds (we return a value, never throw). A pruned `block` leaves
      // assemble's `block` input unwired (the narrator-spine shape) instead of delivering `undefined`.
      // The failure stays observable via `report` (shown in the trace preview) + the debug entry.
      return {
        outputs: { report: `recall failed open: ${nodeError.message}`, error: nodeError },
        debug: { ...promptDebug, 'recall error (failed open)': nodeError.message },
        deadPorts: ['block', 'report'],
        failedOpen: true
      }
    }
    // Abort-with-empty: nothing to plan; still trace the prompt so the empty result is diagnosable.
    // `error` port produced no value → declare it dead (A2) so a wired error edge stays inert.
    if (r === null) return { outputs: {}, debug: promptDebug, deadPorts: ['error'] }

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

    // Queries → note sections (CJK-safe grep). Only when the model asked. A single section hit by two
    // <Query> tags would otherwise appear twice AND burn two of the max_note_sections budget, so dedupe
    // by heading BEFORE formatHits — keeping first-seen order (the first query's hit wins).
    const sections = parseNotesSections(notes)
    const seenHeadings = new Set<string>()
    const hits: SectionHit[] = []
    for (const q of queries) {
      for (const hit of grepSections(sections, q)) {
        if (seenHeadings.has(hit.section.heading)) continue
        seenHeadings.add(hit.section.heading)
        hits.push(hit)
      }
    }
    const notesBlock = queries.length
      ? formatHits(hits, {
          maxSections: cfg.max_note_sections ?? DEFAULT_MAX_NOTE_SECTIONS,
          ...(cfg.max_chars != null ? { maxChars: cfg.max_chars } : {})
        })
      : ''

    // Compose ONE tail block from the directive template (inert-data slots; empty slots collapse). NOTE:
    // recalled rows go INLINE into this single tail block (consumed downstream by prompt.assemble.block),
    // so a chronicle template's per-row `entryPlacement` (depth/order) has NO effect on recall output —
    // those fields only govern the SEPARATE lexical table.export → prompt.assemble.entries path. Template
    // authors copying reference depth/order configs should not expect them to reposition recalled rows.
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

    let report = `recalled ${recalled.length} of ${codes.length} code(s), ${hits.length} note section(s)`
    // Template-shape hint: the planner asked for codes but NONE resolved. If the bound catalogue tables
    // are not shaped for per-row code fetch, say so DISTINCTLY (report + debug) instead of a bare
    // "recalled 0 of N". Fail-open — never throws; a mis-configured table just gets an explanation.
    const shapeIssue =
      template && codes.length && recalled.length === 0 ? recallShapeIssue(template) : ''
    const debug = shapeIssue ? { ...promptDebug, 'recall shape issue': shapeIssue } : promptDebug
    if (shapeIssue) report += ` — ${shapeIssue}`

    // Display-only plot_block (plot-recall data layer): a planner reply exists here (r is non-null past
    // the abort gate), so emit unless explicitly suppressed. It carries the user action + the planner's
    // planning tags VERBATIM for the beautification regex; it is NOT part of any prompt. When suppressed
    // or unproduced upstream, the port is simply absent (its sole consumer, output.writeFloor, persists
    // it only when present — undefined-tolerant), so no deadPorts entry is needed.
    const outputs: Record<string, unknown> = { block, report }
    if (cfg.emit_plot_block !== false) {
      outputs.plot_block = buildPlotBlock({
        action: gen.userAction,
        questPlan,
        recall: extractTagAll(r.raw, 'Recall')
          .map((s) => s.trim())
          .filter(Boolean)
          .join('\n'),
        storyEngine
      })
    }
    // SUCCESS: the `error` port produced no value, so declare it DEAD (A2). Without this, a live
    // error edge on a good turn delivers `undefined` — indistinguishable from a fired error branch —
    // so `log-recall` logs "undefined" and any smarter consumer (retry/notify) fires every turn. Now
    // a wired error branch runs EXACTLY when recall fails open, matching the engine's throw path.
    return { outputs, debug, deadPorts: ['error'] }
  }
}
