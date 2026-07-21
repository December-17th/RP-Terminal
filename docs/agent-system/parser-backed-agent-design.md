# Parser-backed built-in Agent design

**Status:** DESIGN ONLY — UNAPPROVED. Produced by Milestone 5 of the
[Classic Narrator first execution plan](classic-narrator-first-execution-plan.md). Nothing here is
implemented, registered, or scheduled. No runtime, Agent definition, schema, table, or transport
change accompanies this document. Implementing it requires explicit owner approval (that plan's
Owner gates).
**Date:** 2026-07-19. **Branch:** `agent-system`.
**Reconciles with:** [Agent Runtime design](agent-runtime-design.md) (the Harness Interface and the
"no prompt policy in the Harness" rule) and [agentic mode design](../agentic-mode-design.md) (whose
tool-loop portions are already superseded). `docs/plot-recall-memory-design.md` and
`docs/grep-notes-memory-design.md`, cited by `recallNodes.ts:31` and `notesNodes.ts:22`, DO NOT EXIST
in this repository — those citations are dangling and were not used as evidence.

## The proposed built-in kind

```text
typed input
  -> existing operation prompt builder
  -> one prepared Harness text request (AgentHarness.executePrepared)
  -> existing operation parser
  -> typed parsed result
  -> existing deterministic apply service
```

Tool-less. It does not schedule itself, does not write floors, does not own retries beyond a
demonstrated parser-correction need, and adds no registry, adapter layer, or graph.

The governing rule is the plan's: **a candidate whose real trigger, real parser, and real
deterministic apply service cannot all be named in the code is DEFERRED.** Availability in the node
palette, a shipped `.rptflow` example, mock coverage, or historical design prose does not establish a
Classic requirement.

## 1. Consumer / trigger matrix

| Candidate | Node type | Real production trigger | Frequency | Sync / detached | Reachable today? |
| --- | --- | --- | --- | --- | --- |
| Plot recall / planning | `memory.recall` (`recallNodes.ts:267`) | **None.** Not in `buildDefaultMemoryDocV2` (`defaultMemoryTemplate.ts:255-394`), not in `BUILTIN_PACKS` (`tableMemoryPack.ts`), not in `asyncMemoryPack.ts`. Only a hand-wired doc or a manual import of `docs/workflows/plot-recall.rptflow`. | Never, by default | Would be sync pre-phase | **No** |
| Memory recall into the prompt (deterministic) | `table.export` (`tableNodes.ts:164`) | Classic turn, stage 3 (`classicTurn.ts:169`) | Every turn | Synchronous | Yes — and it is **not model-backed** |
| Memory maintenance (SQL tables) | `memory.maintain` (`memoryNodes.ts:141`) | `trigger.cadence everyNFloors: 3` or `trigger.state summary.unprocessed >= 6` → `control.mode.fired` (`defaultMemoryTemplate.ts:279-307,370`), evaluated by `evaluateDocTriggers` (`generationService.ts:237` → `headlessRunService.ts:720`) | At most every 3rd turn commit, further gated by `dueTables` (`memoryNodes.ts:173`) | **Detached** — fire-and-forget off the trace promise, never on the turn's critical path | Yes |
| Notes maintenance | `notes.maintain` (`notesNodes.ts:160`) | **None.** Absent from the seeded doc and both builtin packs. | Never, by default | — | **No** |
| Table backfill (fill) | *no node* — `tableBackfillService.startBackfill:159` | User action: IPC `table-backfill-start` (`tableMemoryIpc.ts:366`) | On demand only | Detached background run | Yes, as a plain service |
| Table refill | *no node* — `tableRefillService.startRefill` | User action: IPC `chat-tables-refill` (`tableMemoryIpc.ts:121`); also the retired "maintain now" entry (`tableMaintainNow.ts:10-13`) | On demand only | Detached, chunk-committed, resumable | Yes, as a plain service |

Two facts fall out of this table and drive everything below.

**Milestone 2's `memory.maintain` finding generalizes.** No model-backed memory operation runs inside
a Classic turn. `classicTurn.ts:52` executes exactly `ctx, trim, export, assemble, llm, parse, apply,
write`; the whole memory group is trigger-rooted and therefore excluded from the turn phase
(`triggerNodes.ts:22-27`, `classicTurn.ts:80-86` synthesizes its post traces as permanently
`skipped`). The one memory operation on the turn path — `table.export` — has no model call at all.

**Two of the four named candidates have no production trigger whatsoever.** `memory.recall` and
`notes.maintain` are palette nodes with tests and a shipped example file, and nothing instantiates
them for a default user.

