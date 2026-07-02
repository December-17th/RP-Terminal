# 04 — Prompt projection: `table.export`

Status: ready-for-agent

## What to build

The read-into-the-prompt half: a `table.export` node that projects the chat's tables into injection entries per each table's injection config, so table contents reach the model exactly the way the 数据库 plugin's exportConfig describes.

Per enabled table it synthesizes virtual lorebook-style entries (reusing the existing world-info keyword-activation and placement machinery rather than a new injection mechanism):
- **Row/whole-table entries** — `splitByRow` on: one entry per data row, rendered through the wrapper template (`$1` = the rendered row); off: one entry for the whole table. `entryType: constant` = always active; `keyword` = activation keywords are the cell values of the configured keyword columns for that row.
- **Index entries** — when enabled, one always-on compact entry listing the configured index columns for every row, honoring per-column `both` / `index_only` modes and the index wrapper template.
- **Placements** — `before_character_definition` / `after_character_definition` / `at_depth_as_system` with depth + order map onto the existing lorebook-entry position vocabulary.

The node outputs both the synthesized entries and a plain rendered text block, wired into the existing assemble surface (`prompt.assemble` / `prompt.preset`'s worldInfo path) so the main turn and any side pipeline can consume table context. Disabled tables (exportConfig off) project nothing.

Demo: with rows written by slice 03, run a turn and observe (via the run trace / prompt inspection) row entries activating on their keywords at the configured anchors, plus the always-on index entry.

## Acceptance criteria

- [ ] Constant entries always appear; keyword entries appear only when their keyword-column values match the scan text, verified through the real matching path.
- [ ] `splitByRow`, wrapper templates (`$1`), index columns with `both`/`index_only` modes, and all three placement positions (+ depth/order) behave per the imported template's config, each covered by tests using the 命定之诗 fixture's configs.
- [ ] Empty tables (header only) inject nothing except an index entry if configured; disabled exports inject nothing.
- [ ] Existing assemble/preset behavior with no `table.export` wired is byte-identical to before (characterization holds).
- [ ] `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

- [03-sandboxed-sql-write-path-and-rewind.md](03-sandboxed-sql-write-path-and-rewind.md)
