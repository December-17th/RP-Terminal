# Agent Runtime debloat audit

**Status:** DECISION-SUPPORT REPORT — NO DELETION APPROVED, NONE PERFORMED. Produced by Milestone 6
of the [Classic Narrator first execution plan](classic-narrator-first-execution-plan.md). No file
under `src/` or `test/` was changed by this milestone or by the 2026-07-19 correction below. Every
disposition here requires explicit owner approval before any debloating implementation begins (that
plan's Owner gates).
**Date:** 2026-07-19, corrected 2026-07-19 after owner scoping. **Branch:** `agent-system`.
**Evidence base:** Classic Narrator is now a real Harness consumer (M1 `b707a66`, M3 `f9ba3bc`), so
every classification below is grounded in what a live Classic turn reaches, not in design intent.

> **Read the [owner decision](#owner-decision-2026-07-19) and the
> [correction](#correction-reachability-is-not-compile-time-dependency) before acting on any
> disposition in this report.** The first revision recommended collapsing `AgentHarness.execute`.
> That recommendation does not compile. It has been withdrawn.

## Owner decision (2026-07-19)

The recommended set was approved, then scoped for implementation, and scoping found it does not
build. The harness decision is now **deferred in full, pending the InvocationRuntime/card-API
decision**. Nothing has been deleted. `AgentHarness.execute` is no longer an independent line item;
it is a dependent of a decision the owner has not yet made — see
[Restructured recommendation](#restructured-recommendation-one-decision-not-twelve).

## Correction: reachability is not compile-time dependency

The first revision classified `AgentHarness.execute` as **Collapse** while placing `InvocationRuntime`
and `HarnessRunAdapter` on **Defer**. Those two are `execute`'s only production callers
(`InvocationRuntime.ts:422`, `HarnessRunAdapter.ts:197`). The audit's justification — "both card-only"
— is a statement about **reachability**: no card invokes them, so no user action reaches that code.
It says nothing about **compile-time dependency**: the TypeScript build still requires the symbol.

These are different tests and the audit applied the wrong one. Deleting `execute` breaks the build of
two facilities the same summary table says to keep. A facility can be simultaneously unreachable at
runtime and load-bearing at build time, and only the second test governs whether it can be deleted.

Stated directly, because this is the third defect in this project to come from a wrong justification
rather than wrong code: the classifications themselves were mostly right; the reasoning attached to
one of them was invalid, and the invalid reasoning is what made the recommendation non-viable. Every
future disposition in this document must pass both tests, and say which one it is invoking.

### The full deletion closure

Deleting `execute` forces, transitively:

| Forced deletion | Was classified | Consequence |
| --- | --- | --- |
| `InvocationRuntime` (905 lines) | Defer | Sole caller at `:422` |
| `HarnessRunAdapter` (267 lines) | Defer | Sole caller at `:197`; also imports `buildAttemptLog` from the collapse set directly at `HarnessRunAdapter.ts:19` |
| `InvocationRuntimeService` | (not listed separately) | Constructs both of the above |
| `FloorState.incorporateAgent` | **Reduce** | `InvocationRuntimeService.ts:189` is its sole caller |
| `ProviderDispatch.resolve()` | Defer | `InvocationRuntimeService.ts:225` is its sole production caller |
| `onBeforeDeleteFromFloor` registration | **Keep** | Lives at `InvocationRuntimeService.ts:244` and guards real floor deletes |
| Card agent IPC (`agentRunIpc`, `wcvIpc` agent half) | Defer | Call `invocationRuntime()` |
| `shared/agentRuntime/plan.ts` | Defer | Only `runPlan` parses it |
| Tools / `AttemptTransaction` | Defer | Only the tool loop stages operations |
| `AgentRunStore` writer path | **Keep** | InvocationRuntime is the only writer |

Net: a single **Collapse** silently consumes **6 Defer'd items, 1 Reduce, and 2 Keeps** — including
`onBeforeDeleteFromFloor`, which the audit itself identified as guarding live floor deletion. The
`HarnessRunAdapter.ts:19` edge is worth calling out separately: it imports `buildAttemptLog` straight
out of the collapse set, bypassing the `harness/index.ts` barrel, so a barrel-level search for
dependents would have missed it.

## The one sentence that governs the whole report

Classic reaches exactly one Agent Runtime entry point — `AgentHarness.executePrepared`
(`src/main/services/generation/harnessDispatch.ts:38`) — which is a 10-line passthrough to
`provider.dispatch` that binds no tool, adds no message, and retries nothing
(`src/main/services/agentRuntime/harness/AgentHarness.ts:698-707`). Everything else in the runtime is
reached only from card-facing IPC, from floor/chat deletion hygiene, or from tests.

## Summary

| Facility | Real consumer today? | Disposition | Est. size | Risk |
| --- | --- | --- | --- | --- |
| Provider Dispatch (adapters, shaping, transports) | YES — Classic, via `createCompatibilityProviderDispatch` (`apiService.ts:71`) | **Keep** | — | — |
| Provider Dispatch `resolve()` / preset selection | NO production caller; card-only + tests | **Defer** | ~60 lines, 1 exported method | Low |
| Harness `executePrepared` | YES — Classic (`harnessDispatch.ts:38`) | **Keep** | — | — |
| Harness `execute` + tool loop, retry, repair, budget, result validation | Unreachable at runtime, but `InvocationRuntime.ts:422` and `HarnessRunAdapter.ts:197` depend on it at BUILD time | **Defer — dependent of the InvocationRuntime decision, not independent** | ~1,170 lines src, ~2,300 lines test | High if taken alone (does not compile) |
| InvocationRuntime (`run`, `runPlan`, cancel) | NO production caller; only card IPC with no card | **Defer — this is the governing decision** | ~906 lines src, ~1,010 lines test | Low |
| FloorState | YES — `floorService.ts:325,353,378,409` (non-agent) | **Keep** | — | — |
| FloorState `incorporateAgent` / journal replay | Card-only (`InvocationRuntimeService.ts:189`) | **Reduce** | ~250 lines, 1 method + replay | Medium |
| Tools / transports (`ToolRegistry`, `CardToolRegistry`, `AttemptTransaction`) | NO — no card registers a tool | **Defer** | ~580 lines src, ~265 lines test | Low |
| Run Records (`AgentRunStore`) | YES — `floorService.ts:399,404`, `chatDeleteService.ts:32`, `ChatView.tsx:530` | **Keep** | — | — |
| Catalogue schema (`AgentCatalog`) | YES for DB/migration (`profileService.ts`, `migrationService.ts:127`); NO for execution | **Reduce** | ~400 of 947 lines | Medium |
| Built-in Agent definitions (`CLASSIC_NARRATOR`, `YUZU_SCENE_DIRECTOR`) | NO — Classic does not use its own catalogue entry | **Remove, but NOT migration-free** | 66 lines, 3 exports + a migration | **High** — orphans undeletable DB rows; see below |
| Retries (`harness/retry.ts`, `repair.ts`) | NO — `callModelResilient` owns Classic retry | **Defer** (follows `execute`) | ~114 lines | Low |
| Lifecycle hooks — `onBeforeDeleteFromFloor` | YES — `InvocationRuntimeService.ts:244` guarding real floor deletes | **Keep** | — | — |
| Lifecycle hooks — `onFloorCommitted` / `cardAgentEvents` | Emitted for real (`chatService.ts:24`) but NO subscriber outside tests | **Defer** | 25 lines src, ~90 lines test | Low |
| Configuration (`AgentDefinition` defaults, `blocksNextTurn`, budgets) | NO — only `execute` reads them | **Defer** | ~200 lines across schema/types | Low |
| IPC — `agent-runs-list/get/cancel` | YES — `AgentRunActivity` in `ChatView.tsx:530` | **Keep** | — | — |
| IPC — card agent channels (`run`, `runPlan`, tool register/complete) | NO consumer; full preload + bridge + WCV plumbing | **Defer** | ~470 lines across 6 files | Low |
| Active-work close/session warning | YES — M4 exit guard (working tree) | **Keep at minimum interface** | — | — |
| Shared `plan.ts` / `InvocationPlan` schemas | NO — `runPlan` only | **Defer** | 168 lines + ~60 schema lines | Low |
| Tests | See "tests as the only consumer" below | **Reduce with their subjects** | ~4,800 lines | Medium |

## Facility detail

### Provider Dispatch — Keep, with one Reduce candidate

Classic's live path is `apiService.streamProvider` →
`createCompatibilityProviderDispatch(providerConnection(settings), params)`
(`src/main/services/apiService.ts:71`) → `dispatchVia = harnessDispatchVia` → `executePrepared` →
`provider.dispatch`. The Anthropic, OpenAI, and Gemini adapters, `shaping.ts`, `capabilities.ts`, and
`transportUtils.ts` are therefore fully production. `providerAdapter.test.ts` (1,001 lines) is
testing live code and must be kept in full.

The one unreached piece is `ProviderDispatch.resolve()`
(`src/main/services/agentRuntime/provider/ProviderDispatch.ts:289-331`), which resolves an API preset
from settings. Its only callers are `InvocationRuntimeService.ts:225` (card-only) and
`harnessDispatch.ts:28`, where the surrounding comment already concedes it is vestigial: "present
only because `createAgentHarness` requires the full options block; the prepared path never calls
`resolve`." Defer rather than Remove: the M5 parser-backed design routes future built-in operations
through the same seam and will plausibly want preset selection.

### Harness — Defer; dependent, not independent

> **Corrected.** This section originally read "Collapse to the prepared path." That recommendation
> does not compile — see [the correction above](#correction-reachability-is-not-compile-time-dependency).
> The sizing and the reachability evidence below are accurate and retained; only the disposition
> changed.

`executePrepared` is 10 lines. `execute` is roughly 800 lines of the 848-line file, and it drags in
`attemptLog.ts` (70), `budget.ts` (50), `repair.ts` (84), `resultValidation.ts` (96), `retry.ts`
(30), `schemaValidation.ts` (15), and `projection.ts` (21). Production callers of `execute`:
`InvocationRuntime.ts:422` and `HarnessRunAdapter.ts:197` — both card-only. Every other caller is
`agentHarness.test.ts`.

All 21 `HarnessFailure` codes (`ATTEMPTS_EXHAUSTED`, `CONTEXT_BUDGET`, `INVALID_INPUT_SCHEMA`,
`INVALID_JSON_RESULT`, `INVALID_TOOL_ARGUMENTS`, `INVALID_TOOL_RESULT`, `INVALID_TOOL_SCHEMA`,
`INVALID_YSS_RESULT`, `MAX_STEPS`, `PROMPT_BINDING_MISSING`, `PROVIDER_SELECTION`,
`REPEATED_TOOL_CALL`, `TOOLS_ONLY_NO_EFFECT`, `TOOLS_UNSUPPORTED`, `TOOL_UNAVAILABLE`,
`TRUNCATED_RESULT`, and the rest) are produced only inside `execute`. **No Classic turn can produce
any of them.** These are the plan's "unreachable hypothetical errors." They are unreachable *because
`execute` has no production caller*, not because the code is wrong — so removing them is the same
decision as collapsing `execute`, and should not be taken separately.

What the original section got wrong was not this evidence but the conclusion drawn from it.
`InvocationRuntime.ts:422` and `HarnessRunAdapter.ts:197` are card-only *callers* — no user action
reaches them — but they are still *compile-time dependents*, and `HarnessRunAdapter.ts:19`
additionally imports `buildAttemptLog` from the collapse set directly. `execute` cannot be removed
while they exist. Whatever happens to `executePrepared` and the `HarnessPreparedRequest` type
(`harness/types.ts:147`), which stay exactly as they are in every branch, the fate of `execute` is
decided by the InvocationRuntime decision and not on its own merits.

### InvocationRuntime — Defer (plan default holds, and is stronger than the plan assumed)

`InvocationRuntime.run` and `runPlan` are reachable only from `agentRunIpc.ts:174,203` and
`wcvIpc.ts:483,520`. Those handlers are registered in production (`src/main/ipc/index.ts:50`), so the
channels are live — but a repo-wide search for `rpt.agents` / `agents.run(` across `src`, `resources`,
and `assets` returns **zero** matches outside test files. No card, pack, or built-in surface calls
them. The plan's `runPlan: Defer` default is correct; the honest framing is that the entire
InvocationRuntime, not just `runPlan`, is a live-but-unreached surface.

### FloorState — Keep, and this contradicts the "speculative runtime" framing

`FloorState` is NOT agent-only. `floorService.ts` calls `createFloorState({ db }).updateTranscript`
at `:325`, `:353`, `:378` and `.deleteFromFloor` at `:409` — ordinary Classic edit/delete/regenerate
paths. Deleting FloorState would break Classic today. `floorState.test.ts` (335 lines) is testing
live code.

The agent-specific part is `incorporateAgent` (called only from `InvocationRuntimeService.ts:189`)
and the operation-journal replay machinery behind it (`validateOperation`, JSON Patch, MVU command
application, `REPLAY_FAILED` / `BASELINE_NOT_FOUND` / `TRANSCRIPT_CHANGED` paths) — roughly 250 of
the 668 lines. That is a Reduce candidate, but a genuinely risky one: the replay code is entangled
with `updateTranscript`'s transaction and snapshot validation, and separating them is refactoring,
not deletion.

### Run Records — Keep, and the plan's "exact request/response logs: Keep" is confirmed for a
different reason than expected

`agentRunStore` has three production consumers that have nothing to do with running agents:
`floorService.ts:399` (`cancelFromFloor`), `floorService.ts:404`
(`deleteFromFloorInTransaction`), and `chatDeleteService.ts:32` (`deleteChatForProfile`). These are
floor/chat deletion hygiene and run on every real delete. The renderer side is also live:
`AgentRunActivity` is mounted at `ChatView.tsx:530`.

The honest nuance: **the table is always empty in production**, because only InvocationRuntime writes
to it. So the UI renders nothing and the deletion hygiene deletes nothing. The code is reachable but
the data never exists. Keep it anyway — it is small relative to the risk of unpicking it from
`floorService`'s delete transaction, and exact request/response evidence is the thing the plan most
wants preserved for the M5 parser-backed work.

### Catalogue schema — Reduce; the built-in Classic Narrator definition is a decoy

`AgentCatalog` is constructed in real production paths: `profileService.ts:19,26,44,53,121` and
`migrationService.ts:127`. Those constructions exist to create and migrate the catalogue tables, so
the schema/migration half of the 947-line file is load-bearing for database integrity regardless of
whether any agent runs.

The execution half — definition lookup by name, card source binding, trigger resolution — is read
only by `InvocationRuntimeService.ts:233` and `cardAgentCatalogBridge.ts`, i.e. card-only.

**`CLASSIC_NARRATOR` (`catalog/builtins.ts:3-31`) is not used by Classic.** Classic's real prompt is
assembled by `generation/classicTurn.ts` and dispatched through `harnessDispatch.ts`; the catalogue
definition's `prompt` ("Continue the roleplay as the narrator using the assembled RP Terminal
context.") never reaches a provider. Same for `YUZU_SCENE_DIRECTOR`. These two definitions are
actively misleading to a future reader — they look like the production Classic configuration and are
not. Remove is still the right call, but the original **Low** risk rating was wrong.

**Corrected risk: High. This is cheap in lines and expensive in migration.**

`seedBuiltins()` (`AgentCatalog.ts:776`) runs from the constructor at `AgentCatalog.ts:220` — on
*every* construction, including `profileService.ts:19,26,44,53,121` and `migrationService.ts:127`.
So every profile that has ever been opened already holds two `source_kind='builtin'` rows on disk.
Deleting `builtins.ts` does not remove them; it only stops new ones being written.

Worse, those rows become undeletable. `AgentCatalog.delete()` at `:647-654` throws
`SOURCE_BACKED` for any row with `source.kind === 'builtin'`, so neither the user nor the
application can clear them. And `seedBuiltins` binds the roles `classic.narrator` and
`yuzu.sceneDirector` (`AgentCatalog.ts:795`), which are not soft references: they are a database
`CHECK` constraint at `src/main/services/db.ts:84`
(`role TEXT NOT NULL CHECK(role IN ('classic.narrator','yuzu.sceneDirector'))`) and a schema field at
`src/main/types/character.ts:211-212`, also read by `characterService.ts:481,491,502`.

A removal therefore requires a real migration that: (a) unbinds both roles, (b) deletes the two
builtin rows in a path that bypasses the `SOURCE_BACKED` guard, and (c) decides whether the `db.ts:84`
`CHECK` constraint and the `character.ts` schema field stay (cards may bind these roles) or go (which
means a table rebuild, since SQLite cannot drop a `CHECK` in place). Step (c) is the expensive one and
was entirely absent from the original estimate.

### Tools / transports — Defer

`createToolRegistry()` is called twice in production: `harnessDispatch.ts:29` with an **empty**
registry (Classic binds no tools), and `InvocationRuntimeService.ts:226` inside the composite. The
`CardToolRegistry` (415 lines) is wired through `agentRunIpc.ts:101,120,284` and
`wcvIpc.ts:550,559,571` and the renderer bridge at `cardBridge/host.ts:253`, but no card registers a
tool. `AttemptTransaction` (68 lines) is used only by the tool loop inside `execute`.

Defer per plan default. Removing the registries would also remove the empty-registry argument
`harnessDispatch.ts:29` currently passes, which is a small extra edit to `createAgentHarness`'s
options.

### Retries — Defer, following `execute`

`harness/retry.ts` (30 lines) and `repair.ts` (84 lines) implement attempt backoff and result
repair. Classic does not use them: `callModelResilient` owns retry on the Classic path and the
`executePrepared` comment states the Harness "performs no retry here." No independent decision is
needed; these die with `execute` or survive with it.

### Lifecycle hooks — split verdict

- `agentRunStore.onBeforeDeleteFromFloor` (`InvocationRuntimeService.ts:244`) fires on real floor
  deletes. **Keep.**
- `emitCardFloorCommitted` is genuinely called from production (`chatService.ts:24`) on every floor
  commit, but the only subscribers are `agentRunIpc.ts:12` and `wcvIpc.ts:26`, which forward to card
  hosts that do not exist. The emit is therefore a real call into an empty room. **Defer** — 25
  lines, and the emit point is a one-line removal if the card surface later goes.
- Active-work close/session warning (M4, working tree): **Keep at the minimum interface**, per plan
  default. The union signal `hasActiveBackgroundWork` is the correct minimum: it does not expose run
  internals, so it survives under either branch above.

### Configuration — Defer

`AgentDefinition` defaults (`maxSteps`, `maxRetryAttempts`, `retryDelayMs`, `blocksNextTurn`,
`toolResultMaxTokens`, `notification`) are read only by `resolveInvocationOptions` inside `execute`.
No production turn reads any of them. They are cheap to leave in place and expensive to
re-derive, and the M5 design will need some of them.

### IPC — Reduce, splitting the two halves

Keep: `agent-runs-list`, `agent-run-get`, `agent-run-cancel` (`agentRunIpc.ts:126-158`) — consumed by
`AgentRunActivity`.

Defer: `CARD_AGENT_CHANNELS.run` / `runPlan` / `registerTool` / `unregisterTool` / tool completion
(`agentRunIpc.ts:160-295`), their WCV twins (`wcvIpc.ts:483-575`), the preload bridges
(`preload/index.ts:259-264`, `preload/wcvHost.ts:173-205`), the renderer host facet
(`cardBridge/host.ts:221-266`), and the `thRuntime` facet declarations
(`shared/thRuntime/index.ts:907-917`, `hostFacets.ts:192-194`, `nullHost.ts:105`). This is the
Session 7 public card Agent API in full. It is the single largest speculative block on the branch and
it has no consumer at any layer.

### Tests as the ONLY consumer

Named explicitly, because this is the finding that most changes the size estimate:

- `test/agentRuntime/agentHarness.test.ts` (2,552 lines) — the only consumer of `AgentHarness.execute`
  outside card-only code.
- `test/agentRuntime/invocationRuntime.test.ts` (567) and `invocationRuntime.integration.test.ts`
  (446) — the only consumers of `runPlan` (`:171,283,289,307,377,385`).
- `test/agentRuntime/cardToolRegistry.test.ts` (265) — the only consumer of tool registration.
- `test/agentRuntime/harnessRunAdapter.test.ts` (342) — the only consumer of `HarnessRunAdapter`
  beyond `InvocationRuntimeService.ts:223`.
- `test/inlineAgentHost.test.ts` (191), `test/wcvAgentHost.test.ts` (167),
  `test/thRuntimeAgentHost.test.ts` (35), `test/fixtures/cardAgentTransport.ts` (12) — the only
  consumers of `rpt.agents.run`, `runPlan`, `registerTool`, and `onFloorCommitted`. No card calls any
  of them.
- Large parts of `test/agentRuntime/contracts.test.ts` (629) exercise schemas with no production
  reader.

`test/agentRuntime/providerAdapter.test.ts` (1,001) and `test/agentRuntime/floorState.test.ts` (335)
are **not** in this category — they test live Classic code and must be kept.

## Where the evidence contradicts a plan default

1. **"unreachable hypothetical errors: Remove with their tests" is not separable.** All 21 harness
   failure codes are unreachable for the same single reason: `execute` has no reachable caller.
   There is no residue of independently-dead error handling to remove; removing them *is* the
   `execute` decision, which is in turn the InvocationRuntime decision. It is not free cleanup, and
   it is three decisions removed from where the plan's default treats it as sitting.
2. **FloorState is not speculative.** It has non-agent production consumers in `floorService`. Any
   earlier framing of "FloorState is Agent Runtime bloat" was wrong.
3. **Run Records are reachable but their data never exists.** "Keep exact logs" is the right call,
   but the owner should know the store is empty in production today — the retention policy is
   currently protecting nothing.
4. **A built-in Agent definition named `Classic Narrator` exists and Classic does not use it.** The
   plan's ordering assumed Classic would become a catalogue consumer; it did not. Whatever else is
   decided, this decoy should be resolved.

## Estimated deletion if the owner approves everything

| Area | Source lines | Test lines | Files touched |
| --- | --- | --- | --- |
| Harness `execute` + helpers + retries | ~1,170 | ~2,300 | 9 src, 1 test |
| InvocationRuntime + service wiring | ~950 | ~1,010 | 3 src, 2 test |
| `HarnessRunAdapter` | ~267 | ~342 | 1 src, 1 test |
| Tools / transports | ~580 | ~265 | 4 src, 1 test |
| Card agent IPC + preload + renderer bridge | ~470 | ~393 | 6 src, 3 test |
| Catalogue execution half + built-ins | ~470 | ~80 | 2 src, 1 test |
| Shared `plan.ts` + unused schema | ~230 | ~400 | 3 src, 1 test |
| FloorState agent replay | ~250 | ~90 | 1 src, 1 test |
| **Total** | **~4,400** | **~4,900** | **~29 src, ~11 test** |

Roughly **9,300 lines**, against a ~9,550-line Agent Runtime source surface and ~8,340 lines of agent
tests. The full-approval case deletes most of the runtime.

This total is the *maximum*. The original revision proposed a middle path — Collapse the Harness,
Remove the built-ins, Defer the rest, "about a quarter of the maximum." **That middle path does not
exist.** The closure table above shows the Collapse pulls in six Defer'd items and two Keeps, so it
is not a quarter of the maximum; it is very nearly the maximum. There is no small, safe subset of the
harness/runtime decision. That is the real finding, and it is what the restructured recommendation
below is built on.

## Restructured recommendation: one decision, not twelve

`AgentHarness.execute` is not a line item. The owner faces **one** question, and the harness
disposition follows from it mechanically:

**Does the card Agent API stay?**

**Branch A — keep the card API (Defer everything).** `InvocationRuntime`, `HarnessRunAdapter`,
`InvocationRuntimeService`, card IPC, `plan.ts`, and the tool registries all remain. `execute` is then
**Keep**, not Collapse — it is a compile-time dependency of code that stays, regardless of the fact
that no card reaches it. Deletion: **0 lines**. This is the current state and, per the owner decision
above, the state the branch is in.

**Branch B — remove the card API.** Then `execute` is **Remove**, together with the entire closure:
InvocationRuntime, HarnessRunAdapter, InvocationRuntimeService, card IPC and preload and renderer
bridge, `plan.ts`, tools/`AttemptTransaction`, and the retry/repair/budget/validation helpers.
`FloorState.incorporateAgent` and `ProviderDispatch.resolve()` lose their sole callers and go with
them. Two Keeps must be **re-homed rather than deleted**: `onBeforeDeleteFromFloor`
(`InvocationRuntimeService.ts:244`) must move somewhere that still exists, or real floor deletion
loses its guard; and `AgentRunStore` keeps its readers (`floorService`, `chatDeleteService`,
`ChatView.tsx:530`) while losing its only writer, so the owner must decide whether an
append-never store is worth keeping. Deletion: **~4,400 source and ~4,900 test lines**.

Branch B is all-or-nothing, but it is **not irreversible** — see below. Branch A costs nothing to
hold. The built-in definitions (`builtins.ts`) are the one genuinely independent item — they can be
resolved under either branch — but as re-rated above they need a database migration, so they are not
the free cleanup the first revision implied.

### The card Agent API has never shipped

This is the single most important input to the choice above, and it was not established when the
audit was first written. Verified 2026-07-19:

```console
$ git branch -a --contains 836143f      # "feat: expose card agent runtime"
* agent-system
  backup/pre-author-rewrite
+ codex/anti-overengineering-guardrails
  remotes/origin/agent-system

$ git tag --contains 836143f
                                        # (no output — no tag contains it)

$ git tag
v0.1.1  v0.1.2  v0.1.3  v0.1.4

$ git rev-list --left-right --count main...agent-system
0	284                                 # 284 ahead of main, 0 behind
```

The commit that exposed the card Agent runtime is not on `main` and is in no released tag. No user
has ever had a build containing `rpt.agents`. **A card cannot call an API that was never released.**

This resolves the open question the original audit correctly flagged but could not settle — whether
some out-of-repo, user-installed card calls `rpt.agents` — which was the stated reason the card API
was Defer rather than Remove. That uncertainty was real when written and is now closed.

Two consequences for Branch B, both narrow:

1. **The compatibility risk is zero, not small.** There is no installed base to break, no card
   contract to honor, and no migration or shim required, because nothing was ever published to be
   compatible with.
2. **It is restorable, not irreversible.** The work survives in this branch's history and in
   `backup/pre-author-rewrite`; reinstating it is a cherry-pick of `836143f` and its neighbors, with
   no migration and no compatibility burden — again, precisely because nothing shipped. The first
   revision's framing of Branch B as closing the card-API option was too strong.

**This is not an argument for choosing Branch B.** It removes a risk from that branch; it supplies no
reason to take it. Whether a card Agent API ships in the next release or two is a product judgement
about where this application is going, and that judgement belongs to the owner. An unshipped feature
is not thereby an unwanted one — the same evidence would equally support finishing it. What the
finding does is make the decision a clean product call instead of a call entangled with a
compatibility unknown.

## Real risks (as distinct from theoretical ones)

**Real:**

0. **Confirmed, and already realized: a disposition can be right about reachability and still not
   build.** This is no longer a hypothesis — the first revision's recommended set was approved and
   failed at scoping. Any future audit item must state whether it is claiming runtime unreachability
   or compile-time independence, because the two diverge exactly where the dead code is largest.
   Direct imports that bypass a barrel (`HarnessRunAdapter.ts:19`) are the specific mechanism by which
   a dependency search misses one.

1. **FloorState replay separation is a refactor wearing a deletion costume.** `incorporateAgent` and
   the operation journal share transaction and snapshot-validation code with `updateTranscript`,
   which Classic uses on every edit and regenerate (`floorService.ts:325,353,378`). A careless split
   corrupts transcript edits. This is the highest-risk item on the list and it is not obvious from
   the file layout.
2. **Both Classic paths are live.** M3 left a `runWorkflow` fallback for edited docs and open pack
   gates, so production resolves either the direct `classicTurn.ts` orchestration or the workflow
   engine depending on user state. Any change validated on only one path is unvalidated. This is
   under-appreciated: the direct path is the common case, so a fallback-only regression would ship
   silently.
3. **Catalogue tables are created by `profileService` and `migrationService` on every profile.**
   Reducing `AgentCatalog` without keeping its migration behavior breaks profile creation and
   database upgrade, not agent execution. The failure would surface at first launch after upgrade,
   far from the code that was changed.

**Theoretical, and should not be weighted:**

- "An existing card might break." None can. No card uses the API in this repo or in any pack under
  `resources`/`assets`, and no released build has ever contained it (`836143f` is not on `main` and is
  in no tag). Deferring costs nothing and the surface is restorable by cherry-pick. Note this retires
  a *compatibility* worry only — "a card might want this API in future" remains a live product
  question and is not answered by any of the evidence here.
- "Deleting harness failure codes loses error coverage." No production path can emit them.
- "The code was expensive." Session 7 shipped the complete card Agent API — inline host, WCV host,
  `thRuntime` facets, preload, IPC, tool registry, plan execution — with no consumer, and Milestone 6
  is the point at which that fact is supposed to be stated plainly rather than softened. Sunk cost is
  not evidence of load-bearingness.

## Verification strategy

### First, what the guard tests below CANNOT do

The seven items listed next were originally presented as a verification strategy for a harness
collapse. They are not one, and the gap is structural rather than a matter of adding a test.

Of the guard tests, only `test/workflow/classicHarnessSlice.test.ts` touches the Harness at all, and
it exercises `executePrepared` (`:244`) — the ten-line passthrough that survives in every branch. **No
guard test touches `execute`.** Every other listed test covers Classic assembly, floor lifecycle,
database migration, or the exit guard. So the full suite passing proves only that Classic still works,
which it would do whether or not the collapsed code was correct: it is measuring the part that did not
change.

The one thing that does cover `execute` is `test/agentRuntime/agentHarness.test.ts` (2,552 lines),
the sole coverage of all 21 failure codes — and it is inside the deletion set. The strategy therefore
deletes its own instrument. After a collapse, a green suite would be indistinguishable from a suite
that lost the ability to observe the change.

A verification strategy that cannot observe the change it is verifying is not a verification strategy.
The owner should not read the items below as covering a harness change; they do not.

**But for Branch B specifically, build-and-suite consistency is not a weak substitute — it is the
correct and sufficient check.** Nothing can regress if nothing can call it: `execute` is unreachable
from any user action, and per the release evidence above no shipped build has ever contained the card
API that would reach it. There is no behavior to preserve, so demanding behavioral evidence would be
demanding evidence about code that has never run in a user's hands. Proving the build is internally
consistent and that Classic's guards still pass is the whole of what is available and the whole of
what is needed.

That conclusion carries one load-bearing caveat: it holds **only once the deletion closure is scoped
correctly**. "Nothing can call it" is a claim about reachability, and the first revision's failure was
allowing exactly that claim to stand in for a compile-time dependency analysis. Consistency-checking
is sufficient for a correctly-scoped Branch B and worthless for an incorrectly-scoped one, because an
incorrect scope does not compile and never reaches the point of being verified. The closure table
above is therefore a prerequisite of this argument, not an aside to it.

### The guard tests themselves

These remain correct and useful for any Classic-adjacent change, including the built-ins migration.
For any approved change, in this order:

1. **Byte-identical provider request.** `test/workflow/classicHarnessSlice.test.ts` asserts the
   Classic sampling call's exact final message array (`:244`). It must pass unchanged. This is the
   single strongest guard and it is cheap to run.
2. **Both Classic paths.** Run `test/generation/classicDirectParity.test.ts` (559 lines),
   `classicDirectGenerate.test.ts`, `classicShape.test.ts`, `classicShapeRoundTrip.test.ts`, plus the
   M2 characterization pair `test/workflow/classicTurnInventory.test.ts` (548) and
   `classicDocResolution.test.ts` (330). The M2 pair is the specific instrument for detecting a
   fallback-path-only regression.
3. **Floor lifecycle.** `test/agentRuntime/floorState.test.ts` and
   `test/agentRuntime/floorDeletionAtomic.test.ts` must pass untouched for any FloorState or
   AgentRunStore change. If either needs editing, the change has crossed out of Classic-neutral
   territory and should return to the owner.
4. **Database.** Create a fresh profile and run a migration from a pre-branch database before and
   after any `AgentCatalog` change; compare `sqlite_master`. Test-suite green is not sufficient
   evidence here. For the built-ins removal specifically, this must also cover a profile that
   *already* holds the two seeded `source_kind='builtin'` rows and has both roles bound — a fresh
   profile will not reproduce the orphan case, which is the whole risk.
5. **Exit guard.** `test/exitGuard.test.ts` (M4) must pass, confirming the active-work signal still
   reports correctly after any InvocationRuntime reduction.
6. **Link and doc integrity.** `npm run check:docs`, compared against the current baseline of 72
   broken links rather than asserted to be clean.
7. **Manual smoke, unavoidable.** One Classic turn, one edited-doc turn, one regenerate, one floor
   delete, one chat delete. Items 1–5 do not cover the `ChatView` agent-activity mount
   (`ChatView.tsx:530`) reading an empty store.

## Not determined from the code

- Whether the two seeded built-in catalogue rows exist in any user's database on disk, and therefore
  whether removing `builtins.ts` requires a data migration or only a code deletion.
- ~~Whether any out-of-repo card or pack (user-installed, not shipped) calls `rpt.agents`. The search
  covered this repository only. That is the main reason the card API disposition is Defer rather than
  Remove.~~ **RESOLVED 2026-07-19 — no such card can exist.** `git branch -a --contains 836143f`
  returns only `agent-system`, `backup/pre-author-rewrite`, `codex/anti-overengineering-guardrails`,
  and `remotes/origin/agent-system` — not `main`. `git tag --contains 836143f` returns nothing, and
  the released tags are `v0.1.1`–`v0.1.4`. `git rev-list --left-right --count main...agent-system`
  gives `0 284`. The card Agent API has never been in a released build, so no user-installed card can
  call it. This removes the compatibility unknown from Branch B; it does not by itself argue for
  Branch B. See [The card Agent API has never shipped](#the-card-agent-api-has-never-shipped).
- Whether the WCV agent channel plumbing (`wcvIpc.ts:483-575`) has behavior differences from the
  inline path that would matter if only one were removed; the two were read as parallel but not
  diffed line by line.