## 2. Exact inputs and parsed outputs

Named from the code, not invented.

### 2.1 `memory.maintain`

- **Input:** `GenContext` (`generation/types.ts`), the bound `TableTemplate`
  (`memoryCore.chatTemplate:27`), the due `string[]` of `sqlName`s (`memoryCore.dueTables:157`), the
  captured `transcriptEpoch(chatId)` (`memoryNodes.ts:180`), and `MemoryMaintainConfig`
  (`memoryNodes.ts:62-79`).
- **Prompt builder:** `composeMaintainerMessages(gen, template, cfg, { scopeDirective })`
  (`memoryNodes.ts:101`) → `ChatMessage[]`, already `providerShape`d (`memoryNodes.ts:138`). Shared
  verbatim with the panel preview IPC `memory-maintain-preview` (`tableMemoryIpc.ts:92`).
- **Parser:** `extractTagAll(raw, 'TableEdit')` (`parseNodes.ts:34`) → `string[]`.
- **Typed parsed result:** the three-way discrimination the node already performs
  (`memoryNodes.ts:216-232`) — `no-tag` (malformed) / `empty-tag` (compliant "no changes") /
  `sql: string`. This is the honest typed output; it is a discriminated union of three cases, not a
  string.
- **Apply service:** `memoryCore.applyTableEdit` (`memoryCore.ts:218`) → `ApplyTableEditResult`
  (`memoryCore.ts:187`), plus `advanceProgress` (`tableProgressService`) on the empty-tag branch.

### 2.2 `memory.recall` (design recorded for completeness; deferred in §8)

- **Input:** `GenContext`, narrowed `TableTemplate`, `TableRead[]` (`tableDbService.readAllTables`),
  the notes file (`notesMemoryService.readNotes`), and the previous `RecallPlanState`
  (`recallNodes.ts:115`).
- **Prompt builder:** `composeRecallMessages` (`recallNodes.ts:238`).
- **Parser:** `extractTagAll` over four tag families — `Recall`, `Query`, `QuestPlan`, `StoryEngine`
  (`recallNodes.ts:362-367`) — plus `parseCodes` (`recallNodes.ts:168`).
- **Typed parsed result:** `{ codes: string[]; queries: string[]; questPlan: string; storyEngine: string }`.
- **Deterministic post-processing (real services):** `synthesizeEntries` + `filterEntriesByCodes`
  (`tableExportService`), `parseNotesSections` / `grepSections` / `formatHits`
  (`shared/memory/notesGrep`).
- **Apply service: none.** Recall's product is a prompt fragment returned on a port, consumed by an
  edge into `prompt.assemble`'s `block` input. The only durable write is `plot_block`, which reaches
  the DB through `output.writeFloor`'s optional `plot_block` input
  (`generationNodes.ts:415-431`) → `persistFloor` (`persistFloor.ts:28,51`). That is a *floor write*,
  which the proposed kind explicitly must not own.

### 2.3 Backfill / refill

- **Input:** `GenContext`, `TableTemplate`, `FloorFile[]`, a `BatchSpan`
  (`tableBackfillService.planBatches:76`), and per-run options from the IPC payload.
- **Prompt builders:** `backfillMaintainerPrompt` (`tableMaintenance.ts:151`) and
  `refillMaintainerPrompt` (`tableMaintenance.ts:107`), both over `composeTablesBlock`
  (`tableMaintenance.ts:71`) and `buildBatchTranscript` (`tableBackfillService.ts:97`). Both produce
  a **single `system` message** (`tableBackfillService.ts:318`, `tableRefillService.ts:836`).
- **Parser:** `extractTagAll(raw, 'TableEdit')` — the same one — inside
  `runMaintainerBatch` (`tableMaintainerLoop.ts:55,73`).
- **Apply services:** backfill → `applyBatch` against the live sandbox with progress advance;
  refill → `validateBatch` + `partitionBySelected` + `applySqlBatchAt(shadow, …)` then a chunk
  commit (`tableRefillService.ts:840-860`).

## 3. Reachable parser failures

`extractTagAll` (`parseNodes.ts:34`) is a total function: a non-greedy, dotall, case-insensitive
regex over `<tag>…</tag>`. It never throws. `extractTagAllWithAttrs` (`parseNodes.ts:63`) is likewise
total and its attribute segment forbids `<`/`>` so an unclosed tag cannot swallow the document.

**Reachable in practice:**

