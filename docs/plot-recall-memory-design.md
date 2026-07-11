# Agentic Plot Recall — LLM-selected table memory + notes grep, pre-turn

**Status:** **Implemented (v1)** (branch `feat/plot-recall`, WP1–WP8, 2026-07-11) — shipped on the
plan below; the as-built deviations are in [§As-built (v1)](#as-built-v1--deviations) at the top of
this doc. The design body below is preserved as-authored; where it and the as-built section differ,
**the as-built section wins**. Implementation plan:
[.scratch/plot-recall/plan-2026-07-10.md](../.scratch/plot-recall/plan-2026-07-10.md); the deferred
world/character-progression stages are assessed in
[.scratch/plot-recall/progression-feasibility-2026-07-10.md](../.scratch/plot-recall/progression-feasibility-2026-07-10.md).
**Owner decisions 2026-07-10:** preset prompt text may be re-used/adapted (no clean-room rewrite —
engine code stays reference-only); RPT's authored memory-code convention is **`MT####`** ("Memory
Table") — matching stays generic exact-key so imported `AM####` cards work unchanged; the Memory
Manager row cards + workspace Tables view get a memory-code badge (plan WP7).
**Date:** 2026-07-10
**Extends / partially supersedes:** [grep-notes-memory-design.md](grep-notes-memory-design.md) — the
`memory.recall` node designed there is upgraded into the recall/planner described here; the notes
file, `notesGrep.ts` pure engine, and `notes.maintain` carry over unchanged. Review findings from
that doc (ship vehicle, CJK grep) are folded in below.
**Clean-room source:** behavior modeled on SP Database V ("shujuku", `E:\Projects\shujuku`, no
license — behavior reference ONLY, no code reuse) as documented in the external technical doc
(`E:/Projects/SP数据库V-shujuku-技术文档.md` §12/§14/§23), and on the companion plot preset
`Can改数据库剧情推进预设-世界后台引擎v3.5.json` + table template `SQL-命定之诗Can改5.9 貂(地理特调).json`
(both under `example sillytarvern character card, presets, extensions and scripts/命定之诗/`).

---

## As-built (v1) — deviations

The feature shipped as planned; the following are the deviations from this design + the plan that a
future reader/maintainer needs. Each is verified against the branch code.

- **Recall fail-open is RETURN-based, not throw-based.** The design's "on side-call error emit empty
  `block` and route `error`" is honored, but the mechanism is: side-call failures are **caught inside
  `run()`** and the node completes with **no `block` output** plus a `NodeError`-shaped value returned
  on its `error` output (a `report` line + a debug entry accompany it). Reason: `memory.recall` runs
  **inline in the narrator's pre phase**, and the engine's fatal guard (an unwired-throw abort in
  `src/main/services/generation/workflowEngine.ts`) would otherwise kill the player's turn. Consequence
  for debugging: the run **trace shows the node as `ran` even on failure** — the failure is observable
  via the `error`/`report` outputs and the debug entry, not via a trace `error` status.
  ([`recallNodes.ts`](../src/main/services/nodes/builtin/recallNodes.ts) run()).
- **No `src/shared/ipc` typed surface.** The plan called for the notes IPC to go through a typed
  `src/shared/ipc` module; that module does not exist in this codebase. The notes IPC is exposed as
  `window.api.notesGet(profileId, chatId)` / `notesSet(profileId, chatId, notes)`, typed in
  [`src/preload/index.d.ts`](../src/preload/index.d.ts) (the established preload-surface pattern).
- **`renderCatalog` gates on `enabled && extraIndexEnabled`** (not `extraIndexEnabled` alone) so the
  catalogue never advertises MT codes whose rows can't resolve.
- **`codeColumnOf` lives in [`src/shared/memory/codeColumn.ts`](../src/shared/memory/codeColumn.ts)**
  with its own minimal structural config type — `shared/` may import neither main nor renderer types
  (depcruise `shared-not-to-main-renderer`), so it declares the structural mirror rather than importing
  `TableExportConfig`.
- **Planner prompts were condensed/adapted, not copied verbatim.** The reference stage-3 task carried
  ~27KB of DM machinery referencing slots outside the node contract (calendar/ledger/EJS
  `getMessageVar`, stage-1/2 tags); the shipped defaults in
  [`defaultRecallPrompts.ts`](../src/main/services/nodes/builtin/defaultRecallPrompts.ts) keep the
  `<Recall_format>` narrative-weight idea but scale the count bands to **6–10 / 10–16 / 16–24** under
  the `max_rows` 24 default, and use **`MT`** throughout (`AM`→`MT`).
- **Content files shipped under `docs/workflows/`.** The RPT chronicle template is
  [`docs/workflows/plot-recall-chronicle.chatsheets.json`](workflows/plot-recall-chronicle.chatsheets.json)
  and the example workflow is [`docs/workflows/plot-recall.rptflow`](workflows/plot-recall.rptflow) —
  a **standalone doc mirroring `memory-fill-async`'s structure**; the `control.mode` `when4`-joining
  idiom was **not** used (it would have required new app code, which the plan forbade).
- **`notesGrep` drops preamble before the first `##` heading** (sections are the addressable unit);
  the `notes.maintain` default prompt enforces named-`##`-section writes.
- **The TableGrid code-column marking is derived internally from the def**, so the MT badge also
  appears in the **editor Memory-sheet Data tab**, not only the workspace Tables view.

**Known owner-pass items (open):** the example doc's state trigger still watches the `summary` table
(chronicle-only setups must repoint it); whether the `<Recall_format>` bands feel right at `max_rows`
24; and an in-app visual check of the Notes tab + MT badges.

---

## The reference behavior (verified against the preset + tech doc)

SP Database V's memory recall is a **pre-generation planning layer** over the chronicle table
(纪要表), whose rows the table-fill LLM keys with `AM####` codes (the template's 编码索引 column
rules). Two projections make it work:

1. **Per-row keyword entries** — each chronicle row becomes a green-light worldbook entry keyed by
   its `AM####` code, wrapped in `<记忆回溯>` (the template's `injectionTemplate`).
2. **The catalogue** (纪要索引) — a single constant entry listing, for every row, the 概览 column (a
   30–60字 one-line skeleton: 【时间】【地点】【行为】→【结果/影响】) plus its code, wrapped in
   `<已发生的事件概览>` (the `extraIndex*` config).

Before the main reply generates, a planner task (the preset's stage-3 `剧情推进与召回`) makes ONE
side LLM call whose prompt contains: the catalogue (`$5`), the last `contextTurnCount`(3) AI
messages (`$7`), the user's input (`$8`), worldbook context (`$1`), and the **previous turn's plan**
(stored per-message as `msg.qrf_plot`, read back via `getMessageVar('剧情规划')`). The reply carries
three tag families:

- `<Recall>` — a comma-separated list of `AM####` codes picked **only from the catalogue**, count
  linked to a narrative-weight judgment (light 12–18 / medium 20–28 / heavy 25–32; never invent
  codes; list all if fewer exist).
- `<QuestPlan>` — the DM's beat plan (beats with a temperature curve, branch presets, active branch,
  NPC motivation floors, lifecycle flags).
- `<StoryEngine>` — tone constraints, quest log (☑/▶/☐/📅), archive, cast in/out management.

The runtime extracts the tags, fills them into a **final storyteller directive** injected into the
outgoing prompt, and stores the plan back on the message for next turn. The recall closes
*lexically*: the `AM####` codes sitting in the injected directive are scanned by the worldbook
keyword engine, which lights up exactly those per-row `<记忆回溯>` entries — so the model receives
the full text of the N selected memories. (The preset's stage-1/-2 tasks — living-world simulation
and off-stage character progression — are **out of scope here** by owner decision.)

## What RPT already has (verified — file:line)

The striking finding: **RPT already implements the write side and both projections.** What's missing
is only the reader.

- **Chronicle rows + codes**: `memory.maintain` drives the fill LLM with each table's authored
  column rules ([memoryNodes.ts:124-176](../src/main/services/nodes/builtin/memoryNodes.ts), rules
  rendered by `renderTablesBlock`, [memoryCore.ts:68-102](../src/main/services/nodes/builtin/memoryCore.ts)) —
  for the Can改 template those rules ARE the AM-code assignment instructions, so imported chronicle
  rows carry 编码索引 with no new code.
- **Per-row keyword entries**: `synthesizeEntries` supports `splitByRow` + keys from the `keywords`
  columns + `injectionTemplate` wrappers ([tableExportService.ts:145-156](../src/main/services/tableExportService.ts)).
- **The catalogue**: the `extraIndex*` path emits the always-on index entry — 概览 + 编码索引 per
  row, wrapped ([tableExportService.ts:171-184](../src/main/services/tableExportService.ts)).
- **Qualification**: `table.export` runs the synthesized entries through the real matcher against
  `gen.scanText` ([tableNodes.ts:162-169](../src/main/services/nodes/builtin/tableNodes.ts)) — the
  last `scan_depth`(3) floors + pending action ([genContext.ts:66-70](../src/main/services/generation/genContext.ts),
  [promptBuilder.ts:327-336](../src/main/services/promptBuilder.ts)).
- **Read query**: `table.query` executes read-only SQL against the sandbox and renders a block
  ([tableNodes.ts:336-365](../src/main/services/nodes/builtin/tableNodes.ts)).
- **Side-call core**: `runLlmCall` / `buildLlmCallConfig` / `presetParamsWithTemperature`
  ([generationNodes.ts:130-206](../src/main/services/nodes/builtin/generationNodes.ts)), transcript
  via `recentTranscript` ([memoryCore.ts:39-58](../src/main/services/nodes/builtin/memoryCore.ts)),
  tag parse via `extractTagAll` ([parseNodes.ts:34-41](../src/main/services/nodes/builtin/parseNodes.ts)).
- **Tail injection**: `prompt.assemble`'s `block` input → system message in the volatile tail, past
  the cache breakpoint ([generationNodes.ts:71-93](../src/main/services/nodes/builtin/generationNodes.ts) →
  [promptBuilder.ts:637-640](../src/main/services/promptBuilder.ts)).
- **Per-node durable state**: `ctx.getNodeState`/`setNodeState`, keyed (chat, workflow, node)
  ([nodes/types.ts:45-48](../src/main/services/nodes/types.ts)).

**The gap, precisely:** with the Can改 template bound, the catalogue injects every turn, but the
per-row `<记忆回溯>` entries are keyed by `AM####` codes that never appear in `gen.scanText` — nothing
in RPT speaks the codes. The chronicle's full memories are today **unreachable**. In shujuku, the
plot-recall planner is the thing that speaks them. This design adds that reader.

## Approach

One consolidated pre-turn node, `memory.recall` (the grep-doc node, upgraded), wired into the
narrator's pre phase (turn-coupled wiring — per CONTEXT.md this is NOT an agent; only the post-turn
maintainers are agents):

```
input.context ──► memory.recall ──block──► prompt.assemble.block
                    (1 side LLM call)
```

Per turn the node:

1. **Builds the catalogue text** — pure helper `renderCatalog(template, reads)` reusing
   `renderIndexLine` over each table's `extraIndex*` config (same rendering as the projected index
   entry), PLUS the notes-file TOC (`parseNotesSections` headings + keyword comments, from the grep
   doc). No bound template and empty notes → **no-op, no model call** (byte-identical when unwired
   or idle).
