# Agent Pack Workflow UX Design, Revision 3

Date: 2026-07-03
Status: grilled design snapshot (13 decisions resolved in a grilling session)
Supersedes: `2026-07-03-agent-pack-workflow-ux-design-revision-2.md`
Decision records: ADRs 0001–0009 under `docs/adr/`; glossary in root `CONTEXT.md`

## Revision Summary

Revision 2 fixed distribution (standalone-first) and framing (fork-and-export, trust surfaces,
settings tiers, override boundary). Revision 3 is the same design after a question-by-question
grilling that resolved the runtime model and the ownership mechanics:

- **Composition (ADR 0001):** a pack's executable part is a workflow *fragment*; at generation time
  the runtime materializes one **effective graph** — narrator + every enabled fragment — executed
  as a single engine run.
- **Attachment (ADR 0002):** fragments attach at named **checkpoints** on the narrator's main path,
  with real visible edges (creators wire, users toggle). Disabling = closing a **gate** on entry
  edges; cascade warnings are computed from reachability.
- **Headless runs (ADR 0003/0004):** turn-decoupled agents (world-sim, async memory compaction) run
  as their own engine runs, started by **triggers** evaluated at commit boundaries only,
  communicating with turns exclusively through committed durable state.
- **Scoping (ADR 0005):** install globally, activate per world, override per chat.
- **Forks (ADR 0006):** copy-on-edit, never in-place detach.
- **Denial (ADR 0007):** denying a capability closes capability-shaped gates.
- **Recipes (ADR 0008):** bundle for transport, reference internally.
- **Pack shape (ADR 0009):** one pack = one graph with many attachments; the gate is per-pack.
- Run timing is **structure, not a setting**; the export wizard is a **contract-aware bundler**;
  the file envelope is **single JSON**; the implementation sequence now starts with the engine
  substrate.

## Premise

The workflow graph is the right substrate for RP Terminal's long-term direction: it can express
multi-agent generation, memory maintenance, tool use, world simulation, post-response cleanup, and
creator-authored behavior. But the graph should not be the primary UI for average users.

The product model:

- Content creators build agents (usually by forking and refining shipped defaults).
- Users import agents from other users, community sources, or cards, and choose which are active.
- RP Terminal orchestrates agents through the workflow runtime.
- Advanced users can inspect, fork, and edit everything.

The flagship proof is the memory experience: a polished, production-quality table-memory setup,
delivered as the first agent pack. Every mechanism below must justify itself by making that one pack
excellent; anything not needed for it moves to a later milestone.

## Non-Negotiable: Creator Authored, User Owned

Agent packs may ship with defaults, recommended settings, suggested prompts, and a curated setup
experience. They must not permanently lock user control.

No imported agent may make settings, parameters, prompts, schedules, model bindings, memory bindings,
permissions, or workflow internals uneditable. Creators define the initial experience; users own the
final experience.

Implications:

- Every creator-exposed setting is editable.
- Every creator-hidden setting remains reachable in advanced mode.
- Prompts are defaults, not sealed assets.
- API/model choices are defaults, not mandates.
- A user can fork/clone an imported agent pack and modify it without asking the original creator.
- If an agent arrives inside a card cartridge, the user can still inspect, disable, fork, and edit it.

## Runtime Model

### One effective graph per turn (ADR 0001)

The engine executes exactly one workflow doc per generation. An agent pack's executable part is a
**fragment** — a subgraph-shaped workflow, not runnable alone. At generation time the runtime
materializes the **effective graph**: the narrator (the base workflow producing the main reply,
resolved through the existing session → world → global → builtin tiers) plus every enabled
fragment spliced in. One engine run, one unified trace — which the Runs timeline and "explain why"
depend on. The narrator is native but forkable, not itself a pack (revisit once pack v0 is proven).

### Checkpoints, branches, inlines, gates (ADR 0002)

The narrator's main path is punctuated by **named checkpoints** — the pack ABI. A fragment enters
at a checkpoint as its own sub-path:

- **Branch** (default): the main flow does not depend on it. It rejoins by contributing a value at
  a later checkpoint (e.g. a prompt injection) or ends in side effects. Failure or disablement
  never blocks the reply — branch sub-paths fail open even in the pre-reply region (an engine
  change: today any pre-phase failure is fatal).
- **Inline**: the main message flow is wired through the fragment; downstream depends on its
  output. Failure blocks the reply; disabling it gates the reply itself, and the user is warned.

