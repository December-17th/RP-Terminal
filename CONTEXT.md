# RP Terminal

A standalone Electron app evolving the SillyTavern-style chat experience into a game platform, with
generation orchestrated by a node-workflow runtime. This glossary covers the agent-pack layer being
designed on top of that runtime.

## Language

### Agents and packs

**Agent Pack**:
A creator-authored, user-owned distributable bundle: a workflow fragment plus its manifest (exposed
settings, prompts, defaults, metadata). The unit users import, enable, and customize.
_Avoid_: plugin, extension, script

**Fragment**:
The executable part of an agent pack — a single subgraph-shaped workflow that may declare several
attachments (checkpoint entries, rejoins, triggers). A fragment is not runnable on its own.

**Checkpoint**:
A named, stable point on the narrator's main path where fragments enter and where their
contributions rejoin. The checkpoint vocabulary (names + the value shape at each) is the
compatibility surface packs depend on.
_Avoid_: hook (implies imperative callbacks; a checkpoint is a graph location)

**Attachment Point**:
Where a fragment joins the turn: an entry checkpoint (plus optional rejoin checkpoint) on the main
path, or off the main path entirely as a headless run started by a trigger.

**Headless Run**:
An execution of a fragment outside any turn, started by a trigger rather than a player action. It
runs parallel to (or between) turns and communicates with future turns only through durable state
(floor variables, memory tables, lorebooks). It never touches an in-flight turn, and no turn ever
waits for it.
_Avoid_: background job (implies a generic scheduler; a headless run is still a fragment run)

**Trigger**:
The condition that starts a headless run: a state condition (e.g. a floor variable crossing a
threshold), a cadence (e.g. every N floors), or a manual action. Triggers are evaluated against
committed state only — never against in-flight writes, and never on wall-clock time.

**Branch Fragment**:
A fragment the main flow does not depend on. It enters at a checkpoint and either rejoins by
contributing a value at a later checkpoint or ends in side effects. Its failure or disablement
never blocks the reply.

**Inline Fragment**:
A fragment the main message flow is wired through — downstream checkpoints depend on its output.
Disabling it gates the reply itself; the user is warned before doing so.

**Gate**:
The enable/disable mechanism. Disabling a pack closes every entry edge its fragment declares, as
one act; everything reachable only through those edges — including other fragments chained after
them — is skipped. Gates are per-pack; only capability denial closes a subset.

**Narrator**:
The base workflow that produces the main assistant reply. Resolved per chat through the existing
selection tiers; forkable but not an agent pack.
_Avoid_: main agent, reply pack

**Effective Graph**:
The single composed workflow actually executed for a turn — the narrator plus every enabled
fragment. Materialized at generation time; never stored as a user-visible artifact.

**Recipe**:
A shareable starting point: a set of agent packs plus an activation preset (which packs are on,
their overrides, the narrator choice). Internally a recipe references packs by id + version; for
transport it embeds full copies, which dedupe into the library at import. Never a sealed mode.
_Avoid_: mode, preset (reserved for API/prompt presets)

### Ownership and customization

**Install**:
The user-owned copy of a pack in the global library, created by import. There is exactly one
install concept regardless of arrival path — a standalone file and a card-bundled pack both land in
the library; the card merely suggests activation for its own world.

**Library**:
The global collection of installed packs, shared by all worlds. Worlds decide activation; the
library owns the artifacts.

**Activation**:
Whether an installed pack's gates are open in a given world, with an optional per-chat exception.
Activation state lives with the world/chat, never inside the pack.

**Override**:
A user edit stored outside the pack, keyed by a stable manifest id (setting id, prompt id).
Overrides survive pack upgrades by being reapplied by id, and layer by scope — global default,
per-world, per-chat — with the nearest scope winning.

**Fork**:
A new library entry created by copy-on-edit the moment a pack's graph is directly edited, with
upstream lineage recorded and existing overrides carried over. The pristine install stays in the
library; only the world where the edit happened repoints to the fork. Forks receive no automatic
upgrades; the user ports upstream changes manually via diff.

**Exposed Setting**:
A control the creator surfaces on the simple settings page, mapping a stable id to a field inside
the fragment. A convenience layer, never a lock.

**System Setting**:
A control the app owns uniformly on every pack: the gate (enabled), API preset, token budget,
retry/failure behavior, and — on headless packs — trigger parameters (the N in a cadence, the
threshold in a condition). Where a pack attaches is not a setting but structure: shown read-only,
changed only by forking. A creator may later declare alternate attachments the fragment genuinely
supports, which is additive.

### Trust

**Derived Capability**:
What a pack can read/write/run, computed from its fragment's node types and edges (prompt
injection and headless running derive from rejoins and triggers, not node types) — never trusted
from creator declarations.
_Avoid_: permission (implies creator-granted; capabilities are runtime-computed)

**Denial**:
A user refusing one of a pack's derived capabilities. Denial closes the entry edges of every
sub-path that reaches a node needing that capability — the same gate mechanism as disabling, with
the same cascade warning. Denying a capability the whole fragment needs is equivalent to disabling
the pack, and the UI says so.
