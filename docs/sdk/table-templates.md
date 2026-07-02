# Table templates — the chatSheets v2 import surface (SQL-table memory)

**Status:** 🟡 partial (issue 02: import + per-chat enablement + read-only view built; writes /
op-log / prompt injection / gate & read & query nodes are issues 03–06, not built).

RP Terminal's memory system is **SQL-table memory** (the 数据库-plugin model): each chat maintains a
set of relational tables, the LLM edits them via SQL (later issues), and the tables project back into
the prompt as worldbook-like entries (later issues). The *schema* of those tables is a **table
template** — a portable, file-based artifact (like presets/lorebooks), importable from the plugin's
**chatSheets v2** export format.

This doc is the contract for that importer: what subset we accept, the field-by-field mapping, and
the defaults applied to the plugin's `-1` sentinels. Behavioral claims cite the file they were
verified against (`CLAUDE.md` grounding rule).

## Artifacts & storage

- **Template** (design-time schema): one JSON file per template,
  `profiles/<profileId>/table-templates/<uuid>.json`, zod-validated by `TableTemplateSchema`
  (`src/main/types/tableTemplate.ts`). CRUD in `src/main/services/tableTemplateService.ts`
  (`listTableTemplates` / `getTableTemplateById` / `deleteTableTemplate` /
  `importTableTemplateFromFile`), mirroring `presetService`.
- **Sandbox DB** (per-chat table DATA): a **separate** SQLite file,
  `profiles/<profileId>/table-dbs/<chatId>.sqlite` — **never** the app DB (`rpterminal.db`). Managed
  by `src/main/services/tableDbService.ts`. A chat's assigned template id is
  `chats.table_template_id` (`src/main/services/db.ts` — `addColumnIfMissing(... 'table_template_id')`);
  `null` = table memory **off** for that chat, zero work done.

## Enablement lifecycle (per chat)

- Assign a template → `chatService.setChatTableTemplateId` → `tableDbService.instantiate`:
  deletes any existing sandbox file, opens a fresh `better-sqlite3` DB, and executes **each table's
  validated single `CREATE TABLE` DDL** in one transaction, then seeds `initialRows`
  (`src/main/services/tableDbService.ts` `instantiate`). **Instantiation is the only moment DDL ever
  runs.**
- Unassign (set `null`) or delete the template / the chat → `tableDbService.removeSandbox` deletes the
  sandbox file (+ WAL sidecars). Chat deletion cleans it up in `chatService.deleteChat`; deleting a
  template unassigns it from every chat that used it (`removeTableTemplateIdFromChats`).
- Both assign and unassign are **destructive** to the sandbox — the renderer (`TablesView.tsx`)
  confirms before calling either.

### DDL safety (the choke point)

The only SQL executed at instantiation is each table's `ddl`, and only after
`extractCreateTableName` (`src/main/parsers/chatSheetsParser.ts`) proves it is **exactly one
`CREATE TABLE` statement** (rejects non-CREATE, multi-statement, or nameless DDL) and returns the
table name. `buildDdlPlan` (`tableDbService.ts`) re-validates at instantiation and asserts the parsed
name equals the stored `sqlName`. Reads/inserts only ever interpolate a `sqlName` that passes
`isSafeSqlIdentifier` (`/^[A-Za-z_][A-Za-z0-9_$]*$/`) — never an unvalidated name.

## Accepted format: chatSheets v2

Top level is `mate` + one `sheet_<id>` object per table. `parseChatSheets(raw, name)`
(`src/main/parsers/chatSheetsParser.ts`) validates and maps it; it throws `ChatSheetsParseError`
(surfaced across IPC as `{ error }`, never a crash) when:

- `mate.type !== 'chatSheets'` or `mate.version !== 2`;
- there are no `sheet_*` keys;
- a sheet has no `ddl`, its `ddl` is not a single `CREATE TABLE`, or it has no header row
  (`content[0]`).

Sheets are ordered by `orderNo`.

## Mapping (chatSheets sheet → `TableDef`)

| chatSheets field                                   | `TableDef` field                       | Notes                                                              |
| -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `uid`                                              | `uid`                                  | Identity carried over.                                             |
| `name`                                             | `displayName`                          | zh display name (e.g. 纪要表).                                     |
| `sourceData.ddl` → `CREATE TABLE <name>`           | `sqlName` (parsed) + `ddl` (verbatim)  | `ddl` kept as-authored, comments and all.                          |
| `content[0]`                                       | `headers`                              | Display column names.                                              |
| `content[1..]`                                     | `initialRows`                          | Usually empty (templates ship header-only).                        |
| `sourceData.note`                                  | `note`                                 | Table-definition prompt.                                           |
| `sourceData.{init,insert,update,delete}Node`       | `{init,insert,update,delete}Node`      | Per-op AI instructions; default `''`.                              |
| `updateConfig.updateFrequency`                     | `updateFrequency`                      | `-1`/absent → **1** (every turn); positive ints kept.              |
| `exportConfig.*`                                   | `exportConfig.*`                       | Verbatim (see below); consumed by injection in issue 04.           |
| `mate.globalInjectionConfig`                       | `TableTemplate.globalInjection`        | `readableEntryPlacement` / `wrapperPlacement`.                     |

### `exportConfig` mapping (stored now, injected in issue 04)

`enabled`, `splitByRow`, `entryName`, `entryType` (`'constant'|'keyword'`, non-`keyword` → `constant`),
`keywords`, `injectionTemplate`, `extraIndexEnabled`, `extraIndexEntryName`, `extraIndexColumns`,
`extraIndexColumnModes` (per-column `'both'|'index_only'`; other values dropped),
`extraIndexInjectionTemplate`, and four `{position, depth, order}` placements — `entryPlacement`,
`extraIndexPlacement`, `fixedEntryPlacement`, `fixedIndexPlacement`. Missing placements default to
`{ position:'at_depth_as_system', depth:0, order:0 }` (`PlacementSchema`).

## Verified against the real template

`test/fixtures/chatsheets-poem-of-destiny-5.9.json` (the 命定之诗 5.9 template) imports into **8**
ordered tables — `sqlName`s: `protagonist_info`, `important_characters`, `chronicle`,
`roleplay_guide`, `foreshadow_table`, `covenant_table`, `region_table`, `location_table`
(`test/chatSheetsParser.test.ts`). Spot-checked: 纪要表 `updateFrequency -1 → 1` + keyword index;
重要角色表 `splitByRow` + keyword columns + `extraIndexColumnModes`; 主角信息 export disabled.

## IPC surface (`src/main/ipc/tableMemoryIpc.ts`, preload `src/preload/index.ts`)

`table-templates-list`, `table-template-get`, `table-template-delete`, `table-template-import-dialog`
(returns `{ summary } | { error } | null`); `chat-table-template-get` / `chat-table-template-set`;
`chat-tables-read` (all tables of the assigned template as
`[{ sqlName, displayName, columns, rows }]`). The read-only **Tables** view is registered as `tables`
in `src/renderer/src/components/workspace/viewRegistry.tsx`.

## Deferred (issues 03–06)

SQL write path + op log (03), prompt injection of table exports (04), gate / read / query workflow
nodes (03/05), view editing (06), card-embedded templates. This slice is import + enablement +
read-only view only.
