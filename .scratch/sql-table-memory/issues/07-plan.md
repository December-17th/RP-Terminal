# Plan for issue 07 — Manual backfill + per-table progress + auto-retry

Status: approved-for-implementation
Issue: [07-manual-backfill-progress-retry.md](07-manual-backfill-progress-retry.md)
Grounding (verified 2026-07-02, head e049404): `tableNodes.ts` (`table.gate` node-state pointer + `renderTableBlock` — both refactored here), `tableStatusService.ts` (replaced), `tableSql.ts`/`tableOpsService.ts`/`tableEditService.ts` (the ONE write path), `parseNodes.ts` (`extractMatches` — the tag extractor to reuse; export a pure helper), `generation/genContext.ts` (`buildGenContext(profileId, chatId, userAction)`), `generation/resilientCall.ts` (`callModelResilient(gen, messages, params, onDelta, signal, cfg)` — API retries + `withPreset` swap + validator corrective retry), `floorService.getAllFloors` (floor content shape: `user_message.content` / `response.content`, thinking stripped via `stripThinking` per `contextNodes.ts:58`), `chatEvents.ts` (the broadcast pattern: `BrowserWindow.getAllWindows()` → `webContents.send`, renderer filters by chatId), `db.ts` (FK-cascade precedent), example workflow's maintainer prompt (`docs/workflows/table-memory-default.rptflow` `frame` config — keep the backfill prompt consistent with it).

## 1. Chat-level progress store — `src/main/services/tableProgressService.ts` (REPLACES the gate's node-state pointer)

Why: the display and both write mechanisms (per-turn gate, manual backfill) must share ONE counter; a per-(workflow, node) pointer can't serve a chat-level display and would double-maintain across workflow switches. This deliberately retires the issue-05 node-state pointer (feature is unreleased — no compat shim).

- App-DB table (in `db.ts` SCHEMA): `CREATE TABLE IF NOT EXISTS table_progress (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, sql_name TEXT NOT NULL, last_floor INTEGER NOT NULL, PRIMARY KEY (chat_id, sql_name));`
- `getProgress(profileId, chatId): Record<sqlName, number>`; `advanceProgress(profileId, chatId, sqlNames[], floor)` — upsert `last_floor = MAX(existing, floor)`; `clampProgress(profileId, chatId, fromFloor)` — `UPDATE … SET last_floor = fromFloor - 1 WHERE last_floor >= fromFloor` (the EXPLICIT rewind clamp; hook it in `chatService.truncateFloors` next to the ops clamp); `resetProgress(profileId, chatId)` — delete rows (hook in `setChatTableTemplateId`, both assign and unassign).
- Pure + tested: `computeTableProgress(lastFloor: number|undefined, updateFrequency, currentFloor)` → `{ processed: last+1, nextExpected: last + freq, unprocessed: max(0, currentFloor - last) }` with `last = lastFloor ?? -1` (a never-processed table: processed 0, nextExpected freq-1… define exactly: nextExpected = the floor index at which the gate will next fire = last + freq; document 0-based).

## 2. Refactor `table.gate` + status onto the store

- `table.gate`: read `getProgress` instead of node state; due when `currentFloor - (progress[t] ?? -1) >= updateFrequency`; on fire `advanceProgress(dueTables, currentFloor)` (at-most-once, same trade). DROP the `at` rewind discriminator entirely — the store is clamped explicitly on truncation. Config/ports unchanged. Gate tests rewritten against a mocked progress service (cadence, at-most-once, config filter, silent no-template); the old rewind-clamp test becomes a `clampProgress` service test.
- `tableStatusService.ts` → repurpose: `getTablesStatus(profileId, chatId)` now returns per-table `{ lastFloor, processed, nextExpected, unprocessed }` from `getProgress` + the template's frequencies + `getAllFloors().length - 1`. The workflow/node-state scanning goes away (`mergeLastMaintained` deleted with its tests — deliberately, same commit).
- `chat-tables-status` IPC returns the richer shape; TablesView shows all three numbers per table (已处理/下次维护/未处理).

## 3. Shared maintainer building blocks (module hygiene before the service)

