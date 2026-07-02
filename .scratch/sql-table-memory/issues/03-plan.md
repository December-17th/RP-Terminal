# Plan for issue 03 — Sandboxed SQL write path + rewind safety

Status: approved-for-implementation
Issue: [03-sandboxed-sql-write-path-and-rewind.md](03-sandboxed-sql-write-path-and-rewind.md)
Grounding (verified 2026-07-02, head a8f20a5): `tableDbService.ts` (sandbox + DDL guard + identifier guard), `chatSheetsParser.ts` (`isSafeSqlIdentifier`), `chatService.ts` (`truncateFloors` — the rewind hook point; `deleteChat` cleanup), `db.ts` (`floors` FK `REFERENCES chats(id) ON DELETE CASCADE` precedent), node patterns (`memoryNodes.ts` pre-removal for the claim/release slot; `varsNodes.ts` for silent-no-op contracts; `NodeRunFailure` classes in `nodes/types.ts`), `vitest.config.ts:20-24` — **better-sqlite3 is ALIAS-mocked because the native module cannot load under plain Node (Electron ABI)**; `vi.importActual` cannot bypass it, so NO real-SQLite integration test is possible. AC adjustment below.

## Modules

### 1. `src/main/services/tableSql.ts` — statement splitting, classification, guarded execution

