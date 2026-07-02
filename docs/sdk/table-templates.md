# Table templates — the chatSheets v2 import surface (SQL-table memory)

**Status:** 🟡 partial (issues 02–03: import + per-chat enablement + read-only view + SQL write path
+ op-log/rewind + the `parse.extract`/`table.apply` nodes built; prompt injection / gate & read &
query nodes / view editing are issues 04–06, not built).

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

## Write path (issue 03)

LLM-emitted SQL edits the tables. It NEVER touches the app DB — it runs only against the chat's
per-chat sandbox file, and only after a strict allowlist passes.

### Batch grammar & the allowlist (`src/main/services/tableSql.ts`)

A batch is one-statement-per-`;`. `splitSqlStatements` splits on top-level `;` only, respecting
`'…'` literals (with `''` escape), `"…"` quoted identifiers, `--` line comments, and `/* … */`
block comments — so semicolons and CJK text inside literals survive (the templates' SQL carries
CJK). `classifyStatement` then reads each statement's head keyword (case-insensitive, after leading
comments/whitespace) and accepts **only**:

- `INSERT [OR …] INTO <table> …`
- `UPDATE [OR …] <table> …`
- `DELETE FROM <table> …`

`<table>` may be bare or `"quoted"`, and must pass `isSafeSqlIdentifier`. Every other head is
rejected with a typed `TableSqlError` naming it: SELECT (top level), CREATE, DROP, ALTER, ATTACH,
DETACH, PRAGMA, BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE, VACUUM, REINDEX, WITH (a CTE head hides the
real verb), EXPLAIN, and REPLACE. Subqueries **inside** an allowed statement are fine — the sandbox
holds only template tables and ATTACH is blocked at the head, so no other file is reachable. The
four documented template shapes all pass: `INSERT … VALUES ((SELECT MAX(row_id)+1 FROM t), …)`,
`INSERT OR IGNORE`, `UPDATE … SET x = COALESCE(x,'') || '…' WHERE …`, and a capacity-cleanup
`DELETE … WHERE row_id IN (SELECT … ORDER BY … LIMIT …)`.

`validateBatch(text, allowedTables)` runs split + classify + asserts every target table ∈ the
template's registry. `applySqlBatch` validates first (throws before touching the DB), then runs the
whole batch in **one transaction**, summing `changes`; exceeding the `max_changes` cap (default 500)
throws inside the transaction so **everything rolls back**. Any statement failure rolls the batch
back too. The DB handle is always closed.

### Op log + rewind (`src/main/services/tableOpsService.ts`, `db.ts` `table_ops`)

Every applied batch is appended to `table_ops (chat_id, floor, seq, sql)` in the app DB, keyed by
the floor it was applied on. On floor truncation (`chatService.truncateFloors` → regenerate / swipe
/ delete-from), ops at/after the cut floor are dropped (`deleteOpsFrom`) and the sandbox is rebuilt
(`rebuildSandbox`): instantiate the template DDL, then replay the surviving ops in `(floor, seq)`
order. Replay is deterministic (single-writer) and **fail-open** — an op that now fails (e.g. a
template change dropped a column) is logged and skipped, never bricking the chat. `table_ops` rows
are cleared by FK cascade on chat deletion (`foreign_keys = ON`), and `setChatTableTemplateId`
clears the whole log on (re)assign/unassign (the sandbox is recreated, so old-template ops must not
replay). The pure `replayPlan(ops, fromFloor)` (which ops survive a cut, order, floor attribution)
is unit-tested; live state-equality after a rebuild lands in the owner's manual pass because
`better-sqlite3` is alias-mocked under vitest.

### Write lock

A per-chat in-module mutex (`tryBeginTableWrite`/`endTableWrite`, 2-minute stale expiry — the
removed compaction-slot pattern) serializes concurrent graph writes for a chat. `table.apply` and
`rebuildSandbox` both take it; a busy chat surfaces as class-B `busy` (retry next turn).

### Nodes (`src/main/services/nodes/builtin/`)

- **`parse.extract`** (`parseNodes.ts`, generic — NOT table-specific): tag/regex extractor. Inputs
  `text: Text`, `when: Signal`; outputs `first: Text`, `all: Any` (string[]), `found: Signal` (fires
  only on ≥1 match). Config `{ mode: 'tag'|'regex' (default 'tag'), tag?, pattern?, flags? }`. Tag
  mode matches `<tag>…</tag>` (non-greedy, dotall, case-insensitive); regex mode captures group 1
  when present else the whole match. A bad user regex → class-B `bad-pattern`; blank input → empty
  outputs, no `found`.
- **`table.apply`** (`tableNodes.ts`): the SQL write node. Inputs `gen: Context`, `sql: Text`,
  `when: Signal`; outputs `results: Any` (`{applied, changes}`), `done: Any` (ordering-only, emitted
  only on a completed apply — wire into a downstream `context.refresh`'s `after`), `error: Error`.
  Config `{ max_changes?: 1..5000 }`. It's a POST-response side branch and **fail-open**: blank sql
  → silent no-op; no template → class-B `no-template`; lock busy → `busy`; validation/exec failure →
  `bad-sql`; all route on the `error` port and never abort the turn. On success it appends ops at
  `floors.length - 1` (clamped ≥0 — the just-persisted floor).

## Deferred (issues 04–06)

Prompt injection of table exports (04), gate / read / query workflow nodes (05), view editing (06),
card-embedded templates.
