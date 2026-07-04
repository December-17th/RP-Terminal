import {
  TableTemplate,
  TableTemplateSchema,
  TableDef,
  Placement,
  PlacementSchema
} from '../types/tableTemplate'

/**
 * Importer: the 数据库-plugin chatSheets v2 table format → the native `TableTemplate`.
 *
 * Lossless: every field the plugin ships (per-op instructions, exportConfig, placements, initial
 * rows) is carried onto the model so a re-export reconstructs the same structure. See research.md §1
 * and docs/sdk/table-templates.md for the field-by-field mapping.
 *
 * The DDL helpers here are PURE and exported for unit tests: the sandbox DB (issue 02
 * `tableDbService`) executes ONLY the `ddl` this parser validated, and only ever targets the
 * `sqlName` it extracted — so this is the security choke point for "what SQL can run at init".
 */

/** Thrown for malformed/unsupported template JSON; the IPC layer surfaces the message, not a crash. */
export class ChatSheetsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatSheetsParseError'
  }
}

/**
 * Strip SQL `-- line comments` (used only for parsing/validation; the stored `ddl` keeps them).
 * Does not attempt to honor comment tokens inside string literals — table DDLs here don't contain
 * `--` inside quotes, and this is validation-only, so a conservative strip is correct and safe.
 */
export const stripSqlComments = (ddl: string): string =>
  ddl
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')

/**
 * Assert `ddl` is exactly one `CREATE TABLE` statement and return its table name. Rejects anything
 * else (multiple statements, non-CREATE, missing name) — this guard is the ONLY gate on DDL that
 * will ever execute against the sandbox. Table name accepts a bare identifier or a `"quoted"` one;
 * the returned name is unquoted.
 */
