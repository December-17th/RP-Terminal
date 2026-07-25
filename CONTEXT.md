# RP Terminal

A standalone Electron app evolving the SillyTavern-style chat experience into a game platform.
This glossary covers the target agent-runtime model and the card-runtime seam. Implementation status
remains in `docs/current-status.md`.

## Language

### The agent runtime

**Agent**:
A named AI worker with one responsibility, an input contract, a result contract, an API preset
selection, a prompt, and an allowed tool set. Agents never schedule other Agents; the RP Terminal
runtime or card logic invokes them.
_Avoid_: worker, sub-agent, background job

**Agent Definition**:
The versioned declarative JSON contract for an Agent: its unique name, prompt, input and Result
Contracts, Tool Bindings, preferred-model hint, and Harness defaults. The same shape ships inside RP
Terminal, imports as a standalone `.rptagent` file, or embeds in a World Card's `agents[]`; it
contains no executable code. Its input schema is optional and defaults to any JSON object; a json
Result Contract requires a result JSON Schema, while text and tools-only contracts do not.

**Agent Source**:
The origin of an Agent Definition: built into RP Terminal, imported into the user's Agent library, or
bundled with a card. All three sources resolve to the same runtime contract and execute through the
same Agent Harness.

**Agent Enablement**:
The player-controlled on/off state of an Agent Binding. Card-imported Agents install enabled without
an approval walkthrough, remain visible through Agent Activity, and may be disabled afterward; Tool
Bindings inherit the existing permission boundary of their card script or plugin implementation.

**Agent Removal**:
User-created and standalone-imported Agents may be deleted, while built-in and card-bundled Agents
remain restorable and may only be disabled while their source exists. An Agent bound to a
Player-facing Agent Role must be replaced before it can be disabled or deleted.

**Agent Name**:
The profile-wide unique invocation name of an Agent across built-in, user, and card sources. RP
Terminal does not resolve collisions by source precedence; an import is blocked until the user
renames the incoming Agent and its imported declarative references update atomically, while a later
player rename creates no alias and does not repair arbitrary card-script references.

**Agent Binding**:
The version-pinned Agent Definition and prompt resolved from an Agent Source for a card. Installed
Agent updates do not silently change an existing binding; changing its version is an explicit upgrade.

**Agent Customization**:
The player's editable changes to any effective Agent Definition, including built-in and card-bundled
Agents; customizations apply profile-wide to every binding of that Agent, with no per-chat overlay.
On an explicit upgrade, RP Terminal reapplies valid fields over the new reviewed baseline; Restore to
default restores that version, while invalid customizations prevent activation until resolved.

**Tool Binding**:
The explicit mapping from a tool declared by an Agent Definition to a card-provided implementation.
An Agent can call only its declared tools; RP Terminal validates their contracts and transaction modes
before play and rejects a binding with a missing required tool.

**Parallel-safe Tool**:
A Tool Binding whose author declares that it may run concurrently with other parallel-safe tool calls
from the same Agent Step. The Harness otherwise executes calls in model-declared order and always
appends their results to the Agent log in that order, independent of completion timing.

**Agent Step**:
One bounded iteration in which the selected model may return an Agent Result or dynamically choose
from the Agent's declared tools. A tool-using Agent repeats steps until it produces a valid result or
exhausts its `maxSteps`; the Invocation Plan orders Agents, not their internal tool choices. A one-call
Agent has one step, a tool-using Agent defaults to eight steps, the author may configure that value,
and the user may impose a lower global cap. Each retry receives a fresh step budget and Attempt
Transaction, making the maximum model turns `(1 + maxRetryAttempts) × maxSteps`.

**Agent Harness**:
The single runtime through which every Agent executes. A one-call Agent is a Harness run limited
to one step with no tools; tool-using Agents use the same runtime with a larger bounded step budget.
It is an RP Terminal-native, provider-neutral runtime; Reasonix informs selected repair and cache
mechanisms but is not embedded or adopted as the Harness.
_Avoid_: agent framework, tool loop

