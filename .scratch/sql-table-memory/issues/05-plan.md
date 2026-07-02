# Plan for issue 05 — Maintenance pipeline nodes + built-in example workflow

Status: approved-for-implementation
Issue: [05-maintenance-pipeline-and-example-workflow.md](05-maintenance-pipeline-and-example-workflow.md)
Grounding (verified 2026-07-02, head 22634ca): `controlNodes.ts` (`control.when` — the `ctx.getNodeState`/`setNodeState` durable-state pattern, keyed per (chat, workflow, node)), the removed `memory.gate` (`git show 0c0c1b1^:src/main/services/nodes/builtin/memoryNodes.ts` — gate re-reads the chat FROM DISK because `gen.floors` is the pre-turn snapshot), `docs/workflows/decomposed-default.rptflow` (examples ship as importable repo files; NO in-app seeding mechanism exists — `workflowStore.ts` only builds in `default`), `tableExportService.ts` render helpers, `tableSql.ts` (`splitSqlStatements`), `tableDbService.readAllTables`.

## Nodes (add to `tableNodes.ts`, register in `builtin/index.ts`)

### `table.gate` — cadence gate
- inputs: `gen: Context`, `floor: Any` (ORDERING-ONLY from `output.writeFloor` — same contract the old memory.gate carried; the gate must re-read the floor count from disk via `getAllFloors(profileId, chatId).length - 1` because `gen.floors` is the pre-turn snapshot).
- outputs: `due: Signal`, `tables: Any` (due sqlNames[]), `span: Any` (`{ from, to }` floor range aged in since the last maintenance).
- config: `tables?: string` (comma-separated sqlNames narrowing which tables the gate watches; unset = all template tables).
- Durable node state: `{ last: Record<sqlName, number> }` — the floor up to which each table was last maintained (missing = -1).
- Fire rule per table: due when `currentFloor - last[t] >= updateFrequency` (freq 1 = every turn). No template / no due tables → `{ outputs: {} }` (no signal).
- **At-most-once semantics: the gate advances `last[dueTable] = currentFloor` IMMEDIATELY when it fires.** A downstream failure skips that span (fail-open, worst case one skipped maintenance batch — the same trade the old decomposed memory chain made, but WITHOUT the claim/release protocol since state advance is atomic here). Document this in the node docstring.
- `span` = `{ from: min(last[t]) + 1 over due tables, to: currentFloor }`.

### `table.read` — the update-prompt ingredients
- inputs: `gen: Context`, `tables: Any` (sqlNames[] from the gate; also accepts a comma-separated string), `when: Signal`.
- outputs: `block: Text`, `tables: Any` (passthrough of what was rendered — lets the apply stage know scope).
- config: `include_rules?: boolean` (default true), `max_rows?: number` (1..500, keep newest-last).
- Rendering per selected table (document the exact format in docs/sdk):
  ```
  ## <displayName> (<sqlName>) — 每 N 轮维护
  【表定义】<note>
  【插入规则】<insertNode>   (omit empty ops; include init only when the table has 0 rows)
  【更新规则】<updateNode>
  【删除规则】<deleteNode>
  【当前数据】
  <renderWholeTable(headers, rows)>
  ```
  `include_rules: false` renders only the header + data. Unwired/empty `tables` = ALL template tables. No template → silent `{ block: '', tables: [] }` (read semantics, like table.export).

### `table.query` — arbitrary read for planner branches
- inputs: `gen: Context`, `query: Text`, `when: Signal`; outputs: `rows: Any` (array of row arrays or objects — pick what better-sqlite3 `.all()` gives and document), `block: Text` (rendered result), `error: Error`.
- Blank query → silent empty. No template → silent empty.
- Validation (pure, exported, tested): the query must be EITHER a bare registered sqlName (→ `SELECT * FROM "t"`) OR a single statement (via `splitSqlStatements`, length 1) whose head is `SELECT` (case-insensitive, after comment strip). Everything else (WITH included — documented) → class-B `bad-query`. Execution opens the sandbox with `{ readonly: true }` (defense in depth behind the head check). Missing sandbox → silent empty. Runtime failure → class-B `bad-query` with SQLite's message.

