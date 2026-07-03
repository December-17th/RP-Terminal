# Plan for issue 02 — Table templates: import, per-chat enablement, read-only Tables view

Status: approved-for-implementation
Issue: [02-table-templates-import-and-enablement.md](02-table-templates-import-and-enablement.md)
Grounding verified 2026-07-02 (post-0c0c1b1): `storageService.ts` (asset dir + JSON helpers), `presetService.ts` (per-profile file-asset CRUD pattern, `profiles/<id>/presets/<id>.json`), `presetIpc.ts` (`import-preset-dialog` showOpenDialog pattern), `chatService.ts:177` + `workflowIpc.ts:37` (chat-level override column pattern `chats.workflow_id`), `db.ts` `addColumnIfMissing`, `viewRegistry.tsx` (view registration), `memoryStore.ts` header note (better-sqlite3 is mocked to a no-op under vitest — SQL execution is NOT unit-testable; test pure helpers instead).

## New modules (all main-side unless noted)

1. **`src/main/types/tableTemplate.ts`** — the native `TableTemplate` zod schema (precedent: `types/preset.ts`).
   Shape (lossless superset of what the importer consumes):
   - `name: string`, `sourceFormat: 'chatSheets-v2' | 'native'`, `globalInjection?: { readableEntryPlacement?: Placement; wrapperPlacement?: Placement }`
   - `tables: TableDef[]`, ordered (from `orderNo`). Each `TableDef`:
     - `uid: string` (keep the sheet uid), `displayName: string` (sheet `name`)
     - `sqlName: string` (parsed from the DDL's `CREATE TABLE <name>`), `ddl: string`
     - `headers: string[]` (from `content[0]`), `initialRows: string[][]` (from `content[1..]`, may be empty)
     - `note: string`, `initNode: string`, `insertNode: string`, `updateNode: string`, `deleteNode: string`
     - `updateFrequency: number` (chatSheets `-1` → `1` = every turn; keep positive ints as-is)
     - `exportConfig`: verbatim-mapped `{ enabled, splitByRow, entryName, entryType: 'constant'|'keyword', keywords, injectionTemplate, extraIndexEnabled, extraIndexEntryName, extraIndexColumns, extraIndexColumnModes, extraIndexInjectionTemplate, entryPlacement, extraIndexPlacement, fixedEntryPlacement, fixedIndexPlacement }` with `Placement = { position: string; depth: number; order: number }`.
   - Unknown extra fields tolerated on parse (zod `.loose()`/passthrough where appropriate); missing per-op instructions default to `''`.

2. **`src/main/parsers/chatSheetsParser.ts`** — chatSheets v2 → `TableTemplate` (precedent: `parsers/stPresetParser.ts`).
   - Validate `mate.type === 'chatSheets'` (accept version 2; reject others with a typed error message).
   - Collect `sheet_*` values, sort by `orderNo`, map per above. `-1`/absent updateConfig values → defaults.
   - **DDL parsing helper** (pure, exported for tests): extract the table name from `CREATE TABLE <name> (`; assert the ddl is a single CREATE TABLE statement (reject anything else — this is the only DDL that will ever execute). Strip `-- comments` only for parsing, keep `ddl` verbatim for storage.
   - Malformed input (no mate, no sheets, unparseable ddl, header row missing) → throw with a message the IPC layer surfaces; renderer shows a localized error toast/dialog.

3. **`src/main/services/tableTemplateService.ts`** — file-asset CRUD, mirroring `presetService`:
   - Dir: `profiles/<profileId>/table-templates/<id>.json` (id = randomUUID at import).
   - `listTableTemplates` (id + name summaries), `getTableTemplateById` (zod-parsed), `deleteTableTemplate`, `importTableTemplateFromFile(profileId, filePath)` (read JSON → parser → save; returns summary or throws).

4. **`src/main/services/tableDbService.ts`** — per-chat sandbox SQLite:
   - File: `profiles/<profileId>/table-dbs/<chatId>.sqlite` (own dir; NEVER the app DB).
   - `instantiate(profileId, chatId, template)`: delete any existing file, open a new `better-sqlite3` Database at that path, execute each table's validated ddl, insert `initialRows` (positional, prepared statements), close or cache the handle (keep a small open-handle cache keyed by chatId with close-on-unassign; simplest correct thing wins).
   - `readTable(profileId, chatId, sqlName)`: guard `sqlName` against the assigned template's registry (never interpolate unvalidated names), `SELECT * FROM "<name>"` → `{ columns: string[], rows: unknown[][] }`.
   - `removeSandbox(profileId, chatId)`: close handle + delete file.
   - NOTE: vitest mocks better-sqlite3 to a no-op (see the old memoryStore header; verify the mock's location in test setup). Keep data-shaping helpers pure and unit-tested; the SQL wrappers are runtime-validated only — same stance as floorService.

5. **Chat assignment** — follow the `workflow_id` precedent exactly:
   - `db.ts`: `addColumnIfMissing(db, 'chats', 'table_template_id', 'table_template_id TEXT')`.
   - `chatService.ts`: `getChatTableTemplateId` / `setChatTableTemplateId`. Setting a NEW template id (re)instantiates the sandbox (destructive — the renderer confirms first); setting null removes the sandbox file. Chat deletion: find where chats are deleted and add sandbox-file cleanup there (verify what chat deletion currently does before editing).

6. **`src/main/ipc/tableMemoryIpc.ts`** + registration in `ipc/index.ts` + preload bridge methods (follow the preset bridge shape in `src/preload/index.ts`):
   - `table-templates-list`, `table-template-get`, `table-template-delete`, `table-template-import-dialog` (showOpenDialog, filters `json`, per `presetIpc.ts:25-34`; surface parser errors as `{ error: string }` rather than throwing across IPC — check how other IPC surfaces errors and match),
   - `chat-table-template-get` / `chat-table-template-set` (assign/unassign per above),
   - `chat-tables-read` (all tables of the assigned template: `[{ sqlName, displayName, columns, rows }]`).

## Renderer

7. **`TablesView.tsx`** registered as `tables` in `viewRegistry.tsx` (mirror the `variables` entry + its store/IPC wiring style — read `VariablesView` first). v1 read-only, self-contained (no SettingsModal changes):
   - Header row: template selector (list from `table-templates-list` + "none"), Import button (opens the dialog IPC), Delete-template button. Assigning/reassigning shows a confirm (destructive: recreates sandbox); unassigning confirms too.
   - Body: one section per table — display name + a plain read-only grid (headers + rows). Empty state ("no template assigned") and zero-row state.
   - Theme: `--rpt-*` tokens only; no hardcoded colors. All strings via `t()` with keys in BOTH `en.ts`/`zh.ts` (zh uses 数据库/表格 vocabulary, e.g. 记忆表格/导入表格模板).

## Docs

8. `docs/sdk/table-templates.md` — the import surface: supported chatSheets v2 subset, mapping table (sheet field → TableTemplate field), defaults for `-1` values, what's deferred (writes/exports — issues 03–05). Add the "if you touch X update Y" row to `docs/sdk/README.md`. Cite file:line for behavioral claims.

## Tests (behavior at seams; fixture = the real template)

- Copy `.scratch/sql-table-memory/fixtures/chatsheets-poem-of-destiny-5.9.json` to the test fixtures location (find where existing tests keep fixtures; create `test/fixtures/` if none).
- `chatSheetsParser`: parses the real template into 8 ordered TableDefs; spot-assert 纪要表 (updateFrequency -1→1, keyword index config), 重要角色表 (splitByRow, keyword columns, extraIndexColumnModes), 主角信息 (export disabled); DDL name extraction for all 8; rejection cases (wrong mate.type, missing sheets, non-CREATE ddl, multi-statement ddl).
- `tableTemplateService`: list/get/delete round-trip (fs-backed like presetService tests — check how presetService is tested and mirror).
- `tableDbService`: pure helpers only (path building, identifier guard, row-mapping) — SQL execution is excluded by the better-sqlite3 mock, mirror floorService's testing stance.
- Renderer store/component tests only if the repo already tests sibling views (check; don't invent a new UI-test harness).

## Explicitly out of scope for this slice
No writes (03), no op log (03), no prompt injection (04), no nodes (03/05), no view editing (06), no card-embedded templates. Do not touch generation code at all.

## Verification gate
`npm run typecheck && npm run check:deps && npm run test` green; import the real template manually is NOT required (owner runs app testing separately) but the fixture tests must cover the same path (`importTableTemplateFromFile` on the fixture file).
