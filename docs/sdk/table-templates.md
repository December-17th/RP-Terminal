# Table templates — the chatSheets v2 import surface (SQL-table memory)

**Status:** Current contract. chatSheets v2 import, per-chat enablement, the Tables view, validated SQL
writes, op-log/rewind, direct Classic prompt projection, built-in Agent recall and maintenance, template export,
structural migration, refill, and per-table progress are implemented. World Cards may embed templates
in `data.extensions.rp_terminal.table_templates[]`; import adds them to the profile library without
auto-assigning them to a chat.

The **Tables view** edits each table's five per-operation prompts, `exportConfig`, `injectionPolicy`,
and `updateFrequency` through `table-template-update`. Structural fields (DDL, columns, and tables)
change only through `table-structure-apply`.

RP Terminal's memory system is **SQL-table memory**: each chat maintains relational tables in a
per-chat sandbox. Models update them through the validated, op-logged SQL path; current rows return to
the narrative prompt through the direct Classic entry projection and the compact memory-tail injection.
The schema is a portable, file-based **table template**, importable from chatSheets v2.

This doc is the contract for that importer: what subset we accept, the field-by-field mapping, and
the defaults applied to the plugin's `-1` sentinels. Behavioral claims cite the file they were
verified against (`AGENTS.md` grounding rule).

## Artifacts & storage

- **Template** (design-time schema): one JSON file per template,
  `profiles/<profileId>/table-templates/<uuid>.json`, zod-validated by `TableTemplateSchema`
  (`src/main/types/tableTemplate.ts`). CRUD in `src/main/services/tableTemplateService.ts`
  (`listTableTemplates` / `getTableTemplateById` / `deleteTableTemplate` /
  `importTableTemplateFromFile`), mirroring `presetService`.
- **Sandbox DB** (per-chat table DATA): a **separate** SQLite file,
  `profiles/<profileId>/chats/<chatId>/table.sqlite` — **never** the central app DB
  (`rpterminal.db`). It travels with the rest of that session in `.rpsave` exports. Managed
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

### World Card bundle import

A World Card may carry `data.extensions.rp_terminal.table_templates[]`
([`character.ts`](../../src/main/types/character.ts)). Each element is imported through
`tableTemplateService.importTableTemplateFromObject`, which accepts the chatSheets v2 shape above or a
native `TableTemplate` containing at least one table. Invalid elements fail softly and are omitted from
the installed count ([`characterService.ts`](../../src/main/services/characterService.ts)).

Bundled templates are **library-drop only**: import never assigns one to the new chat because
`setChatTableTemplateId` recreates the per-chat sandbox and assignment is destructive. When enabled by
`settings.tables.remind_set_template` (default on), creating a chat opens the localized template
reminder; its primary action opens the full-window Memory Manager so the user can inspect and assign the
intended template, including when a card owns the play area with a static layout
([`chatStore.ts`](../../src/renderer/src/stores/chatStore.ts),
[`TableTemplateReminderModal.tsx`](../../src/renderer/src/components/TableTemplateReminderModal.tsx)).
Updating an already-installed World Card does not reinstall its bundled templates: templates are
profile-library artifacts without world ownership, so reinstalling them on every card update would
silently create duplicates. Importing the card as a new world still installs its valid templates.

## Mapping (chatSheets sheet → `TableDef`)

| chatSheets field                             | `TableDef` field                      | Notes                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uid`                                        | `uid`                                 | Identity carried over.                                                                                                                                                                                          |
| `name`                                       | `displayName`                         | zh display name (e.g. 纪要表).                                                                                                                                                                                  |
| `sourceData.ddl` → `CREATE TABLE <name>`     | `sqlName` (parsed) + `ddl` (verbatim) | `ddl` kept as-authored, comments and all.                                                                                                                                                                       |
| `content[0]`                                 | `headers`                             | Display column names.                                                                                                                                                                                           |
| `content[1..]`                               | `initialRows`                         | Usually empty (templates ship header-only).                                                                                                                                                                     |
| `sourceData.note`                            | `note`                                | Table-definition prompt.                                                                                                                                                                                        |
| `sourceData.{init,insert,update,delete}Node` | `{init,insert,update,delete}Node`     | Per-op AI instructions; default `''`.                                                                                                                                                                           |
| `updateConfig.updateFrequency`               | `updateFrequency`                     | `-1`/absent → **`-1` = use the global default** `settings.tables.default_update_frequency` (default 3); `0` = **off** (excluded from auto-maintenance); positive ints kept. `<= -2` clamped to `-1` (issue 04). |
| `exportConfig.*`                             | `exportConfig.*`                      | Verbatim (see below); projected by `generation/classicStages.ts` through the direct Classic prompt path.                                                                                                        |
| `mate.globalInjectionConfig`                 | `TableTemplate.globalInjection`       | `readableEntryPlacement` / `wrapperPlacement`.                                                                                                                                                                  |

### `exportConfig` mapping (direct Classic projection)

`enabled`, `splitByRow`, `entryName`, `entryType` (`'constant'|'keyword'`, non-`keyword` → `constant`),
`keywords`, `injectionTemplate`, `extraIndexEnabled`, `extraIndexEntryName`, `extraIndexColumns`,
`extraIndexColumnModes` (per-column `'both'|'index_only'`; other values dropped),
`extraIndexInjectionTemplate`, and four `{position, depth, order}` placements — `entryPlacement`,
`extraIndexPlacement`, `fixedEntryPlacement`, `fixedIndexPlacement`. Missing placements default to
`{ position:'at_depth_as_system', depth:0, order:0 }` (`PlacementSchema`).

## Main-prompt memory injection — `injectionPolicy` (WS4 / D10)

Each table carries a **native** `injectionPolicy` (`src/main/types/tableTemplate.ts`
`TableInjectionPolicySchema`) controlling a simple capped block in the main narrative prompt. The rich
chatSheets `exportConfig` is also active: the direct Classic path turns enabled table rows into
worldbook-style entries, qualifies them through the lorebook matcher, and supplies them to
`assemblePrompt`. These are separate, cumulative surfaces: `injectionPolicy` controls the compact
memory-tail block; `exportConfig` controls entry activation and placement.

| field  | values                                       | meaning                                                                                               |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mode` | `'recent'` (default) \| `'full'` \| `'none'` | `recent` = keep the **last N** rows; `full` = all rows; `none` = never injected into the main prompt. |
| `rows` | optional int ≥ 0                             | Per-table row cap for `recent`, **overriding** the global cap. Unset = global cap.                    |