**Protocol Repair**:
The bounded, recorded recovery layer inside the Agent Harness. It may normalize difficult tool
schemas, recover calls emitted in the wrong response channel, close unambiguous truncated JSON,
validate repaired calls against the original Tool Binding, and suppress identical-call storms; it
never invents missing semantic arguments. A local repair makes no provider request and consumes no
retry, while an unrecoverable call does.

**Provider Adapter**:
The Harness boundary that normalizes a provider's streaming events, reasoning channel, tool calls,
usage, and errors into one internal contract. OpenAI-, Anthropic-, Gemini-, and DeepSeek-compatible
connections use adapters rather than leaking transport shapes into Agent Definitions.

**Provider Capability Profile**:
The automatically selected description of provider-specific behavior that controls safe Protocol
Repair, schema normalization, tool transport, and cache accounting. Agent authors do not configure
provider quirks manually.

**Run Record**:
The immutable, floor-owned execution snapshot of an Agent Invocation: effective Agent version and
hash, resolved input and prompt messages, contracts, preset and model, final Agent Result, ordered
attempts and tools, errors, token usage, latency, and cache metrics. It survives later Agent edits or
deletion, excludes raw reasoning, and is deleted entirely with its Invocation Floor.

**Agent Activity**:
The always-visible run summary showing Agent name, Invocation Floor, status, selected model, resource
use, and Stop action. Authors may set notifications to none, failure, or completion, but cannot hide
an invocation's existence from the player.

**Agent Workspace**:
The flat management surface for browsing and editing Agent Definitions, Agent Bindings, and ordered
Invocation Plans. It uses forms, full-path bindings, and explicit parallel groups rather than a
canvas, nodes, ports, edges, modules, or arbitrary control flow.

**Agent Prompt Stack**:
The ordered prompt assembled by the Agent Harness from fixed Harness policy, the imported Agent's
role-message array, rendered dynamic bindings, invocation-specific input, and an optional addendum.
Imported messages allow system, user, and assistant roles but not pre-authored tool messages. The
first message containing a dynamic binding starts the volatile suffix, leaving every preceding message
byte-stable and cacheable; an invocation cannot replace the imported prompt, and substantially
different behavior is defined as another Agent.

**Harness Context**:
The three-region context maintained for every provider: an immutable prefix of Harness policy, stable
Agent prompt messages, and normalized tool schemas; an append-only attempt log of dispatched dynamic
input, model messages, and ordered tool results; and a volatile suffix of not-yet-dispatched bindings
or corrective feedback. Once a volatile suffix is sent, it is sealed into the log rather than rebuilt,
preserving the exact prior byte sequence for cache reuse.

**Invocation Isolation**:
Every Agent Invocation starts a fresh Harness Context and inherits no prior Agent log. It receives
earlier information only through explicit Input Bindings, History Policy, floor variables, or Result
Slots, so RP Terminal performs no cross-invocation tool-result compaction.

**Tool Result Projection**:
The model-facing view of a tool result, defaulting to at most 10,000 tokens per result while the full
result remains in the Run Record. Tool Bindings may configure the projection limit; RP Terminal does
not make a hidden model call to summarize it.

**Context Budget Failure**:
The non-retryable failure raised before a provider call when the next Agent Step would exceed the
selected API preset's context window. The Run Record attributes token use to the responsible prompt
and Tool Result Projections so the author can reduce them; RP Terminal neither compacts the context
nor retries an unchanged attempt.

**Prompt Binding**:
A declarative placeholder that injects dynamic input, history, floor-variable, or Result Slot data
into the volatile suffix of an Agent Prompt Stack. Prompt Bindings evaluate without arbitrary code
and establish the cache boundary at the first message that contains one. Floor-variable and Result
Slot bindings use full paths rooted at `variables`, such as `variables.stat_data.世界.时间` and
`variables.__rpt.agent_results.property.monthly_report`; RP Terminal provides no shorthand,
hoisting, or bare-path fallback.

