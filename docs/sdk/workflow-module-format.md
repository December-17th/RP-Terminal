# Workflow module format — the agent UI contract

> **SUPERSEDED — historical only.** The workflow runtime, editor, node catalog, and `.rptmodule` /
> `GroupDecl` formats described below were **removed** by the Agent Runtime cutover
> ([ADR 0020](../adr/0020-agent-runtime-replaces-workflow-system.md)) on the `agent-system` branch. No
> current build supports this format; agents are authored as `.rptagent` Agent Definitions per the
> [Agent Runtime design](../agent-system/agent-runtime-design.md). This page is retained unchanged for
> historical reference — the file/line citations below point at code that no longer exists.

**Status (historical):** Implemented legacy contract, frozen on 2026-07-18, then removed by ADR 0020.

A workflow **module** is a reusable slab of a workflow graph: a named group of in-place nodes, its
internal edges, and the settings it exposes. It ships as a `.rptmodule` file
(`src/shared/workflow/moduleEnvelope.ts`) or lives inline in a workflow doc as a `GroupDecl`
(`src/shared/workflow/types.ts:81`). This page is the **creator-facing contract** for what a module
must contain to get the stock agent UI — no side manifest, purely the document shape.

## The agent UI contract

An **agent** is a named `GroupDecl` whose member chain is rooted at a **trigger** node. Anything
matching that shape gets the full agent UI (status sentence, on/off switch, prompt editor, runs). A
node type is a trigger when its descriptor sets `isTrigger` (`src/shared/workflow/types.ts:38`); the
three built-in triggers set it (`src/main/services/nodes/builtin/triggerNodes.ts:88,101,113`).
Everything below is derived from the doc — the only required authoring is the group name.

| UI element | Source | Author work |
|---|---|---|
| Name | `group.name` (`types.ts:83`) | required |
| On/off toggle | trigger node `disabled` flag; flips ALL triggers in the group | none |
| Status sentence | derived: trigger description + last run | none |
| Settings tab | `group.exposed` (`types.ts` `ExposedGroupSetting`, :72) | pick fields |
| Mode dropdown | any exposed enum field (static schema `enum`, else `dynamicEnum`) | expose the field |
| Prompt tab / card excerpt | node-type descriptor `promptFields` | none (inherited) |
| Runs | runs keyed by trigger node id → mapped through membership | none |
| Setup note | `group.note` (`types.ts`, rendered verbatim in a warning tint) | optional |

## Schema additions (agent & memory UX WP-A — additive)

All additive and optional; a pre-WP-A doc/module is unaffected.

### `GroupDecl.note?: string`