- **Global cap:** `settings.tables.injection_max_rows` (default **20**), mirroring the
  `default_update_frequency` pattern. A per-table `rows` beats it; a zero/negative/non-finite cap clamps
  to `0` (a `recent` table then shows nothing — the opt-out).
- **Rendering** (`tableMaintenance.ts` `renderInjectionBlock` — PURE, `test/tableInject.test.ts`): for
  each non-`none` table **with rows**, a compact section `## <displayName>（<sqlName>）` + the rows (DDL
  real column names, LAST-N for `recent`). When `recent` truncated older rows it emits the marker
  **`…（省略 N 行较早记录）`**. An empty table / a `none` table / a 0-cap table emits **no section**; when
  no section survives, **no block at all** (not an empty header). Every contributing table is joined
  under one `【记忆表格】…` intro.
- **`'summary'` is DEFERRED** (LLM-condensed rows): it needs the future vector/summary engine and is
  **not a valid mode yet**. The truncation marker is the reserved seam that will carry it — nothing else
  is reserved.
- **Injection seams:** `tablesInjectionService.renderChatTablesInjectionBlock`, called by
  `generation/assemble.ts`, adds the compact `injectionPolicy` block to the memory tail. Separately,
  `generation/classicTurn.ts` calls `exportTableEntries`, then concatenates the qualified
  `exportConfig` entries with matched lorebook entries before `assemblePrompt`. Both paths fail open:
  no template, no eligible rows, or a read failure leaves the corresponding prompt contribution empty.
- **Round-trip:** `injectionPolicy` is **RPT-native** — it has no chatSheets analogue, so it is **NOT**
  written by `exportChatSheets` and an import re-applies the schema default (`{ mode:'recent' }`). That
  keeps `parseChatSheets(exportChatSheets(tpl))` lossless-for-the-model (the reader never emits a
  non-default value), so the round-trip test stays honest (`test/chatSheetsParser.test.ts`). It is
  editable via the same `table-template-update` patch (`injectionPolicy?`); the editing **UI is WS6+**.

## Memory Recall Agent — opt-in pre-turn selection

Memory Recall is the seeded built-in Agent with `source_key = memory-recall`. It is disabled by default
because an eligible turn adds one awaited provider call. Its profile-local Agent settings own the enabled
switch, API preset, and editable prompt. The definition is `required: false`, `maxSteps: 1`, and
`blocksNextTurn: false`: Classic already awaits this current-turn call instead of scheduling it from a
floor-commit trigger.

`services/memoryRecallService.ts` prepares the invocation input and explicitly runs the Agent through the
shared Invocation Runtime before prompt assembly. That runtime owns the Run Record, endpoint budget,
cancellation, and configured API preset. The call runs only when the chat has either an enabled
`exportConfig.extraIndexEnabled` table or a non-empty `notes.md`; otherwise it is a zero-call no-op.
On an eligible turn it:

1. passes a full or locally narrowed summary index, notes table of contents, prior plan, recent transcript,
   pending player action, user persona, and character context as the Agent invocation input;
2. asks for `<Recall>`, `<Query>`, `<QuestPlan>`, and `<StoryEngine>` tags;
3. resolves `<Recall>` codes by exact key over the same candidate-row snapshot the Agent saw—Agent
   text is never SQL and cannot select a row hidden by retrieval;
4. greps requested note sections locally with the CJK-safe notes engine;
5. caps resolved rows at 24 and note sections at 6, injects one composed block into `assemblePrompt`'s
   memory tail, and persists the display-only `plot_block` on the resulting floor.

The Run Record is attached to the latest committed source floor, while the resulting floor receives the
new `plot_block`. That prior-floor plan supplies the next turn's advisory state, so truncation/rewind
naturally removes stale plans. Failed or cancelled Agent runs return no recall block and the main turn
continues fail-open; failed runs also show a localized renderer warning. This fail-open policy is RP
Terminal's explicit behavior.

### Large-catalog retrieval