**History Policy**:
The Agent Definition's opt-in bounds for rendering a Prompt Binding to chat history. Background Agents
default to no history; an Agent may configure maximum floors, maximum tokens, and whether to include
user messages, player-facing Agent results, or both. RP Terminal removes oldest floors first and
stores the exact rendered history in the Run Record.

**API Preset Selection**:
The user-local API preset resolved for an Agent Invocation, supplying its provider, endpoint, model,
and request budgets. A card Agent Definition may carry a preferred-model hint but cannot reference a
user-local preset id; resolution order is user per-Agent override, invocation-step choice, Agent
Binding default, then the profile's active preset. The Harness retains the resolved preset and model
through every retry and never escalates automatically.

**API Preset Budget**:
The existing `rpm_limit` and `max_concurrent` controls carried by the API preset selected for an Agent
Invocation. Agent requests share RP Terminal's endpoint-keyed RPM and concurrency queues with all
other requests across chats; the Agent runtime adds no per-chat limiter.

**Generation Parameters**:
The partial existing RP Terminal Preset Parameters applied to an Agent Invocation, including
temperature, output-token limit, common samplers, penalties, and stop strings. Resolution order is
user per-Agent override, invocation-step override, Agent Definition default, then the active generation
preset; the Provider Capability Profile filters unsupported fields.

**Retry Policy**:
The card-authored automatic recovery configuration enforced by the Agent Harness before an Agent
Invocation is declared failed. It exposes maximum retry attempts and time between attempts, and
covers transient provider failures plus repair or rerun of malformed tool calls or invalid structured
results, as well as rolled-back Result Incorporation failures when the attempt remained transactional.
Retry exhaustion then hands control to the Invocation Plan's Failure Policy. An imported Agent
defaults to five retries after its initial attempt with five seconds between retries, and an Invocation
Plan step may override either value. Network timeouts, rate limits, transient provider errors,
malformed calls or results, and transactional incorporation failures are retryable; cancellation,
deleted floors, missing or disabled dependencies, authentication or permission failures, invalid Input
Bindings, Context Budget Failures, and failures after a Non-transactional Tool begins are not. A
provider `Retry-After` value may lengthen but never shorten the configured delay.

**Attempt Transaction**:
The temporary operation buffer owned by one Agent attempt. Stateful card-tool operations are staged
there and commit to the Invocation Floor only after the Agent Result validates; failure, cancellation,
or retry discards the buffer, while read-only tools execute without staging.

**Corrective Retry**:
A fresh Harness Context and Attempt Transaction started after a tool, result, or replay validation
failure, using the same resolved input snapshot plus only the rejected output and concise error as
feedback. A transport failure before any usable response instead resends the identical serialized
request; failed tool logs never carry forward as though their staged effects occurred.

**Non-transactional Tool**:
An Agent-callable card tool explicitly declared to have an external or otherwise non-rewindable
effect. Automatic retry remains available before it executes, but the Harness cannot retry the
attempt after that effect begins; its returned record may belong to the Invocation Floor, while
deleting that floor cannot undo the external effect.

**Agent Invocation**:
An asynchronous request from RP Terminal or card logic to run an Agent with caller-supplied input.
Invocation timing belongs to the caller; RP Terminal does not interpret card variables as schedules.
Its identity is the Agent Name on its Invocation Floor: a named Agent runs at most once per floor, and
a repeated call returns the existing invocation or incorporated result rather than issuing another
provider call.
_Avoid_: variable trigger, agent trigger

**Manual Invocation**:
An Agent Invocation started by the player through the Agent Workspace's Run now action with explicit
JSON input and the latest committed floor. It uses the same Agent Lane, retry, transaction, Result
Slot, and once-per-Agent-per-floor rules as a card-started invocation.

**Invocation Cancellation**:
An explicit stop requested by a card through an `AbortSignal`, by the player through RP Terminal's run
UI, or implicitly by deletion of the Invocation Floor. Cancellation aborts the provider request,
discards the Attempt Transaction, performs no retry or Result Incorporation, and cascades across the
active and queued members of a cancelled Invocation Plan.