2. **Makes ONE side LLM call** (`runLlmCall`, `stream:false`, own `api_preset_id`): prompt scaffold
   (a `promptFields` template, default modeled on the preset's stage-3 task, zh) containing the
   recent transcript (`recentTranscript`, default 3 floors — shujuku's `contextTurnCount`), the
   pending user action, the catalogue, and the **previous plan** (see §Plan persistence). The model
   emits:
   - `<Recall>` — codes picked from the catalogue (shujuku contract: only listed codes, comma-split,
     dedup; the prompt links count to narrative weight; **code enforces a hard cap** `max_rows`).
   - `<Query>` — optional grep queries over the notes file (grep-doc mechanism, CJK-safe — see
     Risks).
   - `<QuestPlan>` / `<StoryEngine>` — planner output, treated as opaque text.
3. **Fetches deterministically** (NOT via the lexical matcher — see the deliberate divergence
   below):
   - Codes → rows: run `synthesizeEntries` for the chronicle table(s), keep the split-by-row entries
     whose keys intersect the recalled codes (preserves each card's `injectionTemplate` wrapper,
     e.g. `<记忆回溯>`), capped at `max_rows`. Pure filtering — no SQL is built from LLM output.
   - Queries → note sections via `grepSections` (grep doc).
4. **Composes ONE tail block** from a directive template (config, default modeled on the preset's
   `finalSystemDirective`, minus the stage-1/2 tags): `{{StoryEngine}}`, `{{QuestPlan}}`, the
   recalled row texts, the note hits. Outputs `block` → `prompt.assemble.block` (volatile tail —
   the load-bearing cache rule from the grep doc).
5. **Persists the plan** for the next turn.

### Deliberate divergence: deterministic fetch, not lexical trigger

Shujuku closes the loop by letting the injected codes lexically re-trigger the per-row keyword
entries. RPT should fetch the selected rows directly, because:

- `gen.scanText` is snapshotted at `input.context` — recall output isn't in it, so the lexical path
  would need a new `scan` input on `table.export` plus ordering constraints; direct fetch needs
  neither.
- The Can改 rows' `entryPlacement` is `at_depth_as_system` depth 999 — near the TOP of the
  assembled prompt. Injecting per-turn-varying rows there invalidates the provider prefix cache
  every turn; the `block` tail is cache-correct.
- Determinism: a fetch-by-key is testable and exact; substring keyword matching can over-fire
  (`AM001` is a substring of `AM0012`-style collisions under `String.includes`,
  [lorebookService.ts:93-105](../src/main/services/lorebookService.ts)).

The user-visible result is identical: the N selected memories, in their authored wrappers, reach the
model. (A `scan:Text` input on `table.export` for exact-lexical compat cards is a possible later
increment, not v1.)

### Plan persistence (shujuku: per-message `qrf_plot`)

v1: store `{ floor: gen.floors.length, plan: { questPlan, storyEngine } }` in node state
(`ctx.setNodeState`). On read, drop the stored plan when its `floor` exceeds the current floor count
(rewind makes it stale → start fresh). This is weaker than shujuku's per-message storage (a rewind
to an *earlier-but-nonzero* floor also discards, where shujuku would restore that floor's plan) but
requires no schema change; floor-keyed history is a later increment alongside the notes-file rewind
story.

## Node contract

`memory.recall` (supersedes the grep-doc contract):

- inputs `gen: Context`, `when: Signal`; outputs `block: Text`, `report: Text`, `error: Error`.
  (The grep doc's `entries` output is DROPPED — its own cache rule forbade using it.)
- config: extends `llmCallConfigSchema` + `messages` (promptFields scaffold), `temperature?`,
  `lastNFloors?`(3), `max_rows?`(24), `max_note_sections?`(6), `max_chars?`, `directive?` (the
  composition template), `recall_tables?` (csv of sqlNames to catalogue; default: every table with
  `extraIndexEnabled`).
- Failure = fail-open: on side-call error, emit empty `block` and route `error`; never block the
  turn (matches the table-memory stance).

`notes.maintain` and the notes file/service/IPC/UI are unchanged from the grep doc. The chronicle's
write side needs **no new code** (it is `memory.maintain` + the imported template's rules).

## Ship vehicle

Per the grep-doc review finding: **not a pack** (`BUILTIN_PACKS` was deliberately emptied by ADR
0011 WP6.2 and the pack system is scheduled for removal —
[tableMemoryPack.ts:265-273](../src/main/services/nodes/builtin/tableMemoryPack.ts)). Ship as:

1. The `memory.recall` node in the builtin registry (inert until wired).
2. An **example workflow doc** (`docs/workflows/plot-recall.rptflow`) wiring it into the narrator
   pre-phase, with the maintainer group joining the default doc's `control.mode` free `when4` slot —
   the extension point built for exactly this
   ([defaultMemoryTemplate.ts:27-28](../src/main/services/nodes/builtin/defaultMemoryTemplate.ts)).
3. Optionally later: a module (ADR 0011 sharing unit) with exposed settings (Mode, max_rows, API
   preset).

Turn-parity: an unwired/no-corpus chat must produce a byte-identical prompt — pinned by a
trace-equivalence test in the style of `test/workflow/defaultMemoryTemplate.test.ts`.

## Build order

1. Pure `renderCatalog` (+ share `renderIndexLine`) + code-set row filtering over
   `synthesizeEntries` output + tests (incl. the `AM001`/`AM0012` exact-key case).
2. The grep-doc's `notesGrep.ts` (with the CJK rule below) + `notesMemoryService` — unchanged
   scope, built first since `memory.recall` composes over it.
3. `memory.recall` node (side call + parse + fetch + compose + plan state) + registry + node tests
   (mocked `runLlmCall`: no-op on empty corpus; happy path codes→rows; invented codes dropped;
   cap enforced; stale plan discarded).
4. Directive/prompt default scaffolds (zh, adapted from the preset's stage-3 task +
   `finalSystemDirective` — owner approved re-using the prompt text; adapt `AM`→`MT`, strip the
   stage-1/2 tag references, map `$5`/`$7`/`$8` to RPT slots), plus an RPT-authored chronicle
   table template using `MT####` codes for users without the Can改 card.
5. Example workflow doc + trace-equivalence test.
6. `notes.maintain` + Notes UI tab + i18n (grep-doc scope, unchanged).
7. UI retrofit (owner decision): a memory-code badge on Memory Manager row cards
   (`TableCards.tsx` `RowCard`) and the workspace Tables view, code column derived from
   `exportConfig` (`keywords` column / extraIndex `'both'` column) — plan WP7.

## Verification

- Gate: `npm run typecheck && npm run check:deps && npm run test`.
- End-to-end (manual, in-app): bind `SQL-命定之诗Can改5.9`, let `memory.maintain` fill chronicle
  rows over a few turns, enable the recall workflow, then confirm in the run trace + stored
  `request` log: (a) the recall side call ran pre-turn with the catalogue in its prompt, (b) the
  reply's `<Recall>` codes resolve to those rows' `<记忆回溯>`-wrapped text in the **tail** system
  block, (c) `<QuestPlan>` persists and reappears in the next turn's recall prompt, (d) an
  out-of-catalogue code is silently dropped.

## Risks / open points

- **Pre-turn latency (top risk, inherited).** One side call on the critical path — same stance as
  the grep doc (cheap `api_preset_id`, fail-open, optional cadence). Note shujuku pays THREE
  sequential planner calls here; one is already a 3× improvement on the reference UX.
- **CJK grep (review finding, now binding).** `\b` word-boundary regex never matches adjacent to
  CJK characters; queries and notes are predominantly zh. `grepSections` must fall back to
  substring/plain-regex when the query contains CJK codepoints.
- **Catalogue growth.** Shujuku auto-merges chronicle rows into denser AM rows past a threshold
  (§12); RPT has no merge service. The catalogue (30–60字 × rows) grows linearly — acceptable for
  v1 (hundreds of rows ≈ a few KB), consolidation is a later increment. `max_rows` on the fill side
  (`table.export` row caps) does NOT cap the catalogue — the index is intentionally complete.
- **Code uniqueness is prompt-discipline only.** The fill LLM assigns 编码索引 per the template
  rules; RPT has no renumbering lock (shujuku §12). Duplicate codes → both rows recalled (harmless);
  skipped codes → harmless. No v1 code needed.
- **Directive placement fidelity.** Shujuku wraps the user input inside its directive; RPT's block
  lands as a system message just before the final user action. Close but not identical — validate
  against the real card in the in-app pass before tuning the default directive text.
- **Double-summarization** (inherited): notes + chronicle may overlap; the maintainer prompts must
  keep the corpora disjoint (notes = prose nuance; chronicle = evented记录). Same "pick your memory
  system" surfacing as the grep doc.
