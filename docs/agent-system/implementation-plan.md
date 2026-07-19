# Agent Runtime implementation plan

Status: Milestones 1–4, Sessions 0–7, are implemented, reviewed, accepted, and committed on
`agent-system`. Session 0 evidence is complete and reviewed.

Session 8 was superseded in ordering by the
[Classic Narrator first execution plan](classic-narrator-first-execution-plan.md), and **all six of
that plan's milestones have now landed** — including M3 (direct Classic player-generation
orchestration), which delivers the substance of Session 8's objective, and M6, whose
[debloat audit](debloat-audit.md) is decision-support only with no deletion approved or performed.
Session 8 is therefore not re-run as written; its remaining scope is the Pending Floor cutover.

Session 10 is **in progress**: the Agent Workspace is being implemented ahead of Session 9, with a
Settings-rail quick-adjustment panel plus a full editor popup. Sessions 9, 11, and 12 remain planned
and unimplemented.

Two facilities are built but deliberately NOT wired, and must not be assumed live:

- `blocksNextTurn` — the barrier exists (`InvocationRuntime.startBarrier` /
  `waitForNextTurnBarriers`) but has no production caller, and `src/main/services/generation/`
  references no part of `InvocationRuntime`. Wiring it is a separate, approval-gated decision.
- The card Agent API has never shipped in any tagged build; card-owned scheduling is the designed
  trigger path (design §11) but has no released consumer.

This plan turns the approved [Agent Runtime design](agent-runtime-design.md) and
[ADR 0020](../adr/0020-agent-runtime-replaces-workflow-system.md) into a sequence of independently
verifiable implementation sessions. It is based on the repository state at commit `ea42ec2`.

The work happens only on the `agent-system` branch and its sub-branches until the complete runtime is
ready to replace the workflow system. Development may temporarily contain both implementations, but
there is no user-facing runtime selector, compatibility API, migration release, or merged state with
two systems.

## 1. Delivery rules

Every session follows these rules:

1. Re-read the files named by that session before changing them.
2. Begin with the narrow contract or regression test that proves the session's load-bearing behavior.
3. Keep the app runnable and the required project gates green after the session.
4. Do not expose unfinished Agent Runtime entry points to cards or players.
5. Do not change or delete Legacy Workflow Data. Old rows and files become inert after cutover.
6. Do not add a workflow-to-Agent converter.
7. Do not add Agent aliases, implicit variable paths, hidden model escalation, or a scheduler.
8. Use the selected API preset's existing endpoint-wide RPM and concurrency controls.
9. Treat an Invocation Floor as the owner of its Agent result, operations, and Run Record.
10. Update the relevant living documentation in the same session as a public contract changes.

The normal end-of-session gate is:

```text
npm.cmd run typecheck
npm.cmd run check:deps
npm.cmd run test
npm.cmd run check:docs
```

Targeted tests should run during development. The full gate runs before each session commit. Existing
documentation-link failures must be distinguished from new failures; the Agent Runtime work may not
increase their count.

## 2. Evidence from the current code

The replacement cannot begin by deleting the graph. The current Classic generation path in
`src/main/services/generationService.ts` resolves an effective workflow, calls `runWorkflow`, waits
for its response-ready checkpoint, persists workflow history, and evaluates headless triggers. Both
regeneration and swipes return through that entry point.

The reusable seams are:

| Existing seam                       | Current location                                                                          | Agent Runtime use                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Prompt construction                 | `src/main/services/generation/assemble.ts`                                                | Internal implementation of the Classic Narrator prompt builder; no workflow types in its new interface.         |
| Provider transport and limits       | `src/main/services/apiService.ts`, `rpmLimiter.ts`                                        | Extract behind a provider-neutral Adapter while retaining a temporary compatibility wrapper for old generation. |
| Provider message shaping            | `src/main/services/generation/providerShape.ts`                                           | Seed for provider normalization; extend it for tool messages and normalized reasoning events.                   |
| Floor snapshots and cut/edit events | `src/main/services/floorService.ts`                                                       | Invocation ownership, cancellation, input invalidation, and replay notifications.                               |
| Floor operation journal             | `src/main/services/varsOpsService.ts`, `generation/varsWrite.ts`                          | Replace with a general, source-aware floor-operation interface and migrate existing producers.                  |
| Suffix re-evaluation                | `generationService.reevaluateVariables`                                                   | Seed for a pure compute-then-commit Forward Replay module.                                                      |
| Per-chat SQLite                     | `src/main/services/sessionDbService.ts`                                                   | Agent Run Records and floor-operation persistence.                                                              |
| Profile SQLite                      | `src/main/services/db.ts`                                                                 | Agent library, source baselines, customizations, and role bindings.                                             |
| Shared card Host                    | `src/shared/thRuntime/types.ts`, `hostFacets.ts`                                          | One Agent facet used by both inline and WCV transports.                                                         |
| WCV Channel Spec                    | `src/shared/thRuntime/wcvChannelSpec.ts`                                                  | Typed transport rows for run, runPlan, tool registration/callbacks, and floor events.                           |
| Card transport parity               | `src/renderer/src/cardBridge/host.ts`, `src/preload/wcvHost.ts`, `src/main/ipc/wcvIpc.ts` | Carry the same Agent API and events without duplicating semantics.                                              |
| Yuzu grammar and validation         | `src/shared/yuzu/*`, `src/main/services/yuzu/vnPrompt.ts`                                 | Text Result Contract validator and degraded narration-only fallback.                                            |
| Existing activity UI                | `agentActivityStore.ts`, `agentFailureStore.ts`                                           | Replace workflow-node events with invocation/run-record events.                                                 |

Current constraints that require explicit repair are:

- `rawGenerate.ts` tracks one abort controller per chat, which cannot represent concurrent Agent
  Invocations. Agent cancellation must be keyed by Invocation ID and plan membership.
- `resilientCall.ts` is workflow-node-specific and permits fallback preset escalation. It must not
  become the Agent retry layer.
- provider adapters currently merge reasoning into `<think>` text and do not normalize streaming
  tool calls. Agent reasoning must remain volatile and absent from Run Records.
- `saveFloor` has a per-chat lock but does not provide an awaited, atomic suffix transaction.
- `setFloorStatData` is intentionally unjournaled, while the approved design requires user edits to
  survive Forward Replay as floor-scoped operations.
- `vars_ops` paths are relative to `stat_data`; Agent Input Bindings and Result Slots require explicit
  full paths rooted at `variables`.
- the workflow editor, workflow/agent-pack IPC, card `workflows[]` import, run history, node registry,
  and `@xyflow/react` are all still live and must be removed together after cutover.

## 3. Target module boundaries

The implementation should expose a small set of deep Modules. Their Interfaces are the test surface;
provider quirks, SQLite schemas, repair heuristics, queue data structures, and replay mechanics stay
inside their Implementations.

### 3.1 `AgentContracts`

Proposed location: `src/shared/agentRuntime/`

Interface responsibilities:

- parse and validate Agent Definitions, effective invocation options, Result Contracts, Tool
  Bindings, Input Bindings, history selection, and Invocation Plans;
- normalize static prompt strings and typed prompt segments into one representation;
- require full paths rooted at `variables`;
- reject pre-authored tool messages, duplicate Agent calls on one floor, nested parallel groups,
  unknown fields where ambiguity would be dangerous, and writes to reserved paths;
- produce structured validation errors with an Agent, field, binding, tool, or plan location.

This Module is pure. It imports no Electron, main-process, renderer, filesystem, database, or
provider code. Add a dependency-cruiser rule equivalent to the current pure workflow-engine rule.

### 3.2 `ProviderDispatch`

Proposed location: `src/main/services/agentRuntime/provider/`

Interface responsibilities:

- resolve and freeze an API preset and generation parameters;
- report a Provider Capability Profile;
- accept normalized messages and tool schemas;
- emit normalized text, tool-call, reasoning, usage, cache, rate-limit, and completion events;
- share the existing endpoint-keyed RPM/concurrency limiters with ordinary generation;
- expose provider errors with retry class and `Retry-After`.

Implementations cover the existing OpenAI-compatible, native Anthropic, and native Gemini transport
families. A scripted in-memory Adapter is the test implementation. `apiService.streamProvider`
temporarily becomes a compatibility wrapper over this Module so existing Classic generation keeps
working while the Harness is built.

### 3.3 `AgentHarness`

Proposed location: `src/main/services/agentRuntime/harness/`

One Interface method executes one resolved Agent Invocation against one immutable input snapshot. It
owns:

- immutable-prefix and append-only attempt-log assembly;
- context-budget attribution;
- one-call and bounded tool-loop execution;
- Tool Binding resolution and availability checks;
- Protocol Repair;
- ordered tool-result projection, defaulting to 10,000 tokens;
- Attempt Transactions;
- retry classification, five-attempt default, five-second delay, and `Retry-After`;
- cancellation;
- text, JSON Schema, tools-only, and YSS Result Contract validation;
- exact attempt/run evidence without raw reasoning.

