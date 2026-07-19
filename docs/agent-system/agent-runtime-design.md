# Agent Runtime design

**Status:** Approved design; Milestones 1–3, Sessions 0–6, are implemented, reviewed, and accepted on
`agent-system`, with commits pending in the current working tree. Sessions 7–12 remain planned and
unimplemented.
**Decision date:** 2026-07-18.
**Supersedes:** the workflow/node authoring and execution model, ADR 0011, the unshipped
tool-loop portions of `docs/agentic-mode-design.md`, and the future-facing contract in
`docs/sdk/workflow-module-format.md`.

RP Terminal will replace its workflow/node system with a deliberately restrictive Agent Runtime.
Every model-backed operation, including the Classic Narrator and Yuzu Scene Director, runs through
one provider-neutral Harness. Cards decide when background work is useful; RP Terminal supplies
durable asynchronous execution, bounded tool use, floor ownership, transactional state changes, and
deterministic replay.

This document specifies the target system. The current workflow implementation remains the shipped
behavior until the atomic cutover described in [§20](#20-workflow-removal-and-atomic-cutover).

## 1. Why replace the workflow system

The node canvas made simple agent behavior expensive to understand and author. Most useful cases need
only:

1. a named prompt and model;
2. JSON input assembled from known state;
3. an optional bounded tool loop;
4. a text, JSON, or tools-only result;
5. a predefined sequence or an explicitly independent parallel group; and
6. a floor-owned place to store the result.

Edges, ports, modules, graph traversal, trigger nodes, graph composition, and a general workflow
editor add substantial learning and maintenance cost without improving those cases. Invocation Plans
therefore support only an ordered sequence and flat parallel groups. Conditional scheduling remains
ordinary card-side logic, and Result Slots replace data-flow edges.

### Goals

- One mandatory Harness for one-call and tool-using Agents.
- Provider-neutral behavior across OpenAI-, Anthropic-, Gemini-, and DeepSeek-compatible APIs.
- Strong floor ownership for asynchronous background results.
- Card-owned scheduling, including in-game variable and time triggers.
- Direct JSON input, schema-validated JSON results, and raw text results including YSS.
- Deterministic state incorporation, rewind, user variable editing, and late-result replay.
- Restrictive, form-based authoring that is easier than general visual programming.
- Complete removal of the workflow runtime, editor, formats, and compatibility surface.

### Non-goals

- A general-purpose workflow language or agent-to-agent delegation.
- Runtime conditionals, loops, recursion, nested plans, or plan-to-plan calls.
- Automatic model escalation, including Flash-to-Pro escalation.
- Cross-invocation conversation memory or automatic context compaction.
- RP Terminal interpreting card variables as schedules.
- Migration or lossy conversion of `.rptflow`, `.rptmodule`, or workflow graph data.
- Durable continuation of in-flight Agent Invocations across app restart in the first implementation;
  that decision is deferred.

## 2. Core runtime model

An **Agent** is the only installed and uniquely named executable model entity. It contains one
responsibility, an ordered prompt, an input contract, a Result Contract, declared tools, and execution
defaults. Agents never invoke or schedule other Agents.

Every invocation uses the same **Agent Harness**:

- A one-call Agent has no tools and exactly one Agent Step.
- A tool-using Agent may choose among its declared tools and defaults to eight Agent Steps.
- Each retry starts with a fresh Harness Context, step budget, and Attempt Transaction.

An **Invocation Plan** is an ordinary validated JSON value. Its top level is an ordered sequence; a
step is either one Agent call or a flat parallel group containing only Agent calls. It is not
installed, named, versioned, bound, or callable by reference.

The runtime has no agent-to-agent call mechanism. A card script may await one Agent and then invoke
another, but RP Terminal sees two ordinary invocations ordered by the caller or by an Invocation Plan.

## 3. Agent Definitions, sources, and identity

### 3.1 One declarative definition

All Agents use the same versioned JSON definition shape whether they are:

- built into RP Terminal;
- imported into the user's profile library as `.rptagent`; or
- bundled in a World Card under `data.extensions.rp_terminal.agents[]`.

An Agent Definition contains no executable code. A representative definition is:

```json
{
  "format": "rpt-agent",
  "formatVersion": 1,
  "name": "Property Management",
  "description": "Calculates monthly property development.",
  "prompt": [
    {
      "role": "system",
      "content": [
        {
          "type": "text",
          "text": "Update the player's properties using only supplied facts."
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "binding",
          "source": {
            "type": "variables",
            "path": "variables.stat_data.玩家.产业"
          }
        }
      ]
    }
  ],
  "inputSchema": {
    "type": "object"
  },
  "result": {
    "mode": "json",
    "schema": {
      "type": "object",
      "required": ["summary", "operations"],
      "properties": {
        "summary": { "type": "string" },
        "operations": { "type": "array" }
      }
    },
    "saveAs": "variables.__rpt.agent_results.property.monthly"
  },
  "tools": [],
  "modelHint": "a fast reasoning model",
  "defaults": {
    "required": true,
    "maxSteps": 1,
    "maxRetryAttempts": 5,
    "retryDelayMs": 5000,
    "blocksNextTurn": false,
    "toolResultMaxTokens": 10000
  }
}
```

The schema above establishes the contract, not a requirement that every prompt use a dynamic binding.
Plain string content is valid for static role messages; messages containing Prompt Bindings use typed
content segments. RP Terminal normalizes both forms before validation and execution. There is no
shorthand for variable or Result Slot paths.

### 3.2 Names and collisions

Agent Names are unique across the whole profile, including built-in, user, and card sources. An
import collision is blocked until the player renames the incoming Agent. Declarative references
inside that same imported package update atomically.

A later player rename changes the Agent's invocation identity immediately. RP Terminal creates no
alias and does not attempt to rewrite arbitrary card-script source. If a player breaks a literal
`rpt.agents.run("Old Name")` call, the call fails visibly as a missing Agent.

### 3.3 Bindings and versions

An Agent Binding selects a version-pinned Agent Definition for use by a card or Player-facing Agent
Role. Source updates never alter a binding silently. Upgrade is explicit and reviewed.

Every Agent is editable, including built-in and card-bundled Agents. RP Terminal retains the pinned
source version as a restoration baseline:

- user changes apply profile-wide to every binding of that Agent;
- Restore to default clears changes back to the current pinned source version;
- explicit upgrade reapplies still-valid customized fields over the new source version;
- the upgrade UI shows a diff before activation; and
- invalid customizations block activation until the player resolves or restores them.

Built-in and card-bundled Agents remain restorable while their source exists, so they may be disabled
but not permanently deleted. User-created and standalone-imported Agents may be deleted. An Agent
currently bound as Classic Narrator or Yuzu Scene Director must be replaced before it can be disabled
or deleted.

Card-bundled Agents install enabled without an approval walkthrough. They remain visible, editable,
restorable, and disableable in the Agent Workspace. Their tools remain constrained by the existing
card/plugin trust and permission boundary.

## 4. Agent Workspace

The workflow canvas is replaced by a flat Agent Workspace:

- **Agent Library:** one row per unique Agent, with source, enabled state, version, role bindings, and
  last activity.
- **Agent editor:** form sections for role-message prompt, Prompt Bindings, input schema, Result
  Contract, Tool Bindings, history, model/API preset, generation parameters, retries, step budget,
  next-turn behavior, and notification behavior.
- **Plan editor:** an ordered list of Agent calls with explicit flat parallel groups. It edits,
  validates, imports, and exports plan JSON but does not install a plan as a runtime object.
- **Agent Activity:** always-visible running and recent invocations with Agent Name, Invocation Floor,
  status, model, token/cache use, latency, and Stop.
- **Run now:** a real Manual Invocation with explicit JSON input on the latest committed floor.

The Workspace contains no canvas, node palette, ports, edges, modules, arbitrary control-flow
widgets, or hidden source-qualified Agent identifiers.

The editor exposes every Agent configuration field. Invalid contracts, missing required tools,
missing API preset bindings, or incompatible role bindings are shown at the responsible field and
prevent activation. Runtime failures also identify the failing Agent, attempt, binding, tool, result
validator, or replay operation rather than reporting a generic generation failure.

## 5. Prompt and context contract

### 5.1 Prompt stack

The Harness assembles this ordered stack:

1. fixed Harness policy;
2. the Agent Definition's role-message prompt;
3. rendered dynamic Prompt Bindings;
4. the invocation input; and
5. an optional invocation addendum.

Imported prompt messages may use `system`, `user`, and `assistant` roles. Pre-authored `tool` messages
are forbidden because tool messages must correspond to real calls made in the current attempt. An
invocation may append input or a bounded addendum but may not replace the Agent prompt. Materially
different behavior is a separately named Agent.

### 5.2 Cache boundary and Harness Context

Each attempt uses three logical regions:

- **Immutable prefix:** Harness policy, stable Agent prompt messages, and normalized tool schemas.
- **Append-only attempt log:** dispatched dynamic input, provider messages, ordered tool calls, and
  Tool Result Projections.
- **Volatile suffix:** dynamic bindings or corrective feedback not yet dispatched.

The first prompt message containing dynamic data begins the volatile region. Once sent, volatile
content seals into the append-only log; the Harness does not rebuild earlier bytes. This preserves
provider prefix-cache opportunities without making cache behavior part of Agent authoring.

### 5.3 Invocation isolation and history

Every Agent Invocation starts fresh and inherits no prior Agent log. Information from earlier floors
must enter through explicit invocation input, a variable path, a Result Slot, or an opt-in History
Policy.

Background Agents default to no history. History Policy may specify:

- maximum floors;
- maximum rendered tokens;
- inclusion of player messages;
- inclusion of player-facing Agent results; or
- both.

Oldest floors are removed first. The exact rendered history is captured in the Run Record. RP
Terminal performs no cross-invocation compaction because there is no inherited Agent conversation to
compact.

### 5.4 Context budget

Tool Result Projection defaults to 10,000 tokens per result. A Tool Binding may lower or raise its
projection within user/API limits. The complete tool result remains in the Run Record; RP Terminal
does not make a hidden model call to summarize it.

Before every provider call, the Harness verifies that the next request fits the selected API preset's
context window. A Context Budget Failure is non-retryable and reports token attribution for prompt
regions and individual Tool Result Projections. The Harness neither compacts the request nor retries
it unchanged.

## 6. Input Bindings and full paths

Invocation input is always a JSON object, and callers may send that object directly. `inputSchema` is
optional and defaults to any JSON object.

An Input Binding can build named input fields from:

- literal JSON;
- the caller's invocation input;
- a full path rooted at `variables`; or
- a full Result Slot path rooted at `variables.__rpt.agent_results`.

Examples:

```text
variables.stat_data.世界.时间
variables.stat_data.玩家.产业
variables.__rpt.agent_results.property.monthly
```

RP Terminal provides no `state`, `results`, bare-path, hoisted, or relative shorthand. Literal caller
input is captured when the invocation queues. Variable and Result Slot bindings resolve only when the
invocation can actually start, after its declared predecessors have incorporated and Forward Replay
has rebuilt the Invocation Floor.

A missing path is a non-retryable Input Binding failure unless the author supplied an explicit JSON
default. Missing values never silently become `null`, an empty string, an empty object, or an empty
array. The completed input object must validate before any provider request.

## 7. Result Contracts and storage

An Agent declares one result mode:

| Mode | Contract |
| --- | --- |
| `text` | Arbitrary text, optionally checked by a deterministic format validator such as YSS. |
| `json` | A JSON value that must validate against a mandatory JSON Schema. |
| `tools-only` | No model-authored persisted result; success is the committed Attempt Transaction. |

A background `text` or `json` Agent must declare a full `saveAs` path beneath
`variables.__rpt.agent_results`. That path is its **Result Slot**. A later successful run using the
same slot replaces the current value; floor history preserves rewind. A tools-only Agent has no
Result Slot.

Player-facing Agents write canonical output to `response_content` instead of a Result Slot:

- Classic Narrator stores text.
- Yuzu Scene Director stores raw YSS mixed with text.

`variables.__rpt` is reserved and read-only to cards, Agents, and the ordinary variable editor. Only
Result Incorporation writes Result Slots and runtime metadata there. A card may copy a Result Slot
into its own editable state through a declared transactional tool or floor-scoped card operation.

## 8. Tools and Attempt Transactions

### 8.1 Explicit Tool Bindings

An Agent can call only tools declared by its Agent Definition and explicitly bound to an
implementation. It cannot discover every card or plugin tool. RP Terminal validates tool schemas,
availability, permissions, transaction modes, and required bindings before play.

Tool implementations may be built into RP Terminal, supplied by a card, or supplied by a plugin.
The definition declares the model-facing contract; the Tool Binding selects the implementation.

### 8.2 Transaction modes

Stateful tools are transactional by default. Their variable and floor operations stage in the
attempt's temporary buffer and become visible only when the Agent Result validates and Result
Incorporation commits. Failure, retry, cancellation, deleted floor, or rejected result discards the
buffer. Read-only tools need no staging.

A tool with an external or otherwise non-rewindable effect must declare itself non-transactional:

- automatic retry remains available before the external effect begins;
- once it begins, the attempt cannot retry automatically;
- deleting the Invocation Floor cannot undo the external effect; and
- the Run Record must identify the irreversible boundary.

### 8.3 Parallel tool calls

The Harness executes model-requested tool calls concurrently only when every call's Tool Binding is
declared `parallelSafe`. Otherwise it uses model-declared order. Regardless of completion time,
tool calls and Tool Result Projections append to the attempt log in the model-declared order.

## 9. Protocol Repair and provider adapters

Protocol Repair is bounded, deterministic, and recorded. It may:

- normalize or flatten schemas for a provider;
- recover a tool call emitted in the provider's reasoning or wrong response channel;
- close unambiguous truncated JSON;
- validate the repaired value against the original schema; and
- suppress storms of identical repeated tool calls.

It never invents missing semantic arguments. A successful local repair consumes no provider retry.
An unrecoverable malformed call or result enters Corrective Retry.

Provider Adapters normalize streaming events, reasoning channels, tool calls, usage, cache metrics,
and errors across OpenAI-, Anthropic-, Gemini-, and DeepSeek-compatible endpoints. Automatically
selected Provider Capability Profiles control safe schema normalization, repair, tool transport,
reasoning handling, and cache accounting. Agent authors do not configure provider quirks.

Reasonix is not embedded as the Harness. Its immutable-prefix, append-only-log, schema-normalization,
wrong-channel recovery, truncation repair, repeated-call suppression, and declared-parallelism ideas
inform this design. Its DeepSeek-specific assumptions, cross-session compaction, and model escalation
do not fit RP Terminal.

## 10. Models, presets, and request budgets

The Harness resolves an API preset, not a standalone model. A portable card Agent may include a
preferred-model hint but cannot reference a user-local preset id.

API preset precedence is:

1. user per-Agent override;
2. locally resolved invocation-step choice;
3. Agent Binding default; and
4. the profile's active preset.

Generation parameter precedence is:

1. user per-Agent override;
2. invocation-step override;
3. Agent Definition default; and
4. active generation preset.

Supported parameters reuse RP Terminal's existing partial preset fields, including temperature,
output-token limit, common samplers, penalties, and stop strings. The Provider Capability Profile
filters fields that the selected endpoint cannot accept.

The resolved preset and model are frozen for every retry. RP Terminal never escalates from Flash to
Pro or changes providers automatically; the author or player chooses the model.

Agent calls use the selected API preset's existing `rpm_limit` and `max_concurrent` controls. The
limiter is endpoint-keyed and shared across all chats and ordinary generation calls. The Agent
Runtime adds no per-chat rate limiter.

## 11. Card API and card-owned scheduling

RP Terminal exposes:

```ts
await rpt.agents.run(name, options)
await rpt.agents.runPlan(plan)
```

Both settle only after Result Incorporation succeeds or the invocation reaches a final failure.
Ordinary JavaScript `await` expresses sequencing, and `Promise.all` expresses author-declared
parallel independence. `runPlan` provides the restrictive declarative equivalent.

RP Terminal does not own a variable scheduler. A card script observes its variables and chooses when
to invoke an Agent. Example:

1. a committed floor crosses an in-game month boundary;
2. the card records that it has observed the boundary;
3. the card invokes `Property Management` and `World Progression`;
4. the Agents calculate property development and off-screen world changes; and
5. their results incorporate into the causative floor.

The card may handle a result directly in script or expose a declared tool that stages the relevant
state operations. Both are supported, but persisted results and operations still belong to floor
variables so floor deletion provides rewind.

## 12. Floor Commit Event and invocation identity

`floor:committed` fires exactly once for a newly committed floor and supplies:

- the new floor number;
- the current floor variables; and
- the previous floor variables.

Forward Replay never emits `floor:committed`; it emits only state-refresh notifications. This
prevents historical result incorporation from retriggering monthly schedules.

An explicit `floor` in `run` or `runPlan` must identify an existing committed floor and normally
comes from the causative Floor Commit Event. Outside that event, omission defaults to the latest
committed floor.

Invocation identity is the Agent Name on the Invocation Floor. The same Agent runs at most once per
floor; a duplicate call returns the existing in-flight invocation or incorporated result. The
runtime has no author-supplied deduplication key. An Invocation Plan containing the same Agent more
than once on one floor is invalid.

A Manual Invocation from Agent Workspace uses explicit JSON input, the latest committed floor, and
the same identity rule.

## 13. Lanes, sequences, and parallel groups

Each chat has one ordered **Agent Lane** per Agent. If `World Progression` is invoked from floor 12
and again from floor 13, floor 13 waits until floor 12 has finished and incorporated. Only then does
floor 13 resolve variable and Result Slot bindings and start, allowing it to consume the earlier
result.

Different Agents run according to the author-declared plan:

- sequence steps wait for predecessor incorporation before resolving their bindings;
- Agents inside one parallel group may start together;
- each parallel result may incorporate as it finishes; and
- RP Terminal does not infer dependencies or serialize calls because their possible variable writes
  look similar.

A parallel declaration is the author's assertion that results do not overlap. Conflicting parallel
results are an authoring error. RP Terminal does not treat one parallel Agent's incorporation as
invalidation of another parallel Agent's input snapshot.

## 14. Invocation Plans

A plan contains only these shapes:

```json
{
  "steps": [
    {
      "agent": "Property Management",
      "input": {
        "month": {
          "source": {
            "type": "variables",
            "path": "variables.stat_data.世界.时间"
          }
        }
      }
    },
    {
      "parallel": [
        { "agent": "World Progression" },
        { "agent": "Off-screen Relationships" }
      ]
    }
  ]
}
```

The allowed grammar is:

```text
Plan          := Sequence
Sequence      := Step*
Step          := AgentCall | ParallelGroup
ParallelGroup := AgentCall+
```

There are no nested parallel groups, branch predicates, loops, recursion, embedded scripts, or plan
references. Card-side code decides whether to call the plan at all. Input Bindings and Result Slots
carry data between sequence steps.

Every Agent call exposes the full invocation configuration, including required/optional Failure
Policy, retry count, retry delay, step budget, next-turn barrier, history, input bindings, result
destination, API preset/model choice where locally resolvable, generation parameters, and
notifications.

## 15. Late results, deletion, and Forward Replay

An Agent Result belongs to its Invocation Floor even if newer floors already exist.

### Deleted Invocation Floor

If floor 12 owns an in-flight invocation and the player deletes floor 12:

1. abort the provider call immediately;
2. discard the Attempt Transaction;
3. discard any late response;
4. cancel queued same-plan work; and
5. delete the entire Run Record.

No diagnostic tombstone is retained. Deleting the floor expresses that the player no longer cares
about its work.

### Late result with newer floors

If floor 12's result finishes after floor 13 exists:

1. stage and validate the result and its operations against floor 12;
2. rebuild floor 12 with those operations;
3. deterministically reconstruct floor 13 and every later floor by replaying their stored model,
   card, and user operations in order; and
4. atomically publish the rebuilt suffix.

The result is never patched directly onto the latest snapshot. Forward Replay emits state-refresh
events only, so card scheduling does not fire twice.

### Result Incorporation

Result Incorporation atomically commits:

- the validated result;
- the Attempt Transaction;
- the Result Slot;
- the Run Record's successful outcome; and
- Forward Replay of every later floor.

If replay fails, none of those changes become visible. A fully transactional attempt may enter
Corrective Retry with concise replay feedback. A non-transactional attempt cannot automatically
retry after its external boundary.

## 16. User variable editing and snapshot invalidation

Card-owned state such as properties and assets remains user-editable. Ordinary edits target the
latest floor; an advanced action may edit a historical floor and atomically replay the later suffix.
Every edit is stored as a floor-scoped journaled operation, so Forward Replay preserves it and
deleting that floor removes it.

Paths under `variables.__rpt` are runtime-owned and not editable.

If a historical user edit at or before an active Invocation Floor makes a transactional invocation's
input snapshot stale, RP Terminal cancels, rebuilds, and restarts the invocation without consuming a
retry. If a non-transactional tool has already crossed its external boundary, RP Terminal reports a
conflict requiring player action.

Parallel Agents do not trigger inferred snapshot invalidation because their author explicitly
declared independence.

## 17. Retry, failure, and cancellation

### Defaults

| Option | Default |
| --- | --- |
| `required` | `true` |
| `maxRetryAttempts` | `5` after the initial attempt |
| `retryDelayMs` | `5000` |
| one-call `maxSteps` | `1` |
| tool-using `maxSteps` | `8` |
| `blocksNextTurn` | `false` |
| Tool Result Projection | `10000` tokens |
| background history | none |

The author may configure every value, and the player may impose a lower global step cap. Maximum
model turns are `(1 + maxRetryAttempts) × maxSteps`.

### Retryable failures

- network timeout, rate limit, and transient provider failure;
- malformed or unrecoverable tool calls;
- invalid text or JSON Agent Result;
- failed transactional tool/result validation; and
- failed transactional Result Incorporation or Forward Replay.

A provider `Retry-After` may lengthen but never shorten the configured delay.

### Non-retryable failures

- explicit cancellation or deleted Invocation Floor;
- missing, disabled, or incompatible Agent, tool, or API preset;
- authentication or permission denial;
- invalid or missing Input Binding;
- Context Budget Failure; and
- any failure after a non-transactional tool begins its external effect.

### Corrective Retry

A transport failure before a usable response resends the identical serialized request. A semantic,
tool, result, or replay failure starts a fresh Harness Context and Attempt Transaction with the same
resolved input snapshot plus only the rejected output and concise validation error. Failed tool logs
never carry forward as though their staged effects occurred.

### Failure Policy

A required final failure stops the remaining plan sequence. An optional failure records the failure
and allows later sequence steps to continue. Imported Agents default to required; an invocation may
override it.

### Cancellation

An `AbortSignal`, Agent Activity Stop action, or floor deletion aborts the provider, discards the
transaction, performs no retry or incorporation, and cancels active parallel and queued members of a
cancelled plan.

## 18. Player-facing Agents and next-turn behavior

### Pending Floor

Submitting a player turn reserves a Pending Floor and captures the user message. RP Terminal runs the
mode's Player-facing Agent, validates and incorporates its output, then commits the floor. Only after
commit may the card's Floor Commit Event schedule background Agents.

Cancellation or final failure discards the Pending Floor and restores the captured user message to
the composer.

### Role bindings

- `classic.narrator` accepts a compatible text Agent.
- `yuzu.sceneDirector` accepts a compatible YSS-text Agent.

RP Terminal supplies built-in defaults. A card may recommend a replacement, while the player chooses
the final role binding.

Classic Narrator text becomes the floor's canonical `response_content`.

Yuzu Scene Director emits YSS mixed with text, not JSON. Raw YSS is canonical
`response_content`; the Yuzu subsystem derives its internal Scene representation and may rebuild that
derived form from the raw response.

YSS uses the existing line-oriented forms:

- `<| ... |>` command lines;
- `speaker: text` dialogue; and
- ordinary prose narration.

Deterministic local repair and parsing observations are recorded. A malformed skipped command or
missing asset that does not invalidate the narration produces a small line-specific warning badge.
If YSS remains invalid after the configured Corrective Retries, RP Terminal commits a
narration-only degraded scene, marks the Run Record degraded, and shows the player where parsing or
validation failed. Raw model reasoning is never shown.

### Next-turn Barrier

Background Agents default to `blocksNextTurn: false`; the next player-facing Agent may start while a
late result uses Forward Replay.

When `blocksNextTurn: true`, RP Terminal may capture the next user message as a Pending Floor but
waits for the background result to incorporate before resolving the player-facing Agent's bindings
and starting it:

- optional final failure releases the barrier without a result;
- required final failure discards the Pending Floor, restores the message, and shows the blocking
  failure.

## 19. Run Records and visibility

Every invocation creates an immutable floor-owned Run Record containing:

- effective Agent version and hash;
- resolved input;
- exact rendered prompt messages and history;
- input, result, and tool contracts;
- selected provider, preset, model, and generation parameters;
- ordered attempts, Protocol Repairs, tool calls, full tool results, and projections;
- final result or failure;
- transaction and replay outcome;
- token, latency, cache, retry, and rate-limit metrics; and
- degraded-output warnings where applicable.

The record remains interpretable after the Agent is edited or deleted. It never follows later Agent
changes and never stores raw reasoning. Deleting its Invocation Floor deletes the record completely.

Agent Activity always reveals that an Agent is running. Authors may choose notification behavior
`none`, `failure`, or `completion`, but cannot hide the invocation itself.

## 20. Workflow removal and atomic cutover

There is no migration period and no dual-runtime release.

Development proceeds on one cutover branch in this order:

1. implement the Harness, Agent storage/import, Provider Adapters, Agent Workspace, and Run Records;
2. implement Attempt Transactions, Result Incorporation, Forward Replay, lanes, plans, and Card Agent
   API;
3. implement and bind the built-in Classic Narrator;
4. switch the existing Classic generation entry point to the Narrator Agent;
5. integrate the Yuzu Scene Director;
6. delete the workflow engine, node registry, workflow services, headless trigger evaluator, canvas,
   workflow stores, workflow IPC, `.rptflow`/`.rptmodule` import/export, seeded workflow examples,
   workflow-only tests, and dependencies used only by that system; and
7. merge only after Classic, Yuzu, background scheduling, replay, and deletion behavior pass.

The branch may temporarily contain both implementations while the replacement is constructed, but
no release or merged state exposes two selectable systems.

Existing workflow definitions, selections, bindings, and run records are **Legacy Workflow Data**.
RP Terminal does not load, execute, display, migrate, convert, or automatically delete them. They
remain inert on disk to avoid destructive mutation of user data. Existing `.rptflow` and
`.rptmodule` files receive no converter and no compatibility promise.

Reusable non-workflow capabilities—prompt assembly, provider transport, table storage, floor
operation journals, variable editing, and card/plugin tools—may be retained behind Agent Runtime
interfaces. Workflow concepts and formats do not survive merely because some implementation code is
reused.

## 21. Implementation slices

The cutover branch should remain runnable after each slice:

1. **Contracts and adapters:** Agent Definition validation, Provider Adapter interface, capability
   profiles, prompt normalization, and one-call Harness.
2. **Tool Harness:** Agent Steps, Tool Bindings, Protocol Repair, Attempt Transactions, retry, abort,
   and context-budget checks.
3. **Persistence and UI:** profile-wide Agent library, source baselines/customization, unique-name
   import, Agent Workspace, Agent Activity, and immutable Run Records.
4. **Floor integration:** Result Slots, Result Incorporation, Forward Replay, historical edits,
   deletion cancellation, and snapshot invalidation.
5. **Invocation:** Card Agent API, Floor Commit Event, lanes, Manual Invocation, Invocation Plans,
   and Next-turn Barrier.
6. **Player-facing roles:** built-in Classic Narrator, Pending Floor cutover, Yuzu Scene Director,
   YSS validation, and degraded fallback.
7. **Removal:** delete every workflow surface and update living SDK/API/status documentation in the
   same change.

No slice may introduce a second card-facing workflow compatibility API.

## 22. Verification obligations

The implementation is not complete until tests cover:

- one-call and bounded tool-loop Agents through the same Harness;
- direct JSON input and every Input Binding source;
- full-path enforcement and missing-path defaults;
- text, JSON Schema, tools-only, and YSS Result Contracts;
- Protocol Repair boundaries and repeated-call suppression;
- ordered tool results under parallel execution;
- retry classification, fixed model selection, `Retry-After`, and Corrective Retry isolation;
- transactional rollback and non-transactional retry cutoff;
- same-Agent floor-12/floor-13 serialization;
- author-declared parallel Agents incorporating independently;
- floor deletion aborting and erasing an in-flight run;
- floor-12 late result followed by deterministic floor-13 Forward Replay;
- historical user edits cancelling/restarting transactional attempts;
- `floor:committed` firing once and never during replay;
- Next-turn Barrier optional and required failure behavior;
- Classic Pending Floor success, failure, cancellation, regeneration, and swipe behavior;
- Yuzu raw-YSS storage, line warnings, retry, and narration-only fallback;
- profile-wide customization, restore, upgrade conflicts, rename breakage, and source-backed removal
  constraints;
- API-preset RPM/concurrency sharing across chats; and
- absence of workflow imports, runtime selection, IPC, editor routes, seeded artifacts, and
  workflow-only dependencies after cutover.

Required project gates remain:

```text
npm.cmd run typecheck
npm.cmd run check:deps
npm.cmd run test
npm.cmd run check:docs
```

## 23. Deferred decisions

Only one architectural decision remains intentionally deferred: whether in-flight Agent Invocations
survive app reload or restart. The first implementation may cancel them cleanly at shutdown as long
as no partial Attempt Transaction or Result Incorporation survives.
