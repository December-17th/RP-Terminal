# Agent Pack Workflow UX Design, Revision 1

Date: 2026-07-03
Status: revised brainstorming snapshot
Based on: `2026-07-03-agent-pack-workflow-ux-design.md`

## Revision Summary

This revision keeps the original direction, but tightens four decisions:

- Build the user-facing Agents/Overview and exposed-settings layer before building a full package
  ecosystem.
- Store normal user edits as override sidecars keyed by stable setting ids; direct Workflow Studio edits
  create a fork.
- Derive capabilities from the workflow graph instead of trusting creator declarations.
- Treat card-shipped agents as the first real distribution path, with standalone files as a secondary
  path.

## Premise

The workflow graph is the right substrate for RP Terminal's long-term direction: it can express
multi-agent generation, memory maintenance, tool use, world simulation, post-response cleanup, and
content-creator-authored behavior. But the graph should not be the primary UI for average users.

The product model should be:

- Content creators build agents in Workflow Studio.
- Users import agents, usually from cards/worlds, and choose which ones are active.
- RP Terminal orchestrates agents through the workflow runtime.
- Advanced users can inspect, fork, and edit everything.

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
- If an agent ships inside a card cartridge, the user can still inspect, disable, fork, and edit it.

## Implementation Sequence

Do not start by building a complete package manager for a nonexistent ecosystem. The first slices should
dogfood the workflows RPT already ships.

Recommended order:

1. Agents/Overview UX over existing workflows.
   - Use the built-in default/decomposed workflow and the table-memory workflow as the first two
     internal "agent-like" experiences.
   - Present them as friendly agent recipes, not raw graphs.

2. Exposed settings sidecar.
   - Let a workflow expose selected fields as simple user controls.
   - Store user values outside the workflow doc.

3. Human-readable Runs/Trace view.
   - Reuse the existing workflow trace data.
   - Reskin/relocate it into the Agents workspace instead of creating a parallel trace system.

4. Dumb import/export.
   - Export an agent pack or recipe as a file with no upgrade/migration story yet.
   - Enough for creator experiments and manual sharing.

5. Card-cartridge integration.
   - Allow a world/card to include suggested agent packs and recipes.
   - Import/install should be explicit and inspectable.

6. Versioning and migrations.
   - Add only after real users/creators publish updated packs that need it.

## User Classes

### Average Users

Average users should not need to touch the workflow graph. Their main tasks are:

- Import an agent pack from a card/world or community source.
- Enable or disable agents.
- Choose API presets/models.
- Adjust a small set of safe, high-level knobs.
- Inspect what happened when an agent runs.
- Recover from failures with guided tools.

Examples of average-user controls:

- Enabled / disabled.
- Run timing: before reply, after reply, background, manual.
- Frequency: every N floors, every scene, manual only.
- Token budget.
- API preset.
- Memory template/table binding.
- Retry count and failure behavior.
- Creator-defined enums such as "Intensity" when the agent pack gives that setting meaning.

Important: generic controls such as "Intensity" should not become hardcoded runtime concepts. They are
patterns creators can expose through settings.

### Content Creators

Content creators use Workflow Studio to build reusable agents. They need:

- Workflow graph editor.
- Agent input/output contracts.
- Exposed settings builder.
- Default prompt and parameter editing.
- Test chat simulator.
- Trace and debug tools.
- Import/export packaging.
- Card-cartridge bundling.
- Compatibility validation.

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

Capabilities and required node types should be derived from `workflow`, not hand-declared as trusted
creator data. Creator annotations can explain intent, but the graph is the source of truth.

## Recipes

A recipe is a lightweight manifest of agent-pack references plus bindings. It should not be overloaded
into the same artifact as a pack.

Suggested shape:

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
- Shujuku-Style Memory: narrator + memory keeper + memory index + optional plot planner.
- Multi-Agent Story: planner + narrator + editor.
- Game Mode: planner + narrator + tool/combat agent + memory keeper.

Recipes are starting points, not sealed modes. Users can fork them.

## Distribution Model

The first real distribution channel is likely the card/world cartridge, not a standalone community pack
registry.

Card-shipped agents should be treated as suggestions bundled with the world:

- The card can include agent packs, recipes, memory templates, and supporting assets.
- Import should show what the card wants to install.
- The user chooses whether to install/activate those agents.
- Installed copies are user-owned and editable.
- Card updates must not silently overwrite user-modified installed agents.

Standalone `.rptagent` / `.rptrecipe` files can exist later, but card-first distribution should shape the
initial design.

