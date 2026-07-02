# 02 — Table templates: import, per-chat enablement, read-only Tables view

Status: ready-for-agent

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
