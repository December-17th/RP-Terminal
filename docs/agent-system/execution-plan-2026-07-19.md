# Agent System execution plan v2

**Status:** Point-in-time plan, drafted 2026-07-19 on `agent-system` (33 commits ahead of `main`,
head `ef8ab9f`, gate green at 4322 tests). Supersedes the **remaining sessions (8, 9, 11, 12)** of the
[implementation plan](implementation-plan.md) and closes out the
[Classic Narrator first execution plan](classic-narrator-first-execution-plan.md), whose six
milestones have all landed. Sessions 0–7 and 10 of the original plan, and ADR
[0020](../adr/0020-agent-runtime-replaces-workflow-system.md) /
[0021](../adr/0021-agents-assemble-prompts-through-the-existing-engine.md), are the baseline this
plan starts from — none of that work is re-planned here.

Milestone 1's decision package requires owner sign-off before Milestones 3–5 start. Milestones 0 and
2 need no new approval.

## 1. Audit — what is actually true on the branch today

### 1.1 Implemented and committed

- **Runtime (Sessions 0–7):** contracts, ProviderDispatch, AgentHarness (`execute` +
  `executePrepared`), AgentCatalog, AgentRunStore, FloorState journal/replay, InvocationRuntime
  (lanes, plans, coalescing, deletion, barriers), card `rpt.agents` API at inline/WCV parity.
- **Classic Narrator plan M1–M6:** the `executePrepared` seam inside `callModelResilient`; the
  turn-dependency characterization; the **two-path** direct Classic orchestration
  (`generation/classicTurn.ts` behind the `classicShape` predicate, `runWorkflow` fallback for
  edited docs and open pack gates); the active-work exit guard; the
  [parser-backed design](parser-backed-agent-design.md) (design only, unapproved); the
  [debloat audit](debloat-audit.md) (decision-support, owner deferred).
- **Session 10 Agent Workspace** (`9036935` + follow-ups): AgentsPanel, AgentEditor,
  AgentPlanEditor, run list/detail with cancel, folder-scan import of `.rptagent` files with
  hash-versioned upgrade and edit-conflict handling (`agentFolder.ts`, `agentCatalogIpc.ts`).
- **ADR 0021, fully implemented:** every Agent prompt renders through the template engine; a
  `preset` bundle turns on full `assemblePrompt` assembly against the owning floor's `GenContext`;
  parameter precedence gains one bundle layer; assembly failure is fail-open but **visible**
  (Run Record warning + "Degraded" badge); guaranteed-inert envelopes are rejected at save time
  (`shared/agentPresetEnvelope.ts`).
- **Two real converted Agents** (`test-agents/*.rptagent`, from the shujuku 命定之诗 plot preset)
  exercising the runtime end to end — via manual **Run now** only.

### 1.2 Facts that have changed under the standing documents

These are the load-bearing findings; each invalidates something a standing doc still asserts.

1. **The debloat audit's governing premise is stale.** The audit's one governing sentence was
   "Classic reaches exactly one entry point — `executePrepared` — and everything else is reached
   only from card-facing IPC or tests," which made "does the card Agent API stay?" the single
   decision. That is no longer true: the Workspace's Run now calls `invocationRuntime().run(...)`
   from `agentCatalogIpc.ts:333`, and preset Agents run the **full `execute` path** (tools, retries,
   Result Contract — ADR 0021 routed them through `execute` deliberately). `AgentHarness.execute`,
   `InvocationRuntime`, `HarnessRunAdapter`, `AgentRunStore`'s writer, `FloorState.incorporateAgent`,
   and `ProviderDispatch.resolve` all have production consumers now. **Branch B (delete ~9,300
   lines) is dead.** The still-genuinely-unreached surface has shrunk to: the card channels
   (`CARD_AGENT_CHANNELS` / WCV twins / preload / bridge / host facets), `runPlan`
   (`agentRunIpc.ts:203`, `wcvIpc.ts:520` — card-only; the Plan editor authors/exports JSON, it does
   not run it), the tool registries (no tool user), and the next-turn barrier
   (`InvocationRuntime.waitForNextTurnBarriers` has no production caller).
