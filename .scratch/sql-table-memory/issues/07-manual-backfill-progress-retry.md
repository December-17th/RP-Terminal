# 07 — Manual backfill from history + per-table progress + auto-retry

Status: ready-for-human (implemented + reviewed; awaiting owner sign-off/merge)

## What to build

Let the player fill the tables from PAST chat history on demand, see per-table processing progress, and optionally auto-retry failed fills.

**Manual backfill.** From the Tables view the player starts a backfill over a chosen scope — the last X floors (or the whole chat) — processed in batches of Y floors, where each batch is treated as ONE 交互/轮 for table purposes (so 纪要表 gains exactly one row per Y floors; the other tables are maintained normally per batch). Each batch runs the same maintainer pass the shipped example workflow performs (tables + rules + the batch's transcript → a non-streaming utility LLM call → `<TableEdit>` SQL extraction → the validated, op-logged apply path), attributed to the batch's last floor so rewind semantics hold. The run is sequential, cancellable, shows live progress (batch i/N, current floor span, per-batch outcome), and can target a chosen API preset (default: the active connection).

**Per-table progress display.** For each table the view shows: how many floors have been processed, the next expected process floor (last processed + the table's update frequency), and how many floors are not yet processed. To make these numbers coherent across BOTH mechanisms (per-turn `table.gate` maintenance and manual backfill), the last-processed pointer becomes a chat-level per-table store that the gate and the backfill both advance and the display reads — replacing the gate's private per-workflow node state. Rewind (floor truncation) clamps the pointers explicitly.

**Auto-retry (optional).** A backfill setting: on an API error (call failed) or an SQL error (extraction produced statements that failed validation/execution), retry the batch up to N times — API errors re-call as-is; SQL errors re-call with the error message fed back so the model can correct its output. Off by default.

## Acceptance criteria

- [ ] Backfill can be started from the Tables view with scope (last X floors / all), batch size Y, optional API preset, and optional retry count; input validation prevents nonsense (X ≥ 1, Y ≥ 1).
- [ ] Each batch produces ops attributed to the batch's LAST floor via the existing validated apply path (write lock, `applySqlBatch`, `appendOps`) — a later rewind past a batch's floor rolls its writes back.
- [ ] The maintainer prompt instructs one-纪要-row-per-batch; batches process ALL template tables' rules.
- [ ] The run is cancellable mid-way; already-applied batches stay applied; progress events stream to the view live.
- [ ] Per-table progress (processed floors, next expected floor, unprocessed count) displays in the Tables view and stays correct across gate maintenance, backfill, rewind, and template reassignment (reset).
- [ ] `table.gate` and the status display share the chat-level pointer store; gate cadence tests updated deliberately (per-workflow node-state pointer retired).
- [ ] Auto-retry: API-error retries re-call; SQL-error retries append the failure message; retries capped; exhausted retries mark the batch failed and the run continues (fail-open) — surfaced in the progress log.
- [ ] Two backfills for one chat cannot run concurrently; backfill and per-turn writes serialize via the existing write lock.
- [ ] All new strings through `t()` in both locales; docs/sdk updated; `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

- [05-maintenance-pipeline-and-example-workflow.md](05-maintenance-pipeline-and-example-workflow.md)
- [06-tables-view-editing-and-template-export.md](06-tables-view-editing-and-template-export.md)

## Comments

**2026-07-02 — implemented + reviewed.** Plan at [07-plan.md](07-plan.md); implemented by an Opus agent as commit `331bd67`; reviewed by the controller with one minor defect fixed in the review commit:

- **Cancel mid-batch misreported `batch-ok`.** A cancel landing inside the corrective-retry loop left the batch unapplied (progress correctly not advanced) but the runner still emitted `batch-ok` for it. `processBatch` now returns whether the batch actually applied; unapplied cancels skip the ok event and the run ends with `cancelled` as before.

Everything else verified: the chat-level `table_progress` store (MAX-upsert advance, explicit rewind clamp in truncateFloors, reset on template reassignment) replaces the gate's node-state pointer cleanly — the gate's due-rule and at-most-once advance are unchanged, only the pointer surface moved, and the `at` discriminator is retired in favor of the explicit clamp; backfill writes go only through lock → applySqlBatch → appendOps at the batch's LAST floor → advanceProgress (floor attribution pinned by the orchestration test: batches of 2 over 4 floors append at floors 1 and 3); API-error retries ride callModelResilient (retries + 2s delay) while SQL-error retries re-call with the failed reply + a corrective zh message, capped, with exhausted retries failing the batch and the run continuing (span stays unprocessed); empty <TableEdit> is a no-op that still advances progress; concurrent backfills per chat rejected; the shipped example workflow's nodes/edges untouched (description-only note; its validation test green). Progress formulas pinned incl. never-processed and empty-chat edges. i18n parity 25 new keys per locale (two stale keys retired from both).

One noted inefficiency (accepted, not fixed): a busy write lock inside a batch is treated as a retryable SQL error, so the corrective path burns one LLM re-call on what is really a timing collision — rare in practice (requires per-turn maintenance racing a manual backfill), semantically harmless since the re-call regenerates against fresh state.

Gate re-run independently post-fix: typecheck PASS, check:deps PASS (351 modules), tests 171 files / **1419** PASS.
