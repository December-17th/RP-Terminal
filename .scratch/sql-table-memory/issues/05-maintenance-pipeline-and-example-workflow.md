# 05 — Maintenance pipeline nodes + built-in example workflow

Status: ready-for-agent

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