Pure, exported, unit-tested:
- `splitSqlStatements(text: string): string[]` — split a batch on `;` **outside** string literals; a small char-scanner tracking `'…'` (with `''` escape), `"…"` quoting, and `--` line comments. Chinese text and semicolons inside literals must survive (the templates' SQL carries CJK strings). Trailing empty segments dropped.
- `classifyStatement(sql): { kind: 'insert'|'update'|'delete', table: string }` — head-keyword match (case-insensitive, after stripping leading comments/whitespace): `INSERT [OR IGNORE|OR REPLACE…] INTO <t>`, `UPDATE [OR …] <t>`, `DELETE FROM <t>`; `<t>` bare or `"quoted"`, validated with `isSafeSqlIdentifier`. ANY other head — SELECT (at the top level of a write batch), CREATE, DROP, ALTER, ATTACH, DETACH, PRAGMA, BEGIN/COMMIT/ROLLBACK/SAVEPOINT, VACUUM, REINDEX, TRIGGER, WITH (a CTE head hides the real verb — reject; the templates don't use top-level CTEs), EXPLAIN — throws a typed `TableSqlError` naming the rejected head. Subqueries INSIDE a statement are fine (the sandbox contains only template tables; ATTACH is blocked at the head so no other file is reachable).
- `validateBatch(text, allowedTables: Set<string>)` — split + classify each + assert every target table ∈ allowedTables; returns the validated list or throws with the failing statement index + reason.

Runtime wrapper (not unit-testable, mirrors `instantiate`'s stance):
- `applySqlBatch(profileId, chatId, template, sqlText, opts?: { maxChanges?: number }): { applied: number; changes: number }` — validate first (throws before touching the DB), open the sandbox file (error if missing — template not instantiated), run all statements in ONE `db.transaction`, summing `run().changes`; if total changes exceed `maxChanges` (default 500) throw INSIDE the transaction so everything rolls back. Any statement error → transaction rolls back, rethrown with the statement index. Always `db.close()` in `finally`.

### 2. `src/main/services/tableOpsService.ts` — floor-keyed op log + rewind replay

- App-DB table (in `db.ts` SCHEMA): 
  `CREATE TABLE IF NOT EXISTS table_ops (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, floor INTEGER NOT NULL, seq INTEGER NOT NULL, sql TEXT NOT NULL, created_at TEXT, PRIMARY KEY (chat_id, floor, seq));` + index on `(chat_id, floor)`. (FK follows the `floors` precedent.)
- `appendOps(profileId, chatId, floor, sqls: string[])` — next `seq` = MAX(seq)+1 per (chat,floor) walk.
- `listOps(profileId, chatId): { floor, seq, sql }[]` ordered by (floor, seq).
- `deleteOpsFrom(profileId, chatId, fromFloor): number`.
- `rebuildSandbox(profileId, chatId)` — look up the chat's template (null → just `removeSandbox`), `tableDbService.instantiate` (DDL + initial rows), then re-apply every logged op **in order** via `applySqlBatch`-style execution but per-op and WITHOUT re-logging and WITHOUT the change cap (already-accepted history); a replay op that now fails is logged (`log('error', …)`) and **skipped** — fail-open, never brick the chat. 
- Pure helper for tests: `replayPlan(ops, fromFloor)` — the ops that survive a cut (floor < fromFloor), in replay order. This is what the rewind AC pins (state-equality is impossible under the alias mock — see Testing).
- **Rewind hook**: in `chatService.truncateFloors`, after `deleteFloorAndSubsequent`: `deleteOpsFrom(...)` then `rebuildSandbox(...)` (only when a template is assigned; cheap no-op otherwise — same shape the old memory hook had). `deleteChat`: ops rows go via FK cascade if PRAGMA foreign_keys is enabled — CHECK whether the app db enables it; if not, delete explicitly (verify, don't assume).
- **Write lock**: a per-chat in-module mutex (`Map<chatId, true>` claim/release with try/finally + a 2-minute stale expiry — reimplement the removed compaction-slot pattern, see the old `tryBeginCompaction` in git history `0c0c1b1^`). `table.apply` and `rebuildSandbox` both take it; a busy chat → class-B failure `busy` (caller may retry next turn).
- `setChatTableTemplateId` (assign/reassign/unassign) must now ALSO clear the chat's op log (the sandbox is recreated from scratch; stale ops from the old template must not replay). Add `deleteAllOps(profileId, chatId)` and call it there.

### 3. Nodes (new file `src/main/services/nodes/builtin/tableNodes.ts` + registry entries in `builtin/index.ts`)

- **`parse.extract`** — generic tag/regex extractor (goes in a general spot: put it in `messageNodes.ts`'s file or a new `parseNodes.ts`; it is NOT table-specific).
  - inputs: `text: Text`, `when: Signal`; outputs: `first: Text`, `all: Any` (string[]), `found: Signal` (fires only when ≥1 match).
  - config (zod): `{ mode: 'tag' | 'regex' (default 'tag'), tag?: string, pattern?: string, flags?: string }`.
  - tag mode: all occurrences of `<tag>…</tag>` (non-greedy, dotall, case-insensitive; tag name escaped). regex mode: `new RegExp(pattern, flags ?? 'g')` in try/catch → class-B `bad-pattern`; captures: full match unless the pattern has a capture group 1 (then group 1) — state this in the node docstring. No/blank input text → empty outputs, no `found` signal (the memory.query blank-input contract).
- **`table.apply`** —
  - inputs: `gen: Context`, `sql: Text`, `when: Signal`; outputs: `results: Any` (`{applied, changes}`), `done: Any` (ordering-only, emitted only on a completed apply — the vars.save precedent), `error: Error`.
  - config: `{ max_changes?: number (int, 1..5000) }`.
  - run: blank/whitespace sql → `{ outputs: {} }` silent no-op. No template assigned → class-B `no-template`. Lock busy → class-B `busy`. Validation/execution failure → class-B with the service's message (code `bad-sql`). Success: `appendOps` with `floor = gen.floors.length - 1` clamped to ≥0 (the just-persisted floor when running post-response; document that assumption in the docstring), then outputs + NO chat-stream pollution.
  - The apply must be fail-open for the turn: it is a post-response side branch; its errors route on the error port (wireable to util.log) and never abort the graph.

### 4. Renderer touch (small)

TablesView already refetches on `floors.length` change; verify a post-response apply is visible on the next refresh (no new UI). No i18n changes expected beyond possibly an error string — if none are added, no locale edits.

### 5. Docs

- `docs/sdk/table-templates.md`: add a "Write path (issue 03)" section — batch grammar (allowed heads, one-statement-per-`;`, target must be a template table), op-log/rewind semantics, the lock, and the two nodes' port/config contracts. Update `docs/sdk/README.md` mapping row if the file list changes.

## Testing (adjusting the issue's AC to the alias-mock reality)

- The issue AC says "rebuilt state equals a never-rewound reference state in tests" — **not implementable**: better-sqlite3 is alias-mocked because the native binary cannot load under plain Node (`vitest.config.ts:24`), and `vi.importActual` cannot bypass an alias. Pin instead: (a) `replayPlan` — ops surviving a cut, order, and floor attribution; (b) `validateBatch`/`splitSqlStatements`/`classifyStatement` exhaustively; (c) the truncateFloors hook calls deleteOpsFrom+rebuildSandbox with the right args (mock the services). Note the deviation in the tracker comment; live state-equality lands in the owner's manual pass.
- `splitSqlStatements`: semicolons/quotes/CJK inside literals, `''` escapes, `--` comments, trailing `;`.
- `classifyStatement` / `validateBatch`: ACCEPT the four documented template shapes (research.md §1): `INSERT … VALUES ((SELECT MAX(row_id)+1 FROM chronicle), …)`, `INSERT OR IGNORE …`, `UPDATE roleplay_guide SET x = COALESCE(x,'') || '…' WHERE …`, `DELETE FROM foreshadow_table WHERE row_id IN (SELECT … ORDER BY … LIMIT …)`; REJECT each forbidden head (SELECT/CREATE/DROP/ALTER/ATTACH/DETACH/PRAGMA/BEGIN/COMMIT/WITH/EXPLAIN/VACUUM) and an unregistered target table.
- Nodes: follow the existing builtin-node test style (`test/workflow/*.test.ts`) — parse.extract tag + regex + bad-pattern + blank input; table.apply silent no-op, no-template, busy, success path with mocked tableSql/tableOps (assert appendOps floor attribution), error routing.
- The old compaction-slot claim/release tests (`0c0c1b1^:test/...`) are a useful reference for the lock tests.

## Out of scope
No prompt injection (04), no gate/read/query nodes (05), no view editing (06), no changes to `prompt.assemble`/`prompt.preset`, no default-graph changes (table.apply is used by authored graphs; the shipped example arrives in 05).

## Verification gate
`npm run typecheck && npm run check:deps && npm run test` green; repo-wide grep confirms no node registers outside `builtin/index.ts` and the two new node types appear in the catalog test.
