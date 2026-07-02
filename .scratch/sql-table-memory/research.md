# Research: SQL-table memory (数据库-plugin-style) blended into the workflow engine

**Date:** 2026-07-02
**Status:** point-in-time research notes backing `PRD.md` in this directory.
**Sources (primary):**
- `C:\Users\wnc74\Downloads\SQL-命定之诗Can改5.9 貂(地理特调).json` — chatSheets v2 table template (8 sheets)
- `C:\Users\wnc74\Downloads\Can改数据库剧情推进预设-世界后台引擎v3.6.plot-preset.json` — 数据库-plugin plot-task preset (4 plotTasks)
- `C:\Users\wnc74\Downloads\命定之诗Kemini5-3.8Can改v7.1 (1).json` — main ST chat-completion preset (123 prompts; context only)
- Repo code as cited inline (all read on branch `claude/interesting-banach-1ccfdb`, main=7da41e8)

Owner decisions (recorded 2026-07-02, via Q&A):
1. **Replace** the existing episodic-memory engine (never ran live) — SQL-table memory becomes THE memory system.
2. Write path = **sandboxed SQL**: the LLM emits SQL in tags; we execute against a per-session isolated SQLite with a statement allowlist.
3. Import compat = **tables only**: first-class importer for the chatSheets v2 template format; plot tasks are re-authored natively as workflow graphs (ship a built-in example graph modeled on the plot preset).
4. The `.plot-preset.json` **is** the 剧情推进/世界推进/角色推进 "template" — no additional file exists.

---

## 1. The chatSheets v2 template format (what we must import)

Top-level: `mate` + one `sheet_<id>` object per table.

`mate` (verified in the template, lines 2–18):
- `type: "chatSheets"`, `version: 2`
- `globalInjectionConfig.readableEntryPlacement` / `wrapperPlacement`: `{position, depth, order}` defaults for injection.

Each sheet:
- `uid`, `name` (display name, zh), `orderNo`
- `sourceData`:
  - `note` — the table definition prompt: column semantics, format constraints, validation checklists ("RM检查点"), compression algorithms (纪要表/重要角色表 carry a "史书压缩算法" — the LLM itself compacts old rows). This is the main per-table customization surface.
  - `initNode` / `insertNode` / `updateNode` / `deleteNode` — per-operation AI instructions. Several contain **literal SQL examples** the LLM is expected to emit, e.g. 纪要表 insertNode:
    `INSERT INTO chronicle (row_id, code_index, …) VALUES ((SELECT MAX(row_id)+1 FROM chronicle), 'AM0002', …);`
    Others: `INSERT OR IGNORE`, `UPDATE … WHERE character_name = …`, `DELETE … WHERE status IN (…)`, capacity-cleanup DELETE with ORDER BY/LIMIT subquery.
  - `ddl` — a full `CREATE TABLE` statement with comments, `CHECK` constraints, `UNIQUE`, `NOT NULL`, `DEFAULT`. Column names are English; display headers (in `content[0]`) are Chinese.
- `content` — array of rows; row 0 is the header (display column names). This doubles as initial data (all templates ship header-only).
- `updateConfig` — `{uiSentinel, contextDepth, updateFrequency, batchSize, skipFloors}`; `updateFrequency: 3` = run this table's maintenance every 3 floors; `-1` = default/every round (纪要表/伏笔表/约定表 use -1 = every turn).
- `exportConfig` — how the table content is injected back into the prompt:
  - `enabled`, `splitByRow` (one injection entry per row vs whole table)
  - `entryName`, `entryType: 'constant' | 'keyword'`, `keywords` (comma-separated **column names** whose cell values become the activation keywords per row)
  - `injectionTemplate` — wrapper with `$1` = rendered row/table (e.g. `<角色最新信息>\n$1\n</角色最新信息>`)
  - `extraIndexEnabled` + `extraIndexColumns` + `extraIndexColumnModes` (`both` / `index_only`) + `extraIndexInjectionTemplate` — a compact always-on index entry listing selected columns of every row (so the model knows what exists and can trigger keyword recall of full rows)
  - four placements `{position, depth, order}`: `entryPlacement`, `extraIndexPlacement`, `fixedEntryPlacement`, `fixedIndexPlacement`. Positions observed: `before_character_definition`, `after_character_definition`, `at_depth_as_system` — ST worldbook-style anchors.

The 8 sheets in the poem template: 主角信息 (single-row), 重要角色表 (row per NPC, `<char_info>`-tag-gated inserts), 纪要表 (append-only chronicle, per-turn), 角色扮演指南 (per-NPC roleplay guide), 伏笔表 (foreshadowing, capped 100, auto-cleanup SQL), 约定表 (covenants, same pattern), 地区表 (regions, `<scene_info>`-gated), 地点表 (locations).

Key semantic observations:
- The plugin's memory model is **"the LLM maintains a relational DB via SQL, and the DB is projected back into the prompt as worldbook-like entries"**. Recall = keyword activation on row entries + always-on index entries; no embeddings.
- Insert gating via **tags in the main narrative reply** (`<char_info>`, `<scene_info>`) — the main model volunteers structured info; the table pass turns it into rows.
- Rewind semantics: table state must follow chat state (the ST plugin snapshots table data per message; our equivalent must survive swipe/regenerate/edit — see §4).

## 2. The plot-preset format (what we re-author natively)

