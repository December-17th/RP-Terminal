# 07 — Manual backfill from history + per-table progress + auto-retry

Status: ready-for-agent

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