Wiring is real, visible edges in Workflow Studio — creators wire, users only toggle. Because
entries and rejoins land on well-known checkpoints rather than raw node ids, packs stay portable
across narrators that expose the same checkpoints. A custom narrator is composition-ready exactly
to the extent it exposes checkpoints; missing ones produce a visible warning, never silent
breakage.

**Disabling a pack closes a gate** on every entry edge its fragment declares, as one act.
Everything reachable only through those edges — including other packs chained after them — is
skipped, and the cascade warning ("turning off X also turns off Y — and the main reply") is
computed from graph reachability, never creator-declared.

### The v1 checkpoint vocabulary (frozen at four)

1. **`context-ready`** — after `input.context`; value: the turn Context. Entry for planners,
   memory recall, history transforms.
2. **`prompt-assembly`** — into `prompt.assemble`; accepts prompt-injection contributions (block +
   placement). The main rejoin point; what makes the injection preview attributable per pack.
3. **`reply-parsed`** — after `parse.response`; value: parsed reply + Context. Entry for editors
   (inline) and after-reply extractors.
4. **`turn-committed`** — after `output.writeFloor`; value: final floor + Context. Entry for
   memory keepers and world-sim; always fail-open.

No fifth checkpoint (e.g. raw-stream interception between `llm.sample` and `parse.response`) until
a real pack is blocked without it. Every checkpoint added is a compatibility promise.

### One pack, one graph, many attachments (ADR 0009)

A fragment may declare several attachments — checkpoint entries (branch or inline) and/or headless
triggers. Motivating case: the async-memory pack is a headless compactor + an inline history
trimmer at `context-ready` (trimming transforms the main flow, so it cannot be a branch) + a branch
injecting the memory export at `prompt-assembly`. The gate stays per-pack: one toggle for "my
memory system." Creators wanting independently-toggleable pieces ship separate packs in a recipe —
expressive, not forced.

### Headless runs and triggers (ADR 0003, ADR 0004)

Agents no player action causes — world-sim firing when in-game time advances a month, compaction
summarizing old exchanges — run as **headless runs**: separate engine runs, parallel to turns,
started by a **trigger**:

- **State condition** — a predicate over floor variables / table state.
- **Cadence** — every N floors (sugar over a state condition).
- **Manual** — a button.

Triggers are evaluated against *committed* state at exactly two moments: after a turn commits and
after a headless run commits (deliberate chains allowed, bounded by a depth cap). No wall-clock
scheduling in v1; adding it later is an additive trigger kind.

Headless runs communicate with turns **only through durable state**, and no turn ever waits: e.g.
compaction advances a progress pointer only when its table write commits; the next turn's trimmer
trims history up to that pointer, and simply carries untrimmed history if the run hasn't landed.
This does not contradict ADR 0001 — the one-effective-graph rule governs everything reply-coupled;
headless runs are precisely the fragments with no rejoin into the current turn.

Consequences: table/variable write locks move from wishlist to required (multiple engine runs can
be live); the Runs timeline shows headless runs attributed to pack and trigger.

## Distribution Model

The primary sharing story is user-to-user: a power user tunes their setup, exports it as a standalone
file, and posts it wherever the community lives. Same social pattern as sharing presets or regex
collections in the ST ecosystem; it is how the ecosystem bootstraps from zero.

- **Standalone artifact first.** A pack (`.rptagent`) or recipe (`.rptrecipe`) must survive being
  posted to a Discord channel and imported by a stranger with no other context.
- **Card bundling is a second wrapper around the same artifact.** A cartridge may embed packs and
  recipes as suggestions; import shows what the card wants to install; the user chooses; installed
  copies are user-owned. Card updates never silently overwrite user-modified installs.
- **No registry assumed.** No central index, signing, or dependency resolution — bundling beats
  reference-by-id everywhere (memory templates inside packs, packs inside recipes).

### Envelope

`.rptagent` / `.rptrecipe` are **single UTF-8 JSON documents** with a top-level `formatVersion`.
Diffable, inspectable, embeddable in the cartridge's JSON side, shareable through chat apps.
Prompts stay inline as structured strings (they need stable ids for overrides anyway). A zip
variant is explicitly deferred until binary assets exist; the inner JSON schema would become one
member of the archive, unchanged.

### Install, activate, override (ADR 0005)

- **Install** — import creates one user-owned copy in the **global library**, regardless of
  arrival path (standalone file or card; the card merely suggests activation for its own world).
- **Activate** — gate state is per **world**, with an optional per-chat exception. The Agents
  workspace inside a world is the library filtered through "enabled here?".