`services/memory/memoryRetrieval.ts` narrows large code-keyed catalogues before the Agent call. The
retrieval switch defaults on, but the full eligible code-keyed catalogue remains unchanged below 200
rows. At or above the threshold it mirrors Shujuku's Crossfire shape:

- the query is the pending player action plus the three-floor recent transcript;
- the newest 50 rows **per table** are retained independently of score;
- older rows are ranked by BM25 (`k1 = 1.5`, `b = 0.75`, at most 1000 sparse candidates) using NFKC,
  lower-cased Latin/code terms and CJK unigrams+bigrams;
- when an OpenAI-compatible embedding preset is selected, cosine matches at `>= 0.45` join BM25 via
  reciprocal-rank fusion (`k = 60`); without one, retrieval is BM25-only;
- at most 200 ranked older rows are unioned with the fixed recent rows, de-duplicated, then restored to
  original table/row order before rendering the Agent catalogue.

The threshold, recent count, candidate count, and enabled flag are profile settings; the current Settings
UI exposes the switch, threshold, and embedding preset. Embeddings are a derived, fingerprinted cache in
the chat's existing `session.sqlite` table `memory_retrieval_embeddings`; canonical memories remain rows
in `table.sqlite`. There is no vector database or vector sidecar. Missing, stale, or corrupt vectors are
rebuilt lazily. An absent/unsupported preset or an embedding failure logs the degradation and preserves
the deterministic BM25 result. Cancellation still aborts the Recall Agent turn rather than starting work
after Stop (`memoryRetrieval.ts`, `sessionDbService.ts`, `settingsService.ts`).

The Shujuku artifacts establish recall as a blocking pre-generation selector over compact memory codes,
with local expansion of the chosen rows in the same narrator turn. RP Terminal adopts its recent-row,
BM25, dense, and RRF candidate shape but keeps the vector cache in per-chat SQLite. It currently uses the
pending action plus recent story directly rather than Shujuku's separate keyword-generation call, has no
external reranker, and intentionally keeps one planner call rather than Shujuku's three serial plot tasks.
Markdown-note `<Query>` retrieval is an RP Terminal extension, not claimed Shujuku parity.

## Verified against the real template

`test/fixtures/chatsheets-poem-of-destiny-5.9.json` (the 命定之诗 5.9 template) imports into **8**
ordered tables — `sqlName`s: `protagonist_info`, `important_characters`, `chronicle`,
`roleplay_guide`, `foreshadow_table`, `covenant_table`, `region_table`, `location_table`
(`test/chatSheetsParser.test.ts`). Spot-checked: 纪要表 `updateFrequency -1` kept verbatim (the
use-global sentinel — issue 04, no longer normalized to `1`) + keyword index; 重要角色表 `splitByRow`

- keyword columns + `extraIndexColumnModes`; 主角信息 export disabled.

## IPC surface (`src/main/ipc/tableMemoryIpc.ts`, preload `src/preload/index.ts`)

`table-templates-list`, `table-template-get`, `table-template-update`, `table-template-delete`,
`table-template-import-dialog` (returns `{ summary } | { error } | null`); `chat-table-template-get` /
`chat-table-template-set`;
`chat-tables-read` (all tables of the assigned template as
`[{ sqlName, displayName, columns, rows, rowids }]`); `chat-tables-edit` (hand edit → `{ ok, changes }
| { error }`); `chat-tables-status` (last-maintained floor per table); `table-template-export-dialog`
(export to chatSheets v2 JSON) — issue 06; `table-structure-apply` (structural edit + bound-chat
migration — Memory-Manager WP4a, below). The **Tables** view is registered as `tables` in
`src/renderer/src/components/workspace/viewRegistry.tsx`.

`table-template-update(profileId, id, patch)` → `{ ok: true } | { error }` (manual-pass issue 03). The
patch is `{ name?, tables: [{ uid, note?, initNode?, insertNode?, updateNode?, deleteNode?,
updateFrequency?, exportConfig?, injectionPolicy? }] }`: only the **five per-op prompts +
`updateFrequency` + the injection `exportConfig` + the main-prompt `injectionPolicy`** (and the template
`name`) are editable — structural fields (`sqlName`,
`ddl`, `headers`, `initialRows`, `displayName`) are IMMUTABLE (DDL only executes at instantiation, so
editing it without re-instantiating would desync every chat using the template). `updateFrequency`
accepts `-1` (global), `0` (off), or a positive int; `<= -2` is a `templateBadPatch` (issue 04). The
merge is the pure
`tableTemplateService.applyTemplatePatch` (unknown table `uid` → `{ error: 'tables.templateUnknownTable' }`;
malformed patch → `{ error: 'tables.templateBadPatch' }`; missing template → `{ error:
'tables.templateNotFound' }`), then `saveTableTemplate` overwrites the SAME id. A template is shared: edits apply to every assigned chat and are read on the next prompt assembly or
Memory Maintenance pass; there is no runtime graph or sandbox rebuild for prompt/config changes.
`chat-tables-read` returns each row's SQLite `rowid` (`rowids[]`, 1:1 with `rows`;
`tableDbService.readOne` selects `rowid AS __rid, *` and slices the alias off so `rows`/`columns` stay
data-only + positional — no other `TableRead` consumer changes). Columns are unified onto the
template's DISPLAY headers when they line up 1:1 with the sandbox's real columns
(`tableDbService.unifyDisplayColumns`), so both empty and populated tables show e.g. 人物名称 rather
than the SQL name (`src/main/services/tableDbService.ts`).

