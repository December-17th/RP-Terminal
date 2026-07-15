import { GenContext } from '../../generation/types'
import { ChatMessage } from '../../promptBuilder'
import { stripThinking } from '../../../parsers/contentParser'
import { getChatTableTemplateId } from '../../chatService'
import { getTableTemplateById } from '../../tableTemplateService'
import { applySqlBatch, validateBatch, partitionBySelected, TableSqlError } from '../../tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from '../../tableOpsService'
import { advanceProgress, getProgress, resolveUpdateFrequency } from '../../tableProgressService'
import { readAllTables, TableRead } from '../../tableDbService'
import { renderTableBlock } from '../../tableMaintenance'
import { getSettings } from '../../settingsService'
import { getFloorCount, transcriptEpoch } from '../../floorService'
import { TableTemplate } from '../../../types/tableTemplate'
import { NodeRunFailure } from '../types'

/**
 * Shared SQL-table-memory internals (WP0 of the `memory.maintain` node plan) — the two pieces the
 * consolidated `memory.maintain` node shares with the fine-grained nodes, factored to ONE
 * implementation so the chains never drift:
 *   · `recentTranscript` — the last-N-floors transcript slice (`history.recent` wraps it).
 *   · `applyTableEdit`   — the LLM-emitted SQL-batch WRITE core (`table.apply` wraps it).
 * `chatTemplate` (resolve a chat's bound template, or null) moved here too since both nodes need it.
 * Behavior is byte-for-byte the pre-extraction code — the existing node characterization tests pin it.
 */

/** Resolve the table template a chat is bound to, or null when the chat has no table memory. */
export const chatTemplate = (gen: GenContext): TableTemplate | null => {
  const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
  return templateId ? getTableTemplateById(gen.profileId, templateId) : null
}

/**
 * Tag families stripped from an AI reply before a memory agent (maintain / notes / recall) reads it —
 * the reference planner-transcript strip-list. `<think>` is handled separately by `stripThinking`
 * (which also folds a dangling open tag); this list covers the model's OTHER non-narrative blocks:
 * MVU variable ops, status-bar placeholders, JSON patches, and the planner's meta families
 * (analysis / summary / options / self-critique). Stripping them keeps the recalled transcript to
 * NARRATIVE PROSE, so a memory pass summarizes the story rather than the model's bookkeeping. Named
 * families ONLY — legitimate prose is never touched. Single shared list so all three nodes benefit.
 */
export const STRIPPED_TAG_FAMILIES = [
  'UpdateVariable',
  'update',
  'updatevariable',
  'summary',
  'options',
  'StatusPlaceHolderImpl',
  'JSONPatch',
  'Analysis',
  'tucao',
  'review',
  'refine',
  'StatusBar',
  'statusbar'
] as const

/**
 * Strip each `STRIPPED_TAG_FAMILIES` block case-insensitively: a paired `<Tag ...>…</Tag>` (tempered so
 * a stray nested open can't over-match), plus any leftover self-closing `<Tag/>` / bare placeholder
 * open. Applied AFTER `stripThinking`, mirroring how `<think>` is removed. Pure string transform.
 */
const stripTagFamilies = (text: string): string => {
  let out = text
  for (const tag of STRIPPED_TAG_FAMILIES) {
    const paired = new RegExp(`<${tag}\\b[^>]*>(?:(?!<${tag}\\b)[\\s\\S])*?<\\/${tag}\\s*>`, 'gi')
    const solo = new RegExp(`<${tag}\\b[^>]*?\\/?>`, 'gi')
    out = out.replace(paired, '').replace(solo, '')
  }
  return out
}

/**
 * The alternating transcript slice a memory agent reads: the last `lastNFloors` floors reduced to the
 * two things it cares about — the player action (`user`) and the AI reply (`assistant`, with reasoning
 * AND the model's own state/meta tag families stripped, `stripThinking` + `stripTagFamilies`).
 * `include` narrows to one side; the default 'both' emits the player action THEN the reply per floor
 * (natural summarizer order). Blank sides are skipped. Pure over `gen.floors` (exported so both
 * `history.recent` and `memory.maintain` — and tests — share it).
 */
