# Agent Pack Workflow UX Design, Revision 2

Date: 2026-07-03
Status: revised brainstorming snapshot
Supersedes: `2026-07-03-agent-pack-workflow-ux-design-revision-1.md`

## Revision Summary

Revision 1 tightened four decisions (build the UX layer before the package ecosystem; override
sidecars + implicit forks; derived capabilities; sequencing). Revision 2 keeps all of those and fixes
the points where revision 1 drifted from the owner's stated intent:

- **Distribution is standalone-sharing-first, not card-first.** Agent packs are primarily shared
  user-to-user as standalone files ("here is my memory setup"); card-cartridge bundling is a second
  wrapper around the same artifact, not the shaping channel.
- **Fork-and-export is the primary pack creation path.** Most packs will be born as forks of the
  shipped defaults, exported by power users — not built from scratch in Workflow Studio.
- **Trust surfaces get their own section.** Injection preview, the runs timeline, and "explain why"
  are the QoL features that motivated this redesign; they are first-class deliverables, not tab
  bullets.
- **Settings are split into three explicit tiers** (system-owned, creator-exposed, advanced), because
  tier 1 is uniform across all packs and buildable before any pack format exists.
- **The override boundary is a one-sentence rule:** anything with a stable id in the pack manifest is
  override territory; anything only reachable through the graph is fork territory.
- **The narrator question is now an explicit open question** (lean: native but forkable).

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

## Distribution Model

The primary sharing story is user-to-user: a power user tunes their setup, exports it as a standalone
file, and posts it wherever the community lives. This is the same social pattern as sharing presets or
regex collections in the ST ecosystem today, and it is how the pack ecosystem bootstraps from zero.

- **Standalone artifact first.** A pack (`.rptagent`) or recipe (`.rptrecipe`) must survive being
  posted to a Discord channel and imported by a stranger with no other context.
- **Card bundling is a second wrapper around the same artifact.** A card/world cartridge may embed
  packs and recipes as suggestions. Import shows what the card wants to install; the user chooses
  what to activate; installed copies are user-owned and editable. Card updates must not silently
  overwrite user-modified installs.
- **No registry assumed.** There is no central index, signing, or dependency resolution. Bundling
  (e.g. memory templates inside the pack) is therefore the default over reference-by-id.

Likely scopes:

- Global library: installed packs available to all worlds.
- World scope: activation and bindings per world (matches the World → Session → Play model).
- Chat/session scope: per-chat enablement and overrides where it makes sense.

## Pack Creation Path

The realistic first creators are power users of RPT itself, not workflow authors starting from a blank
canvas. The creation flow to design for:

1. User installs or starts from a shipped default (the table-memory recipe, the decomposed-default
   workflow).
2. User tweaks it — settings first, then maybe graph internals (which forks it).
3. User hits **Export as Pack**: names it, writes a description, picks which settings to expose as
   friendly controls, reviews the derived capability list, saves a `.rptagent` file.
4. User shares the file.

The export wizard is creator onboarding. It deserves as much design attention as import. Building a
pack from scratch in Workflow Studio is the advanced path, supported but not primary.

Consequence: the shipped defaults must themselves be packaged as (uninstallable, built-in) packs, so
"fork the default" and "fork an imported pack" are the same operation.

## User Classes and Settings Tiers

### Average users

Should never need to touch the workflow graph. Their tasks: import packs, enable/disable agents,
pick API presets, adjust a few knobs, inspect what happened, recover from failures with guided tools.

Settings come in three tiers:

1. **System tier (app-owned, identical on every pack).** Exists even for a pack whose creator exposed
   nothing: enabled/disabled, run timing (before reply / after reply / background / manual),
   API preset binding, token budget, retry count and failure behavior. Buildable today, before any
   pack format exists.
2. **Creator-exposed tier (schema-driven).** Whatever the creator surfaces via the exposed-settings
   schema: update frequency, recall depth, style/intensity enums, template bindings. Semantics are
   creator-defined; the app renders the control and stores the override. Generic knobs like
   "Intensity" live here as a creator pattern, never as a hardcoded runtime concept.
3. **Advanced tier.** Everything else, reachable through the advanced editor / Workflow Studio per
   the non-negotiable above.

### Content creators

Use Workflow Studio (and the export wizard) to build reusable agents. They need: the graph editor,
agent input/output contracts, an exposed-settings builder, default prompt and parameter editing, a
test chat simulator, trace and debug tools, export packaging, card-cartridge bundling, and
compatibility validation.

### Advanced users

Same power as creators. The UI never blocks: opening the graph, editing prompts and hidden
parameters, rebinding tools and memory, changing orchestration, forking imported packs, exporting
modified packs.

## Core Object: Agent Pack

