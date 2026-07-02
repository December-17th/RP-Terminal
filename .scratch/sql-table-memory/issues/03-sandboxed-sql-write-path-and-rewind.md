# 03 — Sandboxed SQL write path + rewind safety

Status: ready-for-human (implemented + reviewed; awaiting owner sign-off/merge)

## What to build

The write half of table memory: LLM-emitted SQL is validated, executed against the chat's sandbox database, logged per floor, and replayed on rewind — surfaced to workflows as two new nodes.

**SQL executor (service):** accepts a batch of statements; splits multi-statement text and validates each statement independently; allows only INSERT/UPDATE/DELETE targeting tables registered in the chat's template (SELECT permitted for reads); rejects ATTACH/PRAGMA/DROP/ALTER/CREATE/TRIGGER/transaction-control and any unregistered table; runs the batch in a transaction with a row-change cap; on any statement failure rolls the whole batch back and reports which statement failed and why. Fail-open: an execution failure never blocks or fails the player's turn.

**Op log + rewind:** every applied batch is appended to a floor-keyed op log `(chat, floor, seq, sql)` stored with chat state. When floors are truncated (regenerate / swipe / delete-from), ops at or beyond the cut floor are dropped and the sandbox DB is rebuilt by executing the template DDL and replaying the remaining ops in order. Replay is deterministic (single-writer, ordered). A per-chat write lock serializes concurrent graph writes (the same slot pattern the removed compaction guard used).

**Nodes:**
- `parse.extract` — generic tag/regex extractor: given text and a tag name (or regex), outputs the matched content (first match + all matches). This is the plot-preset `extractTags` equivalent and is deliberately table-agnostic.
- `table.apply` — takes the gen context, SQL text, and a gating signal; validates + executes via the service, appends the op log, outputs per-statement results, an ordering-only `done`, and a wired `error` port carrying class-B failures.

Demo: a test workflow wires a hand-written SQL string (or a `parse.extract` over a canned reply containing a tagged SQL block) into `table.apply`; the rows appear in the Tables view; swiping the floor makes them disappear.

## Acceptance criteria

- [ ] Executor accepts the templates' documented statement shapes (INSERT with `SELECT MAX(row_id)+1` subquery, `INSERT OR IGNORE`, UPDATE with string concatenation, DELETE with ORDER BY/LIMIT subquery) and rejects every forbidden statement class, each covered by a test.
- [ ] Mid-batch failure rolls back the entire batch; the sandbox DB state is unchanged.
- [ ] Applied batches append to the floor-keyed op log; floor truncation (regenerate/swipe/delete) rebuilds the sandbox DB by replay, and rebuilt state equals a never-rewound reference state in tests.
- [ ] `parse.extract` and `table.apply` are registered nodes with config schemas that auto-render in the editor; `table.apply` failures surface on its error port and never abort the main turn.
- [ ] Concurrent applies for one chat are serialized by the write lock.
- [ ] `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

- [02-table-templates-import-and-enablement.md](02-table-templates-import-and-enablement.md)

## Comments

**2026-07-02 — implemented + reviewed.** Plan at [03-plan.md](03-plan.md); implemented by an Opus agent as commit `cbddfce`; reviewed line-by-line by the controller (this is the security-critical slice). Verdict: accepted with one comment fix (replaySandbox docstring claimed one transaction; replay is deliberately per-op so failures can be skipped fail-open).

Security review of the choke points, all sound: the splitter is a real char-scanner (literals with '' escapes, "" identifiers, --/​/* */ comments, CJK-safe, top-level `;` only); the classifier accepts only INSERT/UPDATE/DELETE heads and validates the target against the template registry — schema-qualified names (`main.t`) fall out as unregistered, `WITH`/`EXPLAIN`/`REPLACE` heads are rejected, and better-sqlite3's one-statement-per-prepare is a second net behind the splitter. applySqlBatch validates before touching the DB, runs one transaction with a change cap, closes in finally. The busy path correctly does NOT release a lock it never claimed. Ops are logged from the service's validated statements (not a re-split), so replay matches execution exactly.

Accepted deviations: results carry the executed statements for exact op-logging; rebuildSandbox takes the resolved template as a parameter (avoids a chatService import cycle). FK-cascade finding verified: db.ts sets foreign_keys=ON, so table_ops clears on chat delete; the sandbox file is removed explicitly.

AC adjustment (as planned): the "rebuilt state equals never-rewound reference" criterion cannot be integration-tested — better-sqlite3 is alias-mocked because the native binary can't load under plain Node. Pinned instead via pure replayPlan (+ splitter/classifier/validateBatch exhaustive tests incl. the four documented template SQL shapes) and node run() contracts. Live state-equality belongs to the owner's manual pass.

Gate re-run independently post-fix: typecheck PASS, check:deps PASS (344 modules), tests 166 files / **1318** PASS (60 new).