2. **The trigger gap is now the product-critical hole.** Design §11 says RPT owns no scheduler;
   cards observe variables and invoke Agents. But the card API is unshipped and its shipping is
   owner-deferred, so **the only way any Agent runs today is a manual click**.
   `character-progression.rptagent` declares `blocksNextTurn: true` and the flag is recorded,
   displayed, and inert (`test-agents/README.md` documents this honestly). An imported progression
   Agent that cannot fire is a demo, not a feature.
3. **Session 9 (Yuzu Scene Director) is obsolete as written.** After ADR 0008/0019, Yuzu rides the
   Classic pipeline: `vnMode` is resolved in `generation/genContext.ts:44` and applied inside
   `assemble.ts` (overlay at `:185`, token budget at `:324`) — both of which the direct
   `classicTurn` path already uses. There is no separate Yuzu generation path left to cut over. What
   remains of Session 9 is verification plus a decision about whether a distinct
   `yuzu.sceneDirector` role should exist at all.
4. **The builtin catalog rows are decoys, and now user-visible ones.** `CLASSIC_NARRATOR` and
   `YUZU_SCENE_DIRECTOR` are seeded into every profile, undeletable (`SOURCE_BACKED`), role-bound
   under a DB `CHECK` constraint — and Classic does not read them (its prompt comes from
   `classicTurn.ts`). Since Session 10 they are displayed in the Workspace as if they were the
   production configuration. The audit rated resolving them **High** risk (migration + possible
   table rebuild); leaving them is now actively misleading in the UI.
5. **Workflow deletion (Session 11) has three unresolved prerequisites**, none of which the original
   session text accounts for: (a) `memory.maintain` — the only production automatic model-backed
   operation — is triggered by `trigger.cadence`/`trigger.state` nodes in the user-editable doc via
   `evaluateDocTriggers`; deleting the doc orphans it, and the parser-backed design calls the
   re-homing of its cadence settings "the single hardest problem in the conversion." (b) Edited
   docs and open pack gates route real users through `runWorkflow` (the `classicShape` predicate
   fails closed), so deletion is a behavior change for them, not a cleanup. (c) Card `workflows[]`
   import is still live.
6. **Status headers were stale** (design doc claimed Sessions 7–12 unimplemented; the plan claimed
   Session 10 in progress). Corrected 2026-07-19 alongside this plan. The design doc's §3/§10 have
   not yet been reconciled with ADR 0021's prompt/preset model.
7. **The renderer has no mount-level test seam.** `2ce4277` fixed a whole-app blank screen
   (AgentRunActivity on session entry) that shipped past a fully green gate. Every Workspace
   milestone below inherits this risk until a smoke-mount seam exists.