**Card Agent API**:
The card-side async surface `rpt.agents.run(name, options)` and
`rpt.agents.runPlan(plan)`. The primitive `run` lets ordinary `await` and `Promise.all` express
sequences and parallel groups, while `runPlan` executes an Invocation Plan. A call may name and must
validate an existing committed Invocation Floor, normally supplied by the causative floor event;
outside such an event, omission defaults to the latest committed floor. Both APIs settle only after
Result Incorporation completes. Persistence and recovery of in-flight invocations across card reloads
or application restarts are deferred.

**Floor Commit Event**:
The card-side notification carrying a newly committed floor number, its variables, and the preceding
floor's variables. Card scheduling logic compares those JSON snapshots and passes the event's floor to
the Card Agent API when it decides an Agent should run. It fires once for a newly committed floor and
never during Forward Replay, which emits only a state-refresh notification for UI and card caches.

**Agent Result**:
The validated outcome of an Agent Invocation. Card logic may consume it directly or an Agent may
pass it through card-supplied tools; every stateful consequence from either route is recorded in
floor-scoped variables so floor rewind removes it.
_Avoid_: agent output, shared result

**Result Contract**:
The payload mode declared by an Agent Definition: text for a validated string, json for an object
validated against the Agent's JSON Schema, or tools-only when committed staged operations are the
entire result. Harness-owned status, attempts, errors, and provenance are recorded separately from
the author-defined payload. A text contract may still have a format-specific deterministic validator,
as the Scene Director does for YSS.

**YSS Result**:
The Scene Director's text result: a Yuzu Scene Script mixing command lines, `speaker: text` dialogue,
and ordinary prose narration. The Agent emits no scene JSON; RP Terminal parses and validates the YSS
text into its internal Scene representation after generation. The raw YSS is the Invocation Floor's
canonical `response_content`; the internal Scene is derived cache data that RP Terminal may rebuild.

**Degraded YSS Fallback**:
The narration-only Scene committed when a Scene Director exhausts its Retry Policy without valid YSS.
The floor remains playable, its Run Record is marked degraded, and the player is shown the rejected
line or scene rule with a path to the validation details; raw model reasoning remains hidden. A valid
scene with nonfatal parser or vocabulary observations instead receives a non-blocking floor warning
badge with line-specific details.

**Result Slot**:
The author-declared path beneath the reserved `variables.__rpt.agent_results` floor-variable branch,
selected by an invocation step's `saveAs` field. RP Terminal commits a validated text or json Agent
Result there on the Invocation Floor so later card logic or Agents can read it without direct coupling;
reusing a path intentionally replaces its current value while floor history preserves rewind. The
reserved `variables.__rpt` branch is read-only to card scripts and Agents; they may copy a result into
card-owned state but cannot alter its validated record. `saveAs` is mandatory for background text and
json Agents, unnecessary for tools-only Agents, and replaced by canonical `response_content` for
player-facing Agent roles.

**User Variable Edit**:
A user-authored floor-scoped operation on a card-owned variable path, including gameplay domains such
as properties and assets. RP Terminal journals the edit so Forward Replay preserves it and deleting
its floor removes it; the reserved `variables.__rpt` branch is not editable. The normal editor targets
the latest floor, while an advanced action may attach an edit to any existing floor and atomically
Forward Replay the later suffix.

**Snapshot Invalidation**:
Cancellation and restart of a transactional Agent Invocation when a User Variable Edit changes its
Invocation Floor or an earlier floor. RP Terminal restarts it from the rebuilt floor without consuming
a retry; if a Non-transactional Tool already crossed an irreversible boundary, RPT instead reports a
conflict that requires user action.

**Input Binding**:
The declarative construction of an Agent Invocation's JSON-object input from literal JSON, invocation
input, a full path rooted at `variables`, or a Result Slot's full reserved path. An author may bind an
entire object or assemble fields from those sources; arrays and scalars are carried in named fields,
RP Terminal provides no general expression language or path shorthand, and validates the completed
object against the Agent's input contract before calling the model. Literal invocation input is
captured when queued, while floor-variable and Result Slot references resolve when the call can start,
after declared predecessors commit and Forward Replay rebuilds the Invocation Floor. A missing path is
a non-retryable binding error unless the author declares an explicit JSON default, which is then
validated as part of the completed input; RP Terminal never invents an empty or null value.