- **Override** — setting values layer global default → per-world → per-chat, nearest wins, with
  provenance shown in the UI ("set for this chat, overriding this world").

This mirrors the workflow selection tiers users already live in.

### Recipes (ADR 0008)

A recipe is a set of packs plus an activation preset (enabled set, world-scope overrides, narrator
choice). Internally it references packs by id + version; **for transport it embeds full copies**,
which dedupe into the library at import (installed → skip, new → ordinary install). Recipe import
is N pack installs + one activation preset — not a second import pathway.

- Version collision: the recipe's pinned version installs alongside; the recipe activates what it
  pinned (recipes are reproducible or they are nothing); "use your newer version instead" is an
  explicit user choice.
- Narrator: builtin referenced by well-known id; a custom narrator embeds like a pack.
- Examples: Simple Chat (narrator only); Table Memory (+ memory keeper); Indexed Table Memory
  (+ memory index + optional planner); Multi-Agent Story (planner + narrator + editor); Game Mode
  (+ tool/combat agent).

## Pack Creation Path

The realistic first creators are power users of RPT itself. The flow to design for:

1. Start from a shipped default (the table-memory pack, the decomposed-default workflow) — the
   shipped defaults are themselves packaged as built-in, uninstallable packs, so "fork the default"
   and "fork an imported pack" are the same operation.
2. Tweak: settings first, then maybe graph internals (which forks it, see below).
3. **Export as Pack** — the wizard is creator onboarding.
4. Share the file.

### Export wizard v0: a contract-aware bundler

The v0 wizard does: name/version/description; shows the **detected attachments** (which checkpoints
and triggers the graph uses); shows the **derived-capability preview** (the same `shared/`
derivation import uses); and **refuses** to export a fragment with no attachment or with edges into
non-checkpoint narrator nodes (narrator-bound fragments would break on every other machine, and
with no registry there is no recall). It does *not* include an exposed-settings builder — v0 packs
ship with system settings only, which already cover the motivating examples. Export-time and
import-time validation are one `shared/` implementation, so "exports fine here, rejected there"
cannot happen.

## User Classes and Settings Tiers

### Average users

Should never need to touch the workflow graph. Their tasks: import packs, toggle agents, pick API
presets, adjust a few knobs, inspect what happened, recover from failures with guided tools.

Settings come in three tiers:

1. **System tier (app-owned, identical on every pack).** The gate (enabled/disabled), API preset
   binding, token budget, retry count and failure behavior, and — on headless packs — trigger
   parameters (the N in a cadence, the threshold in a condition). **Run timing is not here:**
   where a pack attaches is structure, shown read-only ("runs before the reply"), changed only by
   forking. A creator may later declare alternate attachments the fragment genuinely supports
   (additive manifest metadata), and only then does a timing switcher appear.
2. **Creator-exposed tier (schema-driven).** Whatever the creator surfaces via the exposed-settings
   schema: update frequency, recall depth, style/intensity enums, template bindings. Semantics are
   creator-defined; the app renders the control and stores the override. Generic knobs like
   "Intensity" live here as a creator pattern, never as a hardcoded runtime concept.
3. **Advanced tier.** Everything else, reachable through Workflow Studio per the non-negotiable.

### Content creators

Use Workflow Studio and the export wizard. They need: the graph editor, the checkpoint/attachment
contract, derived-capability preview, default prompt and parameter editing, a test chat simulator,
trace and debug tools, export packaging, card-cartridge bundling, compatibility validation.

### Advanced users

Same power as creators. The UI never blocks: opening the graph, editing prompts and hidden
parameters, rebinding tools and memory, changing orchestration, forking imported packs, exporting
modified packs.

## Core Object: Agent Pack

```ts
type AgentPack = {
  formatVersion: number
  id: string
  name: string
  version: string
  description: string
  creator?: string
  minRptVersion?: string
  fragment: WorkflowDoc            // one graph...
  attachments: AttachmentDecl[]    // ...many attachments: checkpoint entries, rejoins, triggers
  exposedSettings: AgentSettingSchema[]
  defaults: AgentPackDefaults
  prompts: AgentPromptResource[]   // stable ids; inline strings
  bundledMemoryTemplates?: TableTemplate[]
  ui?: AgentPackUiMetadata
  annotations?: AgentPackAnnotations
}
```

Capabilities and required node types are **derived from `fragment`**, never hand-declared. Creator
annotations explain intent; the graph is the source of truth.

## Exposed Settings and Override Sidecars

Example exposed setting:

```ts
{
  id: "memory.updateFrequency",
  label: "Update frequency",
  type: "number",
  default: 3,
  min: 1,
  max: 20,
  target: {
    workflowNodeId: "memory_gate",
    path: "config.every"
  }
}
```

Storage decisions:

- User edits through exposed settings and system-tier settings are stored in an **override sidecar
  keyed by stable id**, outside the workflow doc, layered by scope (ADR 0005).
- The effective workflow is materialized by applying overrides to the base pack at run time.
- On pack upgrade, overrides reapply by id. Creators can restructure the graph in v2 and remap the
  same setting id to a new target; overrides carry over.
- Prompt edits in the simple prompt editor are sidecar overrides keyed by prompt resource id.

**The override boundary rule:** anything with a stable id in the pack manifest (exposed settings,
system settings, prompt resources) is override territory. Anything only reachable through the graph
is fork territory.

### Forks are copy-on-edit (ADR 0006)

Editing an installed pack's graph in Workflow Studio creates a **new library entry** with upstream
lineage recorded and existing overrides carried over; the world where the edit happened repoints
its activation to the fork; the pristine install stays untouched for every other world. No prompt,
no choice — the edit is the fork, and it is non-destructive. The library groups entries by lineage
("Plot Planner — 2 forks"); "apply this fork to other worlds" is offered afterward. Forks receive
no automatic upgrades; "new upstream version available" shows a diff against the (never-mutated)
original, and the user ports changes manually. No pretending arbitrary graph edits can be safely
three-way-merged.

## Capability and Trust Model (ADR 0007)

Capabilities are derived from the graph, never trusted from creator declarations. Derivation lives
in `shared/` (pure graph analysis) so Studio's export preview and main-process import verification
run the same code and cannot drift. The mapping is mechanical over the existing node inventory:

- `table.read` / `table.query` / `table.export` → reads tables; `table.apply` → writes tables.
- `vars.get` → reads variables; `vars.save` / `mvu.set` / `apply.state` → writes variables.
- `lorebook.select` / `lorebook.entries` / `tool.lorebookSearch` → reads lorebooks.
- `context.history` / `input.context` → reads chat history; `llm.sample` → calls an LLM;
  `output.writeFloor` → writes floors; `tool.startCombat` / `tool.startDuel` → runs game tools.
- From **edges**, not node types: a rejoin at `prompt-assembly` → injects prompt context; a
  declared trigger → runs headless.

Known gap: **no lorebook-write node exists today**, so no pack can derive that capability (the Lore
Curator role is read-only until one is added deliberately).

