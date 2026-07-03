import { LorebookEntry, LorebookEntrySchema } from '../types/character'
import { TableTemplate, TableDef, Placement } from '../types/tableTemplate'
import { TableRead } from './tableDbService'

/**
 * PURE prompt-projection for SQL-table memory (issue 04). Turns a chat's table rows into REAL
 * `LorebookEntry` objects per each table's `exportConfig`, so table contents reach the model through
 * the SAME world-info activation + placement machinery lorebook entries use (no new injection path).
 *
 * The `table.export` node (nodes/builtin/tableNodes.ts) reads rows via `tableDbService.readAllTables`,
 * calls `synthesizeEntries` here, then QUALIFIES the result through the real `matchAcross` matcher —
 * constant entries always survive, keyword entries only on a scan hit. This file does NO I/O.
 *
 * INVARIANT (rows are POSITIONAL): `readAllTables` returns rows in the table's DDL column order, which
 * mirrors `template.headers` (the header row is authored to match the DDL). Column lookup here is ALWAYS
 * by DISPLAY name → index into `headers` (`columnIndex`), NEVER by SQL column name. See docs/sdk/table-templates.md.
 */

/** Positional index of a display column name in `headers` (-1 when absent). Rows are positional in this order. */
export const columnIndex = (headers: string[], displayName: string): number =>
  headers.indexOf(displayName)

/** Read a positional cell by display column name; '' when the column or cell is missing/null. */
const cell = (headers: string[], row: unknown[], displayName: string): string => {
  const i = columnIndex(headers, displayName)
  if (i < 0 || i >= row.length) return ''
  const v = row[i]
  return v == null ? '' : String(v)
}

/** Split a comma-separated list of display column names (chatSheets `keywords`), trimmed, empties dropped. */
const splitColumns = (csv: string): string[] =>
  csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** `header: value` lines, one per column in `headers` order (null/'' cells rendered as an empty value). */
export const renderRow = (headers: string[], row: unknown[]): string =>
  headers
    .map((h, i) => {
      const v = i < row.length ? row[i] : null
      return `${h}: ${v == null ? '' : String(v)}`
    })
    .join('\n')

/** Whole-table rendering: a ` | `-joined header line, then one ` | `-joined line per row (deterministic). */
export const renderWholeTable = (headers: string[], rows: unknown[][]): string =>
  [
    headers.join(' | '),
    ...rows.map((row) =>
      headers.map((_, i) => (i < row.length && row[i] != null ? String(row[i]) : '')).join(' | ')
    )
  ].join('\n')

/** `col: value` pairs for the configured index columns, joined with ` | ` (columns in config order). */
export const renderIndexLine = (
  indexColumns: string[],
  headers: string[],
  row: unknown[]
): string => indexColumns.map((c) => `${c}: ${cell(headers, row, c)}`).join(' | ')

/** Apply a wrapper whose `$1` is the rendered body. An empty/absent wrapper yields the body verbatim. */
export const applyTemplate = (wrapper: string, body: string): string =>
  wrapper && wrapper.length ? wrapper.split('$1').join(body) : body

/**
 * Map a chatSheets placement onto our LorebookEntry position vocabulary (the compat contract —
 * documented in docs/sdk/table-templates.md):
 *  - `at_depth_as_system` → depth-spliced system message: insertion_depth = depth, insertion_order = order.
 *  - `before_character_definition` / `after_character_definition` → the top World Info block
 *    (insertion_depth = null); our model has NO char-def anchor, so the top block is the closest —
 *    an APPROXIMATION. insertion_order = order.
 *  - Any other position (the imported `fixed*` placements) → treated as top-block too (ignored in v1).
 */
const mapPlacement = (p: Placement): { insertion_depth: number | null; insertion_order: number } =>
  p.position === 'at_depth_as_system'
    ? { insertion_depth: p.depth, insertion_order: p.order }
    : { insertion_depth: null, insertion_order: p.order }

/** Build a fully-defaulted LorebookEntry from the fields we set (schema fills the rest — enabled, etc). */
const entry = (fields: Partial<LorebookEntry>): LorebookEntry =>
  LorebookEntrySchema.parse({ prevent_recursion: true, ...fields })

