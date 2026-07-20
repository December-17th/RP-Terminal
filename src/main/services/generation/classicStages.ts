import { GenContext } from './types'
import { getChatTableTemplateId } from '../chatService'
import { getTableTemplateById } from '../tableTemplateService'
import { readAllTables, TableRead } from '../tableDbService'
import { synthesizeEntries } from '../tableExportService'
import { getProgress } from '../tableProgressService'
import { matchAcross } from '../lorebookService'
import { LorebookEntry } from '../../types/character'

/**
 * The pure Classic-pipeline STAGE services `context.trimProcessed` and `table.export` wrap, relocated
 * out of their node files (`nodes/builtin/contextNodes.ts` / `tableNodes.ts`) into a stable generation
 * home (execution-plan M5b). The direct Classic path (`classicTurn.ts`) calls these directly, and the
 * node `run()`s now delegate here, so there is exactly ONE implementation for both paths after M5c
 * deletes the node wrappers. Moved VERBATIM — the classic-turn inventory characterization pins the
 * behavior (identity return when nothing is trimmed; silent empty projection with no template).
 */

// ── context.trimProcessed — the async-memory INLINE history trimmer ───────────────────────────────

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

/** The trim itself, as a plain Context→Context service (Classic Narrator plan, Milestone 3): the
 *  direct Classic path runs this stage WITHOUT the graph, and `resolveProcessedPointer` + the slice
 *  are node-local logic that a second copy would drift from. `contextTrimProcessed.run` delegates here,
 *  so there is exactly ONE implementation for both paths. Returns the SAME object when nothing is
 *  trimmed (the identity the inventory test pins). */
export const trimProcessedContext = (gen: GenContext, only?: string): GenContext => {
  const pointer = resolveProcessedPointer(gen, only)
  // pointer < 0 → nothing processed / no template / compaction not landed → carry the FULL history
  // (fail-soft, ADR 0003). Also a no-op when there is nothing to drop.
  if (pointer < 0 || gen.floors.length === 0) return gen

  // Floors at index ≤ pointer are already folded into the tables → drop them; keep index > pointer.
  // slice(pointer + 1) never trims PAST the pointer, and clamps naturally when the pointer is beyond
  // the history (→ empty tail). lastFloor is re-pinned so every lastFloor-derived read stays coherent.
  const kept = gen.floors.slice(pointer + 1)
  if (kept.length === gen.floors.length) return gen // nothing to drop
  return { ...gen, floors: kept, lastFloor: kept[kept.length - 1] }
}

// ── table.export — the SQL-table-memory READ-INTO-THE-PROMPT projection ────────────────────────────

/** The subset of `table.export`'s config the projection reads (a comma sqlName narrow + a per-table
 *  row cap). Structurally compatible with the node's zod-parsed config. */
export interface ExportEntriesConfig {
  tables?: string
  max_rows?: number
}

/** The top World Info block text of the qualified entries: null-depth entries' content, joined like
 *  promptBuilder's top block (blank content dropped, '\n\n'-separated). For composed prompts that want
 *  a plain text rendering rather than the entry objects. */
const exportBlock = (entries: LorebookEntry[]): string =>
  entries
    .filter((e) => e.insertion_depth == null)
    .map((e) => e.content)
    .filter(Boolean)
    .join('\n\n')

/** The export itself, as a plain service (Classic Narrator plan, Milestone 3): the direct Classic path
 *  runs this stage WITHOUT the graph, and the read→cap→synthesize→qualify sequence is node-local logic
 *  a second copy would drift from. `tableExport.run` delegates here, so there is exactly ONE
 *  implementation for both paths. */
export const exportTableEntries = (
  gen: GenContext,
  cfg: ExportEntriesConfig
): { entries: LorebookEntry[]; block: string } => {
  const templateId = getChatTableTemplateId(gen.profileId, gen.chatId)
  const template = templateId ? getTableTemplateById(gen.profileId, templateId) : null
  // No table memory on this chat → project nothing (silent; export is a read).
  if (!template) return { entries: [], block: '' }

  // Optional narrowing to a subset of tables (by sqlName). Empty filter = all tables.
  const only = (cfg.tables ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let reads: TableRead[] = readAllTables(gen.profileId, gen.chatId, template)
  if (only.length) {
    const set = new Set(only)
    reads = reads.filter((r) => set.has(r.sqlName))
  }
  // Row cap: keep the LAST N rows (newest-last) per table so long tables don't blow the prompt.
  if (cfg.max_rows != null) {
    const cap = cfg.max_rows
    reads = reads.map((r) => (r.rows.length > cap ? { ...r, rows: r.rows.slice(-cap) } : r))
  }

  const synthesized = synthesizeEntries(template, reads)
  // QUALIFY through the REAL matcher — constants survive, keyword entries fire only on a scan hit.
  const qualified = matchAcross(
    [{ name: 'table-export', entries: synthesized }],
    gen.scanText,
    Math.random,
    gen.maxRecursion
  )
  return { entries: qualified, block: exportBlock(qualified) }
}