**Denial closes gates.** Denying a capability closes the entry edges of every sub-path reaching a
node that needs it — the same mechanism and reachability analysis as disabling, with the same
cascade warning ("denying table writes turns off the memory-update path; the recall path keeps
working"). Denial covering the whole fragment = "this is equivalent to disabling the pack," said
plainly. Because gating is enforcement, the reachability analysis must be sound, in `shared/`,
under test. Degraded-but-useful packs become a supported pattern: creators can design read and
write halves as separate sub-paths knowing denial severs them cleanly.

## Trust Surfaces

First-class deliverables — the direct answer to the QoL gap that motivated this redesign:

- **Injection / prompt preview.** Before sending: assembled sections, table-memory block, triggered
  lorebook entries, agent/planner contributions — attributable per pack because every injection is
  a rejoin edge at `prompt-assembly` — plus omitted/skipped content and token counts per section.
- **Runs timeline.** A reskin of the existing workflow trace, not a parallel system: "Memory Keeper
  ran after floor 38. Updated 2 tables. Skipped 地点表: not due." Headless runs appear alongside
  turns, attributed to pack and trigger.
- **"Explain why."** A button on tables and agents answering "why did / didn't this update?" —
  derivable from gate state (disabled, denied, cascade) plus the recorded trace. Failure states get
  guided recovery (retry, backfill, repair), not raw logs.

## Agent Roles

Roles are packaging and UI concepts, not a runtime enum — the engine remains a generic executor:

- Narrator: produces the main assistant reply (native, forkable, not a pack).
- Memory Keeper: reads chat/table state and writes durable memory.
- Plot Planner: enters at `context-ready`, rejoins at `prompt-assembly`.
- World Simulation Agent: headless, state-condition trigger.
- Editor: inline at `reply-parsed`.
- Tool Agent: uses combat, inventory, dice, scripted actions.
- Lore Curator: read-only until a lorebook-write node exists.

## Memory as an Agent Capability

Memory is part of the agent system, not a parallel silo. The flagship async-memory pack (ADR 0009's
motivating case): headless compaction on a backlog trigger, progress-pointer commits, inline
history trimming against the committed pointer, branch injection of the table export. It ships as
a pack/recipe while preserving room for alternative memory systems later.

## Orchestration Model

Demand-first. Now *required* (no longer wishlist): table/variable write locks (headless runs make
concurrent engine runs real); branch fail-open in the pre-reply region; per-pack retry/failure
behavior (a system setting); trace entries for gated/skipped paths (feeds "explain why").

Defer until a concrete recipe needs them: judge-picks-winner joins, veto/guardrail reducers,
general-purpose merge reducers, rich package migrations. The runtime must not accumulate
speculative orchestration features because they sound agentic.

## Product UX

The user-facing workspace is "Agents" or "Memory & Agents", not "Workflow". Suggested tabs:

- Overview: active packs, health, recent runs, errors, setup checklist.
- Installed Agents: gates, attachment shown read-only, model, key settings with provenance.
- Memory: table template, active tables, maintenance status, backfill, repair.
- Prompt Preview: the injection trust surface.
- Runs: the friendly trace timeline (turns + headless runs).
- Advanced: open Workflow Studio, fork agent, export pack.

The graph editor is **Workflow Studio**, a creator/advanced surface reached via "Customize this
agent," not a top-level destination.

## Import UX

Shows: name, creator, version; role and intended use; **attachments** (where it hooks in, which
trigger); **derived capabilities** with the nodes that require each; bundled memory templates;
default API/model behavior; exposed settings preview; prompts included; source (standalone file,
card cartridge, library). Import creates the user-owned library install; activation is a separate,
per-world act (suggested by cards, chosen by the user).

## Implementation Sequence

Engine substrate first — packs cannot exist until the narrator has checkpoints. Each phase ends
with the built-in packs demonstrably running through the new machinery (same behavior as today =
characterization tests hold).

1. **Engine substrate.** Checkpoints retrofitted into the builtin narrator; effective-graph
   composition; per-pack gates; branch fail-open in the pre-reply region; table/variable write
   locks. Validated by re-expressing the shipped decomposed-default and table-memory workflows as
   built-in packs — dogfooding the ABI before any external creator sees it.
2. **Headless runs + triggers.** Commit-boundary evaluator, depth cap, progress-pointer pattern.
   Unlocks world-sim and async compaction as built-in packs.
3. **Agents workspace v1.** Gates over built-in packs, provenance-aware settings, runs timeline
   reskin, injection preview with per-pack attribution, "explain why."
4. **Pack format v0 + contract-aware export wizard + import.** Capability derivation in `shared/`
   powering both ends; override sidecar; copy-on-edit forks.
5. **Card-cartridge wrapper + recipes.**
6. **Versioning / upgrade UX.** Override reapply exists from day one via the sidecar; this phase is
   the upstream-diff and update-offer flow.

## Resolved Questions (this revision)

- Narrator: **native but forkable, not a pack** (ADR 0001; revisit after pack v0).
- File envelope: **single JSON + formatVersion**; zip deferred until binary assets exist.
- Run timing: **structure, not a setting**; creator-declared alternates are a later additive.
- Prompt edits in the simple editor: **overrides** (stable prompt-resource ids), never forks.

## Open Questions

- Cartridge embedding: packs under `data.extensions.rp_terminal.agentPacks` or another key; how
  bundled memory templates split between cartridge JSON and the appended ZIP.
- How to render an upstream-vs-fork diff in Workflow Studio (graph diffing UX).
- Localization of creator-provided setting labels (multi-locale labels in the schema?).
- Import validation depth for untrusted files beyond capability derivation (schema validation,
  node-type allowlist, size limits).
- When (and whether) to add a lorebook-write node, unlocking the Lore Curator write half.
- Exact value shapes at each checkpoint (the Context type is the candidate carrier; pin when
  building phase 1).

## Current Direction

- Grow the workflow runtime into agent orchestration demand-first, starting from the checkpoint
  substrate.
- Make memory a first-class agent capability; the polished table-memory pack is the flagship proof.
- Let creators author packs primarily by forking shipped defaults and exporting through the
  contract-aware wizard.
- Let average users toggle gates and adjust tiered settings; never require the graph.
- Store customization as layered override sidecars; treat graph edits as copy-on-edit forks.
- Derive capabilities from the graph in `shared/`; enforce denial as gates.
- Distribute standalone-first; bundle everything; card cartridges are a second wrapper.
- Ship the trust surfaces (injection preview, runs timeline, explain-why) as first-class features.
- Preserve full user ownership and customization at every layer.