**Invocation Floor**:
The committed floor whose transition caused an Agent Invocation. Its Agent Result belongs to this
floor even when the run finishes after later floors exist; deleting the Invocation Floor cancels the
run, discards any late result, and deletes its Run Record.

**Pending Floor**:
The uncommitted floor reservation created when the user submits a turn to a player-facing Agent.
RP Terminal captures the user message, runs and incorporates the Narrator or Scene Director result,
then commits the floor before card-side floor triggers may observe it; cancellation or final failure
discards the reservation and restores the user message to the composer.

**Next-turn Barrier**:
The author-configured `blocksNextTurn` behavior of a background Agent Invocation. It defaults off,
allowing the next player-facing Agent to start while late results use Forward Replay; when enabled,
RP Terminal may capture the next user message as a Pending Floor but resolves its bindings and starts
its Agent only after the blocking Result Incorporation completes. An optional final failure releases
the barrier without a result; a required final failure discards the Pending Floor, restores the user's
message to the composer, and shows the blocking failure.

**Player-facing Agent Role**:
The compatibility-checked binding that selects the Agent responsible for a mode's Pending Floor.
`classic.narrator` accepts a text Agent and `yuzu.sceneDirector` accepts a YSS-text Agent; RP Terminal
supplies built-in defaults, a card may recommend replacements, and the user chooses the final binding.

**Agent Lane**:
The ordered invocation queue for one Agent within one chat. A later invocation waits until the
preceding invocation has finished and its Agent Result has been incorporated before the later
invocation takes its input snapshot and starts.

**Invocation Plan**:
The card author's declarative top-level sequence of Agent calls and flat parallel groups containing
only Agent calls. It supports no nested groups, branches, loops, plan calls, recursion, or scripts;
parallel calls assert non-overlapping results, conditional scheduling remains card-side logic, and
the plan itself is an ordinary validated JSON value with no runtime registry, binding, version,
collision handling, or callable name.
_Avoid_: workflow, graph

**Failure Policy**:
The card-authored behavior of a sequence after an Agent Invocation exhausts its Retry Policy. The
invocation configuration marks the step as required, which stops the remaining sequence, or optional,
which records its failure and allows the sequence to continue. Imported Agents default to required,
and an Invocation Plan step may override that default.

**Forward Replay**:
Deterministic reconstruction of every floor after an Invocation Floor by reapplying stored model
changes and floor-scoped operations in order. RP Terminal performs Forward Replay after inserting a
late Agent Result at its Invocation Floor instead of applying that result directly to the latest state.
_Avoid_: rebase, apply to latest

**Result Incorporation**:
The atomic commit of a validated Agent Result, its Attempt Transaction, its Result Slot, and Forward
Replay of the later floor suffix. If any replay step fails, RP Terminal rolls back the entire
incorporation; a fully transactional invocation may retry with the replay error as feedback, while
retry exhaustion marks it failed and applies its Failure Policy. No floor exposes a partially rebuilt
state.

**Narrator**:
The player-facing Agent that produces the main Classic-mode response.
_Avoid_: main agent

**Scene Director**:
The player-facing Agent that produces the next Yuzu/IVN scene as a YSS Result.
_Avoid_: Yuzu narrator, VN agent

### The lore runtime

**Context Pin**:
A card-declared variable path whose current value is appended to the lore scan text each turn, so
state-relevant lorebook entries keep matching after recent messages stop naming them. Pinned values
are visible only to lore matching, never to the model's prompt.
_Avoid_: pin role, scan variable

**Assembly Epoch**:
The per-chat marker that advances whenever something that could change prompt assembly is edited —
variables, transcript, lorebooks, preset, or card. A floor remembers the epoch it was assembled
under; a floor whose epoch is current still has a faithful stored prompt.
_Avoid_: dirty flag, edit counter

