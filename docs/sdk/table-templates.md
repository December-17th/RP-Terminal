# Table templates — the chatSheets v2 import surface (SQL-table memory)

**Status:** 🟢 complete (issues 02–06: import + per-chat enablement + the Tables view (read + hand
editing) + SQL write path + op-log/rewind + prompt projection (`table.export`) + the maintenance
pipeline (`table.gate` / `table.read` / `table.query`) + template EXPORT (chatSheets v2, round-trip) +
per-table last-maintained indicator all built). The only deferred item is card-embedded templates.

The **Tables view** now also shows and edits each table's per-table template prompts inline (the five
per-op prompts, `updateFrequency`, and the injection `exportConfig`) via `table-template-update` —
structural fields (DDL/headers/rows) stay read-only.

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
| `exportConfig.*`                                   | `exportConfig.*`                       | Verbatim (see below); projected into the prompt by `table.export` (issue 04). |
| `mate.globalInjectionConfig`                       | `TableTemplate.globalInjection`        | `readableEntryPlacement` / `wrapperPlacement`.                     |

### `exportConfig` mapping (projected by `table.export`, issue 04)

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

`table-templates-list`, `table-template-get`, `table-template-update`, `table-template-delete`,
`table-template-import-dialog` (returns `{ summary } | { error } | null`); `chat-table-template-get` /
`chat-table-template-set`;
`chat-tables-read` (all tables of the assigned template as
`[{ sqlName, displayName, columns, rows, rowids }]`); `chat-tables-edit` (hand edit → `{ ok, changes }
| { error }`); `chat-tables-status` (last-maintained floor per table); `table-template-export-dialog`
(export to chatSheets v2 JSON) — issue 06. The **Tables** view is registered as `tables` in
`src/renderer/src/components/workspace/viewRegistry.tsx`.

`table-template-update(profileId, id, patch)` → `{ ok: true } | { error }` (manual-pass issue 03). The
patch is `{ name?, tables: [{ uid, note?, initNode?, insertNode?, updateNode?, deleteNode?,
updateFrequency?, exportConfig? }] }`: only the **five per-op prompts + `updateFrequency` + the
injection `exportConfig`** (and the template `name`) are editable — structural fields (`sqlName`,
`ddl`, `headers`, `initialRows`, `displayName`) are IMMUTABLE (DDL only executes at instantiation, so
editing it without re-instantiating would desync every chat using the template). The merge is the pure
`tableTemplateService.applyTemplatePatch` (unknown table `uid` → `{ error: 'tables.templateUnknownTable' }`;
malformed patch → `{ error: 'tables.templateBadPatch' }`; missing template → `{ error:
'tables.templateNotFound' }`), then `saveTableTemplate` overwrites the SAME id. A template is shared:
edits apply to every chat assigned to it and are **picked up on the next maintenance pass** (`table.gate`
/ `table.read` re-read the template each pass — no sandbox rebuild).

`chat-tables-read` returns each row's SQLite `rowid` (`rowids[]`, 1:1 with `rows`;
`tableDbService.readOne` selects `rowid AS __rid, *` and slices the alias off so `rows`/`columns` stay
data-only + positional — no other `TableRead` consumer changes). Columns are unified onto the
template's DISPLAY headers when they line up 1:1 with the sandbox's real columns
(`tableDbService.unifyDisplayColumns`), so both empty and populated tables show e.g. 人物名称 rather
than the SQL name (`src/main/services/tableDbService.ts`).

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

## Prompt projection (issue 04)

The READ-into-the-prompt half. `table.export` turns a chat's table rows into **real `LorebookEntry`
objects** per each table's `exportConfig`, then qualifies them through the SAME world-info matcher
(`lorebookService.matchAcross`) and placement machinery lorebook entries use — no new injection path.

### Nodes / ports