The Harness does not know about lanes, plans, floors after its input snapshot is created, UI, or card
scheduling. It returns a validated result plus staged operations, or a structured final failure.

### 3.4 `AgentCatalog`

Proposed location: `src/main/services/agentRuntime/catalog/`

One profile-scoped Interface owns built-in, user-imported, user-created, and card-bundled Agents. It
enforces profile-wide unique names, effective-definition calculation, source baselines,
customizations, restore, upgrade conflict reporting, enabled state, deletion constraints, and
Classic/Yuzu role bindings.

Suggested profile-database records:

- `agent_definitions`: unique name, source kind/key/version, baseline JSON, customization JSON,
  enabled state, effective hash, and timestamps;
- `agent_role_bindings`: role key, Agent Name, and role-local invocation configuration.

The store must retain enough source identity to restore built-ins and installed card Agents. Import
is two-phase only when a name collision requires a rename; otherwise card-bundled Agents install
enabled without a walkthrough. Renaming updates references inside the same declarative import
transaction only.

### 3.5 `FloorState`

Proposed location: `src/main/services/agentRuntime/floorState/`

This is the sole Interface for floor-scoped state operations and deterministic replay. It owns:

- full-path read/write validation;
- an ordered journal with source `model`, `card`, `user`, or `agent`;
- reserved `variables.__rpt` enforcement;
- pure suffix reconstruction from a stable seed;
- atomic compute-then-commit of every affected floor;
- Result Slot writes and Attempt Transaction operations;
- historical user edits;
- transcript epoch/snapshot validation;
- state-refresh notifications that never emit `floor:committed`.

Introduce a general `floor_operations` session table rather than exposing `vars_ops` to new code.
Migrate existing `vars_ops` rows non-destructively on session open, then move current card and model
writers to the new Interface. Keep old tables inert after cutover so existing user data is not
destructively removed.

The replay transaction must calculate and validate the complete suffix before writing any floor.
SQLite commit failure or validation failure leaves every original floor unchanged.

### 3.6 `InvocationRuntime`

Proposed location: `src/main/services/agentRuntime/invocation/`

One Interface accepts `run`, `runPlan`, manual, or Player-facing role requests. It owns:

- Invocation identity `(chat, floor, Agent Name)` and duplicate coalescing;
- per-chat, per-Agent ordered lanes;
- sequence and author-declared flat parallel groups;
- input resolution only when a lane member is ready to start;
- invocation-ID and plan-ID cancellation;
- floor deletion listeners;
- input-snapshot invalidation and restart without consuming retry budget;
- Result Incorporation through `FloorState`;
- required/optional plan failure behavior;
- Next-turn Barriers;
- lifecycle events and immutable Run Records.

Suggested session records:

- `agent_runs`: Invocation ID, identity fields, immutable definition/config snapshots, status,
  timestamps, and final record JSON;
- an append-only `agent_run_events` table only if crash-safe live activity requires it during
  implementation. Do not split the record into many public persistence concepts without evidence.

Run Records are deleted with their Invocation Floor. A deleted in-flight floor leaves no diagnostic
tombstone. App-restart resumption remains deferred; the initial implementation may mark live work
cancelled on shutdown without committing partial state.

### 3.7 `PlayerGeneration`

Proposed location: `src/main/services/agentRuntime/playerGeneration/`

This Module adapts the Harness to Pending Floors and role bindings:

- `classic.narrator` builds the existing Classic prompt through the extracted prompt builder and
  stores text as canonical `response_content`;
- `yuzu.sceneDirector` appends the Yuzu instruction, validates mixed text/YSS, stores the raw output,
  and exposes parsed stage data;
- required background barriers settle before Player-facing input bindings resolve;
- success commits the Pending Floor exactly once;
- cancellation/final failure discards it and restores the player's captured input;
- regeneration and swipes use the same role path.

There is no workflow fallback after the Classic cutover.

### 3.8 `CardAgentHost`

This is a new `AgentHost` facet in `src/shared/thRuntime/hostFacets.ts`, kept flat in the existing
`Host` intersection. It exposes:

```ts
rpt.agents.run(name, options)
rpt.agents.runPlan(plan)
rpt.agents.registerTool(binding, handler)
rpt.agents.onFloorCommitted(handler)
```

`registerTool` is a live, scoped implementation binding, not an Agent-definition mutation. Inline
and WCV transports carry correlated tool requests, results, errors, and aborts. Unmount unregisters
the implementation. The Invocation Runtime rejects a missing implementation before the first
provider call. Card/plugin trust and existing host privilege boundaries still apply.

`floor:committed` is emitted exactly once after a new floor commits. Replay emits a distinct
state-refresh event and cannot retrigger scheduling.

## 4. Dependency direction

```text
AgentContracts
    ↑
ProviderDispatch ← AgentHarness ← InvocationRuntime ← CardAgentHost
                         ↑              ↓
                    Tool Registry    FloorState
                                         ↑
                                 PlayerGeneration
                                         ↑
                              generationService facade
```

`AgentHarness` depends on Interfaces for provider dispatch and tools. `InvocationRuntime` depends on
the Harness, Catalog, Run Store, and FloorState Interfaces. `FloorState` does not import
InvocationRuntime; existing floor cut/edit events notify it through registration at the composition
root. Renderer and WCV code reach main only through typed IPC.

## 5. Session plan

### Session 0 — Freeze parity and deletion inventories

Objective: establish a trustworthy baseline before extracting code.

Work:

- Add focused characterization tests for current Classic prompt bytes, provider shaping, floor
  variable re-evaluation, regeneration, swipe, and Yuzu parsing.
- Add `test/agentRuntime/fixtures/` with scripted provider event streams for text, reasoning,
  fragmented tool calls, usage, rate limits, malformed arguments, and truncation.
- Inventory every registered node from `src/main/services/nodes/builtin/index.ts` into three
  explicit classes:
  - implementation to extract behind an Agent/tool Interface;
  - capability already available as a direct service;
  - workflow-only authoring/control glue to delete.
- Record the full workflow removal file/dependency search in this plan's implementation log when
  work starts; do not delete anything yet.

Required tests:

- existing generation parity tests;
- current Yuzu/YSS tests;
- floor replay and vars operation tests;
- one fixture proving raw reasoning can be separated from visible text.

Exit:

- baseline gates are recorded;
- every workflow node has an owner or deletion disposition;
- no runtime behavior changed.

Suggested commit: `test: freeze agent runtime cutover baselines`

### Session 1 — Contracts and Provider Adapter

Objective: create the pure contract Module and a real provider seam without changing user behavior.

Add:

- `src/shared/agentRuntime/types.ts`
- `src/shared/agentRuntime/schema.ts`
- `src/shared/agentRuntime/paths.ts`
- `src/shared/agentRuntime/plan.ts`
- `src/shared/agentRuntime/errors.ts`
- `src/main/services/agentRuntime/provider/*`
- `test/agentRuntime/contracts.test.ts`
- `test/agentRuntime/providerAdapter.test.ts`

Change:

- `src/main/services/apiService.ts`
- `src/main/services/generation/providerShape.ts`
- `src/main/services/rpmLimiter.ts` only if needed to expose the existing shared limiter cleanly;
- `.dependency-cruiser.cjs`

Work:

- Implement Agent Definition version 1 and Invocation Plan validation.
- Enforce full paths and the reserved Result Slot root.
- Define normalized provider messages/events, including tool calls and volatile reasoning.
- Extract provider-specific request/stream parsing into Adapters.
- Preserve endpoint-keyed RPM and concurrency behavior.
- Make existing `streamProvider` use the Adapter through a compatibility wrapper.
- Do not persist or emit raw reasoning through Agent-facing result events.

Required tests:

- every configured provider identifier normalizes through its applicable transport family;
- fragmented tool-call arguments assemble deterministically;
- reasoning never becomes final text unless the existing non-Agent compatibility caller explicitly
  requests its old `<think>` presentation;
- schema normalization follows the selected capability profile;
- ordinary generation limiter sharing remains unchanged;
- contract errors point to exact fields.

Exit:

- existing generation is byte-compatible;
- Agent contracts and provider tests are green;
- no card or renderer Agent API exists yet.

Suggested commit: `feat: add agent contracts and provider adapter`

### Session 2 — One-call and tool-loop Harness

Objective: implement one provider-neutral Harness for both simple and tool-using Agents.

Add:

- `src/main/services/agentRuntime/harness/AgentHarness.ts`
- internal Harness files for attempt log, budget, repair, retry, result validation, and projection;
- `src/main/services/agentRuntime/tools/ToolRegistry.ts`
- `src/main/services/agentRuntime/tools/AttemptTransaction.ts`
- built-in read-only test tools;
- Harness tests driven only through `AgentHarness.execute`.

Do not expose internal repair/retry helpers as public Interfaces merely to make them easy to test.

Work:

- Build immutable prefix plus append-only attempt log.
- Implement one-call Agents as the same loop with `maxSteps: 1` and no tools.
- Validate tool availability and schemas before dispatch.
- Stage transactional tool operations and discard them on every unsuccessful attempt.
- Execute model-requested tools in order unless every binding is `parallelSafe`; append results in
  model-declared order regardless of completion.
- Apply 10,000-token default Tool Result Projection while retaining the full result in evidence.
- Implement bounded Protocol Repair without inventing semantic arguments.
- Suppress identical repeated-call storms.
- Implement five retries by default, five seconds between attempts, frozen preset/model, and
  `Retry-After` as a lower bound.
- Stop automatic retries once a non-transactional external effect begins.
- Start Corrective Retry with a fresh Harness Context and Attempt Transaction.
- Add context-budget attribution and non-retryable failure.

Required tests:

- text, JSON, tools-only, and YSS validators;
- one-call and multi-step tool Agents use the same Interface;
- wrong-channel/truncated tool-call repairs;
- unrecoverable arguments trigger Corrective Retry;
- transaction rollback on failure, abort, and retry;
- non-transactional retry cutoff;
- parallel-safe completion order differs while appended order stays stable;
- retry delay and `Retry-After` with fake timers;
- fixed provider/preset/model across attempts;
- complete tool result retained, projected result capped;
- max-step and repeated-call termination.

Exit:

- a scripted provider can execute the entire Harness contract in process;
- the Harness has no floor, UI, workflow, or card imports.

Suggested commit: `feat: implement provider-neutral agent harness`

### Session 3 — Agent Catalog, imports, and role bindings

Objective: persist the profile-wide Agent library and make effective definitions deterministic.

Add:

- `src/main/services/agentRuntime/catalog/AgentCatalog.ts`
- catalog store and import/export implementation;
- built-in Classic Narrator and Yuzu Scene Director definition resources;
- profile database migration;
- catalog tests.

Change:

- `src/main/types/character.ts`: add strict `agents[]` and optional role recommendations; leave
  `workflows[]` readable until final removal;
- character import/install service;
- profile deletion/export logic as required;
- settings types only for role-facing defaults that do not belong in an Agent Definition.

Work:

- Store baseline, customization, effective hash, source identity, enabled state, and version.
- Enforce one Agent Name across built-in, user, and card sources.
- Require incoming rename on collision; atomically rewrite references in that imported declarative
  package.
- Implement edit, restore, explicit upgrade/diff, disable, and permitted delete.
- Prevent disabling/deleting an Agent bound to Classic or Yuzu until replacement.
- Avoid the existing `settings.agent` manual-FSM naming collision; new code uses `AgentCatalog` and
  role bindings, not that settings field.
- Keep `.rptagent` Agent Definition import distinct from legacy `.rptagent` workflow pack files by
  validating `format: "rpt-agent"` before install. Legacy pack files remain unsupported and inert
  after cutover.

Required tests:

- profile-wide collisions across all sources;
- rename transaction and deliberate breakage of external literal card-script references;
- customization/restore;
- source upgrade with valid and conflicting customized fields;
- source-backed removal constraints;
- role-binding constraints;
- card Agent installs enabled without an approval wizard;
- malformed or legacy pack import cannot enter the new Catalog.

Exit:

- Catalog is usable from main-process tests;
- built-ins exist but generation still uses the old workflow path.

Suggested commit: `feat: add profile agent catalog`

### Session 4 — Run Records and activity read model

Objective: make every invocation observable and independently interpretable before exposing it.

Add:

- `src/main/services/agentRuntime/runs/AgentRunStore.ts`
- session database migration for floor-owned run records;
- main event broadcaster and typed IPC read/cancel surface;
- renderer `agentRunStore.ts` and a minimal activity list that is not yet a full editor.

Change:

- `src/main/services/sessionDbService.ts`
- `src/preload/index.ts` and `index.d.ts`
- `src/renderer/src/App.tsx`
- existing activity/failure stores, replacing their data source without deleting workflow events yet.

Work:

- Persist immutable definition/config/input/prompt snapshots, attempts, repairs, tool evidence,
  result/failure, replay outcome, and metrics.
- Exclude raw reasoning.
- Key live cancellation by Invocation ID.
- Always show live activity; apply notification `none`, `failure`, or `completion` only to additional
  notifications.
- Delete records when their owning floor is deleted.
- On app shutdown, cancel unfinished invocations cleanly; do not implement restart resumption.

Required tests:

- record remains readable after Agent edit/delete;
- no reasoning field or reasoning text is stored;
- floor deletion removes completed and in-flight records;
- Stop targets one invocation without stopping independent calls in the same chat;
- activity is visible even with notification `none`.

Exit:

- scripted Harness invocations can be observed through the typed main/preload/renderer surface;
- no card-facing run method is enabled.

Suggested commit: `feat: persist agent runs and activity`

### Session 5 — Floor operation journal and atomic Forward Replay

Objective: establish the state foundation before any background Agent can write.

Add:

- `src/main/services/agentRuntime/floorState/FloorState.ts`
- pure replay calculator;
- `floor_operations` session migration and compatibility importer;
- transaction helpers that operate on one chat session database;
- floor-state tests using real SQLite.

Change:

- `src/main/services/generation/varsWrite.ts`
- `src/main/services/varsOpsService.ts`
- `src/main/services/floorService.ts`
- `src/main/services/generationService.ts`
- `src/main/services/chatWriteService.ts`
- variable editor write path;
- table operation integration only where variable replay and table replay must share one commit
  boundary.

Work:

- Journal model, card, user, and Agent operations in deterministic `(floor, seq)` order.
- Validate full rooted paths at the Interface; translate internally to JSON Patch as needed.
- Make ordinary variable editor writes floor-scoped and journaled.
- Keep `variables.__rpt` read-only outside Result Incorporation.
- Compute an entire suffix against copies, including response MVU folds and existing card/user ops,
  before any save.
- Commit the affected floor snapshots and operation rows in one transaction.
- Reject or roll back the whole suffix on any operation/schema/persistence failure.
- Emit state-refresh once after success and never `floor:committed`.
- Preserve current truncation, swipe, edit, and table replay semantics.

Required tests:

- floor 12 operation followed by exact floor 13+ reconstruction;
- user edit survives later replay and disappears when its floor is deleted;
- card writes retain current behavior;
- reserved path rejection;
- failure on the last replayed floor leaves every original floor unchanged;
- transcript changes during compute cancel before commit;
- old `vars_ops` rows replay identically after non-destructive migration;
- state-refresh emits once; floor commit emits zero times.

Exit:

- existing generation and variable editing use `FloorState`;
- `generationService.reevaluateVariables` delegates instead of owning replay mechanics;
- all pre-Agent floor behavior remains green.

Suggested commit: `feat: add atomic floor replay and operation journal`

### Session 6 — Invocation Runtime, lanes, plans, and deletion

Objective: connect Harness results to their Invocation Floors with correct concurrency semantics.

Add:

- `src/main/services/agentRuntime/invocation/InvocationRuntime.ts`
- lane, plan, input-resolution, cancellation, barrier, and incorporation internals;
- invocation integration tests with scripted providers and real session SQLite.

Change:

- floor cut/edit listener registration at the main composition root;
- Run Store lifecycle events;
- FloorState incorporation Interface.

Work:

- Coalesce duplicate `(chat, floor, Agent Name)` calls.
- Serialize the same Agent by floor within a chat.
- Resolve bindings only after earlier lane work incorporates.
- Run different Agents in explicit flat parallel groups without conflict inference.
- Stop the rest of a required sequence on final failure; continue after optional failure.
- On floor deletion, abort, discard staged state and late responses, erase the Run Record, and cancel
  active/queued plan members.
- On a stale transactional input snapshot, cancel and restart without consuming retry count.
- Reject restart after a non-transactional external boundary.
- Incorporate result, result slot, transaction operations, record outcome, and suffix replay as one
  logical operation.
- Implement Next-turn Barrier state, but do not yet bind it to Player Generation.

Required tests reproduce the approved cases exactly:

- floor 12 call, delete floor 12, immediate abort and no response/record;
- floor 12 call, create floor 13, late incorporation into 12 and deterministic replay of 13;
- same Agent on floors 12 and 13 waits, incorporates 12, then resolves 13 input and starts;
- author-declared parallel Agents start together and incorporate independently;
- duplicate same-Agent/same-floor call returns the existing promise/result;
- nested parallel and duplicate plan membership fail validation;
- cancellation propagates through a plan;
- required and optional failure policies;
- stale snapshot restart and non-transactional rejection.

Exit:

- main-process invocation semantics are complete through one deep Interface;
- no public card scheduling API yet.

Suggested commit: `feat: add floor-owned agent invocation runtime`

### Session 7 — Card Agent API and card-owned scheduling

Objective: expose asynchronous execution and floor commit events at inline/WCV parity.

Add:

- `AgentHost` facet and public `rpt.agents` runtime assembly;
- main/preload/renderer IPC for Agent calls, plans, tool callbacks, aborts, and floor events;
- card runtime parity fixtures.

Change:

- `src/shared/thRuntime/hostFacets.ts`
- `src/shared/thRuntime/types.ts`
- `src/shared/thRuntime/index.ts`
- `src/shared/thRuntime/nullHost.ts`
- `src/shared/thRuntime/wcvChannelSpec.ts`
- `src/renderer/src/cardBridge/host.ts`
- `src/renderer/src/cardBridge/createCardBridge.ts`
- `src/preload/wcvHost.ts`
- `src/preload/wcvPreload.ts`
- `src/main/ipc/wcvIpc.ts`
- main renderer IPC and preload surface;
- `docs/rpt-api.md` and `docs/sdk/component-inventory.md`.

Work:

- Implement `run`, `runPlan`, `registerTool`, and `onFloorCommitted`.
- Allow direct JSON input.
- Scope calls and tool implementations to the bound profile/chat/card; ignore caller-supplied scope
  IDs at privileged boundaries.
- Make tool request/result transport correlated, abortable, ordered, and size-limited.
- Reject unavailable/unmounted card tools before provider dispatch.
- Emit current and previous variables with one causative floor commit.
- Ensure replay and card variable refresh cannot trigger the commit handler.
- Document monthly property/world progression as card-side example code.

Required tests:

- null Host, inline Host, and WCV Host expose the same shape;
- both transports execute identical run/plan fixtures;
- direct JSON input round-trips without stringification ambiguity;
- tool registration/unregistration and abort;
- context spoofing is rejected;
- floor event fires once after commit and never after replay;
- monthly example does not double-run after a late result;
- same-Agent duplicate from a repeated handler coalesces.

Exit:

- card authors can schedule background Agents;
- Classic player turns still use the workflow path;
- no scheduler exists in RPT.

Suggested commit: `feat: expose card agent runtime`

### Session 8 — Classic Narrator and Pending Floor cutover

Objective: remove the workflow engine from every Classic player-facing generation path.

Add:

- `PlayerGeneration` Module;
- Classic prompt-builder Adapter around existing prompt assembly;
- Pending Floor lifecycle and tests.

Change:

- `src/main/services/generationService.ts`
- `src/main/services/generation/assemble.ts`
- `callModel.ts`, `parseResponse.ts`, and `persistFloor.ts` as required;
- `rawGenerate.ts` controller ownership;
- regeneration/swipe handlers;
- prompt preview service;
- streaming/activity bridge.

Work:

- Bind the built-in Classic Narrator by default.
- Capture the user message in a Pending Floor.
- Run the Narrator through `AgentHarness`.
- Preserve current prompt ordering, macros, regex, lore, table injection, persona, token trimming,
  provider shaping, metrics, streaming, and response fold behavior.
- Store final text as canonical `response_content`, then commit the floor once.
- Fire `floor:committed` only after commit.
- Wait for required Next-turn Barriers before resolving Narrator bindings.
- On cancellation/final failure, discard Pending Floor and restore the user input.
- Route normal generate, regenerate, swipe, and card `generate(text)` through the same role.
- Replace workflow-based prompt preview with direct prompt assembly.
- Do not fall back to `runWorkflow`.

Required tests:

- byte-level Classic prompt parity for representative presets/cards;
- normal success, stream, cancellation, provider failure, and retry;
- Pending Floor is never visible as a committed floor;
- input restoration on failure/cancel;
- regeneration and swipe preserve ownership and delete/cancel affected Agent runs;
- required barrier success/failure and optional barrier release;
- RPM/concurrency shared with background Agents across chats;
- exact floor event order.

Exit:

- no Classic generation call reaches `workflowEngine.ts`;
- Classic can complete all existing generation parity suites through the Harness;
- workflow code remains present only for deletion and any not-yet-extracted non-Classic capability.

Suggested commit: `feat: cut classic generation over to narrator agent`

### Session 9 — Yuzu Scene Director

Objective: run Project Yuzu through the same PlayerGeneration and Harness path.

Change:

- `src/main/services/yuzu/vnPrompt.ts`
- `src/shared/yuzu/sceneGrammar.ts`
- YSS parser/validator and stage-command integration;
- Yuzu renderer state only where warnings need presentation;
- PlayerGeneration role selection and Run Record warnings.

Work:

- Bind built-in `yuzu.sceneDirector`.
- Keep Yuzu output mode as text, not JSON.
- Accept canonical raw YSS mixed with narration text.
- Validate line by line and identify the exact failed line and reason.
- Use Corrective Retry for invalid output.
- After final validation failure, commit narration-only degraded output, preserve warnings in the Run
  Record, and show the player where parsing failed.
- Feed valid commands to the existing deterministic stage parser; never make the model's tool
  protocol the YSS storage format.

Required tests:

- valid mixed narration/YSS storage and stage derivation;
- invalid line location and message;
- repair/retry isolation;
- narration-only fallback after configured attempts;
- cancellation and swipe;
- Classic/Yuzu role compatibility validation;
- no JSON coercion of YSS.

Exit:

- both Player-facing modes use AgentHarness;
- Yuzu warnings are visible and attributable to a Run Record.

Suggested commit: `feat: run yuzu through scene director agent`

### Session 10 — Complete Agent Workspace

Objective: replace the graph editor with the flat library/editor/plan/activity experience.

Add:

- `src/renderer/src/components/agents/AgentWorkspace.tsx`
- library, form editor, prompt-binding editor, result/tool/history/model/retry sections;
- ordered Plan editor with flat parallel groups;
- Agent diff/restore/import/rename surfaces;
- Run detail and Manual Invocation surfaces;
- dedicated Zustand store and typed IPC.

Change:

- workspace navigation and lazy routes in `App.tsx`/view registry;
- settings links and localization;
- activity/failure presentation;
- variable editor: permit ordinary user paths and keep `variables.__rpt` visibly read-only.

Work:

- Expose every approved Agent option with defaults visible and editable.
- Show source, version, enabled state, role bindings, last activity, and restore state.
- Validate in the responsible field and prevent activation.
- Support Run now with direct JSON on the latest committed floor.
- Support plan JSON import/export and restrictive visual list editing; do not persist plans as runtime
  objects.
- Show full Run Record evidence except raw reasoning.
- Do not reproduce a canvas, ports, edges, nodes, arbitrary branching, or a workflow compatibility
  view.

Required tests:

- Catalog edit/restore/rename/upgrade UI;
- collision rename flow;
- role replacement before disable/delete;
- every configuration field round-trips;
- flat parallel plan authoring and invalid nested input;
- manual invocation identity/coalescing;
- activity Stop and failure location;
- Result Slots displayed read-only in the variable editor.

Manual verification:

- edit a built-in and Restore to default;
- import a colliding Agent and rename it;
- run a text and JSON Agent;
- inspect an attempt with a tool call and retry;
- stop a live invocation;
- use keyboard-only navigation through the Workspace.

Exit:

- every Agent Runtime function is operable without the workflow editor;
- no workflow UI is needed for Classic, Yuzu, background, import, inspection, or debugging.

Suggested commit: `feat: replace workflow canvas with agent workspace`

### Session 11 — Extract remaining capabilities and delete workflow

Objective: make the atomic product cutover complete.

Before deletion, classify every node implementation:

| Node family                                                                | Required disposition                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| generation/context/prompt/message/preset/lore nodes                        | Already replaced by PlayerGeneration prompt assembly; delete node wrappers.                                                                |
| `agent.llm`, history, memory recall/maintain, notes maintain               | Re-express only still-supported operations as built-in Agents or explicit built-in Tools over their direct services; delete node wrappers. |
| table read/query/apply/export                                              | Bind needed direct table services as explicit Tools; keep table storage/replay, delete workflow nodes and cadence gates.                   |
| combat/duel/lore search tools                                              | Bind direct services as explicit Tools with existing privilege checks.                                                                     |
| vars/MVU nodes                                                             | Replaced by FloorState operations and card/tool Interfaces; delete wrappers.                                                               |
| triggers, controls, templates, merge/trim, subgraphs, checkpoints, modules | Delete as workflow-only authoring/control glue.                                                                                            |
| logging-only nodes                                                         | Delete; Harness/Run Record diagnostics replace them.                                                                                       |

Delete:

- `src/shared/workflow/`
- `src/main/services/workflowEngine.ts`
- workflow service/store/events/headless trigger and workflow lore-pick files;
- node registry and every built-in node wrapper;
- agent-pack store/service/materialization/transfer/trigger files;
- workflow and agent-pack IPC registration;
- renderer workflow components, canvas CSS, stores, routes, traces, panels, and old failure/activity
  event handlers;
- preload workflow/agent-pack surface and types;
- `.rptflow`, `.rptmodule`, recipe, fragment, checkpoint, attachment, and effective-graph
  import/export paths;
- seeded workflow examples and workflow-only localization;
- `@xyflow/react` if `rg` proves no non-workflow consumer;
- workflow-only tests after equivalent Agent Runtime tests exist.

Change:

- remove `workflows[]` from the active World Card schema and importer while preserving unknown legacy
  extension data losslessly;
