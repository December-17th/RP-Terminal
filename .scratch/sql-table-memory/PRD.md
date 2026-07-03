# PRD: SQL-table memory, blended into the workflow engine

Status: ready-for-agent
Date: 2026-07-02
Research: [research.md](research.md)

## Problem Statement

The current long-term memory engine (stream/entity collections over a generic `memory_entries` store) was built but never enabled: its free-text summaries are opaque, its customization is limited to per-collection prompt strings, and it lives outside the workflow system as fixed pipeline stages. Meanwhile the ST ecosystem the app targets has converged on a different, proven memory shape: the 数据库 TavernHelper plugin, where memory is a set of **user-defined SQL tables** — each with its own column semantics, per-operation AI instructions, update cadence, and prompt-injection rules — maintained by the LLM emitting SQL and projected back into the prompt as keyword-activated entries. Cards like 命定之诗 ship polished table templates for it. RP Terminal cannot run these templates, and its own memory system offers no comparable customization.

## Solution

Replace the episodic-memory engine with **table memory**: per-chat SQL tables defined by importable templates (first-class import of the 数据库 plugin's chatSheets v2 format), maintained by workflow graphs. The LLM writes tables by emitting SQL inside tags; the app executes it against a per-chat sandboxed SQLite database with a statement allowlist and a floor-keyed op log for rewind safety. Tables are projected back into the prompt as constant or keyword-activated entries (with optional compact index entries) at authorable placements. All moving parts — the update cadence gate, the table-state reader, the SQL extractor, the SQL executor, the prompt exporter — are **workflow nodes**, so the maintenance pipeline is a visible, editable graph (a built-in example graph modeled on the 世界后台引擎 plot-preset ships with the app), not a black box. A dedicated Tables view lets the player inspect and hand-edit table data.

## User Stories

1. As a card player, I want to import a 数据库-plugin table template (chatSheets v2 JSON) and have its tables just work in my session, so that community memory templates are usable without conversion.
2. As a card player, I want the AI to record events, characters, locations, foreshadowing, and covenants into structured tables as I play, so that long-running sessions keep continuity beyond the context window.
3. As a card player, I want table contents injected back into the prompt (whole-table or per-row, keyword-activated or always-on), so that the model recalls exactly the relevant rows.
4. As a card player, I want compact index entries listing what exists in a table, so that the model knows what it can recall without paying for full rows every turn.
5. As a card player, I want table state to follow chat state when I swipe, regenerate, or delete floors, so that memory never desyncs from the story.
6. As a card player, I want to view and hand-edit table rows in a dedicated view, so that I can correct AI mistakes or seed data.
7. As a template author, I want each table to carry its own definition prompt, per-operation instructions (init/insert/update/delete), and DDL, so that I control exactly how the AI maintains it.
8. As a template author, I want per-table update frequency (every turn / every N floors), so that cheap tables update often and expensive ones batch.
9. As a template author, I want per-table injection config (entry name, constant vs keyword, keyword columns, wrapper template, index columns and modes, placement anchors with depth/order), so that I control the prompt surface.
10. As a workflow author, I want the table-maintenance pipeline to be an ordinary workflow graph (gate → read table state → compose prompt → sample a side LLM → extract SQL → apply), so that I can customize any stage — swap the model, rewrite the prompt, add validators, reorder passes.
11. As a workflow author, I want a generic tag/regex extractor node, so that I can pull `<UpdateVariable>`-style tagged content out of any LLM reply (the plot-preset's extractTags equivalent).
12. As a workflow author, I want a frequency-gate node (fires every N floors, optionally batching what aged in), so that I can express updateFrequency semantics for any side pipeline, not just tables.
13. As a workflow author, I want a table-query node that returns rows/rendered text for an arbitrary SQL SELECT or table name, so that other branches (planners, 剧情推进 graphs) can read memory.
14. As a workflow author, I want a built-in example graph modeled on the 剧情推进/世界推进 plot-preset (background world-engine passes running post-response against their own API preset), so that I have a working starting point to customize.
15. As a player, I want table maintenance to run off the hot path (post-response) and fail open, so that a failed side call never blocks or corrupts my turn.
16. As a player, I want the main narrative reply's structured tags (e.g. `<char_info>`, `<scene_info>`) available to the table pipeline, so that insert-gating conventions from existing templates keep working.
17. As a user, I want to enable/disable table memory per chat and choose which template a chat uses, so that sessions without cards that need it pay nothing.
18. As a user, I want to export my table template (and optionally current data) back to JSON, so that templates remain portable and shareable.
19. As a security-conscious user, I want LLM-emitted SQL executed only against an isolated per-chat database with an operation allowlist, so that a malicious or confused reply cannot touch app data.
20. As a bilingual user, I want all new UI (Tables view, import dialogs, node titles/config labels) localized in English and 简体中文, so that the app stays consistent.
21. As a developer, I want the old episodic-memory engine removed in the same effort (store, compaction/retrieval services, its nodes, settings block, view), so that there aren't two half-alive memory systems.
22. As a template author, I want templates stored as file-based portable assets (like presets and lorebooks), so that they travel with worlds and can be versioned.
23. As a card author, I want a documented path for cards to bundle a table template later, so that cartridges can ship memory schemas (documented as future surface, see Out of Scope).

## Implementation Decisions

- **Replace, don't coexist** (owner decision): the `memory_entries` engine, compaction/retrieval services, `memory.*` node family, `memory` settings block, memory IPC/view, and the default graph's gated compaction chain are removed. No data migration (the system never ran live). Characterization tests covering removed behavior are deleted/updated deliberately in the same commits.
- **Template model**: a native `TableTemplate` artifact (zod-schema'd JSON, file-based asset like presets/lorebooks) holding per-table: display name, definition prompt (note), init/insert/update/delete instructions, DDL, update frequency, injection config (entry + index + placements), and initial rows. The chatSheets v2 importer maps that format losslessly onto this model; export writes chatSheets v2 back out.
- **Storage**: per-chat sandbox SQLite database (separate file from the app DB), materialized from the template DDL + an append-only op log keyed `(chat, floor, seq)` stored with chat state. Rewind/swipe/regenerate truncates the op log at the cut floor and rebuilds the sandbox DB by replay. Hand edits from the Tables view are recorded as ops too, attributed to the current floor.
- **SQL safety**: runtime statements restricted to INSERT/UPDATE/DELETE on registered tables (SELECT allowed for the query node); DDL executes only from the template at instantiation. Multi-statement batches are split and validated statement-by-statement; ATTACH/PRAGMA/DROP/ALTER/CREATE and any table not in the registry are rejected; each batch runs in a transaction with a row-change cap; failures roll back the batch and surface on the node's error port (fail-open: the turn is never blocked).
- **Workflow blend (components, not a monolith)** — new node family:
  - `table.gate`: fires per-table-group when its update frequency has elapsed (durable per-chat node state tracks the last-maintained floor); emits the aged floor span.
  - `table.read`: renders selected tables for the update prompt — current data plus the table's definition/operation instructions (the "what you may do" block).
  - `parse.extract`: generic tag/regex extractor over any text (closes the extractTags gap; useful far beyond tables).
  - `table.apply`: validates + executes an SQL batch against the sandbox DB, appends to the op log, emits per-statement results and an ordering `done` output.
  - `table.query`: SELECT/table-name read returning rows + rendered text for arbitrary branches.
  - `table.export`: projects tables into injection entries per their injection config (synthesized as virtual lorebook-style entries so keyword activation and depth placement reuse the existing world-info machinery), wired into `prompt.assemble`/`prompt.preset`.
  - The maintenance pipeline itself is an authored graph composed of these plus existing nodes (`prompt.messages`, `llm.sample` with `api_preset_id`, `context.*`); a built-in example workflow ships modeling the plot-preset's staged background passes (世界推进 → 剧情推进 → table update), runnable post-response.
- **Main-reply tag feed**: the main turn's raw reply is already wireable in graphs; insert-gating tags (`<char_info>`, `<scene_info>`) are pulled with `parse.extract` from it — no special-case parser.
- **Injection placement mapping**: `before_character_definition` / `after_character_definition` / `at_depth_as_system` (+ depth/order) map onto the existing lorebook-entry position vocabulary; the exporter emits entries in that vocabulary.
- **Per-chat enablement**: chat-level selection of a table template (none = feature off, zero cost). Settings carry only cross-cutting knobs (e.g. default utility API preset for maintenance graphs).
- **UI**: a registered `tables` workspace view (grid per table: browse, edit cells, add/delete rows, see last-maintained floor), plus template import/manage surface. All strings through `t()` in both locales; ST-ecosystem terms (数据库表格 vocabulary) used in zh.
- **Docs**: `docs/sdk/` gains the template import surface documentation; the episodic-memory design doc is superseded with a pointer, per the living/point-in-time docs policy.

## Testing Decisions

- Test external behavior at module seams, not internals:
  - Importer: chatSheets v2 JSON → TableTemplate round-trip (import → export equivalence on the real 命定之诗 template as a fixture).
  - SQL sandbox: allowlist acceptance/rejection tables (each forbidden statement class), transactionality on mid-batch failure, op-log append + replay determinism, rewind truncation → rebuilt state equality.
  - Nodes: same style as existing node tests — run() contract per node (gate cadence with durable state, extract patterns, apply happy/error paths, export entry synthesis incl. keyword columns, splitByRow, index modes, placements).
  - Export/injection: entries land at the right anchors through the real assemble path (extend existing assemble/preset characterization tests deliberately).
  - Removal: update/delete the old memory characterization tests in the same commit as each removal, never to “go green”.
- Prior art: existing node unit tests, converter/parity characterization tests, and the vitest patterns already in the repo (note the beforeEach-return gotcha).
- Verification gate per change: `npm run typecheck && npm run check:deps && npm run test`.

## Out of Scope

- Vector/embedding recall for tables (keyword + index entries only, matching the source plugin).
- Importing `.plot-preset.json` files directly (owner decision: plot tasks are re-authored natively; only the example workflow ships).
- Card-embedded table templates in `extensions.rp_terminal` cartridges (documented as a future surface; import is app-level in v1).
- A visual template editor beyond import/manage + data grid (editing DDL/prompts is JSON-level in v1).
- Migrating any `memory_entries` data (none exists in live use).
- The 数据库 plugin's own UI conventions (we build our native Tables view, not a clone).

## Further Notes

- The 纪要表's "史书压缩算法" (LLM-side history compression inside a cell) needs no engine support — it's prompt-level behavior carried by the template.
- The op-log replay design assumes ordered, single-writer application (post-response phase already serializes per chat); a per-chat write lock still guards concurrent graphs, mirroring the compaction slot pattern being removed.
- The plot-preset's `finalSystemDirective` / staged `stage`/`order` semantics are expressible with existing sequencing (post-response chains + `context.refresh` epochs + `subgraph.call`); if authoring friction shows up, a dedicated stage-sequencer node is a follow-on, not v1.