1. **No `<TableEdit>` tag at all.** Observed often enough that `memoryNodes.ts:216-219` carries a
   dedicated branch and a distinct report string, and the node defaults `retries` to 5 because "memory
   fills are side calls prone to transient empty streams" (`memoryNodes.ts:201-204`). Handling:
   report, do not apply, do not advance the pointer.
2. **Empty `<TableEdit></TableEdit>`.** A compliant reply under maintainer rule 4
   (`defaultMemoryTemplate.ts:55`). Must be distinguished from case 1 — it *must* advance pointers or
   the due tables burn a model call every turn (`memoryNodes.ts:222-232`). `extractTagAll` returns
   `['']` here and `[]` for case 1; that single distinction is load-bearing.
3. **Syntactically valid tag, invalid SQL.** Reaches `applySqlBatch`, throws `TableSqlError`, and is
   re-raised as class-B `bad-sql` (`memoryCore.ts:301-303`). In backfill/refill this is the *only*
   demonstrated parser-correction need in the codebase: `runMaintainerBatch`
   (`tableMaintainerLoop.ts:47-76`) feeds the failed reply plus the error back as a corrective user
   turn (`correctiveMessage`, `tableMaintainerLoop.ts:16`) up to `retries` times. `memory.maintain`
   does **not** do this — it fails the pass.
4. **Out-of-scope statements.** The model writes tables it was told not to; dropped deterministically
   by `partitionBySelected` (`memoryCore.ts:256-261`) and counted.
5. **Abort with empty text.** `runLlmCall` returns `null` (`generationNodes.ts:245`) and every caller
   short-circuits before parsing.

**Hypothetical, not reachable:** parser exceptions (both extractors are total), nested/interleaved
tag recovery, partial-tag repair, and any "parser framework" error taxonomy. There is no evidence of
malformed-but-recoverable tag structure in production; the observed failure is *absent* or
*semantically wrong* output, not *unparseable* output.

**Consequence for the design:** the proposed kind needs exactly one retry affordance — the SQL-error
corrective re-ask of case 3, which already exists as a 30-line service. It needs no validator
framework beyond `resilientCall`'s existing `validator` field (`resilientCall.ts:29`).

## 4. Side-effect boundary

What the deterministic apply service writes, and what must therefore stay outside the Agent:

| Writer | Writes | Must stay outside the Agent? |
| --- | --- | --- |
| `applyTableEdit` (`memoryCore.ts:218`) | table sandbox rows via `applySqlBatch`; the floor-keyed op log via `appendOps` (`memoryCore.ts:288`); the chat-level progress pointer via `advanceProgress` (`memoryCore.ts:298`) | Yes — it is the apply service, invoked *after* the Agent returns |
| write guard | `tryBeginTableWrite` / `endTableWrite` per chat (`memoryCore.ts:240,305`) | Yes — a lease, not Agent state |
| staleness fence | reads `transcriptEpoch(chatId)`, drops the batch if it moved (`memoryCore.ts:245-250`, captured at `memoryNodes.ts:180`) | Yes — it must bracket compose→apply, which spans the Agent call |
| `persistFloor` (`persistFloor.ts:18`) | the `FloorFile` incl. `plot_block`, globals, execution record | **Yes, absolutely** — the proposed kind must not write floors |
| `writeNotes` (`notesMemoryService`) | the per-chat notes markdown | Yes |
| refill | temp shadow DB, `table_ops` rows, chunk commit, `publishShadow` (`tableRefillService.ts`) | Yes — and its guard heartbeat (`tableRefillService.ts:806`) must not become Agent lifecycle |

The Agent's own writes must be **none**. Its output is a typed parsed value. Everything in the table
above is already a callable service today; none of it needs to move.

Two things that look like Agent state but are not:

- `ctx.getNodeState` / `setNodeState` plan persistence (`recallNodes.ts:310,416`). In the headless doc
  path these are **stubbed to no-ops** (`headlessRunService.ts:828-829`), so any candidate relying on
  them is silently stateless when triggered.
- `gen.workingVars` mutation by reference (`classicTurn.ts:35-39`). No memory candidate touches it;
  the Agent must not either.

## 5. Response-ready ordering and cancellation

`onResponseReady` fires at `classicTurn.ts:262`, after `persistFloor` and before the floor returns to
the renderer. Everything the plan calls a candidate sits **after** that instant:

```text
persistFloor -> onResponseReady (user sees the reply)
             -> [detached] summarizeRun / appendRun
             -> [detached] evaluateTriggers        (pack path)
             -> [detached] evaluateDocTriggers     (memory.maintain's only door)
```

(`generationService.ts:197-238`.)