- stop reading workflow selections and `chat.workflow_id`;
- leave Legacy Workflow Data tables/rows/files inert on disk;
- remove the workflow dependency-cruiser rule and retain the new AgentContracts purity rule;
- replace workflow references in packaging, examples, current code comments, and active UI copy.

Required searches must return no active runtime imports:

```text
rg -n "shared/workflow|workflowEngine|runWorkflow|workflowService|workflowStore" src test
rg -n "WorkflowEditor|workflow-trace|workflow-activity|agent-pack-" src
rg -n "\\.rptflow|\\.rptmodule|effective graph|checkpoint attachment" src resources
rg -n "@xyflow/react" src
```

Historical docs and superseded ADR bodies are not rewritten merely to make a repository-wide word
search empty.

Exit:

- no workflow code is compiled, registered, routed, or selectable;
- Classic, Yuzu, card scheduling, tools, plans, replay, deletion, and visibility pass;
- dependency removal is reflected in lockfile;
- old workflow data is untouched and ignored.

Suggested commit: `refactor: remove workflow system`

### Session 12 — Living contracts, migration audit, and merge gate

Objective: prove the branch is a complete replacement rather than a parallel experiment.

Update:

- `README.md`
- `CLAUDE.md`
- `CONTEXT.md`
- `docs/current-status.md`
- `docs/documentation-catalog.md`
- `docs/rpt-api.md`
- `docs/plugin-api.md`
- `docs/sdk/README.md`
- `docs/sdk/component-inventory.md`
- `docs/compat-comparison.md`
- status header of `docs/world-card-design.md`
- Agent Runtime design/plan status lines;
- any release notes or packaging checks required by the target release.

Remove or supersede:

- `docs/sdk/workflow-module-format.md`;
- active workflow instructions in living documentation;
- current examples that tell authors to use nodes, graph triggers, packs, or recipes.

Do not rewrite historical plan/ADR bodies. Update lifecycle headers/catalogue entries or add explicit
supersession notes.

Final automated gate:

```text
npm.cmd run typecheck
npm.cmd run check:deps
npm.cmd run test
npm.cmd run check:docs
npm.cmd run build
```

Final manual matrix:

- Classic normal generation, stop, retry, regeneration, and swipe;
- Yuzu valid stage, invalid-line warning, corrective retry, and degraded narration;
- monthly property/world Agent calls from a real card;
- same Agent on consecutive floors;
- independent Agents in parallel;
- late result replay with a newer floor;
- deletion of an in-flight Invocation Floor;
- journaled latest-floor and historical variable edits;
- built-in edit/restore, card Agent import, collision rename, role replacement;
- Run Record inspection and Stop;
- at least one OpenAI-compatible, Anthropic, Gemini, DeepSeek Flash, and DeepSeek Pro preset where
  credentials are available;
- RPM/concurrency behavior across two chats;
- app restart with in-flight work cancelling without partial state.

Exit:

- all gates pass or every pre-existing exception is documented with unchanged evidence;
- the implementation contains one Agent system and no workflow product surface;
- the branch is ready for owner review and eventual replacement of the workflow-bearing branch.

Suggested commit: `docs: finalize agent runtime cutover`

## 6. High-risk checkpoints

### Provider protocol

Do not implement DeepSeek-specific behavior in `AgentHarness`. Provider Capability Profiles select
schema normalization, reasoning-channel handling, cache metrics, and repair support. Test each
behavior against normalized fixtures before live API checks.

### Atomic replay

Forward Replay is the highest data-integrity risk. Its calculator must be pure and deterministic;
the database write happens only after the full suffix validates. Use a real SQLite regression test
that injects a failure late in the suffix and proves byte-for-byte preservation of all original
floor variables.

### Card tool lifetime

A card-supplied tool is available only while its scoped handler is registered. Preflight all required
bindings before the provider call, propagate aborts, and reject late callback responses after
unregistration or floor deletion. Never keep renderer function references in main-process state.

### Classic parity

Do not rewrite prompt assembly during cutover. First place the existing implementation behind the
PlayerGeneration Interface, prove parity, and deepen/refactor it only after the workflow system has
been removed.

### Workflow deletion

Deletion is a capability audit, not a directory removal. A workflow node that wraps a useful table,
memory, combat, lore, or generation service may be deleted only after the surviving capability has a
non-workflow caller and tests through its new deep Interface.

## 7. Completion definition

The Agent Runtime replacement is complete only when:

- every model-backed Player-facing and background call uses `AgentHarness`;
- Agent Definitions from built-in, user, and card sources share one Catalog and unique-name domain;
- cards own scheduling and can use direct results or explicitly bound tools;
- every result and operation is floor-owned, rewindable, and replayed deterministically;
- the two approved deletion/late-result cases and same-Agent lane edge case pass with real
  persistence;
- Classic and Yuzu use role-bound Agents with no model escalation;
- activity and failures are visible at the responsible Agent/attempt/binding/tool/line/replay step;
- all Agent options are editable with Restore to default where a source baseline exists;
- the workflow engine, nodes, canvas, packs, formats, runtime data reads, and workflow-only dependency
  are absent from the product;
- Legacy Workflow Data remains inert and untouched; and
- the full automated and manual cutover gates pass.

## 8. Implementation log

### 2026-07-19 — Classic Narrator plan Milestone 4 implemented

Status: Milestone 4 of the [Classic Narrator first execution plan](classic-narrator-first-execution-plan.md)
is implemented on `agent-system` **in the working tree, uncommitted**. Milestones 1 (`b707a66`),
2 (`ab87f3f`), 3 (`f9ba3bc`), and 5 (`ee84f3f`) are committed and were not modified. Milestone 6
remains planned. Nothing was removed.

**One signal, six sources.** The plan says "the authoritative live-run registry"; there is no single
one. `hasActiveBackgroundWork()` (`src/main/services/activeWork.ts`) is therefore the union of six
read-only accessors, each added to the owner of the state rather than reaching into its internals:

| Source                 | Accessor                       | Covers                                                            |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `InvocationRuntime`    | `hasActiveWork()`              | Agent invocations queued or running; stepping plans                |
| `generationService`    | `hasActiveTurns()`             | a MAIN Classic turn in flight (pre phase)                          |
| `rawGenerate`          | `hasActiveRawGeneration()`     | the `activeControllers` map only — a turn or a bare `generateRaw`  |
| `tableBackfillService` | `hasActiveBackfill()`          | a manual multi-batch table backfill mid-job                        |
| `tableRefillService`   | `hasActiveRefill()`            | a manual multi-batch table refill mid-job                          |
| `headlessRunService`   | `hasActiveTriggerEvaluation()` | a pack-path or doc-path trigger evaluation in flight               |

Each accessor is synchronous and returns a boolean; none exposes mutation. The backfill and refill
accessors read each run's `state.running` rather than their map size: a settled run's entry is kept so
a re-mounting view can read its final state, so a size check would latch true after the first job.

**The direct-provider sweep.** The class of bug is: anything reaching the provider outside `generate()`
is invisible to the signal by construction, because `callModel` deliberately leaves the controller
lifecycle to `generate()` and never registers in `activeControllers`. Every caller was enumerated:

| Caller                                             | Disposition                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `rawGenerate.generateRaw` (combat, duel, TH script) | covered — `hasActiveRawGeneration()`                                     |
| `tableBackfillService` (`table-backfill-start`)     | covered — `hasActiveBackfill()`                                          |
| `tableRefillService` (`chat-tables-refill`)         | covered — `hasActiveRefill()`                                            |
| agentRuntime Harness dispatch                       | covered — `InvocationRuntime.hasActiveWork()`                            |
| the five `runLlmCall` nodes — `llm.sample`, `agent.llm`, `memory.recall`, `memory.maintain`, `notes.maintain` | covered transitively — they run under `runWorkflow`/`runSubgraph` (entered from a turn or from headless trigger evaluation) or under Milestone 3's direct Classic path, which reaches `runLlmCall` without the engine; all three entries are already sources |
| `tableMaintainerLoop.runMaintainerBatch`            | not an entry point — its only callers are backfill and refill above      |
| `previewService`                                    | reaches the provider, left uncovered deliberately — see below            |

**Why preview is uncovered.** Preview does *not* avoid the provider, and an earlier draft of this
entry claimed it did. `buildPreviewRegistry` stubs only `llm.sample` plus the eight
`SIDE_EFFECT_TYPES`; none of the other four `runLlmCall` node types appears in either set, so they run
their real implementations. `memory.recall` feeds `prompt.assemble`'s `block` input, so it executes
*before* the `llm.sample` stub's `abortGraph()` fires — previewing any chat whose effective doc carries
a recall node makes a real, untracked provider call.

It is still left uncovered, as a judgement rather than an oversight: quitting mid-preview discards
nothing durable. Recall writes no state, and the post-phase writers (`memory.maintain`,
`notes.maintain`) genuinely are skipped by the abort, so the cost is a wasted API call — categorically
unlike the backfill/refill hole, which lost memory-table writes. This should be re-evaluated if
preview ever gains a durable writer upstream of the stub.