An Agent Pack is a creator-authored, user-owned bundle.

Suggested shape:

```ts
type AgentPack = {
  id: string
  name: string
  version: string
  description: string
  creator?: string
  minRptVersion?: string
  workflow: WorkflowDoc
  exposedSettings: AgentSettingSchema[]
  defaults: AgentPackDefaults
  prompts: AgentPromptResource[]
  bundledMemoryTemplates?: TableTemplate[]
  ui?: AgentPackUiMetadata
  annotations?: AgentPackAnnotations
}
```

Capabilities and required node types are **derived from `workflow`**, not hand-declared. Creator
annotations can explain intent; the graph is the source of truth.

## Recipes

A recipe is a lightweight manifest of pack references plus bindings — a separate, smaller artifact,
not an overloaded pack.

```ts
type AgentRecipe = {
  id: string
  name: string
  description: string
  agents: Array<{
    packId: string
    enabled: boolean
    bindings: Record<string, unknown>
    overrides?: Record<string, unknown>
  }>
}
```

Examples:

- Simple Chat: narrator only.
- Table Memory: narrator + memory keeper.
- Indexed Table Memory: narrator + memory keeper + memory index + optional plot planner.
- Multi-Agent Story: planner + narrator + editor.
- Game Mode: planner + narrator + tool/combat agent + memory keeper.

Recipes are starting points, not sealed modes; users can fork them. Early on, a "recipe" may simply be
"which packs are enabled in this world" — don't build the artifact until sharing demands it.

## Exposed Settings and Override Sidecars

Creators choose which settings appear on the simple settings page. This is a convenience layer, not a
lock.

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

- User edits made through exposed settings (and system-tier settings) are stored in an **override
  sidecar keyed by stable id**, outside the workflow doc.
- The effective workflow is materialized by applying overrides to the base pack at run/save time.
- On pack upgrade, overrides are reapplied by id. Creators can restructure the graph in v2 and remap
  the same setting id to a new target; overrides carry over.
- Prompt edits made in a simple prompt editor are sidecar overrides keyed by prompt resource id —
  prompts are declared manifest resources, same as settings.

**The override boundary rule:** anything with a stable id in the pack manifest (exposed settings,
system settings, prompt resources) is override territory. Anything only reachable through the graph is
fork territory.

Direct Workflow Studio edits:

- Editing hidden internals creates an **implicit fork**. The install detaches from upstream automatic
  upgrades and is badged (e.g. "modified from X v1.2").
- The UI can still surface "new upstream version available" with a diff, but the user ports changes
  manually.

This keeps upgrades honest: no pretending arbitrary graph edits can be safely three-way-merged.

## Capability and Trust Model

Capabilities are derived from the graph — node types, edges, stages, bindings — never trusted from
creator declarations. Derivation logic lives in `shared/` (pure graph analysis, no main/renderer
imports), so Workflow Studio's export preview and the main-process import verification run the same
code and cannot drift.

Examples of derived capabilities: reads chat history; reads/writes memory tables; injects prompt
context; reads/writes lorebooks; calls an LLM preset; runs before reply / after reply / in background.

User denial is enforceable at the runtime:

- Deny table writes → table-write nodes cannot run for that install.
- Deny lorebook writes → lorebook-write nodes fail or are disabled for that install.
- The import screen explains which nodes require each capability.

Creator annotations ("why this agent writes lorebooks") ride alongside as human-readable context.

## Trust Surfaces

These are the features that make the system feel trustworthy and are the direct answer to the QoL gap
that motivated this redesign. They are first-class deliverables:

- **Injection / prompt preview.** Before sending, the user can inspect exactly what will enter the
  next prompt: assembled sections, table-memory block, triggered lorebook entries, agent/planner
  notes, omitted or skipped content, and token counts per section.
- **Runs timeline.** A human-readable trace built by reskinning the existing workflow trace data, not
  a parallel system: "Memory Keeper ran after floor 38. Updated 2 tables. Skipped 地点表: not due."
- **"Explain why."** A first-class button on tables and agents answering "why did / didn't this
  update?" — derivable from gate conditions plus the recorded trace. Failure states get guided
  recovery (retry, backfill, repair) rather than raw logs.

## Agent Roles

RPT should not hardcode agent types, but the UI can offer common role slots:

- Narrator: produces the main assistant reply.
- Memory Keeper: reads chat/table state and writes durable memory.
- Plot Planner: runs before the reply and injects direction or recalled memory.
- World Simulation Agent: advances background state on a schedule or after turns.
- Editor: revises, validates, or style-checks generated output.
- Tool Agent: uses app/game tools such as combat, inventory, dice, or scripted actions.
- Lore Curator: selects, rewrites, or maintains lorebook/worldbook entries.

