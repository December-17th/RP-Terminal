import type { LorebookEntry } from '../types/character'
import type { TableDef, TableTemplate } from '../types/tableTemplate'
import type { JsonObject } from '../../shared/agentRuntime'
import { extractTagAll } from '../../shared/memory/tagExtract'
import { MEMORY_RECALL_AGENT_NAME } from '../../shared/memoryRecall'
import {
  formatHits,
  grepSections,
  parseNotesSections,
  type SectionHit
} from '../../shared/memory/notesGrep'
import { AgentCatalog } from './agentRuntime/catalog'
import { invocationRuntime } from './agentRuntime/InvocationRuntimeService'
import { getChatTableTemplateId } from './chatService'
import type { RunContext } from './generation/runContext'
import type { GenContext } from './generation/types'
import { log } from './logService'
import { historyText, recentTranscript } from './memory/memoryCore'
import { retrieveRecallCandidates } from './memory/memoryRetrieval'
import { readNotes } from './notesMemoryService'
import { readAllTables, type TableRead } from './tableDbService'
import {
  renderCatalog,
  renderRecallDocumentCatalog,
  resolveRecallDocumentsByCodes,
  synthesizeRecallDocuments,
  type RecallDocument
} from './tableExportService'
import { getTableTemplateById } from './tableTemplateService'
import { buildPlotBlock } from './memory/plotRecallCompose'
import { RECALL_DIRECTIVE } from './memory/defaultRecallPrompts'

/** Everything the direct Classic caller needs; all planner mechanics stay behind this interface. */
export interface MemoryRecallResult {
  block: string
  plotBlock: string
  report: string
}

const DEFAULT_MAX_ROWS = 24
const DEFAULT_MAX_NOTE_SECTIONS = 6
const DEFAULT_MAX_NOTE_QUERIES = 8
const RECALL_LAST_N_FLOORS = 3
/** Hard wall-clock bound on the whole awaited recall stage (retrieval embeddings + planner call). A
 * provider that accepts the socket and never responds must not block the narrator turn forever. */
const RECALL_DEADLINE_MS = 90_000

const hasCatalogueTable = (template: TableTemplate): boolean =>
  template.tables.some(
    (table) => table.exportConfig.enabled && table.exportConfig.extraIndexEnabled
  )

const codeKeyed = (table: TableDef): boolean => {
  const config = table.exportConfig
  const hasKeyColumn =
    config.keywords.split(',').some((column) => column.trim()) ||
    config.extraIndexColumns.some((column) => config.extraIndexColumnModes[column] === 'both')
  return config.splitByRow && config.entryType === 'keyword' && hasKeyColumn
}

const recallShapeIssue = (template: TableTemplate): string => {
  const catalogue = template.tables.filter(
    (table) => table.exportConfig.enabled && table.exportConfig.extraIndexEnabled
  )
  if (catalogue.some(codeKeyed)) return ''
  return `table ${catalogue.map((table) => table.sqlName).join(', ')} has no code-keyed per-row entries`
}

const parseCodes = (bodies: string[]): string[] => {
  const seen = new Set<string>()
  const codes: string[] = []
  for (const body of bodies) {
    for (const token of body.split(/[\s,，、;；]+/)) {
      const code = token.trim()
      if (!code || seen.has(code)) continue
      seen.add(code)
      codes.push(code)
    }
  }
  return codes
}

const renderNotesToc = (notes: string): string =>
  parseNotesSections(notes)
    .map((section) =>
      section.keywords.length
        ? `## ${section.heading} (${section.keywords.join(', ')})`
        : `## ${section.heading}`
    )
    .join('\n')