The `rawGenerate` source's coverage was briefly overstated in this entry and in two source comments as
"any provider call in flight". It is not: it covers the `activeControllers` map only, which is exactly
why backfill and refill needed their own accessors. Corrected in all three places.
`InvocationRuntime.hasActiveWork()` reads `lanes` and `plans` for queued/running work and scans
`invocations` by its `finished` flag: that map is the identity/dedupe ledger and is not pruned on
success, so a size check would latch true forever.

The raw-provider source is not optional and is **not** a subset of the turn guard — an earlier draft of
this entry claimed it was, which was factually wrong. It is retained here as the corrected record.

`combatService` (adjudication, enemy turns) and
`duelService` (narration) call `generateRaw` directly from their own IPC handlers, entirely outside
`activeTurns`, and that work writes to the chat via `writeNarrationToChat`; without this source the
signal read false while it was in flight and the app quit and discarded it silently. The two maps
overlap rather than nest and both are required: `activeControllers` is keyed per chat and shared with
`generate()`, so a raw call starting mid-turn overwrites the turn's entry and then deletes the shared
key in its `finally` — it can go empty while a turn still runs, and is non-empty for raw work the turn
map never sees.

The one genuinely excluded source is `AgentRunStore`'s persisted `status = 'running'` rows. Those are
durable records that outlive the process, so after a crash they still read "running" for work that is
long dead; they answer "what was interrupted", not "what is in flight now".

**Interception.** The app had no close handler at all; this milestone adds the first. `before-quit`
covers macOS Cmd-Q, the dock's Quit, and every programmatic `app.quit()`. The window's `close` event
is guarded only outside macOS: `window-all-closed` is already wrapped in `if (process.platform !==
'darwin')`, so off macOS the close button really does cascade into `app.quit()` and discard work,
while on macOS it leaves the app and its background work running — prompting there would be a false
alarm and would change what the close button means. `will-quit` is too late to stop an exit.

The third terminating surface is the `restart-app` IPC channel (`storageIpc.ts`, reachable from
Storage settings), which calls `app.relaunch()` + `app.exit(0)`. `app.exit` emits neither
`before-quit` nor `will-quit` by design, so it bypassed the guard *and* skipped shutdown cleanup
(the cleanup skip was pre-existing). It now awaits the same guard and, once cleared, calls the same
cleanup explicitly before terminating. The `will-quit` body moved verbatim into
`runShutdownCleanup()` (`src/main/appExit.ts`) so both paths run one implementation; it is idempotent
and each half is individually try/caught, so running it twice is harmless.

If `app.relaunch()` throws, the restart handler's `finally` calls `releaseConfirmation()`: the process
is then still alive, already cleaned up, with the latch armed, and the next quit would otherwise skip
its confirmation. `app.exit(0)` does not return, so that `finally` runs only on the failure path.

The decision logic lives in `src/main/exitGuard.ts`, free of electron, so it is testable;
`src/main/appExit.ts` holds the single guard instance wired to the real signal,
`dialog.showMessageBox`, and `app.quit`, shared by `index.ts` and `storageIpc.ts` so all three
surfaces share one `confirmed` latch and one `prompting` flag. Because `showMessageBox` is async and
`preventDefault()` cannot await, the event-driven entry point always prevents, then re-issues the quit
after the answer: the `confirmed` latch lets the re-issued quit and its cascading events pass straight
through, and `prompting` makes a second close action while the dialog is open prevent-and-drop rather
than stack a dialog or double-quit. `restart-app` can await, so it uses a sibling `confirmExit()` that
shares the same two flags — a restart requested while a quit dialog is open declines rather than
stacking. Both entry points keep the same idle short-circuit: one synchronous boolean, no dialog.

This only GATES the existing shutdown path. `will-quit` → `shutdownInvocationRuntime()` already aborts
plans and invocations with `APP_SHUTDOWN` and finalizes live run controllers as cancelled, idempotently;
no cancellation was duplicated and its idempotence was not weakened. No recovery, resumption,
negotiation, or lifecycle framework was added — those stay out of scope.

**Known, accepted gap.** The detached post-turn chain in `generationService`
(`summarizeRun`/`notifyWorkflowTrace` → `appendRun` → `evaluateTriggers`/`evaluateDocTriggers`) runs
*after* `activeTurns.delete` in the turn's `finally`. Only the trigger phase is covered, and only once
it has entered its per-chat guard. The window between turn release and trigger-guard entry — run-trace
summarization and run-history persistence — is tracked by nothing, so a quit landing exactly there is
not warned about. Closing it would mean adding the lifecycle machinery this milestone forbids, so it
is recorded here rather than fixed.

Exit surfaces reviewed and deliberately NOT guarded: the renderer reload at `SettingsPanel.tsx` resets
UI only and drops nothing in main; chat switching already aborts per-chat and gets no confirmation.
Process-level termination that no handler can intercept (SIGKILL, a main-process crash, OS shutdown)
is out of reach by definition.

Tests: `test/exitGuard.test.ts` (no-work path is fully unchanged, prompt on active work, cancel keeps
the app open and still prompts next time, confirm quits exactly once and lets the cascade through, a
second close while the dialog is open neither stacks nor double-quits, a failing dialog stays open,
plus the six-source union); `test/rawGenerationSignal.test.ts` (a combat/duel-style `generateRaw` in
flight flips the signal and clears when it settles); `test/tableBackfill.test.ts` and
`test/tableRefillLifecycle.test.ts` (a real mid-job backfill / refill reads active and goes idle when
it finishes, with the settled run entry still present — pinning `state.running` over map size);
`test/restartAppExitGuard.test.ts` (restart with no work is unchanged, cancelling does not restart or
tear anything down, confirming runs the full cleanup in order before relaunch, and a throwing relaunch
disarms the latch so the next exit still prompts); and a queued/running/drained signal case in
`test/agentRuntime/invocationRuntime.test.ts`. Gates:
`npm run typecheck` PASS; `npm run test` PASS (359 files, 4153 tests); `npm run check:docs` at the
unchanged 72-broken-link baseline, no new breakage. `npm run check:deps` was not run — it aborts on a
Node 25.9.0 version gate before reading source.

### 2026-07-19 — Classic Narrator plan Milestone 3 implemented

Status: Milestone 3 of the [Classic Narrator first execution plan](classic-narrator-first-execution-plan.md)
is implemented on `agent-system` in the working tree; Milestones 1 (`b707a66`) and 2 (`ab87f3f`) are
committed and untouched. Milestones 4-6 remain planned. Nothing was removed: the workflow engine,
every node, and every workflow facility are intact, as Milestone 6's decision requires.

**The literal exit criterion was not met, deliberately.** The milestone as written says "no synchronous
Classic call reaches `runWorkflow`". Milestone 2's evidence — recorded in the entry below, and pinned by
`test/workflow/classicTurnInventory.test.ts` — proved that removing `runWorkflow` UNCONDITIONALLY is a
capability REGRESSION, which the plan could not know when it was written. Two production states break the
assumption: the resolved doc is a SAVED, USER-EDITABLE copy, so a node the user wires downstream of
`write` lands in the detached post phase and genuinely runs there; and opening an agent-pack gate splices
extra nodes into the very graph the turn executes. Deleting the engine from the path would silently drop
both. Preserving capability outranks the literal criterion, so this milestone ships a TWO-PATH design and
leaves the disposition of the workflow surface to Milestone 6, where it belongs.

Classic runs a direct orchestration only when a shape predicate says the resolved effective doc is
structurally the seeded default; every other doc keeps the existing `runWorkflow` path, completely
unchanged. The branch is one ternary in `generationService.generate` at the `runPromise` assignment.
Both paths resolve the same `RunResult`, so the turn lock, abort registration, `onResponseReady` race,
failure classification, trace broadcast, run-history persistence, and trigger chain are SHARED, not
duplicated.

The predicate (`src/main/services/generation/classicShape.ts`) has two parts, both required. Pack
composition is detected by `doc.meta.composition`, which `composeEffectiveGraph` stamps exactly when it
splices (it returns the narrator by identity when no gate is open). Doc shape is a STRUCTURAL comparison
against `buildDefaultMemoryDocV2()`, because there is no provenance signal for "unedited":
`createWorkflowFromDoc` stamps only a fresh id, `meta.seeded` is an idempotence marker that survives
every edit, and `saveWorkflow` rewrites verbatim with no version, hash, or dirty flag. The comparison
covers every node's `type`, `disabled`, `isMainOutput`, and `panel`, plus the whole edge set; `config` is
compared ONLY inside the turn phase — the `computePhases` pre closure, now exported from
`workflowEngine.ts` rather than re-derived, so the two definitions cannot drift. Scoping config to the
turn phase is load-bearing: the seeded doc's most user-visible knobs (`control.mode.selected`,
`trigger.cadence.everyNFloors`, the memory node's settings) are trigger-rooted and outside the turn
phase, so whole-doc equality would demote every user who merely switched memory Mode onto the workflow
path for no behavioral reason. Doc id, name, description, node position, and groups are ignored. The
predicate fails CLOSED: any mismatch routes to the unchanged engine.

