import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { readAllTablesBounded } from './tableDbService'
import { getSettings } from './settingsService'
import { renderInjectionBlock, injectionReadLimits } from './tableMaintenance'
import { log } from './logService'

/**
 * WS4 (injection consumption, D10) — read a chat's bound table template + its CURRENT sandbox rows and
 * render the capped, per-table MEMORY block for the MAIN narrative prompt. This is the READER (the dumb
 * I/O wrapper); every DECISION (per-table policy resolution, cap math, marker emission, exclusion) lives
 * in the PURE helpers of `tableMaintenance` (`renderInjectionBlock` / `capInjectionRows` /
 * `resolveInjectionPolicy`), unit-tested in `test/tableInject.test.ts`.
 *
 * It is called once per assembly from `assemblePrompt` and its output is folded into the SAME memory
 * tail the recall / pack block uses (`buildPrompt`'s `memoryBlock` splice) — never a parallel assembly
 * path, and it never touches the `prompt-assembly` checkpoint's `block`/`entries` anchor lanes (those
 * stay free for pack rejoin). No model call: one `readAllTables`.
 *
 * FAIL-OPEN + silent-empty (the house style for table reads): no bound template, an empty template, or a
 * policy that excludes every table → `''` (no injection at all, prompt byte-identical to before). Any
 * read error degrades to `''` with a warning — a memory block must never crash the turn.
 *
 * NOTE: the rich `exportConfig` (per-row worldbook-style entries / keywords / placements) stays
 * UNCONSUMED for injection — this is the deliberate simple capped block (plan §0 reconciliation);
 * exportConfig-driven injection is a later item gated on the vector/summary engine.
 */
export const renderChatTablesInjectionBlock = (profileId: string, chatId: string): string => {
  try {
    const templateId = getChatTableTemplateId(profileId, chatId)
    if (!templateId) return ''
    const template = getTableTemplateById(profileId, templateId)
    if (!template || !template.tables.length) return ''
    const globalCap = getSettings(profileId).tables?.injection_max_rows ?? 20
    // P1-5: push each table's row cap into SQL (ORDER BY rowid DESC LIMIT N) so a long table is never
    // fully materialized just to keep its newest N rows. `renderInjectionBlock` still caps defensively
    // (a no-op when the read is already bounded), and `totalRows` keeps the omitted-rows marker exact.
    const limits = injectionReadLimits(template, globalCap)
    const reads = readAllTablesBounded(profileId, chatId, template, limits)
    return renderInjectionBlock(template, reads, globalCap)
  } catch (err) {
    log('error', `table memory injection skipped: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}