- Move `renderTableBlock` (and its helpers) from `tableNodes.ts` into a shared spot (`tableExportService.ts` or a new `tableMaintenance.ts` — implementer's pick; nodes and backfill import the SAME function; no copy).
- Export a pure `extractTagAll(text, tag): string[]` from `parseNodes.ts` (the existing tag-mode logic, reused by the backfill; the node keeps its behavior).
- `BACKFILL_MAINTAINER_PROMPT` (zh, one constant): the example workflow's maintainer prompt PLUS the batch rule: 「以下【本批剧情】包含第 {from}–{to} 层的多轮对话；将其视为一次交互进行维护：纪要表只允许新增恰好一行（概括整批），其余表按各自规则维护。」 Placeholders `{from}`/`{to}` substituted per batch.

## 4. Backfill engine — `src/main/services/tableBackfillService.ts`

- `startBackfill(profileId, chatId, opts)` where `opts = { lastFloors: number | 'all', batchSize: number, apiPresetId?: string, retries: number }` (retries 0–5, default 0). Rejects if a backfill is already running for the chat (in-module `Map<chatId, AbortController>`), or no template assigned.
- Pure + tested `planBatches(totalFloors, lastFloors, batchSize): Array<{ from, to }>` — scope = the last X floors (`start = max(0, N - X)`), ascending batches of Y, last batch partial. Empty chat / zero scope → [].
- Per batch, sequentially:
  1. Transcript: floors `from..to` → `User:`/`Assistant:` lines (assistant via `stripThinking`, the context.history convention).
  2. Tables block: `renderTableBlock` over ALL template tables (rules + current data — state advances batch by batch, so later batches see earlier batches' rows).
  3. Messages: `[system: BACKFILL_MAINTAINER_PROMPT(with tables block + transcript + {from}/{to})]` — mirror the example's frame shape (tables块, 本批剧情块; no 本轮回复 section — the transcript IS the content).
  4. Call: `buildGenContext(profileId, chatId, '')` once per run; `withPreset` swap when `apiPresetId` set (unknown id → run fails at start, surfaced); `callModelResilient(gen, messages, params, () => {}, signal, { retries: opts.retries, retry_delay_s: 2 })` — API-error auto-retry rides the EXISTING resilience machinery. `params` from the gen's preset parameters (the context.params logic — max_tokens capped is fine).
  5. Extract: `extractTagAll(raw, 'TableEdit')` joined; empty tag → batch succeeds as a no-op.
  6. Apply: take the write lock (busy → treat as a failed attempt, retryable), `applySqlBatch` + `appendOps` at floor `to`, `advanceProgress(allTemplateTables, to)`.
  7. **SQL-error retry** (only when `opts.retries > 0`): on a `TableSqlError`, re-call the LLM with the previous reply + a corrective user message (「你上次输出的 SQL 执行失败：<error>。请修正后重新只输出一个 <TableEdit> 块」), up to `opts.retries` total corrective attempts per batch; exhausted → the batch is marked failed, progress NOT advanced for it, and the run CONTINUES with the next batch (fail-open; the failed span stays "unprocessed" in the display).
  8. Emit a progress event after every batch (see §5); check `signal.aborted` between batches (cancel keeps applied batches).
- `cancelBackfill(profileId, chatId)`; `getBackfillState(chatId)` → `{ running, batchIndex, batchCount, span, failures[] }` for view re-mount.

## 5. Events + IPC + preload

- `tableBackfillEvents.ts` (the `chatEvents.ts` broadcast pattern): `table-backfill-progress` payload `{ chatId, batchIndex, batchCount, span, status: 'running'|'batch-ok'|'batch-failed'|'done'|'cancelled'|'error', message? }`; renderer filters by chatId.
- IPC in `tableMemoryIpc.ts`: `table-backfill-start` (returns `{ ok } | { error }` — validation errors as i18n keys per the established `tables.*` contract), `table-backfill-cancel`, `table-backfill-state`; `chat-tables-status` reshaped per §2. Preload + `index.d.ts`.

## 6. TablesView

- Per-table header line gains the three counters: `已处理 N 层 · 下次维护 第 M 层 · 未处理 K 层` (em-dash when never processed).
- A "回填 Backfill" panel (collapsed by default): scope (number input X + "全部" checkbox), 每批楼层数 Y (default 3), API preset `<select>` (list from the existing presets IPC; empty = active connection), 自动重试 count (0–5, 0 = off), Start/Cancel, a progress line (`第 i/N 批 · 第 a–b 层`) + a compact failure list. Buttons disabled while running; refetch tables + status after every progress event.
- All strings `t()` in BOTH locales; tokens only.

## 7. Docs + tests

- `docs/sdk/table-templates.md`: "Backfill & progress (issue 07)" — the batch semantics (one 纪要 row per batch), progress-pointer store (chat-level, gate + backfill shared, rewind clamp, reset on reassignment), retry semantics, event/IPC contracts; note the gate's node-state pointer is retired. README row.
- Tests: `planBatches` (scopes, partial batch, all, empty), `computeTableProgress`, progress-service pure bits (the SQL wrappers follow the untestable-stance), gate refactor tests (mocked progress service), backfill orchestration with mocked llm/apply/ops/progress (batch loop, floor attribution at `to`, SQL-retry with corrective message, exhausted-retry continues, cancel between batches, busy-lock retry), extractTagAll reuse, IPC validation errors. The example workflow is untouched.

## Out of scope
Retry for the per-turn workflow path (llm.sample already has retries; table.apply stays as-is); resumable-across-restart backfills (state is in-memory; a restart just lets the player start again — progress pointers persist); backfill prompt customization UI.

## Verification gate
`npm run typecheck && npm run check:deps && npm run test`; i18n parity; generateParity untouched.