## Structural edit + migration (Memory-Manager WP4a — `src/main/services/tableStructureService.ts`)

Structural fields ARE editable, but ONLY through `table-structure-apply(profileId, templateId, ops)`
→ `{ ok, tablesChanged, columnsChanged, chatsMigrated, failedChats, warnings }` | `{ ok:false, error }`
(a localizable `tables.structure*` key). This is the ONE path that rewrites `ddl` / `sqlName` /
`headers` / `initialRows`; `table-template-update` still refuses them. `ops` is an ordered list of
high-level ops (`addTable` / `dropTable` / `renameTable` / `addColumn` / `renameColumn` /
`dropColumn`); tables are addressed by their stable `uid`, and `addTable` mints a new one
(`StructureOp`, exported from the service, mirrored inline in `preload/index.d.ts`).

Algorithm — a **strict ordering** so a mid-way failure can never leave a half-migrated chat:

1. **Validate** the whole batch against the current template (identifier safety, existence /
   collision); REJECT atomically on any bad op (nothing written).
2. **Derive the new DDL** from a THROWAWAY `:memory:` DB seeded from the current DDL: run the
   `ALTER/CREATE/DROP` there and read each canonical `CREATE TABLE` back from `sqlite_master` (so the
   stored `ddl` is exactly what `instantiate` will re-run). **No real sandbox is touched here** — a
   derivation failure (or the "produced no DDL" guard) leaves the template AND every sandbox
   byte-for-byte unchanged.
3. **`saveTableTemplate` ONCE** (same id), only after derivation succeeds: `headers` regenerate from
   the new columns (surviving/renamed columns keep their label, new columns default to the column
   name); `initialRows` remap positionally (surviving values kept, dropped columns removed, added
   columns filled `''`); `exportConfig` (`keywords` / `extraIndexColumns` / `extraIndexColumnModes`)
   remaps by the rename map and drops references to dropped columns. Per-op prompt **prose is NOT
   rewritten** — a reference to a renamed/dropped column becomes a `warnings[]` advisory.
4. **Migrate each bound chat, one at a time.** Apply the `ALTER/CREATE/DROP` to its live sandbox in
   an OPEN transaction, read the migrated rows on that same (uncommitted) handle to build the
   floor-0 baseline (`DELETE FROM t` + one `INSERT` per row), **rewrite its op log ATOMICALLY** (one
   app-DB transaction: `deleteAllOps` then `appendOps` — the old ops are never dropped without the
   new baseline landing), and only THEN commit the sandbox. The baseline is ordinary DELETE/INSERT
   that passes `validateBatch`, so a later `rebuildSandbox` / rewind reconstructs the MIGRATED rows
   (the raw `ALTER` is never replayed). rowids are reproduced via the `row_id` PK value (the memory
   convention) or an explicit `rowid` column otherwise.

**Per-chat failure is recoverable, not half-migrated.** If any step for a chat throws, its sandbox
rolls back and the op-log rewrite either never ran or rolled back — the chat is left on the PREVIOUS
schema + its OLD op-log, and appears in `failedChats: [{ chatId, reason }]` (WP4b surfaces it for a
re-sync/retry). The template + every other chat stay migrated. Because the op-log rewrite commits
BEFORE the sandbox commit, the one residual (non-data-loss) window is the reverse: op-log written but
the sandbox commit lost to a crash — a subsequent `rebuildSandbox` (`instantiate(new)` + replay of the
new baseline) self-heals to the migrated state.