Author setup guidance, rendered verbatim in a warning tint on the agent panel (e.g. "needs a bound
table template + an API preset"). Plain string, never interpreted. Declared in the doc schema
(`src/shared/workflow/docSchema.ts` `GroupDeclSchema`) — **zod strips undeclared keys**, so an
un-declared field would silently vanish on a round-trip through `parseWorkflowDoc`. It also travels
with a `.rptmodule` export: `ModulePayload.note` (`moduleEnvelope.ts`), populated from the group by
`buildModuleEnvelope` (`src/main/services/moduleTransferService.ts`).

### `GroupDecl.origin?: 'import'`

Import provenance. `'import'` marks a group that arrived via a `.rptmodule` import (the Agents ▾
dropdown shows an `imported` chip). Stamped by the importer at insert time, **not** carried in the
module envelope — a module file never asserts its own provenance. `'import'` is the only accepted
value (`GroupDeclSchema` uses `z.literal('import')`).

### Node-type descriptor `promptFields?: string[]`

The config field name(s) that hold an **authored prompt** — a role-message array or a template
string. Surfaced through the `list-node-types` catalog
(`src/main/services/nodes/catalog.ts` `NodeTypeInfo` / `listNodeTypes`) so the editor routes those
fields to the dedicated Prompt editor instead of the generic schema-form control, and derives the
on-card prompt excerpt. Set on the built-ins:

- `agent.llm` → `['messages']` (`src/main/services/nodes/builtin/agentNodes.ts`)
- `memory.maintain` → `['messages']` (`src/main/services/nodes/builtin/memoryNodes.ts`)
- `text.template` → `['template']` (`src/main/services/nodes/builtin/messageNodes.ts`)

An imported agent inherits this from its built-in node types — no author work.

### Node-type descriptor `dynamicEnum?`

`{ path, optionsPath, keyField, labelField }` (`DynamicEnumHint`, `src/shared/workflow/types.ts`).
Describes an enum config field whose options are **not** a static zod enum but live in a sibling
config array. The generic exposed-enum renderer prefers a static JSON-Schema `enum`, falling back to
resolving this hint against the node instance's current config. First stamped by `control.mode`
(WP-B): `{ path: 'selected', optionsPath: 'options', keyField: 'key', labelField: 'label' }`
(`src/main/services/nodes/builtin/controlNodes.ts`).

## The `control.mode` node (WP-B)

The generic **mode selector** (spec §3.1, plan §0.2) that makes agent chains mutually exclusive
behind one exposed enum. Lives in `src/main/services/nodes/builtin/controlNodes.ts`; registered in
`builtin/index.ts`.

- **Config:** `{ options: [{ key, label? }] (1–4), selected: string }`. `label` is optional — the
  renderer falls back to `key`. A `selected` key not present in `options` **fails soft** to the
  first option (logged); it never throws.
- **Ports:** inputs `when1..when4: Signal`; outputs `fired: Signal`, `selected: Text`.
- **Slot mapping (the contract):** `options[i]` corresponds to `when{i+1}` — the first option to
  `when1`, the second to `when2`, and so on. Fixed at 4 slots (mirrors `control.switch` `case1–4`).
  An imported system joins the mutual exclusion by wiring its trigger into a free slot and adding an
  option — pure wiring, no app code.
- **Firing rule** (plan §0.2 — a deliberate refinement of the spec's literal text): `fired` fires
  iff **(the selected option's slot is wired AND that slot's edge was live this run)** OR **(no
  `whenN` slot is wired at all)**. Consequences:
  - Non-selected slots are dead ends — structural mutual exclusion.
  - An option whose slot is unwired (e.g. `off`) selects "nothing runs": in a wired graph an
    unwired selected slot is a dead end, which is what makes `off` the master off-switch.
  - Zero wired `when` slots ⇒ fires unconditionally — the node doubles as a standalone
    config-driven gate.
- **`selected: Text`** always emits the (fail-soft-resolved) selected key whenever the node runs —
  it is data, not a gate. Note the node only runs at all if ≥1 wired slot fired or no slot is wired
  (standard engine Signal gating, `src/main/services/workflowEngine.ts`).
- **Engine support:** `run()`'s third argument (`NodeMeta`, `src/main/services/nodes/types.ts`)
  carries `wiredInputs: string[]` — the input-port names with ≥1 incoming edge, live or dead —
  supplied at the single run call site (`workflowEngine.ts`). This is how a node distinguishes
  "wired but not fired" from "not wired at all". Additive: no other built-in reads it.

## The `memory.maintain` node (memory.maintain plan)

The **all-in-one SQL-table memory maintenance node** — one self-seeding node that folds the
five-node chain (`history.recent → table.read → agent.llm → parse.extract(TableEdit) →
table.apply`) into a single canvas node. Lives in `src/main/services/nodes/builtin/memoryNodes.ts`;
registered in `builtin/index.ts`; classified `writes-tables` in the ADR-0007 capability map.

- **Ports:** input `when: Signal` (gated by `control.mode.fired` in the seeded doc); outputs
  `report: Text`, `error: Error` (class-B failures route here — wire to `util.log`).
- **Config:** `messages` (the scaffold prompt — a role array, `promptFields`-routed to the Prompt
  editor), plus `lastNFloors` (history window, default 6), `max_rows` (per-table row cap),
  `include_rules` (default true), `advance_progress` (default **true** — advance the table-progress
  pointer after a successful apply so the backlog trigger + `context.trimProcessed` clear), and the
  shared LLM knobs (`api_preset_id`, `temperature`, `retries`, …).
- **Scaffold placeholders:** `{{tables}}` (canonical) / `{{input}}` (alias, so the proven verbatim
  maintainer prompt transfers unchanged) → the rendered tables block; `{history}` → the recent
  transcript (a row whose entire content is `{history}` is replaced by the history messages
  role-preserving; inline `{history}` → flattened transcript text). Table/history text is substituted
  as DATA (after macros/EJS run on the authored scaffold), never executed. The seeded Default uses an
  **inline** `{history}` (one `【本批剧情】\n{history}` user row) on purpose: role-preserving splicing
  ends the prompt on the last floor's `assistant` reply, and OpenAI-compatible Gemini endpoints reject a
  trailing `assistant` turn with an empty completion — the inline form flattens the transcript so the
  prompt ends on a `user` turn.
- **Per-table maintenance rules are NOT node config** — each table's `note`/`initNode`/`insertNode`/
  `updateNode`/`deleteNode` live in the **bound table template** (`docs/sdk/table-templates.md`) and
  are rendered into the prompt by the shared `renderTablesBlock`. The node's details panel edits them
  back into the template file via `table-template-update` (per-chat binding — edits are shared across
  every chat using the template). The node's `messages` is only the maintainer scaffold.
- **Behavior:** no bound template → silent no-op (no wasted model call); an empty
  `<TableEdit></TableEdit>` reply → no write, `report: "no changes"`. The fully composed prompt is
  recorded on the run trace (`debug['prompt (sent)']`) so what was sent is inspectable in the Runs tab.

The fine-grained five nodes stay registered — imported `.rptflow` modules and power-user chains keep
working; `memory.maintain` is additive.

**Example:** `docs/workflows/memory-maintain.rptflow` (trigger → `control.mode` → `memory.maintain`,
mirroring the seeded Default v2) — import it, bind a table template, and flip the Mode setting.

## The plot-recall nodes — `memory.recall` + `notes.maintain` (plot-recall v1)

Two additional builtin nodes (branch `feat/plot-recall`, 2026-07-11) that add an **LLM-selected
plot-recall** layer over the existing SQL-table memory + a per-chat prose **notes** corpus. Both are
registered in `builtin/index.ts`; both are **inert until wired** (no seeding, no settings flag —
opt-in = wiring). Full design + as-built deviations:
`docs/plot-recall-memory-design.md` (internal, local-only).

- **`memory.recall`** (`src/main/services/nodes/builtin/recallNodes.ts`) — a **pre-turn planner**
  (turn-coupled, NOT an agent). Inputs `gen: Context`, `when: Signal`; outputs `block: Text`,
  `report: Text`, `error: Error`; config extends the shared LLM knobs (`llmCallConfigSchema`) plus
  `messages` (planner scaffold, `promptFields`-routed to the Prompt editor), `temperature?`,
  `lastNFloors?` (3), `max_rows?` (24), `max_note_sections?` (6), `max_chars?`, `directive?` (the
  compose template), `recall_tables?` (csv). Per turn it builds the 纪要索引 **catalogue**
  (`renderCatalog`, one line per row across `extraIndexEnabled` tables) + the notes TOC, makes **one
  side LLM call**, parses `<Recall>` MT-codes / `<Query>` note greps / opaque
  `<QuestPlan>`/`<StoryEngine>`, **fetches the selected chronicle rows deterministically by exact
  code** (not via the lexical matcher — invented codes drop out) capped at `max_rows`, greps the
  notes, and composes ONE **tail** system block wired to `prompt.assemble`'s `block` port (volatile
  tail, cache-correct). No bound catalogue table **and** empty notes → **no-op, zero model calls**
  (byte-identical prompt). **Fail-open is return-based:** a side-call failure is caught inside `run()`;
  the node completes with no `block`, a `NodeError`-shaped value on `error`, and a `report`/debug entry
  — the pre-phase turn is never aborted (so the run trace shows the node as `ran` even on failure).
  The MT-code convention is RPT-authored; matching is **generic exact-key**, so imported `AM####`
  cards work unchanged. Default planner scaffold + compose directive live in
  `src/main/services/nodes/builtin/defaultRecallPrompts.ts` (zh, adapted from the reference stage-3
  task, `AM`→`MT`, bands scaled to `max_rows` 24).
- **`notes.maintain`** (`src/main/services/nodes/builtin/notesNodes.ts`) — a **post-turn maintainer**
  (cadence/state-gated like `memory.maintain`). Input `when: Signal`; outputs `report: Text`,
  `error: Error`; builds its own gen (`buildGenContext`), reads the recent transcript + current notes,
  makes one side LLM call, parses `<MemoryNote section="…" mode="append|replace">…</MemoryNote>` (a
  small attribute-aware tag extractor added beside `extractTagAll` in `parseNodes.ts`), and
  `mergeNotes` → `writeNotes` the per-chat markdown notes file
  (`profiles/<id>/chat-notes/<chatId>.md`, `notesMemoryService.ts`; notes IPC surfaced as
  `window.api.notesGet`/`notesSet` in `src/preload/index.d.ts`). No-op with no transcript **and** no
  existing notes file. Prose-only discipline (do not restate MVU numbers / duplicate the SQL tables).

**Example:** `docs/workflows/plot-recall.rptflow` — the narrator spine PLUS `memory.recall` wired
pre-turn (`input.context → memory.recall → prompt.assemble.block`) and the seeded-Default Table-memory
maintainer group. Bind a chronicle template whose overview + code columns are `extraIndexEnabled`:
import `docs/workflows/plot-recall-chronicle.chatsheets.json` (an RPT-authored MT-coded 纪要 template)
or any `AM`/`MT`-coded 纪要 template such as the 命定之诗 Can改 SQL template. The **MT-code badge** on
the Memory Manager row cards + workspace Tables view is derived from the bound template's export config
(the `keywords` / extraIndex `both` column, via `src/shared/memory/codeColumn.ts`).

## The seeded "Default" doc + the open-slot convention (WP-C; v2 = memory.maintain)

Every profile is lazily seeded with an ordinary, EDITABLE workflow doc named **"Default"**: the
narrator spine plus a collapsed **"Table memory"** group (`buildDefaultMemoryDocV2`,
`src/main/services/nodes/builtin/defaultMemoryTemplate.ts`; seeding rule in
`src/main/services/workflowService.ts` `seedDefaultMemoryWorkflow`). The old narrator-only
`DEFAULT_GRAPH` builtin has been **deleted**: the invisible read-only fallback is now the SAME memory
doc, normalized to id `'default'` with its seed marker stripped (`workflowStore.BUILTIN_DEFAULT_DOC`).
That fallback is **not** a `listWorkflows` entry — the only visible "Default" is the seeded editable
copy. **v2** replaced the original five-node maintenance chain with the single `memory.maintain` node
(gated by `mode.fired`, `error → util.log`); `buildDefaultMemoryDoc` (v1) is retained only as the
superseded-doc fixture. A plain narrator-only spine survives solely as the test fixture
`test/fixtures/narratorSpineDoc.ts` (`NARRATOR_SPINE_DOC`).

- **Seeding rule** (memory.maintain plan WP3): lazy at the `listWorkflows` entry point; idempotent via
  the `meta.seeded = 'default-memory-v2'` marker (survives rename/edit); skipped when any user doc
  already contains a memory node (`table.apply` / `agent.llm` / `memory.maintain`); the global
  selection is set to the seeded doc only when nothing was selected. Ships with mode **`every_turn`**
  (memory maintenance runs every N floors out of the box; a bound table template with a `summary`
  table is still required before anything is written — the exposed Mode setting switches to `async`
  or `off`). Because the memory group is trigger-rooted, a plain turn still excludes it regardless of
  mode, so the narrator behavior is unchanged.
- **v1 → v2 auto-replace:** a profile that still carries a live `default-memory-v1` doc has it
  **superseded** — v2 is seeded first (crash-safe), then the v1 doc is deleted (which tombstones its
  marker and repoints the global selection to v2). Hand-edits to a v1 default are lost. **Tombstones
  win:** deleting either default (recorded in `_selection.json` `seededTombstones`) blocks reseeding —
  a v2-tombstoned profile never reseeds, and a deliberately-deleted v1 is not resurrected as v2.
- **The open-slot convention for imported memory systems** (spec §3.2): the seeded doc's
  `control.mode` uses `when1` (cadence trigger) and `when2` (backlog state trigger); **`when3` and
  `when4` are deliberately left unwired.** An imported memory/agent module joins the mutual
  exclusion by (1) wiring its own trigger's `fired` into a free slot and (2) adding a matching
  option `{ key, label? }` to the mode's `options` — options map to slots in order
  (`options[i] ↔ when{i+1}`). Pure wiring; no app code. The `off` option deliberately has NO wired
  slot — selecting it dead-ends the chain (the WP-B firing rule), which is the master memory
  off-switch.

### `isTrigger` surfaced through the catalog

`NodeTypeInfo.isTrigger` mirrors the descriptor flag through `list-node-types`, so the canvas keys
its agent detection + on/off switch off the catalog rather than a `trigger.*` name prefix (the prefix
is kept only as a fallback for a stale/absent catalog entry —
`src/renderer/src/components/workflow/FlowCanvas.tsx`).

## `agent.llm` lorebook resolution (WP-H)

`agent.llm` gains an optional `lore: Lore` input and an optional config field
`lorebook: 'main' | 'custom'` (default `'main'`). Resolution order — **wire wins, then config**
(`resolveAgentLore`, `src/main/services/nodes/builtin/agentNodes.ts`):

1. **`lore` input WIRED in the doc** (per `wiredInputs` — wired-ness, not liveness) ⇒ the wire's
   books, flattened with `lorebook.entries` semantics (enabled entries' raw contents, blank-line
   joined, NO keyword scan — `lorebookNodes.ts`). A wired-but-gated edge yields an EMPTY block (the
   author's chosen source produced nothing); it does NOT fall back to matching. The Settings-tab
   Lorebook row shows "wired on canvas" and disables the picker.
2. **config `custom` with stored picks** ⇒ exactly the picked entries — constant, no keyword scan.
   Picks are per-WORLD, stored OUTSIDE the doc in the profile's `workflows/_lore-picks.json`, keyed
   `(worldId = chat.character_id, docId, nodeId)`
   (`src/main/services/workflowLorePicksStore.ts`) — the doc stays world-portable. **Entry identity
   is `(book id, entry comment)`**: RPT's lorebook entries carry no `uid`
   (`src/main/types/character.ts` `LorebookEntrySchema`; `normalizeLorebookData` maps `comment`
   only), so the plan's documented comment-fallback identity applies — the same identity
   `lorebook.entries` filters use. A pick whose `(book, comment)` no longer resolves is skipped
   fail-soft at run time and surfaces as "N missing" in the picker. Duplicate comments within one
   book resolve together.
3. **else** (`main`, or `custom` with no picks yet for this world) ⇒ the STANDARD matching the
   narrator's assemble uses — the same `matchAcross` core over the same active books + recursion cap
   (`assemble.ts` `matchWorldInfo` = `matchAcross` + an FSM-mode cache; the side call invokes the
   shared core directly and never reads/poisons that cache) — scanned over the agent's `history`
   input, falling back to the narrator's own scan window (`gen.scanText`) when no history is
   wired/live.

**Injection** (spec §7.3): a `{{lore}}` placeholder in any template row is substituted with the
resolved block (empty block ⇒ empty string, before macro interpolation); with no placeholder, a
non-empty block is appended as a trailing `system` row. Empty block + no placeholder ⇒ nothing.

`llm.sample` is untouched (the narrator path's lorebook context flows through `prompt.assemble` as
before — parity-pinned).

## Round-trip guarantees

- **Doc save/load:** every field above is declared in `docSchema.ts` (groups) or surfaced by
  `catalog.ts` (descriptor hints). The editor's `editorToDoc` passes `groups` through wholesale from
  the base doc (`src/renderer/src/components/workflow/editorModel.ts`), so `note`/`origin` survive its
  field whitelist. Pinned by `test/workflow/docSchema.test.ts` + `test/workflow/editorModel.test.ts`.
- **`.rptmodule` export/import:** `ModulePayload.note` is in the serialize key order, the parse
  schema, and the known-keys set (`moduleEnvelope.ts`). Pinned by
  `test/moduleTransferService.test.ts`. `origin` is intentionally not carried.
