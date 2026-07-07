# 05 — Maintenance pipeline nodes + built-in example workflow

Status: ready-for-human (implemented + reviewed; awaiting owner sign-off/merge)

## What to build

The nodes that make table maintenance an authorable workflow, plus a shipped example graph so it works out of the box.

**Nodes:**
- `table.gate` — cadence gate: fires when a table group's update frequency has elapsed (per-table `updateFrequency`; every-turn tables fire each turn). Tracks the last-maintained floor in durable per-(chat, workflow, node) state; emits the aged floor span and the due table ids. Mirrors the removed compaction gate's claim/release discipline so overlapping runs skip cleanly.
- `table.read` — renders the update-prompt ingredients for selected (or due) tables: current data plus each table's definition prompt and the operation instructions (init/insert/update/delete) — the "here are the tables, here is what you may do" block the 数据库 plugin builds.
- `table.query` — arbitrary read: a table name or SELECT statement (validated read-only against registered tables) returning rows and a rendered text block, for planner/剧情推进 branches.

**Example workflow (shipped, like the decomposed-default example):** a post-response chain modeled on the 世界后台引擎 plot-preset's staged passes — gate → `table.read` + context slices (`context.history`, `vars.get`, `table.query`) → `prompt.messages` → `llm.sample` (side call: `stream=false`, its own `api_preset_id`, retries/validator) → `parse.extract` (the SQL tag) → `table.apply` → errors to `util.log`. The main reply's raw text is wired in so template tag conventions (`<char_info>`, `<scene_info>`) reach the update prompt. Staging (世界推进 before 剧情推进) is expressed with ordinary sequencing (ordering edges / `context.refresh` epochs / `subgraph.call`), demonstrating the plot-preset's stage/order semantics without a new engine feature.

Demo: assign the 命定之诗 template, select the example workflow, play several turns; every-turn tables (纪要表) gain rows each turn, frequency-3 tables update on their cadence, and a failed side call logs without disturbing the turn.

## Acceptance criteria

- [ ] `table.gate` fires per configured frequency with durable state (restart-safe), claims/releases so overlapping runs skip, and emits due tables + aged span.
- [ ] `table.read` output contains data + definition + operation instructions for exactly the selected/due tables.
- [ ] `table.query` enforces read-only + registered tables; rejects writes.
- [ ] The example workflow ships, is loadable from the editor, runs post-response without blocking the turn, and end-to-end produces table rows from played turns.
- [ ] Node titles/config labels localized in both locales.
- [ ] Workflow SDK/docs updated with the new node family and the example graph.
- [ ] `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

- [03-sandboxed-sql-write-path-and-rewind.md](03-sandboxed-sql-write-path-and-rewind.md)
- [04-prompt-projection-table-export.md](04-prompt-projection-table-export.md)

## Comments

**2026-07-02 — implemented + reviewed.** Plan at [05-plan.md](05-plan.md); implemented by an Opus agent as commit `57944c3`; reviewed by the controller with one real defect found and fixed in the review commit:

- **Gate stalled after a rewind.** The gate's durable `last` pointers live in node_state (not floor-keyed), so truncateFloors left them pointing past the cut — `currentFloor - last` went negative and maintenance stalled until the chat re-grew past the old floor. Fix: the state now records `at` (the floor at which it was written); `at > currentFloor` is unambiguous rewind evidence (a same-floor re-run has `at === currentFloor`), and on rewind every pointer clamps to `currentFloor - 1` so cadences resume immediately. Test added covering the rewind + the same-floor non-rewind re-run.

Everything else verified: gate math (freq-1/freq-3 cadences, at-most-once advance, span), table.read block format (note gated by include_rules — accepted deviation; init rules only when empty), validateReadQuery (bare-name/SELECT-only, WITH rejected, readonly open behind it), the example workflow (17 nodes/42 edges; ports checked against real node defs; maintainer prompt mandates ONE <TableEdit> block matching the `sql.first` wiring; ships without api_preset_id so it runs out-of-the-box; sideParams added so the side llm's params are never unwired — accepted deviation). Example validated by test/workflow/tableMemoryExample.test.ts.

Gate re-run independently post-fix: typecheck PASS, check:deps PASS (345 modules), tests 168 files / **1373** PASS.

**2026-07-02 — post-merge cadence fix (owner-reported).** Live testing showed the maintenance pass firing EVERY round (the poem template marks 纪要表/伏笔表/约定表 `-1` = every turn → importer-normalized freq 1) and the maintainer inventing forward plot instead of recording. Fix branch `fix/table-maintenance-cadence`: (1) `table.gate` config gains `every` — a global cadence override replacing all watched tables' frequencies, so the whole pass runs at most every N floors; the Tables view's 下次维护 honors it (`tableStatusService.effectiveFrequencies`). (2) `MAINTAINER_RULES` rule 5: tables are a historical archive — record only facts that explicitly happened, no inventing/predicting/advancing plot (shared by backfill + example). (3) `context.history` gains a `span` input; the example wires `gate.span` through a `context.refresh`-fed history so each pass covers EXACTLY the aged-in floors (including the just-persisted turn — the old count-4 + llm.raw framing could gap or overlap). Example ships with `every: 3` and a rewritten frame prompt matching the backfill contract. NOTE: previously-imported copies of the example do NOT auto-update — re-import or hand-edit the gate config.