The one candidate that would run *before* the user sees the response is `memory.recall` — it is a
pre-phase ancestor of assembly and adds a full serial model call to time-to-first-token. That cost is
currently paid by nobody, because nothing triggers it (§1).

**Cancellation, as it actually is today:**

- The turn has a two-signal split (stream abort vs graph abort — `classicTurn.ts:42-43`).
- The headless doc run creates its own `AbortController` at `headlessRunService.ts:799` and **never
  aborts it.** There is no user-facing cancel for `memory.maintain`. A user Stop does not reach it; app
  close does not reach it. Milestone 4's `hasActiveBackgroundWork` warning exists precisely because
  this work cannot be cancelled, only discarded.
- Backfill and refill *do* have explicit cancels (`table-backfill-cancel`, `chat-tables-refill-cancel`)
  and honour `signal.aborted` mid-batch (`tableMaintainerLoop.ts:59`, `tableRefillService.ts:864`).

**What the design requires:** a converted Agent must accept a caller-supplied `AbortSignal` and must
not create its own. It must not extend cancellation semantics — inventing a cancel for
`memory.maintain` is a behavior change requiring the owner gate on "deleting or changing existing
post-response memory behavior", not a side effect of a conversion.

## 6. Node migration / deletion map

| Node | Disposition | Evidence |
| --- | --- | --- |
| `memory.maintain` (`memoryNodes.ts:141`) | **CONVERT** — the only candidate with all three paths | Trigger: `defaultMemoryTemplate.ts:370` via `evaluateDocTriggers`. Prompt builder: `composeMaintainerMessages:101`. Parser: `extractTagAll(…,'TableEdit')`. Apply: `applyTableEdit:218`. |
| `memory.recall` (`recallNodes.ts:267`) | **DEFER** | No production trigger; no apply service — its only durable write is a floor field the kind may not own (§2.2). |
| `notes.maintain` (`notesNodes.ts:160`) | **DEFER** | Prompt builder, parser (`parseMemoryNotes:145`), and apply (`mergeNotes` + `writeNotes:205`) all exist and are real — but no production trigger names it. Trigger missing ⇒ deferred by rule. |
| `table.gate` (`tableNodes.ts:220`) | **REMOVE with its tests** | Superseded by `memory.maintain`'s inline `dueTables` gate (`memoryNodes.ts:173`); absent from the seeded default v2 and retained only in v1 and the packs (`tableNodes.ts:44-49` records the supersession). |
| `table.read` (`tableNodes.ts:302`) | **COLLAPSE** into `memoryCore.renderTablesBlock` | It is already a one-call delegation to that service (`tableNodes.ts:324`). |
| `table.apply` (`tableNodes.ts:54`) | **COLLAPSE** into `memoryCore.applyTableEdit` | Already a thin wrapper (`tableNodes.ts:86`); the only difference from `memory.maintain`'s use is the no-template policy (class-B vs silent). |
| `table.export` (`tableNodes.ts:164`) | **KEEP as the service `exportTableEntries`** | Already extracted for exactly this reason (`tableNodes.ts:124-127`) and already called directly by `classicTurn.ts:169`. Not model-backed ⇒ never an Agent. |
| `table.query` (`tableNodes.ts:344`) | **DEFER / candidate REMOVE** | No production consumer found; described as serving "planner / 剧情推进 branches", i.e. the deferred recall path. |
| `parse.extract` (`parseNodes.ts:112`) | **COLLAPSE** into `extractTagAll` | The node is a wrapper over the pure extractor plus a `found` signal; in the v2 default it no longer appears. |
| `agent.llm` (`agentNodes.ts`) | **Defer to Milestone 6** | Only the v1 default and the packs instantiate it; disposition depends on the pack decision, not on this design. |
| Backfill / refill | **No node exists — keep as services** | They already bypass the node system entirely (`tableMaintainerLoop.ts:33` calls `callModelResilient` directly). |

## 7. Collapse or remove rather than convert

Stated plainly, because it is the largest finding here: **most of the memory node surface is wrapper,
not behavior.** `table.read`, `table.apply`, `parse.extract`, and `table.export` each delegate to a
service that already exists and is already called from at least one non-node path. Converting them to
Agents would preserve the wrapper and add an Agent definition on top. Collapsing them deletes the
wrapper and keeps the service. `table.gate` is superseded outright.

Only one candidate is genuinely a *model-backed operation* that a built-in Agent could own end to
end: `memory.maintain`.

## 8. DEFERRED list, with the missing path named