- **`table.export`** (`tableNodes.ts`): inputs `gen: Context`, `when: Signal`; outputs `entries: Any`
  (the qualified `LorebookEntry[]`), `block: Text` (plain-text rendering of the qualified NULL-depth /
  top-block entries, `'\n\n'`-joined — for composed prompts that want text), `error: Error`. Config
  `{ tables?: string (comma-separated sqlNames narrowing which tables project; unset = all),
  max_rows?: 1..500 (per-table cap on projected DATA rows, keeps the NEWEST-last rows) }`. **No table
  template assigned → SILENT empty** (`{ entries: [], block: '' }`), NOT an error — export is a read;
  a chat without table memory simply projects nothing (contrast `table.apply`'s `no-template` class-B
  failure). It does **not** auto-inject anywhere; projection reaches the prompt only through wiring.
- **`prompt.assemble` / `prompt.preset`** gain an optional **`entries` input port** (`Any`). Wired
  `LorebookEntry[]` are **concatenated onto the scanned matches** before assembly. Unwired = empty
  concat = **byte-identical** to before (the parity gate, `test/generation/generateParity*.test.ts`).
  On `prompt.preset`, a wired `worldInfo` override still skips the keyword scan (`matched = []`), but
  wired `entries` are **still appended** — they're explicit author intent, whereas the scan is implicit.

### Wiring recipe

`table.export.gen ← input.context.gen`; `prompt.assemble.entries ← table.export.entries` (or
`prompt.preset.entries`). The default graph does **not** auto-wire this (issue 05's example workflow
demonstrates it).

### Synthesis (`src/main/services/tableExportService.ts`, pure)

Per **enabled**-`exportConfig` table (an `enabled: false` table contributes **nothing**, not even an
index). Rows are **positional in `template.headers` order** (the `readAllTables` contract mirrors the
DDL column order); column lookup is by DISPLAY name → index into `headers`, **never** by SQL column name.

- **Row / whole-table entries** — `splitByRow: true` → one entry per data row, `content =
  applyTemplate(injectionTemplate, renderRow(headers, row))`, `comment = <entryName|displayName>#<rowIndex>`.
  `splitByRow: false` → one whole-table entry over all rows (`renderWholeTable`). `entryType: 'constant'`
  → `constant: true` (always fires); `'keyword'` → keys derived (below). Zero data rows → no row entries.
- **Index entry** (`extraIndexEnabled`) → **always-on** (`constant: true`): `content =
  applyTemplate(extraIndexInjectionTemplate, <one renderIndexLine per row, '\n'-joined>)`. An **empty
  table emits ONLY this index entry** (empty body); a table without `extraIndexEnabled` emits nothing here.
- Every synthesized entry has `prevent_recursion: true`.

**Key derivation (keyword entries):** the CELL VALUES of the `keywords` columns (comma-separated
DISPLAY names) **plus** the cells of `extraIndexColumns` whose mode is `'both'` — trimmed, empties
dropped, de-duped (first-seen order). Constant entries carry `keys: []`.

**Rendering formats** (deterministic, documented):

- `renderRow` — one `header: value` line per column, in `headers` order; null/short cells → empty value.
  E.g. `row_id: 1\n姓名: 艾莉亚\n所在位置: 王城`.
- `renderWholeTable` — a ` | `-joined header line, then one ` | `-joined line per row.
- `renderIndexLine` — `col: value` pairs (index columns, in config order) joined with ` | `.
  E.g. `姓名: 艾莉亚 | 所在位置: 王城 | 角色间关系: 盟友`.
- `applyTemplate` — replaces every `$1` in the wrapper with the body; an empty wrapper yields the body verbatim.

### Placement mapping (compat contract)

`{position, depth, order}` → our `{insertion_depth, insertion_order}` (`entryPlacement` for the row/
whole-table entry, `extraIndexPlacement` for the index entry):

| `position`                                              | `insertion_depth` | `insertion_order` | Notes                                                     |
| ------------------------------------------------------- | ----------------- | ----------------- | --------------------------------------------------------- |
| `at_depth_as_system`                                    | `depth`           | `order`           | Rides the existing depth-splice (system message at depth).|
| `before_character_definition` / `after_character_definition` | `null` (top block) | `order`      | **Approximation** — our lorebook model has no char-def anchor; the top World Info block is the closest. |
| `fixedEntryPlacement` / `fixedIndexPlacement` (any `fixed*`) | — | — | **Imported but IGNORED in v1** (not honored).             |