8. **Pending Floor was never built** (Session 8's residue). The direct Classic path commits through
   the existing `persistFloor` transaction. Nothing currently motivating it has surfaced; it stays
   deferred rather than being carried as fake scope.

## 2. Design review — what should change

**Reframe the governing decision.** "Does the card Agent API stay?" was the right question when the
runtime's only consumers were hypothetical cards. The Workspace ended that. The question that now
governs the remaining work is: **what triggers an Agent?** Everything still blocked — the progression
Agents being real, the `memory.maintain` conversion, `blocksNextTurn`, workflow deletion, and (as a
dependent, not a driver) the card API — hangs off that one answer.

**Recommended answer: a minimal declarative commit-boundary trigger, owned by the Agent Runtime.**
An optional `trigger` on the effective definition / role binding, of exactly one kind:
`onFloorCommitted` with an `everyNFloors` cadence (and, only if the memory conversion demonstrates
the need, the existing unprocessed-count condition as a second predicate). Evaluated only when a new
floor commits — the same boundary ADR 0004 already fixed for workflow triggers — with no timers, no
variable watching, no cron. Rationale:

- It is **required anyway**: the `memory.maintain` conversion has no home for its cadence settings
  once the doc dies (parser-backed design, risk 1). A definition-level trigger *is* that home, and
  dissolves the "hardest problem" without a node-adapter framework.
- It makes imported Agents real **without** coupling their fate to the card-API ship decision.
  Card-owned scheduling remains the designed path for *variable-predicate* triggers (month
  boundaries, quest states) exactly as design §11 says — cadence is the only piece RPT takes, and it
  is calendar-free.
- It honors ADR 0004's boundary rule and the design's "deliberately does less" stance. This is not
  a scheduler; it is one predicate at one existing event.

**Secondary design corrections:**

- **No inert contract fields.** `blocksNextTurn` must either be wired (the barrier exists;
  generation must await `waitForNextTurnBarriers` before resolving Narrator input) or removed from
  the accepted schema until it is. The same lesson as `ef8ab9f`: degraded or dormant behavior must
  be visible, not plausible. Wiring requires an owner policy: does a failed required Agent block the
  turn (fail-closed) or release it without the result (fail-open, warned)?
- **Retire Session 9; keep the role question.** Yuzu needs a characterization test proving vnMode
  parity through the direct path, and a decision to either drop the `yuzu.sceneDirector` role
  concept or leave it bound to the future. No new execution path.
- **Resolve the decoys with the deletion milestone, not before.** The builtin-rows migration and the
  `CHECK` constraint decision belong with the catalog/role rework that deletion forces anyway;
  doing it twice would mean two migrations. Interim mitigation is cheap: label the two rows in the
  Workspace as placeholders not yet used by generation.
- **Deletion becomes a migration project, not a directory removal.** Session 11's inventory and
  removal searches remain valid, but the session must be re-scoped around the three prerequisites in
  §1.2.5 and an explicit policy for edited-doc users.
- **Add the missing test seam** before more Workspace surface lands: one smoke-mount test that
  renders the app shell with a chat open and the Workspace routes reachable, so a top-level render
  crash fails the gate.

## 3. Decisions required (Milestone 1 package)

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Trigger surface | (a) declarative commit-boundary cadence in RPT + card scheduling later; (b) ship the card API now and keep RPT trigger-free; (c) manual only | **(a)** — see §2 |
| D2 | Card `rpt.agents` API | ship next release / hold dormant / delete the card channels only | **hold** — it no longer blocks anything, costs nothing (audit: restorable, zero compat risk), and D1(a) removes the pressure to ship it half-baked |
| D3 | `memory.maintain` conversion | approve parser-backed CONVERT (+ the collapse-only subset) / collapse-only / neither | **approve both** — it is the second real Harness consumer and the deletion prerequisite; the collapse-only subset (`table.gate` remove; `table.read`/`table.apply`/`parse.extract` collapse) is safe under any branch |
| D4 | Workflow deletion policy | for edited docs and pack gates: hard cutover to the fixed pipeline (accept behavior change, documented) vs. any preservation mechanism | **hard cutover** — ADR 0020 already forbids converters and dual runtimes; preserving edited-doc semantics would rebuild the engine |
| D5 | `blocksNextTurn` failure policy | fail-closed (block the turn) / fail-open with visible warning | **fail-open, warned** — consistent with ADR 0021's degraded-run stance; a lost progression beat is recoverable, a hung turn is not |
| D6 | Builtin decoy rows | migrate away with the D4 catalog rework / keep as real config by making Classic read them | **migrate away in M5** — making Classic read the catalog is a second cutover with no user benefit yet |

## 4. Milestones

Delivery rules, gates (`typecheck`, `check:deps`, `test`, `check:docs` vs. the 61-broken-link
baseline), and the one-module-per-change rule from the implementation plan §1 all carry over
unchanged. Each milestone ends with an implementation-log entry in this file.

### M0 — Truth and reconciliation (docs only, no approval needed)

- Reconcile `agent-runtime-design.md` §3 (AgentDefinition) and §10 (portability) with ADR 0021's
  `prompt`/`preset` model; correct its status header (done 2026-07-19).
- Mark implementation-plan Sessions 8, 9, 11, 12 as superseded by this plan (done 2026-07-19).
- Verify `docs/sdk/` and `docs/rpt-api.md` against the Session 7 card surface and the Session 10
  import format: `rpt.agents.*`, `.rptagent` (`format: "rpt-agent"`), and the scan-folder flow must
  be documented or explicitly marked unshipped. `docs/sdk/README.md`'s mapping decides the exact
  files.
- Exit: no standing doc asserts a stale governing fact from §1.2.

### M1 — Decision package to the owner

- Present §3 with the audit evidence behind each row (this file is the package; a grilling pass on
  D1/D4 is worthwhile before sign-off).
- Exit: D1–D6 each have a recorded owner answer; answers gate M3–M5 scope below. If an answer
  contradicts a recommendation, this plan's affected milestone is re-scoped before it starts,
  not improvised during it.

### M2 — Workspace hardening (no approval needed; parallel with M1)

- Add the smoke-mount renderer test seam (§2, last bullet): app shell + open chat + Agents panel +
  Workspace popup render without throwing, under the real store wiring. This is the regression net
  for the `2ce4277` class of failure.
- Sweep the Session 10 exit checklist against what shipped and close the genuine gaps (candidates
  from the original session text: diff/restore surfaces beyond the scan-conflict flow, role-binding
  replacement before disable/delete, keyboard navigation). Verify rather than assume — some of this
  landed in `429090f`/`ef8ab9f`.
- Confirm every Workspace string routes through `t()` with keys in both locales (the panel added
  ~133 keys each; the check is for stragglers in later fixes).
- Exit: gate green including the new smoke seam; Session 10 marked complete in this log.

### M3 — Trigger runtime and barrier wiring (gated on D1, D5)

Scope assuming D1(a), D5 fail-open:

- Add the optional `trigger` block (`onFloorCommitted` + `everyNFloors`) to `AgentContracts` schema,
  the effective-definition calculation, and the editor. Reject any other trigger kind at parse time.
- Evaluate triggers in main at the same commit boundary that emits `emitCardFloorCommitted`
  (`chatService.ts` — single emit site, `isNewFloor`-guarded), dispatching through the existing
  `invocationRuntime().run` identity path so coalescing, lanes, and floor ownership apply unchanged.
  Replay and re-incorporation must not fire triggers (same invariant the card event already keeps).
- Wire `blocksNextTurn`: the Classic direct path awaits `waitForNextTurnBarriers(chatId)` before
  resolving Narrator input; a failed required Agent releases the barrier with a visible warning on
  the turn (D5). The workflow fallback path is deliberately **not** wired — it predates the feature
  and dies in M5.
- Tests: cadence fires on the Nth commit and not on replay; duplicate coalescing across
  trigger+manual; barrier blocks/releases/fails per policy; Stop during a barrier; exit-guard signal
  covers triggered runs (it already reads `InvocationRuntime.hasActiveWork`).
- Exit: an imported `.rptagent` with a cadence runs unattended; `blocksNextTurn` is live or the
  field is gone; no timers, no variable watching anywhere in the diff.

### M4 — memory.maintain becomes a built-in Agent (gated on D3)

- Implement parser-backed CONVERT per the approved design §6, with its non-negotiables: the
  three-way `no-tag`/`empty-tag`/`sql` discrimination preserved verbatim; caller-supplied
  `AbortSignal` only, no new cancel semantics; the staleness fence (`transcriptEpoch`) bracketing
  compose→apply; `composeMaintainerMessages` staying shared with the preview IPC byte-for-byte.
- Re-home the cadence/mode/preset settings onto the built-in Agent's definition + role binding
  (M3's trigger is the cadence home); the memory panel's settings UI reads/writes those instead of
  doc group settings.
- Land the collapse-only subset in a separate commit: remove `table.gate`, collapse
  `table.read`/`table.apply`/`parse.extract` wrappers onto their services. Both builtin packs and
  saved docs still reference these until M5 — so this commit only lands **with or after** the M5
  routing decision is fixed, or scoped to leave registry entries as thin deprecated stubs until M5.
  Sequence this at execution time; do not let it fork the doc-trigger path into two behaviors.
- Exit: the default profile's memory maintenance runs through `AgentHarness.execute` with a Run
  Record; `evaluateDocTriggers` no longer fires it; due-table pointer semantics proven by a test
  that distinguishes empty-tag from no-tag outcomes.

### M5 — Single-path Classic and workflow deletion (gated on D4, D6; the old Session 11)

- Remove the `classicShape` predicate and the `runWorkflow` fallback: every Classic turn takes the
  direct path. Edited-doc users cut over hard (D4); release notes name the change.
- Delete the workflow surface per the original Session 11 inventory (engine, nodes, canvas, packs,
  formats, IPC, stores, `@xyflow/react`, `workflows[]` import) with its removal searches as the
  acceptance check. Legacy data stays inert on disk.
- Builtin decoy migration (D6): unbind and delete the two seeded rows via a migration path that
  bypasses `SOURCE_BACKED`, and settle the `role` `CHECK` constraint (`db.ts:84`) and
  `character.ts` role-recommendation schema in the same change. Test against a profile fixture that
  already holds the seeded rows — a fresh profile cannot reproduce the orphan case.
- Yuzu verification (old Session 9 residue): characterization test for vnMode overlay/token-budget
  parity through the direct path; drop or explicitly defer the `yuzu.sceneDirector` role.
- Exit: original Session 11 exit criteria, plus: both FloorState guard suites pass untouched, the
  M2 smoke seam passes, and a pre-branch database migrates cleanly (compare `sqlite_master`).

### M6 — Living contracts and merge gate (the old Session 12, trimmed)

Unchanged in substance from Session 12: update the living docs and catalogs, supersede
`docs/sdk/workflow-module-format.md`, run the full gate plus `build`, and the manual matrix — with
these matrix edits: Yuzu cases run as vnMode-on-Classic; "monthly card Agent call" is replaced by a
cadence-triggered imported Agent (card-trigger case only if D2 shipped the API); add
"cadence Agent + Classic turn on the same commit boundary" and "blocksNextTurn failure releases the
turn with a visible warning."

Exit: the completion definition in implementation plan §7, reread against D1–D6's answers — any
clause invalidated by an owner decision (e.g. "cards own scheduling") is amended there in the same
commit, not silently ignored.

## 5. Deferred (carried, not planned)

- Pending Floor lifecycle (Session 8 residue) — no motivating defect on record.
- App-restart resumption of in-flight invocations.
- `runPlan` execution from the Workspace (the editor stays author/export-only).
- Card API ship (D2 hold), card-owned variable-predicate scheduling, and the WCV agent-channel
  line-by-line diff the audit flagged as unread.
- Making Classic read its catalog definition (rejected for now under D6).

## 6. Risks

1. **FloorState replay entanglement** (audit risk 1): `incorporateAgent` shares transaction and
   snapshot validation with `updateTranscript`, which every edit/regenerate uses. M4/M5 changes near
   it require `floorState.test.ts` and `floorDeletionAtomic.test.ts` to pass untouched.
2. **Comparator rot inverted:** M5 deletes the `classicShape` comparator; until then any
   `defaultMemoryTemplate` change silently reroutes users to the fallback. The rot pin in
   `classicShape.test.ts` remains the tripwire and must not be deleted before M5 lands.
3. **Trigger double-fire:** M3's commit-boundary evaluation and M4's converted maintenance must
   share one dispatch identity, or a cadence Agent could fire from both the new trigger and a
   leftover `evaluateDocTriggers` path during the M4→M5 window. The M4 exit criterion
   ("`evaluateDocTriggers` no longer fires it") is the guard; test it explicitly.
4. **Catalog migration blast radius:** `AgentCatalog` construction runs in `profileService` and
   `migrationService` on every profile open; a wrong migration surfaces at first launch after
   upgrade, far from the change. Suite green is insufficient — use the `sqlite_master` comparison.
5. **Template engine init race** (ADR 0021 known gap): `initTemplates()` is fire-and-forget, so an
   early triggered Agent can fall open to raw prompt text. M3 makes unattended early invocations
   possible for the first time — either await engine readiness before the first trigger dispatch or
   accept and document the degraded-warned first run.
6. **The two shujuku prompts embed `$U`/`$C`/`$1` shujuku placeholders** that RPT's engine does not
   substitute; they currently reach the provider as literals. Harmless for plumbing tests,
   misleading for quality judgments — convert or annotate before using them as acceptance evidence
   in M3/M6.

## 7. Implementation log

### 2026-07-19 — M1: owner decisions recorded

The owner directed implementation to proceed "in accordance to the plan" after reviewing the §3
decision package; the recommended answers are therefore adopted as the decisions of record:
**D1 = (a)** declarative commit-boundary cadence trigger in RPT, card scheduling stays deferred;
**D2 = hold** the card `rpt.agents` API dormant; **D3 = approve** both the parser-backed
`memory.maintain` CONVERT and the collapse-only subset; **D4 = hard cutover** for edited docs and
pack gates; **D5 = fail-open, warned** for `blocksNextTurn` failure; **D6 = migrate the builtin
decoy rows away in M5**. Milestones 3–5 are unblocked with these scopes.

### 2026-07-19 — Plan created

Audit performed against `ef8ab9f`; findings in §1. Stale status headers in
`agent-runtime-design.md` and `implementation-plan.md` corrected in the same change. No code
changed. M1 decision package awaiting owner.