export const extractCreateTableName = (ddl: string): string => {
  const stripped = stripSqlComments(ddl).trim()
  if (!stripped)
    throw new ChatSheetsParseError('Empty DDL: expected a single CREATE TABLE statement')

  // Reject multi-statement DDL: a `;` may only appear as the trailing terminator (optionally with
  // whitespace after it). Anything else means a second statement is smuggled in.
  const firstSemi = stripped.indexOf(';')
  if (firstSemi !== -1 && stripped.slice(firstSemi + 1).trim().length > 0) {
    throw new ChatSheetsParseError('DDL must be a single CREATE TABLE statement (multiple found)')
  }

  // CREATE [TEMP|TEMPORARY] TABLE [IF NOT EXISTS] <name>(  — capture <name>, bare or "quoted".
  const m = stripped.match(
    /^create\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?("?)([A-Za-z_][A-Za-z0-9_$]*)\1\s*\(/i
  )
  if (!m) {
    throw new ChatSheetsParseError('DDL must be a single CREATE TABLE statement with a table name')
  }
  return m[2]
}

/** Whether `name` is a safe SQL identifier we can interpolate into a quoted `"name"` (guard reuse). */
export const isSafeSqlIdentifier = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && !Number.isNaN(v) ? v : fallback

/**
 * chatSheets `updateFrequency` → the stored value, KEEPING the plugin semantics (manual-pass issue 04):
 * `-1` = use the app-level global default; `0` = excluded from auto-maintenance; `N>=1` = every N turns.
 * Absent / non-finite → `-1` (global default); anything `<= -2` is clamped to `-1`.
 */
const normalizeUpdateFrequency = (v: unknown): number => {
  const n = num(v, -1)
  const t = Math.trunc(n)
  if (t < -1) return -1
  return t
}

const asPlacement = (raw: unknown): Placement | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  return PlacementSchema.parse(raw)
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Map one raw `sheet_*` object onto a TableDef (throws ChatSheetsParseError on bad DDL). */
const mapSheet = (uid: string, sheet: any): TableDef => {
  const sourceData = sheet?.sourceData ?? {}
  const ddl = str(sourceData.ddl)
  if (!ddl.trim()) {
    throw new ChatSheetsParseError(`Sheet "${sheet?.name || uid}" has no DDL`)
  }
  const sqlName = extractCreateTableName(ddl) // validates + throws for non-single-CREATE

  const content: unknown[] = Array.isArray(sheet?.content) ? sheet.content : []
  const headers = content.length > 0 ? strArray(content[0]) : []
  if (headers.length === 0) {
    throw new ChatSheetsParseError(`Sheet "${sheet?.name || uid}" has no header row (content[0])`)
  }
  const initialRows = content.slice(1).map((row) => strArray(row))

  const ec = sheet?.exportConfig ?? {}
  const exportConfig = {
    enabled: ec.enabled === true,
    splitByRow: ec.splitByRow === true,
    entryName: str(ec.entryName),
    entryType: ec.entryType === 'keyword' ? ('keyword' as const) : ('constant' as const),
    keywords: str(ec.keywords),
    injectionTemplate: str(ec.injectionTemplate),
    extraIndexEnabled: ec.extraIndexEnabled === true,
    extraIndexEntryName: str(ec.extraIndexEntryName),
    extraIndexColumns: strArray(ec.extraIndexColumns),
    extraIndexColumnModes:
      ec.extraIndexColumnModes && typeof ec.extraIndexColumnModes === 'object'
        ? Object.fromEntries(
            Object.entries(ec.extraIndexColumnModes as Record<string, unknown>)
              .filter(([, mode]) => mode === 'both' || mode === 'index_only')
              .map(([col, mode]) => [col, mode as 'both' | 'index_only'])
          )
        : {},
    extraIndexInjectionTemplate: str(ec.extraIndexInjectionTemplate),
    entryPlacement: asPlacement(ec.entryPlacement) ?? PlacementSchema.parse({}),
    extraIndexPlacement: asPlacement(ec.extraIndexPlacement) ?? PlacementSchema.parse({}),
    fixedEntryPlacement: asPlacement(ec.fixedEntryPlacement) ?? PlacementSchema.parse({}),
    fixedIndexPlacement: asPlacement(ec.fixedIndexPlacement) ?? PlacementSchema.parse({})
  }

  return {
    uid,
    displayName: str(sheet?.name, uid),
    sqlName,
    ddl,
    headers,
    initialRows,
    note: str(sourceData.note),
    initNode: str(sourceData.initNode),
    insertNode: str(sourceData.insertNode),
    updateNode: str(sourceData.updateNode),
    deleteNode: str(sourceData.deleteNode),
    updateFrequency: normalizeUpdateFrequency(sheet?.updateConfig?.updateFrequency),
    exportConfig
  }
}

/**
 * Parse a raw chatSheets v2 object into a validated `TableTemplate`. `name` is the fallback
 * display name (e.g. the imported file's basename). Throws `ChatSheetsParseError` for any malformed
 * or unsupported input.
 */
export const parseChatSheets = (raw: any, name: string): TableTemplate => {
  if (!raw || typeof raw !== 'object') {
    throw new ChatSheetsParseError('Not a chatSheets template (expected a JSON object)')
  }
  const mate = raw.mate
  if (!mate || typeof mate !== 'object' || mate.type !== 'chatSheets') {
    throw new ChatSheetsParseError('Not a chatSheets template (missing mate.type === "chatSheets")')
  }
  if (mate.version !== 2) {
    throw new ChatSheetsParseError(`Unsupported chatSheets version: ${mate.version} (expected 2)`)
  }

  const sheetEntries = Object.entries(raw).filter(
    ([key, value]) => key.startsWith('sheet_') && value && typeof value === 'object'
  ) as Array<[string, any]>
  if (sheetEntries.length === 0) {
    throw new ChatSheetsParseError('chatSheets template has no sheets (no sheet_* keys)')
  }

  // Order by orderNo (stable within equal values via the original key order).
  const ordered = sheetEntries
    .map(([key, sheet]) => ({ key, sheet, orderNo: num(sheet.orderNo, Number.MAX_SAFE_INTEGER) }))
    .sort((a, b) => a.orderNo - b.orderNo)

  const tables = ordered.map(({ key, sheet }) => mapSheet(str(sheet.uid, key), sheet))

  // Two sheets creating the same SQL table would collide at instantiation — reject at import
  // with a clear message instead of a late SQLite error on chat assignment.
  const seen = new Set<string>()
  for (const t of tables) {
    if (seen.has(t.sqlName)) {
      throw new ChatSheetsParseError(`Duplicate table name "${t.sqlName}" across sheets`)
    }
    seen.add(t.sqlName)
  }

  const gi = mate.globalInjectionConfig
  const globalInjection =
    gi && typeof gi === 'object'
      ? {
          readableEntryPlacement: asPlacement(gi.readableEntryPlacement),
          wrapperPlacement: asPlacement(gi.wrapperPlacement)
        }
      : undefined

  // Final zod parse guarantees the returned value matches the schema exactly.
  return TableTemplateSchema.parse({
    name: str(raw.name, name),
    sourceFormat: 'chatSheets-v2',
    globalInjection,
    tables
  })
}

/**
 * WRITER (issue 06) — reconstruct a chatSheets v2 object from a native `TableTemplate` so a template
 * stays portable back to the ST ecosystem. Sits next to the parser it must MIRROR: it writes back
 * exactly the fields `parseChatSheets` consumes, so the round-trip is LOSSLESS FOR THE MODEL —
 * `parseChatSheets(exportChatSheets(tpl))` deep-equals `tpl`. It is NOT byte-identical to a
 * plugin-authored file (the importer keeps `updateFrequency` verbatim — including the `-1` global-default
 * sentinel — but clamps `<= -2` to `-1` and drops UI sentinels / `preventRecursion`), which is why the AC
 * and its test assert TEMPLATE EQUIVALENCE, not bytes.
 *
 * `dataRows` (optional) is "export with data": the current sandbox rows per `sqlName`, embedded as
 * `content[1..]` (cells already stringified by the caller). Absent → the template's own `initialRows`
 * are written, so a header-only template re-exports header-only. `uid` and `orderNo` (array index)
 * are preserved so sheet identity/order round-trip.
 */
export const exportChatSheets = (
  template: TableTemplate,
  dataRows?: Map<string, string[][]>
): Record<string, unknown> => {
  // Only emit `globalInjectionConfig` when the template HAS injection defaults — the parser treats a
  // present-but-empty object as "has globalInjection" (→ `{readable:undefined, wrapper:undefined}`),
  // so omitting the key entirely is what makes export the true inverse for a template without them.
  const gi = template.globalInjection
  const mate: Record<string, unknown> = { type: 'chatSheets', version: 2 }
  if (gi) {
    const globalInjectionConfig: Record<string, unknown> = {}
    if (gi.readableEntryPlacement) globalInjectionConfig.readableEntryPlacement = gi.readableEntryPlacement
    if (gi.wrapperPlacement) globalInjectionConfig.wrapperPlacement = gi.wrapperPlacement
    mate.globalInjectionConfig = globalInjectionConfig
  }

  const out: Record<string, unknown> = { name: template.name, mate }

  template.tables.forEach((t, index) => {
    const rows = dataRows?.get(t.sqlName) ?? t.initialRows
    out[`sheet_${t.uid}`] = {
      uid: t.uid,
      name: t.displayName,
      orderNo: index,
      content: [t.headers, ...rows],
      updateConfig: { updateFrequency: t.updateFrequency },
      sourceData: {
        ddl: t.ddl,
        note: t.note,
        initNode: t.initNode,
        insertNode: t.insertNode,
        updateNode: t.updateNode,
        deleteNode: t.deleteNode
      },
      exportConfig: t.exportConfig
    }
  })

  return out
}