/**
 * The activation keys for a keyword entry over a set of rows: the cell values of the `keywords`
 * columns PLUS the cells of index columns whose mode is `'both'`, across every row given. Trimmed,
 * empties dropped, de-duped (first-seen order preserved). Constant entries pass `[]`.
 */
const deriveKeys = (table: TableDef, headers: string[], rows: unknown[][]): string[] => {
  const ec = table.exportConfig
  const keyCols = [
    ...splitColumns(ec.keywords),
    ...ec.extraIndexColumns.filter((c) => ec.extraIndexColumnModes[c] === 'both')
  ]
  const seen = new Set<string>()
  const keys: string[] = []
  for (const row of rows) {
    for (const col of keyCols) {
      const v = cell(headers, row, col).trim()
      if (v && !seen.has(v)) {
        seen.add(v)
        keys.push(v)
      }
    }
  }
  return keys
}

/**
 * Synthesize the projection entries for every ENABLED-`exportConfig` table in the template, reading
 * rows from the matching `TableRead`. Pure — takes template + reads, returns entries. The caller
 * qualifies them through `matchAcross` (constant always fires; keyword only on a scan hit).
 *
 * Per table:
 *  - `splitByRow: true`  → one entry per data row (content = applyTemplate(injectionTemplate, renderRow)).
 *  - `splitByRow: false` → one whole-table entry (content = applyTemplate(injectionTemplate, renderWholeTable)).
 *  - keyword entries (`entryType: 'keyword'`) get keys from `deriveKeys`; constant entries are always-on.
 *  - Index entry (`extraIndexEnabled`) → ALWAYS-ON (constant): one renderIndexLine per row joined by
 *    newline, wrapped by extraIndexInjectionTemplate. Empty body when there are no rows (an empty table
 *    still emits ONLY this index entry — the AC's "inject nothing except an index entry if configured").
 *  - `enabled: false` tables contribute NOTHING (not even an index).
 *  - Zero data rows → no row/whole-table entries (only the index case above).
 */
export const synthesizeEntries = (
  template: TableTemplate,
  reads: TableRead[]
): LorebookEntry[] => {
  const readBySql = new Map(reads.map((r) => [r.sqlName, r]))
  const out: LorebookEntry[] = []

  for (const table of template.tables) {
    const ec = table.exportConfig
    if (!ec.enabled) continue
    const read = readBySql.get(table.sqlName)
    if (!read) continue

    // Rows are positional in DDL order == template.headers order; use the template's DISPLAY headers.
    const headers = table.headers
    const rows = read.rows
    const isConstant = ec.entryType === 'constant'
    const dataPlacement = mapPlacement(ec.entryPlacement)
    const baseName = ec.entryName || table.displayName

    if (ec.splitByRow) {
      rows.forEach((row, i) => {
        out.push(
          entry({
            keys: isConstant ? [] : deriveKeys(table, headers, [row]),
            content: applyTemplate(ec.injectionTemplate, renderRow(headers, row)),
            constant: isConstant,
            comment: `${baseName}#${i}`,
            ...dataPlacement
          })
        )
      })
    } else if (rows.length) {
      out.push(
        entry({
          keys: isConstant ? [] : deriveKeys(table, headers, rows),
          content: applyTemplate(ec.injectionTemplate, renderWholeTable(headers, rows)),
          constant: isConstant,
          comment: baseName,
          ...dataPlacement
        })
      )
    }

    // The always-on index entry (constant), independent of splitByRow / entryType. Empty tables emit
    // ONLY this (empty body); tables without extraIndexEnabled emit nothing here.
    if (ec.extraIndexEnabled) {
      const body = rows
        .map((row) => renderIndexLine(ec.extraIndexColumns, headers, row))
        .join('\n')
      out.push(
        entry({
          keys: [],
          content: applyTemplate(ec.extraIndexInjectionTemplate, body),
          constant: true,
          comment: ec.extraIndexEntryName || `${table.displayName} index`,
          ...mapPlacement(ec.extraIndexPlacement)
        })
      )
    }
  }

  return out
}