export const recentTranscript = (
  gen: GenContext,
  opts: { lastNFloors?: number; include?: 'both' | 'user' | 'assistant' } = {}
): ChatMessage[] => {
  const count = opts.lastNFloors ?? 6
  const include = opts.include ?? 'both'
  const selected = gen.floors.slice(-count)
  const messages: ChatMessage[] = []
  for (const f of selected) {
    if (include !== 'assistant') {
      const user = (f.user_message?.content ?? '').trim()
      if (user) messages.push({ role: 'user', content: user })
    }
    if (include !== 'user') {
      const assistant = stripTagFamilies(stripThinking(f.response?.content ?? '')).trim()
      if (assistant) messages.push({ role: 'assistant', content: assistant })
    }
  }
  return messages
}

/**
 * Render the "here are the tables, here is what you may do" block a maintainer prompt needs: for the
 * selected (or all) template tables, each one's `renderTableBlock` (definition + per-op rules + current
 * data), joined by blank lines, plus the sqlNames actually rendered. The WRITE-node counterpart to
 * `applyTableEdit`: this is exactly what `table.read` produces (which now wraps it), shared so
 * `memory.maintain` composes a byte-identical block. Row cap keeps the LAST `maxRows` rows per table;
 * `only` scopes to specific sqlNames (empty/unset = all). Pure over the chat's sandbox reads + settings.
 */
export const renderTablesBlock = (
  gen: GenContext,
  template: TableTemplate,
  opts: { maxRows?: number; includeRules?: boolean; only?: string[] } = {}
): { block: string; tables: string[] } => {
  const includeRules = opts.includeRules !== false
  const onlySet = opts.only && opts.only.length ? new Set(opts.only) : null
  const tables = onlySet ? template.tables.filter((t) => onlySet.has(t.sqlName)) : template.tables
  if (!tables.length) return { block: '', tables: [] }

  const readsBySql = new Map(
    readAllTables(gen.profileId, gen.chatId, template).map((r) => [r.sqlName, r])
  )
  const globalDefault = getSettings(gen.profileId).tables?.default_update_frequency ?? 3
  const blocks: string[] = []
  const rendered: string[] = []
  for (const table of tables) {
    let read: TableRead = readsBySql.get(table.sqlName) ?? {
      sqlName: table.sqlName,
      displayName: table.displayName,
      columns: table.headers,
      rows: [],
      rowids: []
    }
    // Row cap: keep the LAST N rows (newest-last) per table.
    if (opts.maxRows != null && read.rows.length > opts.maxRows) {
      read = { ...read, rows: read.rows.slice(-opts.maxRows) }
    }
    // Header cadence: resolve -1 (global) / 0 (off → 手动维护) / N.
    const resolvedFreq = resolveUpdateFrequency(table.updateFrequency, globalDefault)
    blocks.push(renderTableBlock(table, read, includeRules, resolvedFreq))
    rendered.push(table.sqlName)
  }
  return { block: blocks.join('\n\n'), tables: rendered }
}

/**
 * The set of tables DUE for AUTOMATIC maintenance this turn (WS3 / D9 due-set gating). PURE.
 *
 * A table is due when its resolved cadence is not `null` (an authored `0` → 手动维护, never auto) AND at
 * least `resolvedFreq` floors have elapsed since its last-processed pointer:
 * `currentFloor - (last ?? -1) >= resolvedFreq`. A never-processed table (`last = -1`, absent from
 * `progress`) is due once `currentFloor + 1 >= resolvedFreq` (e.g. freq 1 fires at floor 0; freq 3 at
 * floor 2). `currentFloor` is the last floor's 0-based index (`getAllFloors().length - 1`); an empty
 * chat (`-1`) yields none. The result is the DUE `sqlName`s in template order — the write scope + the
 * advance set for the auto pass, so all tables still RENDER for context (D5) but only due tables are
 * written and advanced.
 */