Single-element array; element keys verified: `name`, `prompts`, `extractTags`, `extractInjectTags`, `contextExtractRules`, `contextExcludeRules`, `minLength`, `contextTurnCount`, `worldbook*`, `plotWorldbookConfig`, `loopSettings`, `plotTasks[4]`, `promptGroup[11]`, `finalSystemDirective`.

Each `plotTask`: `{id, name, enabled, promptGroup, extractTags, extractInjectTags, finalDirectiveTemplate, minLength, maxRetries, mergeStrategy, stage, order}`.
- `promptGroup` = a scripted multi-turn conversation (user/assistant alternation) with `$`-macros (`$U` user setting, `$C` card 基调, `$5` 纪要索引, `$7` 前文剧情, …) — i.e., a hand-rolled prompt composition + context-slice pipeline.
- `extractTags` (e.g. `Recall`, `UpdateVariable`) — tag names whose content is extracted from the reply; `extractInjectTags` (e.g. `StoryEngine,QuestPlan`) — extracted content re-injected into the next main call.
- `stage`/`order` — sequential pipeline ordering; `mergeStrategy: append`.
- Example task 剧情推进与召回: a "DM爱德华" persona plans plot beats over 纪要索引 + recent context, outputs `<Recall>` (memory recall requests) and StoryEngine/QuestPlan blocks.

**Mapping to RPT:** this is exactly what the node workflow engine already generalizes. Verified building blocks:
- Scripted prompt: `prompt.messages` / `text.template` / `merge.messages` (`src/main/services/nodes/builtin/messageNodes.ts`)
- Context slices ($-macros): `context.history/card/persona/action/params` (`contextNodes.ts`), `vars.get` (`varsNodes.ts`), `lorebook.select/entries` (`lorebookNodes.ts`)
- Own preset + own model: `prompt.preset` (`presetNodes.ts`, AssembleOverrides) + `llm.sample` `api_preset_id`/validators/retries (`generationNodes.ts:119-178`)
- Sequencing/epochs: post-response phase after `output.writeFloor` (isMainOutputCapable, `generationNodes.ts:234`), `context.refresh` (`generationNodes.ts:48`), `subgraph.call/loop` (`subgraphNodes.ts`)
- **Gap:** no generic tag extractor node (extractTags equivalent). `parse.response` only handles rpt-events/MVU. A `parse.extract` (tag/regex → text) node is needed.
- **Gap:** no per-N-floors gate except `memory.gate` (compaction-specific, being removed). A generic `table.gate`/frequency gate is needed for `updateFrequency` semantics.

## 3. What exists today (to be replaced/reused)

- Episodic memory engine (REPLACE, owner decision 1): `memoryStore.ts` (`memory_entries` CRUD, entity sheets, embeddings), `compactionService.ts` / `retrievalService.ts`, `generation/memoryRecall.ts`, nodes `memory.recall`, `memory.compact`, `memory.gate/extract/write/query` (`memoryNodes.ts`, `generationNodes.ts`), `memory` settings block + `MemoryCollection` (`types/models.ts:47-60,205+`), `memoryIpc.ts`, memory view/UI, default-graph gated chain (`defaultGraph.ts`). Flagged off (`memory.enabled=false`), never ran live → no data migration needed.
- App DB: better-sqlite3 singleton (`db.ts`), schema for profiles/settings/characters/chats/floors(+…). Portable artifacts live as JSON files (presets/lorebooks) — a table **template** is the same class (file-based asset); per-chat table **data** is session state.
- Node contract: `NodeImpl` + `RunContext` (`nodes/types.ts`) — per-(chat,workflow,node) durable state, signals, error ports, config zod→JSON-schema→editor auto-form (`catalog.ts`).
- Injection: `matchWorldInfo` + `assemblePrompt` (via `prompt.assemble`/`prompt.preset`); lorebook entries carry ST positions/depth — table exports can be synthesized as virtual lorebook entries to reuse keyword activation + placement.

## 4. Design constraints discovered

- **Rewind safety**: floors can be truncated (regenerate/swipe/edit); old engine hooked `deleteFromTurn`. For SQL tables, deterministic replay is the cleanest: keep an append-only op log keyed by floor (`chat_id, floor, seq, sql`), materialize into a per-chat sandbox SQLite; on truncation, rebuild from DDL + replaying ops with floor < cut. (SQL with `SELECT MAX(row_id)+1` subqueries is deterministic under ordered replay.)
- **SQL safety**: statements come from an LLM. Sandbox = separate SQLite database per chat (not the app DB). Allowlist statement types (INSERT/UPDATE/DELETE only at runtime; CREATE TABLE only from the template's ddl at init), reject multi-statement injection tricks, verify target table is registered, run each batch in a transaction, cap changes per batch.
- **Injection placement**: `at_depth_as_system` / `before|after_character_definition` + `order` must map onto our preset/assemble anchors; lorebook-entry synthesis covers keyword/constant + depth positions.
- **i18n**: all new UI strings via `t()` in both `en.ts`/`zh.ts` (CLAUDE.md hard rule). Table display headers are card content (stay as-is).
- **Module boundaries**: new service in `main/services`; nodes in `main/services/nodes/builtin`; renderer only via `shared/ipc`. dependency-cruiser rules unchanged unless a new boundary is added deliberately.
- **SDK docs**: importer + any card-facing surface changes require `docs/sdk/` updates in the same change (CLAUDE.md).
