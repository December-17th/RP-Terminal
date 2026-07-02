# Plan for issue 06 — Tables view editing + template export + polish

Status: approved-for-implementation
Issue: [06-tables-view-editing-and-template-export.md](06-tables-view-editing-and-template-export.md)
Grounding (verified through the 01-05 reviews, head 499dfa5): `tableDbService.readOne` (SELECT * — no row identity yet), `tableSql.applySqlBatch` + `tableOpsService.appendOps`/write lock (the ONE write path everything must go through), `chatSheetsParser.parseChatSheets` (the importer the writer must round-trip against), `TablesView.tsx` (read-only grid), `presetIpc.ts:25-34` (open-dialog precedent — find the SAVE-dialog precedent by grepping `showSaveDialog` in src/main; workflow export likely has one), `nodeStateService.getNodeState(chatId, workflowId, nodeId)` + `workflowService.resolveWorkflowDoc` (for the last-maintained indicator), issue-02 review note (display headers vs SQL names inconsistency — fix here).

## 1. Row identity: `rowid` in reads

- `tableDbService.readOne`: `SELECT rowid AS __rid, * FROM "t"` → `TableRead` gains `rowids: number[]`; `rows` remain the data columns only (first result column sliced off). For tables with `row_id INTEGER PRIMARY KEY`, rowid aliases it — harmless duplication in the SELECT, sliced away.
- `rowid` is replay-deterministic here: instantiate + ordered replay re-assigns the same rowids (SQLite max+1 rule, single writer, ordered ops). Deletes create gaps but replay reproduces the same gaps. Document this invariant where the edit SQL is built.
- **Display-header unification (the 02 review note):** when `template.headers.length` matches the data column count, the view shows the DISPLAY headers for both empty and populated tables; SQL names only as the fallback. Do this in `readOne` (columns = headers when widths match) so every consumer benefits.

## 2. Edit path — `src/main/services/tableEditService.ts`

Every hand edit becomes literal, replayable SQL routed through the SAME `applySqlBatch` + `appendOps` + write-lock path as AI writes (floor attribution: `getAllFloors().length - 1` clamped ≥0). Pure builders (exported, tested):
- `sqlQuote(v: string)` — `'…'` with `''` doubling.
- `buildCellUpdate(sqlName, sqlColumn, rowid, value)` → `UPDATE "t" SET "col" = '<quoted>' WHERE rowid = N` — `sqlColumn` validated with `isSafeSqlIdentifier` (it comes from the SANDBOX's real column list, not the display headers), `rowid` must be a safe integer.
- `buildRowInsert(sqlName, values: (string|null)[])` → positional `INSERT INTO "t" VALUES (…)` with NULL for null cells and quoted literals otherwise (the buildInitialInsert convention: first cell null when it's the empty row_id slot).
- `buildRowDelete(sqlName, rowid)` → `DELETE FROM "t" WHERE rowid = N`.
- `buildTableReset(sqlName)` → `DELETE FROM "t"` — **reset is OP-LOGGED (deliberate choice per the issue AC):** replay stays consistent (instantiate re-seeds initial rows, the replayed DELETE clears them again). Confirmed in the UI.
- `applyEdit(profileId, chatId, op)` where `op = { kind: 'cell'|'insert'|'delete'|'reset', table, rowid?, column?, value?, values? }` → resolve template, build SQL, take the write lock (busy → error result), `applySqlBatch`, `appendOps`. Returns `{ ok } | { error }` (error strings for the renderer: reuse the `{ error }` import-contract style from issue 02 — i18n key or verbatim SQLite message).
- CHECK/NOT NULL constraint violations surface as the error result (toast) — the classifier already allows these statements; SQLite enforces the rest.

## 3. Template export — writer next to the parser

- `exportChatSheets(template: TableTemplate, dataRows?: Map<sqlName, string[][]>)` in `chatSheetsParser.ts` (writer besides the parser it must mirror): reconstruct `mate` (`type: 'chatSheets'`, `version: 2`, `globalInjectionConfig` from `template.globalInjection`, defaulted when absent) + one `sheet_<uid>` per table (uid preserved from import), `orderNo` = array index, `content` = `[headers, …(dataRows?.get(sqlName) ?? initialRows)]`, `sourceData` = note/init/insert/update/delete/ddl verbatim, `updateConfig.updateFrequency` as stored (the importer's `-1 → 1` normalization means re-import equivalence, not byte equality — the issue AC says "round-trips to an equivalent template", assert THAT), `exportConfig` verbatim.
- **Round-trip test (the AC):** parse fixture → export → parse again → deep-equal `TableTemplate`s. Export-with-data: rows embed as `content[1..]` (cells stringified; null → '').
- IPC `table-template-export-dialog(profileId, templateId, chatId?)` — `showSaveDialog` (find the existing save-dialog precedent and mirror it; default filename `<name>.json`); `chatId` present = export WITH that chat's current data (`readAllTables` → stringified rows).

## 4. View (TablesView.tsx) — editing + polish

- Cell editing: click a cell → input (commit on Enter/blur, Escape cancels) → `applyEdit {kind:'cell'}` → refetch. Uses the SANDBOX column name for the edited column (the service maps display index → real column via the sandbox's column list; define the mapping in the IPC layer so the renderer only sends the column INDEX).
- Add row: an "add row" button per table opens a blank editor row (one input per column, row_id-convention first cell left empty → NULL); confirm → `{kind:'insert'}`. Constraint violations toast the SQLite message.
- Delete row: per-row ✕ with confirm → `{kind:'delete'}` (rowid from `TableRead.rowids`).
- Reset table: per-table button, confirm dialog, `{kind:'reset'}`.
- Last-maintained indicator: IPC `chat-tables-status(profileId, chatId)` → main resolves the chat's workflow doc (`resolveWorkflowDoc`), finds `table.gate` nodes, reads their node_state (`nodeStateService`), merges the `last` maps (max per table) → `Record<sqlName, number|null>`; the view renders `最后维护: 第 N 层 / —` per table header.
- All new strings via `t()` in BOTH locales (数据库/表格 vocabulary); tokens only; empty/error states kept.

## 5. Docs — final SDK pass

`docs/sdk/table-templates.md`: editing semantics (rowid identity + replay determinism note, op-logged reset), export/round-trip contract (equivalence-not-bytes, `-1` normalization), the status IPC; verify every behavioral claim in the doc carries a file:line citation (the docs policy) and refresh any that drifted across issues 02-05. `docs/sdk/README.md` mapping row.

## Tests
- Pure builders: sqlQuote (quotes/CJK/embedded quotes), each build* shape, rowid integer guard, unsafe column rejection.
- `applyEdit`: mocked tableSql/tableOps — lock busy path, floor attribution, op append with the BUILT sql, error propagation. (Execution untestable — alias mock, same stance.)
- Export writer: fixture round-trip equivalence (the AC); with-data embedding; globalInjection default.
- readOne changes are runtime-only (mock) — pin the pure width-match header-unification helper if extracted; extract it pure.
- Status aggregation: pure merge helper tested (max per table across gates).

## Out of scope
DDL/prompt editing UI (JSON-level per the PRD), card-embedded templates, any generation/node changes (the node surface is frozen this slice — only `readOne`/TableRead widen).

## Verification gate
`npm run typecheck && npm run check:deps && npm run test`; i18n key parity; generateParity untouched.