export const dueTables = (
  template: TableTemplate,
  progress: Record<string, number>,
  currentFloor: number,
  globalDefault: number
): string[] => {
  const due: string[] = []
  for (const table of template.tables) {
    const freq = resolveUpdateFrequency(table.updateFrequency, globalDefault)
    if (freq == null) continue // authored 0 → 手动维护, excluded from auto-maintenance
    const last = progress[table.sqlName] ?? -1
    if (currentFloor - last >= freq) due.push(table.sqlName)
  }
  return due
}

/** Flatten a Messages list into a transcript text block — the inline `{history}` substitution shape.
 *  Shared by `agent.llm` and `memory.maintain` so the two never drift (WP0 no-drift intent). */
export const historyText = (history: ChatMessage[]): string =>
  history
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'System'}: ${m.content}`)
    .join('\n')

/** The composed send-prompt as the run trace's `debug['prompt (sent)']` value — role-tagged rows joined
 *  by blank lines. Shared so the agent + memory nodes render the trace identically. */
export const composedPromptDebug = (messages: ChatMessage[]): Record<string, string> => ({
  'prompt (sent)': messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')
})

/** What a successful table-edit apply reports (mirrors the applySqlBatch tally). */
export interface ApplyTableEditResult {
  applied: number
  changes: number
  /** Staleness fence (owner pass 2026-07-14): the transcript changed between compose and apply
   *  (regenerate/edit/swipe mid-call) — NOTHING was applied and NO pointer advanced. Present only
   *  when the caller passed `expectTranscriptEpoch` and the check failed. */
  stale?: true
  /** WS3: statements dropped by the write-scope filter (present ONLY when `writeScope` was passed). */
  dropped?: number
}

/**
 * Apply an LLM-emitted SQL batch to a chat's table sandbox — the WRITE core of `table.apply`, shared
 * with `memory.maintain`. Callers resolve `template` and enforce the no-template policy (a write with
 * no schema is a class-B error for `table.apply`, a silent no-op for `memory.maintain`), and MUST
 * pre-check for a blank batch (this assumes non-blank `sql`).
 *
 * Guards a per-chat write with `tryBeginTableWrite`/`endTableWrite`, runs `applySqlBatch`, appends the
 * EXACT executed statements to the just-persisted floor's op log (`floors.length - 1`, clamped), and —
 * when `advanceProgress` — advances the shared table-progress pointer to the current floor (re-read
 * from disk, the table.gate idiom) AFTER success only, so a failed batch leaves the backlog standing
 * for the next commit boundary to retry. `label` prefixes the thrown NodeRunFailure messages so each
 * caller's errors read naturally (defaults to `table.apply` — the pre-extraction wording).
 *
 * WS3 due-set gating (opt-in; the `table.apply` node and any caller that omits these keep today's
 * behavior byte-for-byte): `writeScope` restricts WRITES to statements targeting those tables — the
 * batch is validated + partitioned through the shared `partitionBySelected` filter and out-of-scope
 * statements are DROPPED before apply (counted in `dropped`), so the model may SEE every table for
 * context but only writes the in-scope ones. `advanceTables` overrides which pointers advance (default:
 * all template tables), so the auto pass advances only the due tables it maintained.
 */
export const applyTableEdit = (
  gen: GenContext,
  template: TableTemplate,
  sql: string,
  opts: {
    maxChanges?: number
    advanceProgress?: boolean
    label?: string
    writeScope?: string[]
    advanceTables?: string[]
    /** Staleness fence: the `transcriptEpoch(chatId)` captured when the batch was COMPOSED. When the
     *  epoch moved by apply time (regenerate/edit/swipe mid-call), the batch is DROPPED — no apply,
     *  no op-log rows, no pointer advance — and `{ stale: true }` is returned. The backlog stands
     *  (truncateFloors already clamped the pointers), so the next commit boundary re-maintains the
     *  NEW content instead of filling tables from a discarded reply. */
    expectTranscriptEpoch?: number
    /** Advance pointers to THIS floor (the floor the model actually saw) instead of re-reading the
     *  disk floor count — so a floor appended mid-call is never credited as processed. */
    advanceTo?: number
  } = {}
): ApplyTableEditResult => {
  const label = opts.label ?? 'table.apply'
  if (!tryBeginTableWrite(gen.chatId)) {
    throw new NodeRunFailure('B', `${label}: a table write is already in flight for this chat`, 1, 'busy')
  }
  try {
    // Staleness fence (checked INSIDE the write guard so the decision can't race a concurrent write).
    if (
      opts.expectTranscriptEpoch !== undefined &&
      transcriptEpoch(gen.chatId) !== opts.expectTranscriptEpoch
    ) {
      return { applied: 0, changes: 0, stale: true }
    }
    // WS3 write-scope: drop statements targeting out-of-scope tables before apply (the model saw all
    // tables for context but may only WRITE the due/selected ones). Validate through the shared filter
    // so a bad batch throws TableSqlError → the class-B bad-sql path below, exactly like applySqlBatch.
    let batchSql = sql
    let dropped: number | undefined
    if (opts.writeScope) {
      const allowed = new Set(template.tables.map((t) => t.sqlName))
      const { kept, dropped: out } = partitionBySelected(validateBatch(sql, allowed), new Set(opts.writeScope))
      dropped = out.length
      batchSql = kept.join(';\n')
    }

    // Apply only when something survives the scope (an all-dropped batch still advances the due pointers
    // below — the pass ran for them, the model just chose not to write in-scope changes).
    let applied = 0
    let changes = 0
    if (batchSql.trim()) {
      const result = applySqlBatch(gen.profileId, gen.chatId, template, batchSql, { maxChanges: opts.maxChanges })
      applied = result.applied
      changes = result.changes
      // Attribute ops to the just-persisted floor (this runs POST-response, so the reply floor is the
      // last one). Log EXACTLY the statements that ran (from the service), not a re-split, so replay
      // matches execution.
      if (result.statements.length) {
        const floor = Math.max(0, gen.floors.length - 1)
        // Batch-wide SPAN START (from_floor): this maintain batch summarizes each maintained table's
        // floors (last-pointer + 1)..floor, so the conservative earliest source floor is the MIN over
        // the scope tables of (progress[t] ?? -1) + 1, clamped to [0, floor]. Recording it lets a later
        // refill widen its cut onto the span boundary instead of bisecting this batch. Conservative (may
        // sit slightly earlier than strictly needed) is safe — it only widens a refill, never narrows.
        const scopeTables = opts.writeScope ?? opts.advanceTables ?? template.tables.map((t) => t.sqlName)
        const progress = getProgress(gen.profileId, gen.chatId)
        let fromFloor = floor
        for (const t of scopeTables) {
          const cand = (progress[t] ?? -1) + 1
          if (cand < fromFloor) fromFloor = cand
        }
        appendOps(gen.profileId, gen.chatId, floor, result.statements, 'maintain', Math.max(0, fromFloor))
      }
    }
    // Advance the shared pointer ONLY after a successful batch (advance-after-success). currentFloor is
    // re-read FROM DISK here (the table.gate idiom), not from gen.floors. `advanceTables` scopes WHICH
    // pointers move (default: all template tables — the pre-WS3 behavior).
    if (opts.advanceProgress === true) {
      const names = opts.advanceTables ?? template.tables.map((t) => t.sqlName)
      const currentFloor =
        opts.advanceTo ?? Math.max(0, getFloorCount(gen.profileId, gen.chatId) - 1)
      advanceProgress(gen.profileId, gen.chatId, names, currentFloor)
    }
    return dropped === undefined ? { applied, changes } : { applied, changes, dropped }
  } catch (error) {
    const msg = error instanceof TableSqlError ? error.message : String(error)
    throw new NodeRunFailure('B', `${label}: ${msg}`, 1, 'bad-sql')
  } finally {
    endTableWrite(gen.chatId)
  }
}