The raw `ALTER/CREATE/DROP` runs on the migration's OWN db handle, bypassing the LLM write-path
guard (`classifyStatement` rejects `ALTER`) — intended: this is trusted in-process schema evolution,
not model-emitted SQL. The progress pointer (`tableProgressService`) is left untouched (a structural
edit doesn't change which floors were processed).

**Residual non-atomic boundary (documented, not closed):** the template is a JSON file and the op
logs live in SQLite — two different stores, so `saveTableTemplate` (step 3) and the per-chat op-log
rewrites (step 4) can't be one atomic unit. A crash between them leaves the new template on disk with
some chats not yet migrated; those chats then behave exactly like a `failedChats` entry (old schema +
old op-log), and re-running the same ops finishes them.

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

Every applied batch is appended to `table_ops (chat_id, floor, seq, sql, created_at, target_table,
source, from_floor)` in the app DB, keyed by the floor it was applied on. On floor truncation
(`chatService.truncateFloors` → regenerate / swipe / delete-from), ops at/after the cut floor are
dropped (`deleteOpsFrom`) and the sandbox is rebuilt (`rebuildSandbox`): instantiate the template
DDL, then replay the surviving ops in `(floor, seq)` order. Replay is deterministic (single-writer)
and **fail-open** — an op that now fails (e.g. a template change dropped a column) is logged and
skipped, never bricking the chat. `table_ops` rows are cleared by FK cascade on chat deletion
(`foreign_keys = ON`), and `setChatTableTemplateId` clears the whole log on (re)assign/unassign (the
sandbox is recreated, so old-template ops must not replay). The pure `replayPlan(ops, fromFloor)`
(which ops survive a cut, order, floor attribution) is unit-tested; live state-equality after a
rebuild lands in the owner's manual pass because `better-sqlite3` is alias-mocked under vitest.

**Op attribution (WS1 — `target_table` + `source`).** Two columns, added by forward migration in
`db.ts` `getDb()` (`addColumnIfMissing` + index `idx_table_ops_chat_table_floor(chat_id,
target_table, floor)`):

- **`target_table`** — the single table a statement writes, classified at append time by
  `appendOps` via the pure `opTargetTable(sql)` (same single-table INSERT/UPDATE/DELETE classifier as
  the write path). Deterministic because every logged statement was already `validateBatch`-gated;
  `'*'` is the defensive fallback for a statement that no longer classifies. A one-time backfill
  (`migrateTableOpsTargetTable`, idempotent — scoped to `target_table IS NULL`) classifies legacy
  rows. Enables the table-scoped cut `deleteOpsFor(profileId, chatId, tables, fromFloor)` (drops ops
  at/after `fromFloor` whose `target_table ∈ tables`); **`'*'` rows are never matched by the IN-list,
  so they always survive** (do not pass `'*'` in `tables`).
- **`source`** — write-path provenance, one of `maintain` (auto `memory.maintain`), `backfill`
  (`tableBackfillService`), `edit` (`tableEditService` hand edits), `baseline` (structural
  re-baseline, `tableStructureService.rewriteOpLog`), `refill` (the WS2 refill engine), or **NULL for
  legacy rows** (provenance is not reconstructable). `appendOps` takes an optional trailing
  `source?: TableOpSource`; `hasBaselineOps(profileId, chatId, tables)` probes for `source='baseline'`
  ops (the refill partial-refill gate reads it).

  **Residual risk (legacy NULL source):** a structural re-baseline written before WS1 has
  `source=NULL`, indistinguishable from organic floor-0 ops, so `hasBaselineOps` cannot detect it —
  a partial refill of such a chat could still re-duplicate. New re-baselines (post-WS1) are stamped
  `'baseline'` and gated correctly.

- **`from_floor`** (P1 — span provenance) — the START floor of the maintainer batch that produced an
  op. Ops are keyed to the batch's **LAST** floor (`floor`), so a multi-floor batch's span start would
  otherwise be lost; without it a refill whose cutpoint lands INSIDE a batch's span would delete the op
  but only regenerate from the cutpoint, losing the span's earlier floors' contribution. Writers stamp
  it: refill (`appendOpsAt`) records each batch's `span.from`; backfill passes `span.from`; the baseline
  re-write passes `0`; auto-maintain passes a conservative batch-wide `max(0, min(progress[t]+1 over the
scope tables))`; hand edits pass their own floor. **Nullable — legacy rows stay NULL**, which the
  refill widener COALESCEs to the op's own `floor` (= single-floor op, no widening below the request).
  `earliestSpanStart(chatId, tables, fromFloor)` returns `MIN(COALESCE(from_floor, floor))` over the
  selected tables' ops ending at/after `fromFloor`; the refill uses it to WIDEN its cutpoint down onto a
  span boundary (`widenedRefillFrom`, before the baseline gate) so a cut can never bisect a stored span.

`listOpsForDisplay` surfaces `source` (nullable) alongside the SQL-derived `kind`/`table` for the
History surface.

### Write lock (token-owned)

A per-chat in-module mutex serializes concurrent table writes for a chat (the removed compaction-slot
pattern). It is **token-owned** so a long refill can't have its slot silently handed to a concurrent
auto-maintain by the stale expiry:

- `beginTableWrite(chatId): token|null` — claim the slot, returning a unique token (null while another
  writer holds an unexpired claim, `WRITE_GUARD_MS = 120_000`).
- `renewTableWrite(chatId, token): boolean` — refresh the expiry **iff** the token still owns the slot
  (false when the 120s window lapsed and another writer reclaimed it). The refill engine calls this at
  the top of every batch **and on a ~45s heartbeat interval** (`startGuardHeartbeat`, < `WRITE_GUARD_MS`/2)
  for the whole run, so the lease can never lapse across a single batch's model call — which can exceed
  120s once retries + SQL-corrective re-asks stack up. A `false` (from the heartbeat or the loop top)
  stops the run before its next commit.
- `endTableWrite(chatId, token?)` — release; with a `token`, release only if it still owns the slot
  (never frees a successor's claim). Without a token, the legacy unconditional release.
- `isTableWriteBusy(chatId): boolean` — a non-claiming **pre-flight probe** (held && unexpired) for
  destructive callers that must REFUSE rather than silently skip. Used by the structure migration
  (`applyStructureOps` — a single synchronous pass, so it busy-rejects up front instead of holding a
  lease) and the template delete/assign paths (`removeTableTemplateIdFromChats`, which scans every bound
  chat before unbinding any). The refill heartbeat above is what lets these probes trust the busy
  reading even while a long refill sits inside a >120s model await.
- `tryBeginTableWrite(chatId): boolean` / `endTableWrite(chatId)` — thin wrappers for short-hold
  callers (`applyTableEdit`, backfill, hand-edit, and sandbox rebuild) that complete well inside 120s.
  A busy chat yields a recoverable `busy` result so automatic maintenance can retry later.

### Refill engine (`tableRefillService.ts` — the chunk-committed regenerate)

`startRefill(profileId, chatId, { tables?, fromFloor?, extraHint?, apiPresetId?, retries?, batchSize? })`
(IPC `chat-tables-refill`) FIXES the duplicate-rows bug that both the append `memory.maintain (run now)`
path (now retired) and the manual backfill exhibit on overlapping floors. Instead of APPENDING onto the
current tables, it ROLLS the selected tables (or all) back to a cutpoint and REGENERATES the tail from
the transcript, built as a **generalized backfill** (per-BATCH attribution: each batch's statements keyed
to its `span.to` via `appendOpsAt`, and carrying its `span.from` as `from_floor` provenance, not a collapse
to one floor) on a temp **shadow sandbox**:

**Lifecycle interface and compatibility adapter.** `createTableRefillLifecycle({ runMaintainerBatch,
notifyProgress })` creates an isolated lifecycle instance with `start`, `resume`, `cancel`, `discard`, and
`state` methods. Each instance owns its live run map, abort controllers, and snapshots. `start` and
`resume` return a `RefillRunHandle`; its `completion` promise resolves to the terminal
`RefillRunOutcome` (`done` with `finalize:true`, or `cancelled`/`error` with `finalize:false`). The
production exports remain the compatibility surface: `startRefill` and `resumeRefill` validate and launch
through one production lifecycle instance but return once the run starts, while `cancelRefill`,
`discardRefill`, and `getRefillState` delegate to that same instance. IPC timing and user behavior are
unchanged.

Only the external maintainer/model call and progress notification sink are adapters. Transcript storage,
session SQLite, table sandboxes, op-log replay, progress pointers, and template lookup use their production
implementations. Durable `table_refill_progress`, committed `table_ops`, final `table_progress`, and the
published sandbox files are authoritative; lifecycle snapshots and progress events are projections of
that state.

1. **Guard + gates.** Claim the token-owned write guard; capture the op-log watermark (`opsWatermark` =
   `MAX(rowid)` for the chat). A partial refill (`from > 0`) of a table carrying a `source='baseline'`
   op (a structural re-baseline) is REJECTED with `tables.refillNeedsFull` (`refillBaselineBlocked`) —
   it would re-duplicate; a from-0 full refill is always clean. Default `from` when unset =
   `defaultRefillFrom` (min earliest-un-maintained across selected, **clamped to `latest`** so run-now
   stays meaningful when pointers are current). The requested cutpoint is then WIDENED DOWN onto a stored
   span boundary (`widenedRefillFrom` over `earliestSpanStart`, BEFORE the baseline gate) so it can never
   bisect a multi-floor batch — widening to 0 correctly turns a would-be baseline-blocked partial into an
   allowed full refill. (The pre-confirm range shown in the UI does not yet reflect this widening — a
   known UI follow-up; the engine widens authoritatively.)
2. **Shadow build.** `instantiateAt(refillShadowPath, template)` + `replayOpsInto` every op EXCEPT the
   selected tables' tail (`shouldReplayIntoShadow`: drops `selected ∧ floor ≥ from`; `'*'`/NULL and
   unselected always replay). The live sandbox is untouched.
3. **Regenerate in chunks (chunk = 1 batch).** Per batch: render the tables block FROM THE SHADOW,
   prompt the maintainer (`refillMaintainerPrompt` — the backfill framing + an "only update:
   <selected>" directive + optional `extraHint`), apply the reply to the shadow FILTERED to the
   selected tables (`partitionBySelected` drops + counts out-of-scope statements), record the executed
   statements against `span.to` (with `span.from` as their `from_floor`), and `renewTableWrite` the guard.
   The lease is ALSO renewed on a ~45s heartbeat (`startGuardHeartbeat`) DURING each batch's model call,
   so it never lapses across a >120s await and the pre-flight probes above can trust `isTableWriteBusy`
   the whole time; if the heartbeat ever reports a lost slot, the run stops before that chunk's commit
   (`tables.refillGuardLost`). The lease is treated as lost if it ever provably lapsed — a renewal gap
   ≥ the guard window (`WRITE_GUARD_MS`), which under event-loop starvation lets a probe see the slot
   free while the run's identity-owned token would still renew fine — not only when it was reclaimed.
4. **Commit + publish per chunk.** One app-DB transaction = { first COMMITTED chunk only:
   `deleteOpsFor(selected, from)`; insert the chunk's ops via `appendOpsAt(chatId, floorOps, 'refill')`;
   advance the `table_refill_progress` row }, guarded by a re-check of the watermark (`watermarkMoved` —
   a foreign INSERT that raised `MAX(rowid)` ABORTS the commit). Then **publish** the shadow over the
   live sandbox by file snapshot (`publishShadow` — WAL-checkpoint + copy), **never** `rebuildSandbox`
   (which self-claims the held guard and silently skips); `rebuildSandboxUnguarded` is the
   publish-failure fallback.
5. **Finalize / resume — STOP-AND-RESUME failure semantics** (`refillRunOutcome`). A batch that
   exhausts its retries TERMINATES the run (a `batch-failed` event, then a terminal `error`) — NOT
   backfill's continue-on-failure: the tail is already cut, so skipping a failed span would let later
   chunks advance `completedUntil` past it and finalize would advance the pointers over a permanent,
   non-resumable hole. On failure/cancel: committed chunks STAY, the `in_progress` row stays
   (`completedUntil` = the last GOOD chunk), pointers are NOT advanced, the shadow is dropped;
   **Resume** (`resumeRefill`, IPC `chat-tables-refill-resume`) starts a fresh refill from
   `resumeRefillFrom(fromFloor, completedUntil) = max(from, completedUntil+1)` — retrying exactly the
   failed span (the op-log composes exactly). Only a CLEAN full run finalizes:
   `advanceProgress(selected, latest)` + delete the progress row + shadow. `discardRefill` (IPC
   `chat-tables-refill-discard`) drops the resume record + shadow, keeping committed chunks.
   `getRefillState` (IPC `chat-tables-refill-state`) returns `{ run, persisted }`.
6. **Transcript-staleness fence** (the regenerate-mid-refill race, 2026-07-14). The run captures
   `floorService.transcriptEpoch(chatId)` in the same sync block that snapshots the floors; the epoch
   is bumped by truncation (`deleteFloorAndSubsequent`), in-place floor edits, and swipe
   switch/append (NOT by appends or variable-only saves). Each chunk commit re-checks it inside the
   transaction and throws `tables.refillTranscriptChanged` on a mismatch; a moved epoch after the
   loop also blocks FINALIZE (pointers would overshoot the clamp `truncateFloors` applied). On
   unwind with a moved epoch the run rebuilds the live sandbox via `rebuildSandboxUnguarded` before
   releasing the guard — `truncateFloors`' own guarded rebuild self-skipped while the refill held it.
   Proactively, `truncateFloors` → `floorService.onTranscriptCut` listeners → the engine ABORTS a
   live run immediately and fixes the resume row per `refillProgressAfterCut(row, cutFloor)`: cut ≤
   `fromFloor` ⇒ row deleted; cut inside the committed range ⇒ `completedUntil` clamped to
   `cutFloor - 1`; cut above ⇒ kept. An in-place floor EDIT / swipe switch (indices survive, content
   stale) fires the sibling `floorService.onTranscriptEdited` seam → the engine ABORTS the live run and
   clamps the resume row per `refillProgressAfterEdit(row, editFloor)`: edit inside the committed range ⇒
   `completedUntil` clamped to `editFloor - 1` (Resume then regenerates the edited floor — its cut drops
   the stale committed ops, and `startRefill`'s widener pulls the cut down further if the edit bisects a
   stored span); edit below `fromFloor` or above `completedUntil` ⇒ kept; NEVER deleted (an edit
   invalidates content, not floor indices). (`memory.maintain` uses the same epoch via `applyTableEdit`'s
   `expectTranscriptEpoch` — a stale single-call batch is dropped with report
   `stale transcript, skipped`.)

**Progress table.** `table_refill_progress(chat_id PK REFERENCES chats(id) ON DELETE CASCADE,
selected_json, from_floor, completed_until, status, updated_at)` — one in-flight refill per chat, the
shujuku `manualRefillProgress` analogue. **Events** ride the backfill channel `table-backfill-progress`
with `kind:'refill'` (+ `completedUntil`). Pure decision helpers (unit-tested):
`shouldReplayIntoShadow`, `partitionBySelected`, `defaultRefillFrom`, `refillBaselineBlocked`,
`watermarkMoved`, `resumeRefillFrom`, `planChunkCommit`, `refillRunOutcome`, `refillProgressAfterCut`,
`refillProgressAfterEdit`.

**Lifecycle testing stance.** `test/tableRefillLifecycle.test.ts` drives the instance interface against
real workspace-local files and real SQLite through the Node `better-sqlite3` compatibility adapter. It
asserts published rows, committed refill ops and floor attribution, durable resume/frontier state,
cancellation, discard, transcript-staleness recovery, and terminal outcomes. The maintainer batch runner
is scripted because it is the external model seam; progress events are recorded only to check agreement
with durable state. `test/tableRefill.test.ts` retains focused pure coverage for reusable algorithms and
hard edge matrices such as chained cutpoint widening, progress adjustment, terminal precedence, and
heartbeat-gap detection.

## Prompt projection

`generation/classicTurn.ts` calls `exportTableEntries(gen, {})` directly before prompt assembly. The
service resolves the chat's assigned template, reads current table rows, calls `synthesizeEntries`,
qualifies the resulting `LorebookEntry[]` through `lorebookService.matchAcross`, and concatenates the
qualified entries with normal world-info matches. No template or no qualified entries is a silent
empty projection. There is no node, port, wiring recipe, or selectable workflow path.

The internal `ExportEntriesConfig` may narrow by comma-separated `sqlName` and cap each table to its
newest rows. Classic uses the default empty config, so every enabled `exportConfig` table participates
without a row cap.

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
- `renderWholeTable` — a `|`-joined header line, then one `|`-joined line per row.
- `renderIndexLine` — `col: value` pairs (index columns, in config order) joined with `|`.
  E.g. `姓名: 艾莉亚 | 所在位置: 王城 | 角色间关系: 盟友`.
- `applyTemplate` — replaces every `$1` in the wrapper with the body; an empty wrapper yields the body verbatim.

### Placement mapping (compat contract)

`{position, depth, order}` → our `{insertion_depth, insertion_order}` (`entryPlacement` for the row/
whole-table entry, `extraIndexPlacement` for the index entry):

| `position`                                                   | `insertion_depth`  | `insertion_order` | Notes                                                                                                   |
| ------------------------------------------------------------ | ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `at_depth_as_system`                                         | `depth`            | `order`           | Rides the existing depth-splice (system message at depth).                                              |
| `before_character_definition` / `after_character_definition` | `null` (top block) | `order`           | **Approximation** — our lorebook model has no char-def anchor; the top World Info block is the closest. |
| `fixedEntryPlacement` / `fixedIndexPlacement` (any `fixed*`) | —                  | —                 | **Imported but IGNORED in v1** (not honored).                                                           |

Qualification uses the real matcher: **constant entries always survive; keyword entries fire only on a
scan hit** against `gen.scanText` (recursion honored via `gen.maxRecursion`).

## Automatic maintenance

Automatic table maintenance is the built-in **Memory Maintenance** Agent (`source_key =
memory-maintenance`), not an authorable workflow. Its profile-local Agent settings own the enabled
switch, `trigger.onFloorCommitted.everyNFloors`, API preset, and maintainer overrides. The Memory
sheet's Maintenance strip edits those settings; manual **Run now** and cadence-triggered runs use the
same configured API preset and Invocation Runtime path.

### Dispatch and due set

`agentRuntime/triggerRuntime.ts` observes the single new-floor commit event and evaluates the Agent's
cadence. Before dispatch, `memoryMaintenanceAgentBridge.planDispatch` resolves the assigned template
and calls `memory/memoryCore.dueTables`:

- `updateFrequency: -1` uses `settings.tables.default_update_frequency` (default 3);
- `0` disables automatic maintenance for that table;
- `N >= 1` is the table's floor cadence;
- a table is due when `currentFloor - (progress[sqlName] ?? -1) >= frequency`.

An empty due set skips the invocation completely: no provider call and no Run Record. The last
processed floor lives in `table_progress`; floor truncation clamps it and template reassignment resets
it.

### Prompt and write contract

For a due pass, `memoryMaintenanceAgentBridge.composePrompt` builds the owning floor's `GenContext`,
renders all template tables for context through the shared `composeMaintainerMessages`, and prepends a
write-scope directive naming only the due tables. The same composer and effective maintainer config
power `memory-maintain-preview`, so preview and execution stay aligned.

A successful result is consumed once by `withMemoryMaintenanceApply`:

- no `<TableEdit>` tag is malformed output: apply nothing and advance nothing;
- an empty `<TableEdit></TableEdit>` is a compliant no-change result and advances only the due tables
  when the transcript epoch is still current;
- SQL is filtered to the due-table write scope, validated, applied transactionally by `applyTableEdit`,
  appended to the floor op log, and advances only the due tables after success;
- a changed transcript epoch drops the result without applying or advancing.

Failures remain due for a later commit. Triggered, manual Workspace, and card-transport entry paths all
share the same single-owner apply wrapper, preventing both discarded manual results and double apply.

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
(clamped ≥0 — the just-persisted floor, same attribution automatic maintenance uses). Returns
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
  deep-equals `tpl` (`test/chatSheetsParser.test.ts`). `updateFrequency -1` now round-trips **verbatim**
  (issue 04 — no longer normalized to `1`); a byte match is still impossible because the importer drops
  UI sentinels / `preventRecursion` (and clamps `<= -2` to `-1`); the _model_ round-trips exactly.
- **Export with data:** `dataRows` (a `Map<sqlName, string[][]>`) embeds current rows as `content[1..]`
  (cells stringified, `null → ''`); absent → the template's own `initialRows`. Orchestrated by
  `tableTemplateService.exportTableTemplateToFile` (reads live rows via `readAllTables` when a `chatId`
  is passed) behind `table-template-export-dialog` (a native `showSaveDialog`).

## Backfill & progress (issue 07)

### The progress store (`table_progress`, chat-level automatic-maintenance cursor)

A single **chat-level** last-processed pointer per `(chat, table)` lives in the app-DB table
`table_progress (chat_id, sql_name, last_floor)` (`db.ts` SCHEMA; FK-cascade on chat delete), managed
by `src/main/services/tableProgressService.ts`. `last_floor` is the 0-based floor index a table was
last processed through. It is:

- **advanced** (`advanceProgress`, MAX-semantics upsert) after a successful or compliant-empty Memory
  Maintenance result and by every applied backfill batch;
- **clamped** (`clampProgress` → `last_floor = fromFloor - 1 WHERE last_floor >= fromFloor`) on floor
  truncation by the explicit rewind hook in `chatService.truncateFloors`, with no legacy node-state or
  `at`-discriminator inference;
- **reset** (`resetProgress`, rows deleted) on template assignment or removal in
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
(`tableMaintenance.backfillMaintainerPrompt`, the SAME contract as the built-in Memory Maintenance
Agent's maintainer prompt + the batch rule) → one non-streaming `callModelResilient` pass → `extractTagAll(raw,
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

`injectionPolicy.mode: 'summary'` and vector/summary-backed projection remain deferred. Card-embedded
table templates are implemented through `data.extensions.rp_terminal.table_templates[]`.