The direct path (`src/main/services/generation/classicTurn.ts`) is eight awaited service calls in the
order Milestone 2 pinned — no pipeline, graph, hook bus, scheduler, or registry dispatch. It reuses the
existing services rather than copying them: `buildGenContext`, the newly extracted
`trimProcessedContext` and `exportTableEntries` (the node bodies moved into exported helpers that the
nodes now delegate to, so each has exactly one implementation), `matchWorldInfo` + `assemblePrompt`, the
newly extracted `sampleMainCall` (the whole `llm.sample` dispatch seam, including provider shaping, late
dispatch transforms, and the Milestone 1 Harness executor), `parseResponse` + `computeMetrics`,
`foldState`, and `persistFloor`. All four off-port channels are preserved deliberately: the one shared
`GenContext`, `gen.executionRecord`, `gen.floorStateBaseline`, and `gen.workingVars` BY REFERENCE — the
"PARITY HAZARD" whose loss fails no turn and raises no error, it just silently omits the variable from
the floor. `onResponseReady` fires after the durable write and before the hand-off; abort-with-empty
aborts the graph signal and returns null; abort-with-text still persists; a hard failure surfaces as a
fatal result.

Run history is NOT dropped on the direct path. `appendRun` in `generationService` records every turn, so
a path emitting no traces would silently delete Classic run history. Instead the direct path synthesizes
a full `RunResult` — the eight stages traced `ran` with real timings and their outputs, the five memory
nodes traced `skipped` with the same phases the engine assigns — so the existing `summarizeRun` →
`notifyWorkflowTrace` → `appendRun` block is reached unchanged and produces an equivalent record.

Coverage is parity-based, not one-sided: `test/generation/classicDirectParity.test.ts` runs the same turn
twice against the same mocked leaves, once per path, and compares the provider-bound message array and
sampler params AND the persisted floor (only the wall-clock stamps normalized away).
`test/generation/classicShape.test.ts` covers the predicate in both directions plus a comparator-rot pin,
and `test/generation/classicDirectGenerate.test.ts` covers routing, run history, and a mid-session edit
that flips the path between turns without changing the floor or the prompt. Note that
`test/generation/generateParity.test.ts` mocks `resolveEffectiveDoc` to the narrator spine fixture and
therefore cannot distinguish the two paths; it is not parity evidence for this milestone.

COMPARATOR ROT is the milestone's quiet failure mode: if `defaultMemoryTemplate.ts` changes without the
comparator being revisited, every user falls back to `runWorkflow` — correct, but invisible. The pinning
case in `classicShape.test.ts` fails first. It deliberately does not pin the memory group's config
defaults, which the comparator ignores by design.

The suites were mutation-checked rather than assumed to bite. Building the assembly template context
from a copy of `workingVars` (the real parity hazard) fails 2 tests including the persisted-floor
comparison; folding onto a copy fails 4; copying the whole `GenContext` fails 5; dropping the
`executionRecord` stamp fails 2; handing the response over before persisting fails 1 (after the timing
case was tightened to record every hand-off rather than only the last); letting abort-with-empty fall
through fails 1. On the predicate: ignoring `panel` fails 2, ignoring composition fails 1, comparing
config outside the turn phase fails 2, ignoring edges fails 1. On the template: adding a node, changing a
turn-phase node's default config, and rewiring each fail the rot pin.

Independent review returned PASS with two fixes, both applied. First, no test fed the predicate the
input production actually resolves — a JSON-round-tripped, `parseWorkflowDoc`-normalized SAVED doc, the
common case for any profile that has opened the workflows UI. The behavior was already right, but
unpinned: a later normalization change could have flipped everyone to the fallback with nothing failing.
`test/generation/classicShapeRoundTrip.test.ts` now seeds through the real lazy seeding path, resolves
through `resolveWorkflowDoc` and `resolveEffectiveDoc`, re-saves through `saveWorkflow`, and reads the
stored bytes straight off disk, asserting the direct route each time and the fallback for an edited save.
Perturbing normalization three ways — coercing a default `panel` onto every node, dropping an edge, and
injecting node config — fails 4 of its 5 cases each, while the in-memory predicate suite stays green,
which is the gap itself. Second, the synthesized trace appended its skipped-node rows last while the
engine seeds excluded trigger nodes first, so the Runs-timeline row ORDER differed between paths; the
parity comparison sorted and could not see it. The direct path now emits excluded rows first, pre-phase
rows next, and post-phase rows in the engine's topological order, and — matching `runNodes` — traces
NOTHING past a pre-phase fatal. The comparison no longer sorts and covers the happy, abort, and fatal
paths. Appending excluded rows last fails 3, tracing past a fatal fails 1, post rows out of topological
order fails 2.

Gates on darwin: `npm run typecheck` PASS; `npm run test` PASS — 356 files, 4131 tests (was 352 / 4077);
`npm run check:docs` expected baseline failure at 72 broken local links, unchanged by this work.
`npm run check:deps` was skipped: it aborts on a Node 25.9.0 version gate before reading any source.

### 2026-07-19 — Classic Narrator plan Milestone 2 implemented

Status: Milestone 2 of the [Classic Narrator first execution plan](classic-narrator-first-execution-plan.md)
is implemented on `agent-system` as characterization tests only. Nothing was removed and no production
behavior changed. Its Milestones 3-6 remain planned.

Two new suites pin what `runWorkflow` still contributes to a Classic turn, both running the real
production doc through the real engine and the real builtin node registry, with only leaf I/O faked:
`test/workflow/classicTurnInventory.test.ts` (the turn inventory) and
`test/workflow/classicDocResolution.test.ts` (doc resolution and pack composition).

The production doc holds 13 nodes. Exactly 8 run on a turn, all synchronous, all in the pre phase, in
this order: `input.context` (ctx), `context.trimProcessed` (trim), `table.export` (export),
`prompt.assemble` (assemble), `llm.sample` (llm), `parse.response` (parse), `apply.state` (apply),
`output.writeFloor` (write, `isMainOutput`). `llm.sample` is the only provider call on a turn.
`output.writeFloor` is the only durable-state writer: `saveGlobals`, `appendFloor`,
`saveExecutionRecord`, plus `FloorState.setBaseline` on floor 0 only.

Five nodes never run on a turn: `trigger.cadence` and `trigger.state` are `isTrigger` and removed by
`computeExcluded`; `control.mode` has both signal edges dead and is pruned by `gatedOff`;
`memory.maintain` — the doc's second model-backed node — takes its sole `when` from the pruned `mode`
and is structurally unreachable, firing only via `evaluateDocTriggers`; `util.log` is fed only by
`maintain.error`. Turn behavior is independent of the memory Mode setting.

