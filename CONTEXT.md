# RP Terminal

A standalone Electron app evolving the SillyTavern-style chat experience into a game platform,
with generation orchestrated by a node-workflow runtime. This glossary covers the agent layer as
redefined by ADR 0011 (the one-canvas pivot, 2026-07-03).

## Language

### The canvas model

**Canvas**:
The one workflow editor surface showing every node of the active workflow doc at once — the
narrator chain and all agent chains, expanded or collapsed, enabled or disabled. Palette left,
settings panel right, run history in a drawer.

**Narrator**:
The chain that produces the main assistant reply (the main-output node and its ancestors).
Resolved per chat through the existing workflow selection tiers.
_Avoid_: main agent

**Agent**:
A trigger-rooted chain in the workflow doc. Excluded from turn execution; runs headlessly when
its trigger fires. Turn-coupled behavior (e.g. prompt injection) is not an agent — it is ordinary
wiring into the narrator.
_Avoid_: pack (retired), background job

**Trigger Node**:
A graph-root node that starts its downstream chain: state condition, cadence, or manual. It is
the agent's timing config AND its off-switch — disabling the trigger disables the agent, which
stays visible on the canvas, dimmed.

**Module**:
A grouped sub-chain rendered as one collapsible bigger node. The author picks which inner-node
settings are exposed on the module's settings panel. Reversible (ungroup). The unit of sharing.
_Avoid_: pack, plugin, extension

**Agent Module (file)**:
An exported module: sub-graph + exposed-settings map + optional bundled table schema/templates.
Imports by dropping into the current doc, after inspection (locally derived capabilities,
unknown-node blockers).

**Exposed Setting**:
An inner-node setting the module author surfaced on the module's panel. A convenience, never a
lock — expanding the module reaches everything.

**Derived Capability**:
What a chain/module can read/write/run, computed from its node types — never trusted from a
file's claims. Shown at import.

### Retired vocabulary (see ADR 0011)

Pack, fragment, checkpoint, attachment, gate, activation, effective graph, override scopes,
fork-vs-override, recipe (as a distinct artifact) — phase-1–5 concepts whose engineering
survives underneath (trigger evaluator, subgraph machinery, envelopes, materialization) but which
are no longer part of the product language.
