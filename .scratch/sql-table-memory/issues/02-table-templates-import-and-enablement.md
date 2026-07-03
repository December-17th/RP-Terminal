# 02 — Table templates: import, per-chat enablement, read-only Tables view

Status: ready-for-human (implemented + reviewed; awaiting owner sign-off/merge)

## What to build

The template layer of table memory, end-to-end: a native `TableTemplate` artifact (zod-schema'd JSON, stored as a file-based portable asset alongside presets/lorebooks), a first-class importer for the 数据库 plugin's chatSheets v2 format, per-chat template selection, sandbox database instantiation, and a read-only Tables view.

A template holds, per table: display name, definition prompt (the `note`), init/insert/update/delete instructions, the `CREATE TABLE` DDL, update frequency, injection config (entry name, constant/keyword type, keyword columns, wrapper template with `$1`, index entry columns + per-column `both`/`index_only` modes, and the four placement anchors with depth/order), and initial rows. The importer maps chatSheets v2 (`mate` + `sheet_*` objects — see [research.md](../research.md) §1) losslessly onto this model; unknown/`-1` config values fall back to sane defaults.

Selecting a template for a chat instantiates a per-chat sandbox SQLite database (a separate file from the app DB) by executing the template DDL — the only moment DDL ever runs. No template selected = feature completely off for that chat.

The Tables view is a registered workspace view (same registration pattern as the variables view): one grid per table showing current rows (initially the header/initial rows only), read-only in this slice.

Demo: import `SQL-命定之诗Can改5.9`, assign it to a chat, open the Tables view, see its 8 tables with their columns.

## Acceptance criteria

- [ ] chatSheets v2 JSON imports into a `TableTemplate`; the real 命定之诗 template is a test fixture and round-trips import → (internal model) → export-equivalent structure.
- [ ] Malformed/unsupported template JSON is rejected with a user-visible localized error, not a crash.
- [ ] Templates are file-based assets: list, import, delete via IPC; renderer touches them only through `shared/ipc`.
- [ ] Assigning/unassigning a template per chat works; assignment creates the sandbox DB from DDL; unassigned chats incur zero table-memory work.
- [ ] DDL execution is confined to instantiation; the sandbox DB is a separate file from the app DB.
- [ ] Tables view renders every table's columns + rows read-only; all UI strings go through `t()` with keys in both `en.ts` and `zh.ts` (数据库/表格 ecosystem vocabulary in zh).
- [ ] `docs/sdk/` documents the template import surface in the same change.
- [ ] `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

- [01-remove-episodic-memory-engine.md](01-remove-episodic-memory-engine.md)

## Comments

**2026-07-02 — implemented + reviewed.** Plan at [02-plan.md](02-plan.md); implemented by an Opus agent as commit `07023ae`; reviewed by the controller. Review found and fixed two defects (committed as the review-fix commit on top):

1. **`buildInitialInsert` used display headers as SQL column names** — chatSheets `content[0]` headers are display labels (row_id + Chinese names), not the DDL's column names, so `isSafeSqlIdentifier` dropped every non-ASCII column and any template shipping initial rows silently lost them (latent today — the poem fixture is header-only — but it would poison issue 06's export-with-data round-trip). Rewritten as a purely positional `INSERT INTO "t" VALUES (?, …)` (one placeholder per header column; empty `row_id` cell binds NULL for PK auto-assign); tests re-pinned to the corrected behavior.
2. **Duplicate `sqlName` across sheets wasn't rejected** — two sheets creating the same table would fail late (SQLite error at chat assignment) instead of at import. The parser now rejects with a clear `Duplicate table name` error; test added.

Everything else verified clean: DDL guard (single-CREATE, multi-statement rejection, name cross-check at instantiation, identifier allowlist), sandbox isolation (`profiles/<id>/table-dbs/<chatId>.sqlite`, never the app DB), chat-column pattern matching `workflow_id`, IPC/preload wiring, TablesView (tokens + t() + confirms on destructive actions), i18n parity (17 `tables.*` keys in each locale), docs/sdk/table-templates.md + README mapping row, real-fixture parse of all 8 tables in order. Gate re-run independently post-fix: typecheck PASS, check:deps PASS (340 modules), tests 163 files / **1258** PASS.

Accepted agent deviations: `log('info')` (no `warn` level exists), zod `.prefault({})` for nested defaults (zod 4 `.default({})` doesn't apply inner defaults), import-error contract `{ summary?, error? }` with i18n-key-or-verbatim-message semantics.

Noted for issue 06 (not fixed here): populated tables display SQL column names (from `stmt.columns()`) while sandbox-missing tables display the template's display headers — unify on display headers when the widths match, as part of the view-editing polish.
