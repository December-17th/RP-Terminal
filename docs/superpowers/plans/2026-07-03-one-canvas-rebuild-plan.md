# One-Canvas Rebuild Plan (post-ADR 0011)

Date: 2026-07-03
Status: planned; supersedes the remaining phases of `2026-07-03-agent-packs-master-plan.md`
(phases 1–5 of that plan are BUILT and their engine/services layer is the substrate here; its
Amendments log remains the execution record of that era)
Spec: `docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-4.md`
Executor profile: Opus 4.8 agents at medium effort; every WP name states model+effort; every UI
WP walks the primary user journey end-to-end (standing rule).

The same discipline as the master plan applies (read-first lists, one layer per WP, the full
gate, characterization rules, i18n en+zh, deliberate-assertion lists for expected fallout).
Deletion is a feature: each WP lists what it RETIRES.

## WP6.1 — Trigger nodes + node-disable in the engine [shared+main]

New `trigger.state` / `trigger.cadence` / `trigger.manual` node types (config mirrors the WP2.1
trigger grammar — reuse its validation). Engine: chains reachable ONLY from trigger nodes are
excluded from turn runs; a `disabled` node flag (any node) marks the node + exclusive downstream
skipped with dead-edge semantics; a disabled trigger never fires. headlessRunService pivots from
pack attachments to scanning the ACTIVE workflow doc for trigger nodes (evaluation semantics —
commit boundaries, baselines, cadence floors, OR-dedupe per chain, depth cap — unchanged; the
trigger-state table re-keys from pack ids to (doc id, trigger node id): migration). Retires: the
pack-attachment trigger path. Characterization: turn behavior of docs without triggers unchanged.

## WP6.2 — Consolidated agent nodes + rebuilt memory workflows [main]

New nodes: `history input` (last N floors, role filter AI-reply+player-action), `agent`
(role-alternating prompt template + api preset — one LLM call), `parser` (reply → SQL v0),
reusing `table.apply` for SQL ops. The two memory experiences re-shipped as five-node chains in
example/default docs (cadence trigger = every-turn variant; state trigger on backlog = async
variant, with the trim + export wires into the narrator as visible canvas wiring). Retires: the
builtin packs (seed list) once the chains ship. Legacy node types stay registered.

## WP6.3 — Grouping: modules on the canvas [shared+renderer]

Select linked nodes → group into a module: doc-level group records (member node ids, name,
exposed-settings map: (nodeId, path, label)); collapsed rendering = one big node (name, exposed
settings summary, aggregate status); expand/ungroup. Settings panel: module shows exposed
settings; editing inside a module offers "expose in module settings". Ground whether groups are
doc metadata over in-place nodes (preferred — nothing moves) vs subgraph extraction; the
subgraph.call machinery remains for explicit reuse but grouping should not force doc splits.

## WP6.4 — The one canvas as THE surface [renderer]

Editor becomes the primary surface: palette left (nodes + agent modules section + import/export +
memory template binding), settings right (selection-driven), run-status overlay on nodes, live
trigger state on trigger nodes, disabled dimming, bottom run-history drawer replaying statuses
onto the canvas, prompt preview attached to the narrator's prompt node. Retires: the Agents
control center (six rails), Effective mode, launcher cards (workspace 'workflow'/'agents' ids
point at the editor). The wizard/inspector sheets survive with module framing.

## WP6.5 — Module files: import/export [main+renderer]

Module export (sub-graph + exposed settings + bundled schema/templates) and inspected import
(dedupe is per-doc now — importing twice = two module instances; capabilities re-derived locally;
unknown-node blockers). Reuses packPayload/envelope machinery with a module envelope kind.
Retires: the pack store/library/activation UI + IPC (data migration: installed non-builtin packs
offered as module files on first run, or exported to a folder — decide with the code; nothing
silently deleted). Recipes: the .rptrecipe surfaces are parked (formats/services kept, entries
removed) pending a doc-sharing rethink.

## WP6.6 — Deletion + consistency pass [renderer+main]

Remove retired code paths (control center, pack cards/detail, effective projection stores,
fork routing, scope switchers), prune i18n, update docs/agents-era SDK references, final polish
+ journey walks: (1) build the memory agent from palette nodes, group it, expose two settings,
toggle its trigger; (2) import a module file and see it run; (3) read a whole setup at a glance
on one canvas.

## Sequencing notes

6.1 → 6.2 → 6.3 → 6.4 → 6.5 → 6.6 strictly (each consumes the previous). The engine substrate of
phases 1–2 (headless evaluator, locks, run history, envelopes, materialization) is load-bearing
throughout — repurposed, not rewritten.