Qualification uses the real matcher: **constant entries always survive; keyword entries fire only on a
scan hit** against `gen.scanText` (recursion honored via `gen.maxRecursion`).

## Maintenance pipeline (issue 05)

The nodes that make **table maintenance an authorable post-response workflow** — a gated side-call
that reads the due tables, prompts a maintainer LLM, and applies the emitted SQL. All three live in
`src/main/services/nodes/builtin/tableNodes.ts` and are registered in `builtin/index.ts`.

### `table.gate` — the update-frequency cadence gate

Fires `due` once any watched table's effective update-frequency window has elapsed. Inputs `gen:
Context`, `floor: Any` (**ORDERING-ONLY** — wire from `output.writeFloor.floor`; its value is ignored,
it exists to sequence the gate AFTER the reply floor is persisted). Outputs `due: Signal`, `tables:
Any` (the due `sqlName[]`), `span: Any` (`{ from, to }`, the aged floor range). Config `{ tables?:
string (comma-separated sqlNames narrowing which tables to watch; unset = all template tables),
every?: 1..500 }`.

- **`every` — the global cadence override** (`tableNodes.ts` gate run(); post-merge cadence fix): when
  set, EVERY watched table's effective frequency becomes `every`, so the whole maintenance pass runs
  at most once every N floors. This is the player's knob for imported chatSheets templates whose
  tables carry `-1` (= every turn — normalized to `1` by the importer), which would otherwise fire the
  maintainer each round. Unset = the template's per-table frequencies. The Tables view's 下次维护
  prediction honors the override (`tableStatusService.effectiveFrequencies`, pure + tested — several
  overriding gates on one table: the lowest `every` wins).

- **Floor source:** the gate re-reads the floor count FROM DISK via `getAllFloors(profileId,
  chatId).length - 1` (`currentFloor`, clamped ≥0). `gen.floors` is the PRE-turn snapshot
  `input.context` took, so the just-persisted reply floor is missing from it — the disk read is
  mandatory for the cadence to advance.
- **Due rule:** the last-processed pointer lives in the **chat-level `table_progress` store**
  (`tableProgressService.getProgress` → `Record<sqlName, lastFloor>`, missing = `-1`), shared with the
  manual backfill and the Tables display — **NOT per-workflow node state** (issue 07 retired that,
  including its `at` rewind discriminator). A table is due when `currentFloor - (progress[t] ?? -1) >=
  updateFrequency` (freq `1` = every turn). No template / no due tables → `{ outputs: {} }` (no signal;
  a chat without table memory is a silent no-op).
- **AT-MOST-ONCE / FAIL-OPEN:** when the gate fires it **advances the store for every due table to
  `currentFloor` IMMEDIATELY** (`advanceProgress`, MAX-semantics upsert), before any downstream node
  runs. If the maintainer chain then fails, that span is simply skipped — worst case one missed batch.
  `span.from = min(progress[t] over due tables) + 1`, `span.to = currentFloor`.

### `table.read` — the maintainer-prompt ingredients

Renders the "here are the tables, here is what you may do" block. Inputs `gen: Context`, `tables: Any`
(the gate's due `sqlName[]`, or a comma-separated string; **unwired/empty = ALL template tables**),
`when: Signal`. Outputs `block: Text`, `tables: Any` (passthrough of the rendered scope). Config
`{ include_rules?: boolean (default true), max_rows?: 1..500 (per-table cap, keeps NEWEST-last rows) }`.
No template / no selected tables → **SILENT empty** (`{ block: '', tables: [] }`), never an error (the
`table.export` read precedent). Per-table block format:

```
## <displayName> (<sqlName>) — 每 N 轮维护
【表定义】<note>              (with rules)
【初始化规则】<initNode>       (with rules; ONLY when the table has 0 rows)
【插入规则】<insertNode>       (with rules)
【更新规则】<updateNode>       (with rules)
【删除规则】<deleteNode>       (with rules)
【当前数据】
<renderWholeTable(headers, rows)>
```

Empty rule strings are omitted. `include_rules: false` drops the definition + all rules (the whole
"ingredients" set), rendering just the `##` header + `【当前数据】` data. Blocks are `'\n\n'`-joined.