Roles are packaging and UI concepts, not a runtime enum. The engine remains a generic workflow
executor.

## Memory as an Agent Capability

Memory is part of the agent system, not a parallel feature silo. The Memory Keeper agent can: read
recent floors; read current table state; read table rules and DDL; query memory tables; write SQL
table updates; advance progress pointers; trigger backfill; export memory into prompt context; report
what changed.

This lets the flagship table-memory experience ship as a pack/recipe while preserving room for
alternative memory systems later.

## Orchestration Model

The workflow runtime should grow toward true agent orchestration, demand-first.

Already useful (exists or near-exists): synchronous pre-reply stages, main response stage,
asynchronous post-reply stages, parallel branches, subgraphs and loops, cancellation propagation,
human-readable traces.

High-priority additions:

- Resource locks for stateful writes — table writes first (real corruption risk).
- Clear per-agent/per-node retry and fallback policy.
- Better friendly traces for skipped/failed agents (feeds "explain why").

Defer until a concrete recipe needs them: judge-picks-winner joins, veto/guardrail reducers,
general-purpose merge reducers, rich package migrations. The runtime must not accumulate speculative
orchestration features because they sound agentic.

## Product UX

The user-facing workspace is "Agents" or "Memory & Agents", not "Workflow".

Suggested tabs:

- Overview: active recipe, health, recent agent runs, errors, setup checklist.
- Installed Agents: enable/disable, role, timing, model, key settings.
- Memory: table template, active tables, maintenance status, backfill, repair.
- Prompt Preview: the injection trust surface (see above).
- Runs: the friendly trace timeline (see above).
- Advanced: open Workflow Studio, fork agent, export pack.

The graph editor is renamed/framed as **Workflow Studio**, positioned as a creator/advanced surface.
Users normally arrive there via "Customize this agent," not as a top-level destination.

## Import UX

Agent import shows:

- Name, creator, version.
- Role and intended use.
- Derived capabilities and required node types.
- Bundled or required memory templates.
- Default API/model behavior.
- Exposed settings preview.
- Prompts included.
- Whether the pack modifies tables, lorebook entries, variables, or prompt injection.
- Source: standalone file, card cartridge, or global library.

Import creates a user-owned installed copy. Creator updates can be offered later; user customizations
are never silently overwritten.

## Implementation Sequence

Do not start with a package manager for a nonexistent ecosystem. Dogfood the workflows RPT already
ships:

1. **Agents workspace over existing workflows.** System-tier settings, the shipped table-memory and
   decomposed-default workflows presented as installed agents, injection preview, runs reskin,
   "explain why." Only engine work: table write lock.
2. **Pack format v0.** Exposed-settings schema, override sidecar, fork/detach semantics, and the
   fork-and-export wizard producing a dumb `.rptagent` file (derived capabilities included, no
   upgrade story).
3. **Import.** Standalone-file import with the capability/inspection screen. Card-cartridge bundling
   as the second wrapper (key under `data.extensions.rp_terminal`, exact shape TBD).
4. **Orchestration on demand.** Sync pre-reply planner when a planner recipe ships; joins/policies
   when a recipe actually needs parallel.
5. **Versioning and migrations.** Only after real creators publish updated packs that need it.

## Open Questions

- **Is the Narrator itself a pack, or a native built-in that packs orbit?** Making the main reply
  path installable is elegant but means a bad import can break the core loop. Current lean: narrator
  stays native but forkable; planners/editors/keepers are packs. Revisit once pack format v0 is
  proven.
- Exact file formats for `.rptagent` / `.rptrecipe` (JSON envelope vs zip; where binary assets go).
- Cartridge embedding: agent packs under `data.extensions.rp_terminal.agentPacks` or another key; how
  bundled memory templates split between cartridge JSON and the appended ZIP.
- How to diff an upstream pack against a user fork in Workflow Studio.
- Localization of creator-provided setting labels (multi-locale labels in the schema, fall back to
  whatever exists?).
- How much import validation runs on packs arriving from untrusted sources beyond capability
  derivation (schema validation, node-type allowlist, size limits).

## Current Direction

- Make workflow a real multi-agent orchestration runtime, grown demand-first.
- Make memory one first-class agent capability; the polished table-memory pack is the flagship proof.
- Let creators author rich agents — primarily by forking shipped defaults and exporting.
- Let average users import agents and adjust them through friendly, tiered settings pages.
- Store normal user customization as override sidecars keyed by manifest ids.
- Treat direct graph edits as forks.
- Derive capabilities from the graph, in `shared/`, enforceable on denial.
- Distribute standalone-first; card bundling is a second wrapper around the same artifact.
- Ship the trust surfaces (injection preview, runs timeline, explain-why) as first-class features.
- Preserve full user ownership and customization at every layer.