**Resample**:
Regenerating or swiping by replaying the floor's stored prompt byte-for-byte and drawing only a new
model response. Available only while the floor's Assembly Epoch is current; otherwise regenerate
falls back to full reassembly with fresh lore selection.
_Avoid_: reroll, prompt reuse, cached regenerate

### The card runtime seam

**Host**:
The single interface between the shared card runtime and each transport; everything a card
capability needs from the app crosses it.
_Avoid_: bridge (that names one transport), host API

**Transport**:
One of the two adapters that carries the Host across a realm: inline (card iframe in the renderer)
or WCV (isolated WebContentsView).
_Avoid_: mode, environment

**Host Facet**:
A named capability slice of the Host interface (VarsHost, WorldbookHost, …). Every Host member
belongs to exactly one facet; a new capability has one obvious home.
_Avoid_: sub-interface, section

**Agent Host Facet**:
The Host Facet through which a card invokes Agents and Invocation Plans, supplies Tool Bindings, and
observes Floor Commit Events. Its behavior is identical across the inline and WCV Transports.
_Avoid_: Card Agent Host, Agent bridge

**Agent Host Session**:
The lifetime binding one authoritative card realm to its Agent invocations, Tool Bindings, and Floor
Commit Event observation. It ends with its owning Transport context and retains that Transport's
established teardown behavior.
_Avoid_: Agent connection, sender session

**Channel Spec**:
The shared table mapping each Host member to its WCV transport channel (name, call kind, fallback).
Both sides of the transport derive from it, so they cannot drift apart.
_Avoid_: channel list, IPC map

**Null Host**:
The complete no-op Host. Adapters and test fakes spread over it, so every member is always present
and unsupported operations are explicit no-ops rather than missing.
_Avoid_: partial host, mock host

### The preset compatibility seam

**Preset Envelope**:
The lossless persisted form of an imported ST preset: the original file bytes + SHA-256 plus the
parsed, nothing-dropped JSON, alongside the normalized view the runtime consumes. Edits mutate the
normalized view in place; the envelope's original bytes are silent provenance, not a lock.
_Avoid_: raw preset, preset blob

**The Oracle**:
The frozen set of golden fixtures captured once from SillyTavern 1.18.0 (transport bodies +
post-extension messages), which defines what "parity" means. Assembly parity is judged against the
Oracle given its inputs — the Oracle supplies World Info entries and token budget; it does not
cover WI activation or tokenizer behavior.
_Avoid_: reference implementation, ST comparison

**Execution Record**:
The forensic journal of one generation: ordered source spans, controlled-transform lineage, opaque
before/after entries for script mutations, decisions and omissions, and the exact wire messages.
Explains what was sent; does not promise deterministic re-execution.
_Avoid_: replay log, Run Record

**Prompt Contribution**:
An authored input to assembly from a preset or Agent: source identity, role, placement intent,
ordering, activation, budget class, and trust. Contributions go in; an Execution Record comes out.
_Avoid_: prompt block (that names the preset's normalized entries), message

**High-Trust Script**:
A card/preset script granted the remote-code capability by explicit per-preset opt-in. Runs with
network fetch and DOM freedom strictly inside the isolated card realm; the app renderer, main
process, and keys stay unreachable at every trust level. Import itself is the trust act for all
non-remote content — only remote code needs this extra grant.
_Avoid_: privileged script, unsafe mode

### Retired vocabulary

Workflow, canvas, node, trigger-rooted chain, trigger node, module, Agent Module, exposed setting,
derived capability, pack, fragment, checkpoint, attachment, gate, activation, effective graph,
override scopes, fork-vs-override, and recipe (as a distinct artifact) are no longer part of the
product language. Existing workflow artifacts and runtime behavior have no compatibility status in
the Agent system.

**Legacy Workflow Data**:
Stored workflow definitions, bindings, and run records from releases before the Agent system. RP
Terminal leaves them inert on disk but never loads, executes, migrates, or automatically deletes them.