/** The plot block is already persisted with each floor, so it is also the rewind-correct plan state. */
const previousPlan = (gen: GenContext): string => {
  for (let index = gen.floors.length - 1; index >= 0; index--) {
    const plot = gen.floors[index].plot_block
    if (!plot) continue
    return [...extractTagAll(plot, 'QuestPlan'), ...extractTagAll(plot, 'StoryEngine')]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

const matchingNoteHits = (notes: string, queries: string[]): SectionHit[] => {
  const sections = parseNotesSections(notes)
  const seen = new Set<string>()
  const hits: SectionHit[] = []
  for (const query of queries) {
    // `literal` is load-bearing: the queries are model output, so compiling them as live regexes
    // would let a valid-but-pathological pattern backtrack unboundedly on the main process.
    for (const hit of grepSections(sections, query, { literal: true })) {
      if (seen.has(hit.section.heading)) continue
      seen.add(hit.section.heading)
      hits.push(hit)
    }
  }
  return hits
}

interface RecallCorpus {
  template: TableTemplate | null
  documents: RecallDocument[]
  notes: string
  input: JsonObject
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Build the read-only invocation input and retain the exact corpus that its result will select from. */
const prepareRecallCorpus = async (
  gen: GenContext,
  signal?: AbortSignal
): Promise<RecallCorpus | null> => {
  const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
  const template = templateId ? getTableTemplateById(gen.profileId, templateId) : null
  const hasTables = !!template && hasCatalogueTable(template)
  const notes = readNotes(gen.profileId, gen.chatId)
  if (!hasTables && !notes.trim()) return null

  const reads: TableRead[] = template ? readAllTables(gen.profileId, gen.chatId, template) : []
  const allDocuments = template ? synthesizeRecallDocuments(template, reads) : []
  const recentStory = historyText(recentTranscript(gen, { lastNFloors: RECALL_LAST_N_FLOORS }))
  const selection = allDocuments.length
    ? await retrieveRecallCandidates({
        profileId: gen.profileId,
        chatId: gen.chatId,
        documents: allDocuments,
        queryText: `${gen.userAction}\n${recentStory}`,
        settings: gen.settings.tables.retrieval,
        apiPresets: gen.settings.api_presets,
        signal
      })
    : null
  const documents = selection?.documents ?? allDocuments
  const card = gen.card.data
  return {
    template,
    documents,
    notes,
    input: {
      summary_index: documents.length
        ? renderRecallDocumentCatalog(documents)
        : template
          ? renderCatalog(template, reads)
          : '',
      notes_toc: renderNotesToc(notes),
      previous_plan: previousPlan(gen),
      recent_story: recentStory,
      user_input: gen.userAction,
      user: {
        name: gen.userName,
        persona: text(gen.settings.persona?.description)
      },
      character: {
        name: text(card.name),
        description: text(card.description),
        personality: text(card.personality),
        scenario: text(card.scenario)
      }
    }
  }
}

/** Resolve one successful Agent result against the exact local corpus that appeared in its input. */
const resolveRecallResult = (
  gen: GenContext,
  corpus: RecallCorpus,
  raw: string
): MemoryRecallResult => {
  const recallBodies = extractTagAll(raw, 'Recall')
  const codes = parseCodes(recallBodies)
  const queries = extractTagAll(raw, 'Query')
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, DEFAULT_MAX_NOTE_QUERIES)
  const questPlan = extractTagAll(raw, 'QuestPlan').join('\n').trim()
  const storyEngine = extractTagAll(raw, 'StoryEngine').join('\n').trim()

  let recalled: LorebookEntry[] = []
  if (corpus.template && codes.length) {
    recalled = resolveRecallDocumentsByCodes(corpus.documents, codes, DEFAULT_MAX_ROWS)
  }
  const recalledText = recalled.map((entry) => entry.content).join('\n\n')
  const hits = matchingNoteHits(corpus.notes, queries)
  const notesBlock = queries.length
    ? formatHits(hits, { maxSections: DEFAULT_MAX_NOTE_SECTIONS })
    : ''

  const block = RECALL_DIRECTIVE.split('{{StoryEngine}}')
    .join(storyEngine)
    .split('{{QuestPlan}}')
    .join(questPlan)
    .split('{{recalled}}')
    .join(recalledText)
    .split('{{notes}}')
    .join(notesBlock)
    .trim()

  let report = `recalled ${recalled.length} of ${codes.length} code(s), ${hits.length} note section(s)`
  if (corpus.template && codes.length && !recalled.length) {
    const issue = recallShapeIssue(corpus.template)
    if (issue) report += ` — ${issue}`
  }

  return {
    block,
    plotBlock: buildPlotBlock({
      action: gen.userAction,
      questPlan,
      recall: recallBodies
        .map((body) => body.trim())
        .filter(Boolean)
        .join('\n'),
      storyEngine
    }),
    report
  }
}

/** Link the turn's Stop signal with the recall deadline. The composite aborts on EITHER: a user Stop
 * (forwarding the base reason, so the run record finalizes as an ordinary cancel) or the wall-clock
 * bound elapsing. `timedOut()` lets callers report the deadline distinctly from a Stop. */
const withRecallDeadline = (
  base: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } => {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort(base?.reason)
  if (base?.aborted) onAbort()
  else base?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`recall deadline (${ms}ms) elapsed`))
  }, ms)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: (): void => {
      clearTimeout(timer)
      base?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Run the Memory Recall Agent (a toggleable builtin, seeded ENABLED) immediately before narrator
 * prompt assembly. Both Classic and VN turns ride `runClassicTurnDirect`, so recall deliberately
 * serves both modes — a VN turn is still a narrator turn.
 *
 * The catalog owns enablement, prompt customization, API-preset selection, budgeting, cancellation, and
 * the durable Run Record. The turn deliberately awaits the outcome because its resolved block
 * contributes to this same narrator turn — bounded by `RECALL_DEADLINE_MS`, so a hung provider degrades
 * to fail-open instead of blocking the reply forever. No eligible corpus means no invocation; every
 * failed/cancelled/timed-out outcome is fail-open. The candidate catalogue is narrowed by SQL-owned
 * hybrid retrieval when large enough; LLM-selected codes never become SQL and resolve only against
 * that exact candidate snapshot.
 */
export const runMemoryRecallAgent = async (
  ctx: RunContext,
  gen: GenContext
): Promise<MemoryRecallResult | null> => {
  let agent
  try {
    agent = new AgentCatalog(gen.profileId).get(MEMORY_RECALL_AGENT_NAME)
  } catch (error) {
    log(
      'error',
      `Memory Recall catalog lookup failed open for chat ${gen.chatId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
  if (!agent?.enabled) return null

  // One deadline spans the whole stage: retrieval (embedding fetches) AND the planner call.
  const deadline = withRecallDeadline(ctx.modelSignal ?? ctx.signal, RECALL_DEADLINE_MS)
  try {
    let corpus
    try {
      corpus = await prepareRecallCorpus(gen, deadline.signal)
    } catch (error) {
      log(
        'error',
        deadline.timedOut()
          ? `Memory Recall timed out after ${RECALL_DEADLINE_MS}ms during retrieval; failed open for chat ${gen.chatId}`
          : `Memory Recall preparation failed open for chat ${gen.chatId}: ${
              error instanceof Error ? error.message : String(error)
            }`
      )
      return null
    }
    if (!corpus) return null
    const sourceFloor = gen.floors[gen.floors.length - 1]?.floor
    if (sourceFloor == null) return null

    try {
      const outcome = await invocationRuntime().run({
        profileId: gen.profileId,
        chatId: gen.chatId,
        floor: sourceFloor,
        agent: MEMORY_RECALL_AGENT_NAME,
        options: {
          input: corpus.input,
          ...(agent.invocationConfig.apiPresetId
            ? { apiPresetId: agent.invocationConfig.apiPresetId }
            : {})
        },
        signal: deadline.signal
      })
      if (outcome.status !== 'succeeded') {
        if (deadline.timedOut()) {
          log(
            'error',
            `Memory Recall timed out after ${RECALL_DEADLINE_MS}ms; failed open for chat ${gen.chatId}`
          )
        } else if (outcome.status === 'failed') {
          log(
            'error',
            `Memory Recall Agent failed open for chat ${gen.chatId}: ${outcome.failure.code}: ${outcome.failure.message}`
          )
        }
        return null
      }
      return resolveRecallResult(
        gen,
        corpus,
        typeof outcome.result === 'string' ? outcome.result : ''
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Memory Recall Agent failed open for chat ${gen.chatId}: ${message}`)
      return null
    }
  } finally {
    deadline.dispose()
  }
}