| Candidate | Missing path |
| --- | --- |
| Plot recall / planning (`memory.recall`) | **Trigger and apply service.** No seeded doc or builtin pack instantiates it (`defaultMemoryTemplate.ts`, `tableMemoryPack.ts`, `asyncMemoryPack.ts`); `classicTurn.ts:183` passes `undefined` for the assemble `block` the node would fill. Its only durable output is `plot_block` via `persistFloor` — a floor write the proposed kind may not own. |
| Notes maintenance (`notes.maintain`) | **Trigger.** Builder, parser, and apply all exist; nothing fires it in production. |
| Table refill | **Node, and a reason.** There is no refill node; `tableRefillService` is already a service with its own prompt builder, the shared parser, its own apply, its own guard heartbeat, resumable chunk commits, and a real cancel. Wrapping it in an Agent adds a layer and buys nothing. |
| Table backfill | **Node, same reasoning.** `tableBackfillService` is user-initiated and already service-shaped. |
| `table.query` | **Consumer.** Its documented consumer is the deferred recall/planner branch. |

If plot recall is ever wanted in Classic, the honest sequence is: decide it is a product requirement,
wire a trigger, and only then revisit conversion. Building an Agent for it now would be building the
missing pieces under the cover of a conversion — exactly what the plan's central rule forbids.

## 9. What this design would delete, keep, and risk

**Delete** (only on approval): the `table.gate` node and its tests; the `table.read`, `table.apply`,
and `parse.extract` node wrappers, their config schemas, port declarations, and registry entries;
`memory.maintain`'s node scaffolding (config schema, ports, fail-policy plumbing) once its body is an
Agent. That is node surface, not behavior.

**Keep:** every service the wrappers call — `applyTableEdit`, `renderTablesBlock`,
`exportTableEntries`, `extractTagAll`, `dueTables`, `advanceProgress`, `transcriptEpoch`,
`tableMaintainerLoop`, `tableBackfillService`, `tableRefillService`, `persistFloor`. Keep exact
request/response evidence. Keep `memory.maintain`'s three-way tag discrimination verbatim; it is the
subtlest correctness detail in the whole area.

**Risks the owner should weigh:**

1. **The `memory.maintain` trigger lives in a user-editable doc.** Its cadence, mode, and API preset
   are exposed group settings (`defaultMemoryTemplate.ts:379-384`). Converting the node to an Agent
   removes the thing those settings are attached to. Either the doc keeps a node-shaped placeholder
   that invokes the Agent — which is the node-adapter framework the plan rejects — or the settings
   move to a new surface, which is a UX change, not a conversion. **This is the single hardest
   problem in the conversion and it has no clean answer inside Milestone 5's boundary.**
2. **The empty-tag / no-tag distinction is easy to lose.** Collapsing the parser to
   `extractTagAll(...).join('\n').trim()` — which is what `tableMaintainerLoop.ts:55` already does —
   erases it. If that shape is adopted for `memory.maintain`, due tables burn a model call every
   cadence window forever. Silent, expensive, and invisible in tests that only assert "applied N".
3. **Two live consumers share `composeMaintainerMessages`:** the node and the preview IPC
   (`tableMemoryIpc.ts:92`). The preview must keep showing exactly what a run sends.
4. **`memory.maintain` cannot be cancelled today.** Converting it must not quietly acquire a cancel,
   and must not quietly lose the staleness fence that stands in for one.
5. **Deleting `table.apply` / `table.read` / `table.gate` breaks any user-saved doc that wires them,
   and both builtin packs.** `isClassicDirectShape` fails closed for edited docs
   (`classicShape.ts:95`), so those users are on `runWorkflow` — which is the path the deletion
   removes nodes from. This is a migration question, not a refactor.

**What Milestone 6 would then have to live with:** if this design is approved, exactly one Agent
(memory maintenance) becomes the second production Harness consumer, and the audit's Keep/Collapse/
Remove classification for `agent.llm`, `parse.extract`, and the two builtin packs is entangled with
risk 5 above. If it is rejected or trimmed to §7's collapse-only subset, Milestone 6 inherits a
smaller node surface and a Harness with exactly one real consumer — Classic — which is a weaker but
more honest basis for deletion. The collapse-only subset is available without the Agent conversion
and carries none of risk 1.

## 10. Explicitly rejected in this design

Per the plan's reviewer-reject criteria, this design contains no generic tool framework, no
node-adapter framework, no graph framework, and no parser framework. Where a candidate started to
require one — recall's absent apply service, refill's already-complete service shape, the
`memory.maintain` exposed-settings problem in risk 1 — the response is deferral or collapse, not an
abstraction.
