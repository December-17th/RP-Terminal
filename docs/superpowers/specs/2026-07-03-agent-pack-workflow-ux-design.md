# Agent Pack Workflow UX Design

Date: 2026-07-03
Status: brainstorming snapshot / design direction

## Premise

The workflow graph is the right substrate for RP Terminal's long-term direction: it can express
multi-agent generation, memory maintenance, tool use, world simulation, post-response cleanup, and
content-creator-authored behavior. But the graph should not be the primary UI for average users.

The product model should be:

- Content creators build and publish agents.
- Users import agents and choose which ones are active.
- RP Terminal orchestrates agents through the workflow runtime.
- Advanced users can inspect and edit everything, including the underlying graph.

## Core Decision: Creator Authored, User Owned

Agent packs may ship with defaults, recommended settings, suggested prompts, and a curated setup
experience. They must not permanently lock user control.

No imported agent may make its settings, parameters, prompts, schedules, model bindings, memory
bindings, permissions, or workflow internals uneditable. Creators can define the initial experience;
users own the final experience.

Implications:

- Every creator-exposed setting is editable.
- Every creator-hidden setting remains reachable in an advanced editor.
- Prompts are defaults, not sealed assets.
- API/model choices are defaults, not mandates.
- Capability declarations inform and warn; they do not create creator-owned control.
- A user can fork/clone an imported agent pack and modify it without asking the original creator.

## User Classes

### Average Users

Average users should not need to touch the workflow graph. Their main tasks are:

- Import an agent pack from a card creator or community source.
- Enable or disable agents.
- Choose API presets/models.
- Adjust a small set of safe, high-level knobs.
- Inspect what happened when an agent runs.
- Recover from failures with guided tools.

Examples of average-user controls:

- Enabled / disabled.
- Run timing: before reply, after reply, background, manual.
- Frequency: every N floors, every scene, manual only.
- Intensity: subtle, balanced, aggressive.
- Token budget.
- API preset.
- Memory template/table binding.
- Retry count and failure behavior.

### Content Creators

Content creators use workflow graphs to build reusable agents. They need:

- Workflow graph editor.
- Agent input/output contracts.
- Tool/capability selection.
- Exposed settings builder.
- Default prompt and parameter editing.
- Test chat simulator.
- Trace and debug tools.
- Import/export packaging.
- Version and migration metadata.

### Advanced Users

Advanced users get the same power as content creators. The UI should never block them from:

- Opening the underlying graph.
- Editing prompts and hidden parameters.
- Rebinding tools and memory.
- Changing orchestration rules.
- Forking imported packs.
- Exporting modified packs.

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
  workflow: WorkflowDoc
  exposedSettings: AgentSettingSchema[]
  defaults: AgentPackDefaults
  capabilities: AgentCapabilities
  prompts: AgentPromptResource[]
  memoryRequirements?: AgentMemoryRequirement[]
  migrations?: AgentPackMigration[]
  ui?: AgentPackUiMetadata
}
```

The exact schema can change, but these concepts should remain separate:

- Workflow: executable behavior.
- Exposed settings: friendly controls for normal users.
- Defaults: creator recommendations.
- Capabilities: what the agent may read/write/run.
- Prompts: editable prompt resources.
- Memory requirements: tables, lorebooks, variables, or other state the agent expects.
- UI metadata: labels, grouping, descriptions, warnings.

## Agent Roles

RPT should not hardcode every possible agent type, but the UI can offer common role slots.

Initial role vocabulary:

- Narrator: produces the main assistant reply.
- Memory Keeper: reads chat/table state and writes durable memory.
- Plot Planner: runs before the reply and injects direction or recalled memory.
- World Simulation Agent: advances background state on a schedule or after turns.
- Editor: revises, validates, or style-checks generated output.
- Tool Agent: uses app/game tools such as combat, inventory, dice, or scripted actions.
- Lore Curator: selects, rewrites, or maintains lorebook/worldbook entries.

Roles are UI and packaging concepts. Underneath, they map to workflow graphs and node contracts.

## Memory as an Agent Capability

Memory should become part of the agent system, not a parallel feature silo.

The Memory Keeper agent is a first-class agent that can:

- Read recent floors.
- Read current table state.
- Read table rules and DDL.
- Query memory tables.
- Write SQL table updates.
- Advance progress pointers.
- Trigger backfill.
- Export memory into prompt context.
- Report what changed.

This allows shujuku-style memory to ship as an agent pack recipe, while preserving the ability to create
alternative memory systems later.

## Orchestration Model

The workflow runtime should grow toward true agent orchestration.

Needed semantics:

- Synchronous pre-reply stages.
- Main response stage.
- Asynchronous post-reply stages.
- Background/manual stages.
- Parallel branches.
- Joins and reducers.
- Cancellation propagation.
- Per-agent retry/fallback policies.
- Resource locks for writes.
- Human-readable traces.

Useful join policies:

- Wait all.
- First success.
- First acceptable result.
- Merge text blocks.
- Merge structured patches.
- Judge selects winner.
- Veto/guardrail blocks downstream.

Useful resource locks:

- Table write lock.
- Lorebook/worldbook write lock.
- Variables write lock.
- Chat floor write lock.
- File/export lock.

## Product UX

The normal user-facing workspace should be "Agents" or "Memory & Agents", not "Workflow".

Suggested tabs:

- Overview: active recipe, health, recent agent runs, errors, setup checklist.
- Installed Agents: enable/disable, role, timing, model, key settings.
- Memory: table template, active tables, maintenance status, backfill, repair.
- Prompt Preview: what agents/memory/lore will inject next turn.
- Runs: friendly trace of recent agent activity.
- Advanced: open Workflow Studio, fork agent, export pack.

The graph editor should be renamed/framed as Workflow Studio and positioned as a creator/advanced-user
surface.

## Exposed Settings

Creators can choose which settings appear in the simple settings page. This is a convenience layer, not a
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

Rules:

- Exposed settings map to editable workflow/config/prompt fields.
- Hidden settings remain editable in advanced mode.
- Settings should support localization.
- Settings should support validation and reset-to-creator-default.
- User overrides should survive agent pack upgrades when possible.

## Import UX

Agent import should show:

- Name, creator, version.
- Role and intended use.
- Required capabilities.
- Required memory templates or optional dependencies.
- Default API/model behavior.
- Exposed settings preview.
- Prompts included.
- Whether this pack modifies tables, lorebook entries, variables, or prompt injection.

Import should create a user-owned installed copy. Updates from the creator can be offered later, but user
customizations must not be overwritten silently.

## Permission and Trust Model

Agent packs should declare capabilities in human-readable form.

Examples:

- Reads chat history.
- Reads current memory tables.
- Writes memory tables.
- Injects prompt context.
- Reads lorebooks.
- Writes lorebooks.
- Calls selected LLM preset.
- Runs after assistant replies.
- Runs in background.

Permissions are not a lock against the user. They are a safety and transparency layer.

The user can:

- Deny a capability.
- Rebind a capability.
- Inspect which nodes use it.
- Edit the workflow to remove it.

## Recipe Layer

Recipes are curated combinations of agent packs and bindings.

Examples:

- Simple Chat: narrator only.
- Table Memory: narrator + memory keeper.
- Shujuku-Style Memory: narrator + memory keeper + memory index + optional plot planner.
- Multi-Agent Story: planner + narrator + editor.
- Game Mode: planner + narrator + tool/combat agent + memory keeper.

Recipes should be user-forkable. A recipe is a starting point, not a sealed mode.

## Open Questions

- Should Agent Packs and Recipes be the same file format with different metadata, or separate artifact
  types?
- Should memory table templates be bundled inside Agent Packs, referenced as dependencies, or both?
- How should pack upgrades preserve user edits to prompts and hidden workflow fields?
- How should UI expose creator defaults versus user overrides?
- Should agents be installed globally, per profile, per character/world, or per chat?
- How much validation should run before importing a pack from a card cartridge?
- Should packs declare minimum RPT versions and required node types?

## Current Direction

The preferred direction is not to clone a single database plugin UI. Instead:

- Make workflow a real multi-agent orchestration runtime.
- Make memory one first-class agent capability.
- Let creators author rich agents in Workflow Studio.
- Let users import agents and adjust them through friendly settings pages.
- Preserve full user ownership and customization at every layer.