### `table.query` — a validated read for planner / 剧情推进 branches

Inputs `gen: Context`, `query: Text`, `when: Signal`. Outputs `rows: Any` (positional row arrays,
better-sqlite3 `.raw().all()` aligned to the result columns), `block: Text` (`renderWholeTable` of the
result), `error: Error`. **Validation (pure, exported as `validateReadQuery` in `tableSql.ts`,
unit-tested):** the query must be EITHER a bare **registered** `sqlName` (→ `SELECT * FROM "t"`) OR a
**single** statement (`splitSqlStatements` length 1) whose head is `SELECT` (case-insensitive, after
comment strip). Everything else — **`WITH` (a CTE head hides read-vs-write; out of contract)**, PRAGMA,
INSERT/UPDATE/DELETE, an unknown bare name, multi-statement text — is a class-B `bad-query`. Execution
(`executeReadQuery`) opens the sandbox `{ readonly: true }` (defense in depth behind the head check).
A blank query, no template, or a missing sandbox → **SILENT empty** (`{ rows: [], block: '' }`); a
SQLite runtime error → class-B `bad-query` carrying SQLite's message.

### Example workflow — `docs/workflows/table-memory-default.rptflow`

A shipped, importable example (the `decomposed-default.rptflow` convention — there is **no in-app
seeding mechanism**; authors import the file). **Main path:** the builtin default with `table.export`
wired into `prompt.assemble`'s `entries` port, so a chat's tables project into the prompt. **Post-
response maintenance** (reworked in the cadence fix): `table.gate` (gen from `ctx`, floor from
`write.floor`, config `{ every: 3 }` — the whole pass runs every 3 floors; edit/delete `every` to
change the cadence) → `table.read` (`tables` from `gate.tables`, `when` from `gate.due`) →
`prompt.messages` framing a **zh 数据库表格维护** prompt from `{{in1}}` = `read.block` and `{{in2}}` =
the EXACT aged-in transcript: a `context.refresh` (ordered after `write.floor`) feeds
`context.history`, whose `span` input is wired from `gate.span`, so the maintenance covers precisely
the floors since the last pass — including the just-persisted turn — with no gaps or overlap
(`count: 6` is only the dead-span fallback) → a NON-STREAMING `llm.sample` (`stream: false`,
`retries: 1`, **no `api_preset_id`** so it runs out-of-the-box on the active connection) →
`parse.extract` (tag `TableEdit`) → `table.apply` (`sql` from `sql.first`, `when` from `sql.found`).
`side.error` and `tableapply.error` route to two `util.log` nodes (fail-open). The maintainer prompt
instructs **exactly ONE `<TableEdit>` block** with all statements (so `sql.first` captures
everything), only INSERT/UPDATE/DELETE on the listed tables, the 一次交互 batch rule (纪要表 gains
exactly ONE row per pass), an empty tag when nothing changed, and the **record-only rule** (tables are
a historical archive: only facts that explicitly happened; no inventing, predicting, or advancing the
plot — `tableMaintenance.MAINTAINER_RULES` rule 5, shared with the backfill). Its `description` field
documents: assign a template in the Tables view (else the branch is a silent no-op), the `every` knob,
how to point `side` at a cheap model via `api_preset_id`, and how to chain a second staged pass
(世界推进 before 剧情推进) with an ordering edge (first `table.apply.done` → second `gate.floor`).
Validated by `test/workflow/tableMemoryExample.test.ts`.

## Hand editing (issue 06)

The Tables view is **writable**: edit a cell, add a row, delete a row, reset a table. A hand edit is
NOT a special case — it becomes LITERAL, replayable SQL routed through the **exact same op-logged
write path AI writes take**, so it survives turns and rolls back on a swipe past its floor identically.

### Row identity — `rowid`

An edit targets a row by its SQLite `rowid` (`chat-tables-read` returns `rowids[]`). `rowid` is
**replay-deterministic** here: instantiate + ordered op replay re-assigns the same rowids (SQLite
max+1 rule, single writer, ordered ops from `tableOpsService`), so a rowid the view captured survives
a rewind rebuild. Deletes create gaps; replay reproduces the same gaps. Documented where the edit SQL
is built (`src/main/services/tableEditService.ts`) and on `TableRead.rowids`
(`src/main/services/tableDbService.ts`).