Likely scopes:

- Global library: installed packs available to all worlds.
- World/card scope: card-shipped defaults and suggested activation.
- Chat/session scope: per-chat enablement and user overrides.

## Exposed Settings and Override Sidecars

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

The important storage decision:

- User edits made through exposed settings are stored in an override sidecar keyed by setting id.
- Overrides are not written into the workflow doc.
- The effective workflow is materialized by applying overrides to the base pack at runtime/save time.
- On pack upgrade, overrides are reapplied by setting id.
- Creators can restructure the graph in v2 and remap the same setting id to a new target.

Direct Workflow Studio edits are different:

- Opening the graph and changing hidden internals creates an implicit fork.
- A fork detaches from upstream automatic upgrades.
- The UI can still show "new upstream version available" with a diff, but the user must port changes
  manually.

This keeps upgrades honest. It avoids pretending arbitrary graph edits can be safely three-way-merged.

## Capability and Trust Model

Capabilities should be derived from the graph.

Examples of derived capabilities:

- Reads chat history.
- Reads memory tables.
- Writes memory tables.
- Injects prompt context.
- Reads lorebooks.
- Writes lorebooks.
- Calls an LLM preset.
- Runs before reply.
- Runs after reply.
- Runs in background.

Creators can add annotations such as "why this agent writes lorebooks", but the runtime should compute
the actual capability list from node types, edges, stages, and bindings.

User denial should be enforceable:

- If a user denies table writes, nodes requiring table-write capability cannot run.
- If a user denies lorebook writes, lorebook-write nodes fail or are disabled for that install.
- The import screen should explain which nodes require each capability.

This is cheaper and safer than trusting creator-declared permissions.

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

Roles are packaging and UI concepts, not a runtime enum. The engine remains a generic workflow executor.

## Memory as an Agent Capability

Memory should become part of the agent system, not a parallel feature silo.

The Memory Keeper agent can:

- Read recent floors.
- Read current table state.
- Read table rules and DDL.
- Query memory tables.
- Write SQL table updates.
- Advance progress pointers.
- Trigger backfill.
- Export memory into prompt context.
- Report what changed.

This allows shujuku-style memory to ship as an agent pack/recipe while preserving alternative memory
systems later.

## Orchestration Model

The workflow runtime should grow toward true agent orchestration, but engine work should be demand-driven.

Already useful:

- Synchronous pre-reply stages.
- Main response stage.
- Asynchronous post-reply stages.
- Parallel branches.
- Subgraphs and loops.
- Cancellation propagation.
- Human-readable traces.

High-priority additions:

- Resource locks for stateful writes, especially table writes.
- Clear retry/fallback policy per agent or node.
- Better friendly traces for skipped/failed agents.

Defer until a concrete recipe needs them:

- Complex join policies such as judge-picks-winner.
- Veto/guardrail reducers.
- General-purpose merge reducers.
- Rich package migrations.

The runtime should not accumulate speculative orchestration features just because they sound agentic.

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

## Import UX

Agent import should show:

- Name, creator, version.
- Role and intended use.
- Derived capabilities.
- Required node types.
- Required or bundled memory templates.
- Default API/model behavior.
- Exposed settings preview.
- Prompts included.
- Whether this pack modifies tables, lorebook entries, variables, or prompt injection.
- Whether the source is a card cartridge, local file, or global library.

Import should create a user-owned installed copy. Updates from the creator can be offered later, but user
customizations must not be overwritten silently.

## Open Questions

- Exact file formats for `.rptagent` and `.rptrecipe`.
- Whether card cartridge agent packs live under `data.extensions.rp_terminal.agentPacks` or another key.
- How to represent bundled memory templates inside PNG cartridge JSON versus appended ZIP assets.
- How to diff an upstream pack against a user fork in Workflow Studio.
- How much of the capability derivation belongs in shared workflow validation versus main-process import
  code.
- Whether prompt edits made in a simple prompt editor should be exposed-setting overrides or trigger a
  fork.

## Current Direction

The preferred direction is:

- Make workflow a real multi-agent orchestration runtime, but grow it demand-first.
- Make memory one first-class agent capability.
- Let creators author rich agents in Workflow Studio.
- Let average users import agents and adjust them through friendly settings pages.
- Store normal user customization as override sidecars.
- Treat advanced graph edits as forks.
- Derive capabilities from the graph.
- Make card-shipped agents the first distribution path.
- Preserve full user ownership and customization at every layer.
