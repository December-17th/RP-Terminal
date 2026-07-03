import { z } from 'zod'

/**
 * The native, portable Table-Template artifact for SQL-table memory (issue 02).
 *
 * A template is a file-based asset (like presets/lorebooks): one JSON file per template under
 * `profiles/<id>/table-templates/<uuid>.json`. It is the *schema* of a chat's memory tables — per
 * table: its display name, definition prompt (`note`), per-op AI instructions, the single
 * `CREATE TABLE` DDL that will ever execute for it, its update frequency, its prompt-injection
 * config, and any initial rows. NO row DATA maintenance lives here (that is per-chat session state
 * in a sandbox DB, issues 03+); this is the design-time contract.
 *
 * This shape is a lossless superset of the 数据库-plugin chatSheets v2 format so an imported
 * template round-trips (see `parsers/chatSheetsParser.ts` + `docs/sdk/table-templates.md`).
 */

/** ST-worldbook-style injection anchor (position + depth + order). Mirrors chatSheets `{position,depth,order}`. */
export const PlacementSchema = z.object({
  position: z.string().default('at_depth_as_system'),
  depth: z.number().default(0),
  order: z.number().default(0)
})
export type Placement = z.infer<typeof PlacementSchema>

/**
 * How a table's rows are projected back into the prompt (deferred behavior — issue 04 consumes it).
 * Mapped verbatim from chatSheets `exportConfig`; stored now so import is lossless.
 */
export const TableExportConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** One injection entry per row (true) vs one entry for the whole table (false). */
  splitByRow: z.boolean().default(false),
  entryName: z.string().default(''),
  /** 'constant' = always injected; 'keyword' = activated by cell values of `keywords` columns. */
  entryType: z.enum(['constant', 'keyword']).default('constant'),
  /** Comma-separated COLUMN names whose cell values become per-row activation keywords. */
  keywords: z.string().default(''),
  /** Wrapper template; `$1` = the rendered row/table. */
  injectionTemplate: z.string().default(''),
  /** The always-on compact index entry (lists selected columns of every row). */
  extraIndexEnabled: z.boolean().default(false),
  extraIndexEntryName: z.string().default(''),
  extraIndexColumns: z.array(z.string()).default([]),
  /** Per-column index mode: 'both' (index + keyword) or 'index_only'. */
  extraIndexColumnModes: z.record(z.string(), z.enum(['both', 'index_only'])).default({}),
  extraIndexInjectionTemplate: z.string().default(''),
  entryPlacement: PlacementSchema.prefault({}),
  extraIndexPlacement: PlacementSchema.prefault({}),
  fixedEntryPlacement: PlacementSchema.prefault({}),
  fixedIndexPlacement: PlacementSchema.prefault({})
})
export type TableExportConfig = z.infer<typeof TableExportConfigSchema>

/** One table's full design-time definition. */
export const TableDefSchema = z.object({
  /** Stable identity carried over from the source sheet `uid`. */
  uid: z.string(),
  /** Human display name (zh in the poem template), e.g. 纪要表. */
  displayName: z.string().default(''),
  /** SQL identifier parsed from `CREATE TABLE <sqlName>` — the only name the sandbox ever targets. */
  sqlName: z.string(),
  /** The verbatim single-statement `CREATE TABLE` DDL (stored as-authored; comments kept). */
  ddl: z.string(),
  /** Display column headers (from `content[0]`). */
  headers: z.array(z.string()).default([]),
  /** Seed rows (from `content[1..]`); usually empty (templates ship header-only). */
  initialRows: z.array(z.array(z.string())).default([]),
  /** The table-definition prompt: column semantics + validation checklists. */
  note: z.string().default(''),
  /** Per-operation AI instructions (may embed literal SQL examples). */
  initNode: z.string().default(''),
  insertNode: z.string().default(''),
  updateNode: z.string().default(''),
  deleteNode: z.string().default(''),
  /** Run this table's maintenance every N turns; 1 = every turn (chatSheets -1 maps here). */
  updateFrequency: z.number().int().positive().default(1),
  exportConfig: TableExportConfigSchema.prefault({})
})
export type TableDef = z.infer<typeof TableDefSchema>

/** Template-wide injection defaults (chatSheets `mate.globalInjectionConfig`). */
export const GlobalInjectionSchema = z.object({
  readableEntryPlacement: PlacementSchema.optional(),
  wrapperPlacement: PlacementSchema.optional()
})
export type GlobalInjection = z.infer<typeof GlobalInjectionSchema>

export const TableTemplateSchema = z.object({
  name: z.string().default('Untitled Template'),
  sourceFormat: z.enum(['chatSheets-v2', 'native']).default('native'),
  globalInjection: GlobalInjectionSchema.optional(),
  /** Ordered list of tables (source `orderNo`). */
  tables: z.array(TableDefSchema).default([])
})
export type TableTemplate = z.infer<typeof TableTemplateSchema>