### The edit path (`src/main/services/tableEditService.ts`)

Pure, exported, unit-tested builders (`test/tableEditService.test.ts`):

- `sqlQuote(v)` — `'…'` with `''` doubling (CJK values survive verbatim).
- `buildCellUpdate(sqlName, sqlColumn, rowid, value)` → `UPDATE "t" SET "col" = '<quoted>' WHERE
  rowid = N`. `sqlColumn` is the **real sandbox column name** (never a renderer string — see below),
  re-validated with `isSafeSqlIdentifier`; `rowid` must be a safe non-negative integer.
- `buildRowInsert(sqlName, values)` → positional `INSERT INTO "t" VALUES (…)`, `NULL` for null cells
  (the empty `row_id` slot → INTEGER PRIMARY KEY auto-assign), quoted literals otherwise.
- `buildRowDelete(sqlName, rowid)` → `DELETE FROM "t" WHERE rowid = N`.
- `buildTableReset(sqlName)` → `DELETE FROM "t"`.

`applyEdit(profileId, chatId, template, op)` builds the SQL, takes the per-chat write lock
(`tryBeginTableWrite`; busy → `{ error }`), runs it through **`applySqlBatch`** (the same validate +
execute-in-one-transaction path as AI writes), then **`appendOps`** at `getAllFloors().length - 1`
(clamped ≥0 — the just-persisted floor, same attribution `table.apply` uses). Returns
`{ ok, changes } | { error }`; CHECK / NOT NULL constraint violations surface as the `{ error }`
message (renderer toast) — never a crash. There is **no second write path and no unlogged write**.

### Column safety (index, not name)

