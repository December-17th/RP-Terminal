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

/**
 * WS4 — how a table's CURRENT rows are injected into the MAIN narrative prompt (the capped per-table
 * memory block the narrator reads each turn, NOT the maintainer side-call). This is RPT-NATIVE: it has
 * no chatSheets analogue, so it is deliberately NOT round-tripped through `exportChatSheets` — an
 * imported/exported template simply carries the schema default (`{ mode: 'recent' }`), which keeps the
 * chatSheets round-trip lossless-for-the-model (the reader never emits a non-default value). The rich
 * `exportConfig` above stays UNCONSUMED for prompt injection (see `docs/sdk/table-templates.md`).
 *
 * `'summary'` (LLM-condensed rows) is DEFERRED to the future vector/summary engine and is NOT a valid
 * mode yet; the truncation marker (`…（省略 N 行较早记录）`) is the seam that will carry it.
 */
export const TableInjectionPolicySchema = z.object({
  /** 'recent' = keep the LAST N rows (N = `rows`, else the global cap); 'full' = all rows; 'none' =
   *  never injected into the main prompt. */
  mode: z.enum(['recent', 'full', 'none']).default('recent'),
  /** Per-table row cap for 'recent', overriding `settings.tables.injection_max_rows`. Unset = global cap. */
  rows: z.number().int().min(0).optional()
})
export type TableInjectionPolicy = z.infer<typeof TableInjectionPolicySchema>

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
  /** Maintenance cadence in turns. -1 = use the app-level global default (settings.tables.default_update_frequency);
   *  0 = this table is EXCLUDED from auto-maintenance; N>=1 = every N turns. Mirrors the chatSheets/数据库
   *  plugin semantics (manual-pass issue 04). */
  updateFrequency: z.number().int().refine((v) => v === -1 || v >= 0, {
    message: 'updateFrequency must be -1 (global default), 0 (off), or a positive integer'
  }).default(-1),
  exportConfig: TableExportConfigSchema.prefault({}),
  /** WS4 — per-table main-prompt injection policy (RPT-native; defaults to recent-N at the global cap). */
  injectionPolicy: TableInjectionPolicySchema.prefault({})
})
export type TableDef = z.infer<typeof TableDefSchema>

/** Template-wide injection defaults (chatSheets `mate.globalInjectionConfig`). */
export const GlobalInjectionSchema = z.object({
  readableEntryPlacement: PlacementSchema.optional(),
  wrapperPlacement: PlacementSchema.optional()
})
export type GlobalInjection = z.infer<typeof GlobalInjectionSchema>

/** The per-table fields editable from the UI. Structural fields (ddl, sqlName, headers, initialRows)
 *  are deliberately NOT here — DDL only ever executes at sandbox instantiation, so editing it without
 *  re-instantiating would desync every chat using the template. */
export const TableDefPatchSchema = z.object({
  uid: z.string(),
  note: z.string().optional(),
  initNode: z.string().optional(),
  insertNode: z.string().optional(),
  updateNode: z.string().optional(),
  deleteNode: z.string().optional(),
  updateFrequency: z
    .number()
    .int()
    .refine((v) => v === -1 || v >= 0, {
      message: 'updateFrequency must be -1 (global default), 0 (off), or a positive integer'
    })
    .optional(),
  exportConfig: TableExportConfigSchema.optional(),
  /** WS4 — editable main-prompt injection policy (UI is WS6+; the field is patchable now). */
  injectionPolicy: TableInjectionPolicySchema.optional()
})
export type TableDefPatch = z.infer<typeof TableDefPatchSchema>
export const TableTemplatePatchSchema = z.object({
  name: z.string().min(1).optional(),
  tables: z.array(TableDefPatchSchema).default([])
})
export type TableTemplatePatch = z.infer<typeof TableTemplatePatchSchema>

export const TableTemplateSchema = z.object({
  name: z.string().default('Untitled Template'),
  sourceFormat: z.enum(['chatSheets-v2', 'native']).default('native'),
  globalInjection: GlobalInjectionSchema.optional(),
  /** Ordered list of tables (source `orderNo`). */
  tables: z.array(TableDefSchema).default([])
})
export type TableTemplate = z.infer<typeof TableTemplateSchema>