## Example workflow — `docs/workflows/table-memory-default.rptflow`

Ships as an importable repo file (the decomposed-default convention; there is no in-app seeding — say so in the description). Structure:

- **Main path (projection wired in):** `ctx (input.context)` → `export (table.export)` —entries→ `assemble (prompt.assemble)` (block unwired) → `llm (llm.sample)` → `parse` → `apply (apply.state)` → `write (output.writeFloor, isMainOutput)`. This demonstrates issue 04's wiring AND keeps the graph close to the built-in default.
- **Post-response maintenance:** `gate (table.gate)` (gen from ctx, floor from write.floor) → `read (table.read)` (tables from gate.tables, when from gate.due) → `frame (prompt.messages)` composing the maintainer prompt from: `{{in1}}` = read.block, `{{in2}}` = recent transcript (`context.history`, count ~4), `{{in3}}` = the main reply (`llm.raw`) — so `<char_info>`/`<scene_info>` tag conventions reach the maintainer; → `side (llm.sample)` with `stream: false` + `retries: 1` (NO `api_preset_id` in the shipped file — it must run out-of-the-box on the active connection; the description tells authors to set one) → `sql (parse.extract)` tag mode, tag `TableEdit` (text from side.raw, when from gate.due) → `tableapply (table.apply)` (sql from sql.first… use `first`? No — the model may emit several tag blocks; join is needed. parse.extract has no join output; wire `first` and INSTRUCT the maintainer prompt to emit exactly ONE <TableEdit> block containing all statements) → errors: `side.error` and `tableapply.error` → two `util.log` nodes.
- The maintainer system prompt (in `frame`'s config, authored content — zh, matching the 数据库 ecosystem; brief EN note at the top): you are the 数据库表格维护AI; the tables + their rules follow; recent story + this turn's reply follow; output ONLY SQL statements wrapped in ONE `<TableEdit>…</TableEdit>` block; only INSERT/UPDATE/DELETE on the listed tables; follow each table's 插入/更新/删除规则; no commentary inside the tag; if nothing needs updating output an empty tag.
- Description field: what it does, that table memory must be assigned (Tables view) for the maintenance branch to do anything, how to point `side` at a cheap model via `api_preset_id`, and how to chain a second staged pass (世界推进 before 剧情推进) with ordering edges.
- **Validate the file in a test**: find how `decomposed-default.rptflow` is validated today (grep the test dir; the 01 agent kept it validating — locate that test) and cover the new file the same way (every node type in the registry, ports exist, edges type-compatible via the shared validate).

## Docs
`docs/sdk/table-templates.md`: "Maintenance pipeline (issue 05)" — the three nodes' contracts (gate at-most-once advance documented prominently), the table.read block format, the query validation rule, and the example workflow walkthrough. README mapping row if files change.

## Tests
- `table.gate`: due computation across frequencies (1 and 3), state advance on fire, no-refire same floor, config tables filter, no-template silent, span math. Mock `getAllFloors` + template services; drive `getNodeState`/`setNodeState` with a stub RunContext (see existing control.when tests for the pattern).
- `table.read`: format (rules+data, include_rules off, init-only-when-empty rule), tables narrowing (array + comma string), max_rows newest-last, silent no-template.
- `table.query`: pure validation (bare name, SELECT accepted, WITH/INSERT/PRAGMA/multi-statement rejected), silent blanks, class-B codes. Execution wrapper untestable (alias mock) — same stance as before.
- Example workflow: validation test per the existing example's pattern.

## Out of scope
No view editing/template export (06), no default-graph (`DEFAULT_GRAPH`) changes, no changes to nodes from issues 03-04 beyond registering the new ones, no in-app example seeding mechanism.

## Verification gate
`npm run typecheck && npm run check:deps && npm run test`; the example file validates in tests; generateParity untouched.