The renderer sends only a column **INDEX** for a cell edit (`chat-tables-edit`), never a column-name
string. `tableMemoryIpc.ts` maps the index → the real column name off `tableDbService.sandboxColumns`
(the sandbox's actual DDL columns), validates the target table is in the template registry
(`templateSqlNames`), and only then calls `applyEdit`, which re-validates the resolved column with
`isSafeSqlIdentifier` (`src/main/ipc/tableMemoryIpc.ts`, `src/main/services/tableEditService.ts`).

### Reset is op-logged (deliberate)

Reset writes an op-logged `DELETE FROM "t"` (NOT a "clear the log" action). This keeps replay
consistent: on a rewind rebuild, instantiate re-seeds the template's initial rows and the replayed
`DELETE` clears them again, so a chat rebuilt at any later floor matches the live state
(`tableEditService.buildTableReset`). Delete-row and reset both **confirm** in the UI
(`TablesView.tsx`, i18n keys `tables.confirmDeleteRow` / `tables.confirmReset`).

## Template export (issue 06)

`exportChatSheets(template, dataRows?)` (`src/main/parsers/chatSheetsParser.ts`, next to the parser it
mirrors) reconstructs a chatSheets v2 object from a `TableTemplate`, writing back exactly the fields
`parseChatSheets` consumes: `mate.{type,version,globalInjectionConfig}` (the `globalInjectionConfig`
key is **omitted** when the template has no injection defaults — a present-but-empty object would
re-parse as a defined `globalInjection` and break the round-trip) + one `sheet_<uid>` per table
(`uid` preserved, `orderNo` = array index, `content = [headers, …rows]`, `updateConfig.updateFrequency`,
`sourceData.{ddl,note,*Node}`, `exportConfig`).

- **Round-trip contract (the AC): EQUIVALENCE, not bytes.** `parseChatSheets(exportChatSheets(tpl))`
  deep-equals `tpl` (`test/chatSheetsParser.test.ts`). A byte match is impossible because the importer
  normalizes `updateFrequency -1 → 1` and drops UI sentinels / `preventRecursion`; the *model*
  round-trips exactly.
- **Export with data:** `dataRows` (a `Map<sqlName, string[][]>`) embeds current rows as `content[1..]`
  (cells stringified, `null → ''`); absent → the template's own `initialRows`. Orchestrated by
  `tableTemplateService.exportTableTemplateToFile` (reads live rows via `readAllTables` when a `chatId`
  is passed) behind `table-template-export-dialog` (a `showSaveDialog`, mirroring workflowIpc's
  `export-workflow-dialog`).

## Backfill & progress (issue 07)

### The progress store (`table_progress`, chat-level — replaces the gate's node-state pointer)

A single **chat-level** last-processed pointer per `(chat, table)` lives in the app-DB table
`table_progress (chat_id, sql_name, last_floor)` (`db.ts` SCHEMA; FK-cascade on chat delete), managed
by `src/main/services/tableProgressService.ts`. `last_floor` is the 0-based floor index a table was
last processed through. It is:

- **advanced** (`advanceProgress`, MAX-semantics upsert) by `table.gate` on fire AND by every applied
  backfill batch,
- **clamped** (`clampProgress` → `last_floor = fromFloor - 1 WHERE last_floor >= fromFloor`) on floor
  truncation — the **explicit rewind hook** in `chatService.truncateFloors`, right next to the ops
  clamp (no `at`-discriminator inference; the issue-05 gate node-state pointer + its `at` field are
  **retired**),
- **reset** (`resetProgress`, rows deleted) on template (re)assignment/unassignment in
  `chatService.setChatTableTemplateId`.

The pure `computeTableProgress(lastFloor, updateFrequency, currentFloor)` derives the three display
numbers (`test/tableProgress.test.ts`): `processed = last + 1`, `nextExpected = last + updateFrequency`
(0-based floor at which the gate next fires), `unprocessed = max(0, currentFloor - last)` with
`last = lastFloor ?? -1`. A never-processed table → `processed 0`; freq 1 → `nextExpected 0`, freq 3 →
`nextExpected 2`.

`chat-tables-status(profileId, chatId)` → `tableStatusService.getTablesStatus` returns
`Record<sqlName, { lastFloor, processed, nextExpected, unprocessed }>` for every template table (the
old `mergeLastMaintained` workflow/node-state scan is gone). The **Tables** view header shows
`已处理 N 层 · 下次维护 第 M 层 · 未处理 K 层` per table (or `尚未处理` when never processed).

### Manual backfill (`tableBackfillService.ts`)

Fill the tables from PAST history on demand: `table-backfill-start(profileId, chatId, { lastFloors:
number | 'all', batchSize, apiPresetId?, retries })`. Scope = the last X floors (`planBatches` — pure,
tested), processed in ASCENDING batches of Y floors, each treated as ONE 交互 (纪要表 gains exactly one
row; other tables maintained normally). Per batch: render the tables block over ALL template tables
(current data — state advances batch by batch) → build the shared maintainer prompt
(`tableMaintenance.backfillMaintainerPrompt`, the SAME contract as the example workflow's `frame`
system prompt + the batch rule) → one non-streaming `callModelResilient` pass → `extractTagAll(raw,
'TableEdit')` → apply through the **ONE write path** (write lock → `applySqlBatch` → `appendOps` at the
batch's **LAST floor** → `advanceProgress`). Ops attributed to `to` mean a later rewind past that floor
rolls the batch back.

- **Auto-retry (optional, `retries` 0–5, default 0):** API errors ride `callModelResilient`'s own retry
  budget; SQL errors (validation/exec failure, or a busy write lock) re-call the model with the failed
  reply + the error fed back (a corrective attempt), capped at `retries` per batch. Exhausted retries
  mark the batch **failed** and the run **CONTINUES** (fail-open) — the failed span stays visible as
  unprocessed (progress NOT advanced).
- **Cancellation** (`table-backfill-cancel`) takes effect **between batches**; a batch in flight
  finishes or fails, applied batches stay applied. One backfill per chat at a time (`table-backfill-
  state` exposes `{ running, batchIndex, batchCount, span, failures[] }` for view re-mounts).
- **Events:** `table-backfill-progress` broadcasts to all windows (`tableBackfillEvents.ts`, the
  `chatEvents` pattern); the renderer filters by `chatId` and refetches tables + status per event.

## Deferred

Card-embedded templates (a template shipped inside a character card). Everything else in the
table-memory surface is built.