Four off-port channels are pinned because a port-only rewrite would silently drop them: one mutable
`GenContext` object is threaded through every node; `prompt.assemble` stamps `gen.executionRecord`,
which `persistFloor` alone persists; `apply.state` stamps `gen.floorStateBaseline` on floor 0, which
`persistFloor` passes to `setBaseline`; and `gen.workingVars` is shared BY REFERENCE into the
template context during assembly (`assemble.ts`'s documented "PARITY HAZARD"), so a build-time
`{{setvar}}` mutates the same object `foldState` then folds this turn's events onto and `persistFloor`
writes. The last is the subtlest: dropping it fails no turn and raises no error, it just silently
omits the variable from the floor. Both recall nodes fail soft with no bound table
template: `table.export` returns no entries, and `context.trimProcessed` returns its input object
unchanged. The suites were mutation-checked rather than assumed to bite — dropping the
`executionRecord` stamp, making `trim` return a copy, disabling trigger exclusion, building the
template context from a copy of `workingVars`, folding onto a copy in `foldState`, and forcing gate
resolution always-open each fail 3, 4, 7, 2, 2, and 3 tests respectively.

Both previously inferred claims were traced, and both were more qualified than assumed.

Pack composition adds no nodes to a default Classic turn, but not because the zero-fragments default
provider is what runs. `agentPackService.ts` calls `setEnabledFragmentsProvider(enabledFragmentsFor)`
as an import-time side effect, so production runs the real provider. Nothing composes for two
independent reasons: `BUILTIN_PACKS` is empty (one-canvas rebuild WP6.2, ADR 0011 — the memory
experiences ship as example workflow docs, not seeded packs), so a fresh library installs no pack at
all; and an installed pack still contributes nothing until a gate is explicitly opened, since seeding
writes no activation row and "no row" resolves closed. Opening one gate does splice nodes into the
turn graph, so Milestone 3 cannot assume packs never contribute.

"No detached work" is a property of the default doc's shape, not of Classic. Once a profile has
opened any workflow UI, it no longer runs `BUILTIN_DEFAULT_DOC`: `seedDefaultMemoryWorkflow` writes
an editable profile copy of `buildDefaultMemoryDocV2` and selects it globally, and
`resolveWorkflowDoc` returns that saved file. The qualifier is load-bearing for Milestone 3's risk
assessment — seeding is LAZY and deliberately hooked only to `listWorkflows`, never to
`resolveWorkflowDoc` (a resolve-time seed would swap the doc under a running chat), so a profile that
has never opened workflow UI still resolves the builtin and keeps today's behavior. Both states are
reachable in production, and only the first is editable. The seeded copy has the same node and
edge shape, so the inventory above holds for it, but it is user-editable and is resolved verbatim. A
doc with a node downstream of `write` puts that node in the detached post phase, where it runs — so
removing `runWorkflow` from the synchronous Classic path drops that capability for edited docs rather
than being a no-op. On the default doc the post phase holds only already-excluded nodes; the genuinely
detached turn work (trace summarize plus `notifyWorkflowTrace`, `appendRun`, `evaluateTriggers`,
`evaluateDocTriggers`) lives outside `runWorkflow`, chained on `runPromise` in `generationService`.

### 2026-07-19 — Classic Narrator plan Milestone 1 implemented

Status: Milestone 1 of the [Classic Narrator first execution plan](classic-narrator-first-execution-plan.md)
is implemented and reviewed on `agent-system`. Its Milestones 2-6 remain planned.

`AgentHarness` gained an internal prepared-request entry point, `executePrepared`, that takes an
already-final ordered message array plus a caller-resolved connection and performs exactly one
tool-less text step. It adds no harness policy, serialized input, history, addendum, corrective, or
tool message, never re-resolves a provider from settings, and owns no retry. The seam sits inside
`callModelResilient`'s retry loop as an opt-in executor threaded from the `llm.sample` node through
`runLlmCall`, `callModel`, and `streamProvider`, so provider shaping, late dispatch transforms,
preset substitution, RPM/concurrency, abort classification, usage, and retry each keep exactly one
existing owner. The `log('request', …)` at prompt assembly and `log('response', …, raw)` in
`callModel` remain the byte-accurate evidence; no `HarnessEvidence` record is built on this path.

Blast radius: every `llm.sample` node, not Classic Narrator alone. Classic's default graph is the
target, but the memory group template, the async memory pack, and the table memory pack instantiate
the same node type, so their background sampling also routes through `executePrepared`. This is
accepted rather than gated, because the seam is provider-invisible and byte-identical and
discriminating the two would add runtime machinery for no observable difference. `agent.llm`,
`memory.recall`, `notes.maintain`, and the recall nodes call `runLlmCall` directly and are unchanged,
as is `tableMaintainerLoop`'s direct `callModelResilient` use.

The workflow still owns prompt assembly, parse, floor persistence, and every secondary node; no
`InvocationRuntime`, Result Incorporation, run record, floor write, scheduling, `runPlan`, card
Agent, tool, or Workspace surface was added. Tests assert identical ordered messages and identical
serialized OpenAI, Anthropic, and Gemini body bytes with and without a registered dispatch transform,
streaming and final-text parity, real mid-stream and pre-output abort classification distinct from
provider error, and that no other `runLlmCall` consumer receives the executor.

### 2026-07-19 - Milestone 4 Session 7 implemented

Status: Session 7 is implemented, reviewed, and committed as `836143f`. Sessions 8-12 remain planned.

The shared card runtime now exposes `rpt.agents.run`, `runPlan`, `registerTool`, and `onFloorCommitted` through null, inline, and WCV Hosts. Main binds every invocation and card tool to authoritative profile/chat/card scope, preserves direct JSON, correlates and aborts bounded tool callbacks, unregisters implementations on teardown, and rejects missing or incompatible tools before provider dispatch. New-floor commits emit current and previous variables once; FloorState replay does not emit the scheduling event. Existing Invocation Runtime identity coalesces repeated same-Agent/same-floor handlers. Classic remains on the workflow path and no scheduler was added.
### 2026-07-19 — Milestone 3 accepted

Status: Milestone 3 Sessions 5–6 are implemented, reviewed, and accepted on `agent-system`.
Sessions 7–12 remain planned and unimplemented.

Session 5 introduced the general `floor_operations` journal and persisted pre-floor baselines while
retaining existing `vars_ops` rows as non-destructive compatibility data. Model folds plus card,
user, and Agent operations now use the FloorState path to compute and validate a complete suffix
before atomically committing transcript updates, operation rows, and reconstructed floor snapshots.
The generation, variable-edit, replay, and floor-deletion paths share that state foundation, and
unified deletion removes affected floors, floor operations, legacy variable operations, baselines,
and Run Records in one transaction.

Session 6 added the production `InvocationRuntime` composition over the Agent Harness, Run Store, and
FloorState. It provides floor-ordered per-chat/per-Agent lanes, top-level sequence and flat-parallel
plan semantics, duplicate invocation coalescing, invocation/plan/floor cancellation, deletion of
in-flight work and evidence, stale transactional source restarts, and one corrective retry budget
shared by Harness and Result Incorporation failures. Successful incorporation commits `RunStore`
evidence, the Agent result/Result Slot, staged operations, and FloorState suffix replay atomically.
Next-turn Barriers, activity Stop, and idempotent app shutdown are implemented.

This milestone does not expose the card public Agent API or move Classic/Yuzu Player Generation onto
the Harness, and it does not remove the workflow product surface; those remain Sessions 7–12.

### 2026-07-18 — Milestone 1 baseline

Status: Milestone 1 Sessions 0–2 are implemented and reviewed on `agent-system`, with commits
pending in the current working tree. The Session 0 baseline evidence recorded below is complete and
reviewed. Sessions 3–12 remain unimplemented.

Scripted provider fixtures now cover visible text, volatile reasoning, fragmented tool calls, usage,
rate limits, malformed arguments, and truncation under `test/agentRuntime/fixtures/`. Agent-facing
tests consume the fixtures without persisting raw reasoning.

Focused characterization coverage pins Classic `sendMessages` bytes and written floors, provider
shaping, floor-variable journal replay, regeneration and swipe orchestration, swipe selection/events,
and lenient YSS parsing/validation. Regeneration and generated swipes now exercise the public
`generationService` seam: both preserve the last user action and forward the correct generation type,
while generated swipes retain prior alternates and activate the appended response.

The focused baseline command was:

```text
npx.cmd vitest run test/generation/generateParity.test.ts test/generation/providerShape.test.ts test/varsOpsReplay.test.ts test/swipeHelpers.test.ts test/thEvents.test.ts test/yuzu/scene-validate.test.ts --configLoader runner
```

Result on 2026-07-18: PASS — 6 test files, 107 tests.

The 49 node types registered by `src/main/services/nodes/builtin/index.ts` have these cutover
dispositions:

| Disposition                                                                          | Registered node types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extract or re-express behind an Agent/tool Interface                                 | `llm.sample`, `agent.llm`, `history.recent`, `memory.recall`, `memory.maintain`, `notes.maintain`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Direct capability already exists; retain that capability and delete only the wrapper | `input.context`, `context.refresh`, `prompt.assemble`, `parse.response`, `apply.state`, `output.writeFloor`, `text.template`, `prompt.messages`, `merge.messages`, `messages.trim`, `mvu.set`, `tool.startCombat`, `tool.startDuel`, `tool.lorebookSearch`, `lorebook.select`, `lorebook.entries`, `prompt.preset`, `vars.get`, `vars.save`, `parse.extract`, `table.apply`, `table.export`, `table.read`, `table.query`, `context.history`, `context.card`, `context.persona`, `context.action`, `context.params`, `context.trimProcessed` |
| Workflow-only authoring/control glue; delete at atomic cutover                       | `control.if`, `control.switch`, `control.when`, `control.mode`, `util.log`, `table.gate`, `subgraph.input`, `subgraph.output`, `subgraph.call`, `subgraph.loop`, `trigger.state`, `trigger.cadence`, `trigger.manual`                                                                                                                                                                                                                                                                                                                       |

The Session 11 removal searches were run before deletion work. Baseline results:

| Search                                                                                          | Matching files |
| ----------------------------------------------------------------------------------------------- | -------------: |
| `rg -l "shared/workflow\|workflowEngine\|runWorkflow\|workflowService\|workflowStore" src test` |            129 |
| `rg -l "WorkflowEditor\|workflow-trace\|workflow-activity\|agent-pack-" src`                    |             25 |
| `rg -l "\\.rptflow\|\\.rptmodule\|effective graph\|checkpoint attachment" src resources`        |             21 |
| `rg -l "@xyflow/react" src package.json package-lock.json`                                      |              7 |

These matches are the removal baseline, not permission to delete early. They span the shared workflow
model, main services and IPC, preload types, renderer stores/editor, workflow and agent-pack tests,
seed/template references, plus the `@xyflow/react` dependency and its five source consumers.

The documentation gate was also run:

```text
npm.cmd run check:docs
```

Result on 2026-07-18: expected baseline failure — 61 broken local documentation links. The count
matches the pre-existing 61-link baseline; this Session 0 work introduced no additional broken link.
