# Agent Workflow UX Design, Revision 4 — One Canvas

Date: 2026-07-03
Status: owner-directed pivot after hands-on use of the phases 1–5 build
Supersedes: `2026-07-03-agent-pack-workflow-ux-design-revision-3.md` (its runtime/engine layer
survives; its user-facing pack model and control-center UI are retired)
Decision record: ADR 0011 (which also scopes what remains of ADRs 0001–0010)

## The owner's requirements (verbatim intent)

1. The trigger → action → result route must not be scattered across UIs. **One UI to view every
   node at once**: the agent workflows (expanded or collapsed) render alongside the main workflow
   on the same canvas.
2. The workflow model exists so a user can **see and adjust settings on one UI knowing fully how
   the data flows**.
3. Example — the memory table filling agent is five consolidated nodes: **trigger** (starts the
   memory system) → **chat-history input** (AI responses + player actions, last N floors) →
   **generic agent** (sends the request; configurable role-alternating prompt; API preset
   selection) → **parser** (response → SQL) → **SQL ops**. The async variant is the same chain
   with different trigger settings.
4. **Grouping**: several linked nodes can be selected to form a bigger node (a module); the
   author chooses which settings from which inner nodes are exposed on the module's settings
   panel.
5. **Editor layout**: left side = node palette (drag onto canvas). Right side = settings panel
   for the selected node(s).
6. **Import**: a node, or nodes packed together, imports as an **agent module** that carries
   settings (e.g. the memory-fill prompt preset and the SQL table schema).
7. **Disabling**: disable the trigger. The disabled agent stays on the canvas, visibly disabled.

## The model

- One workflow doc (selected per world/session exactly as today) holds everything: the narrator
  chain and every agent chain. The doc the user edits IS the doc that runs — no composition, no
  projection, no library/activation indirection.
- **Turn execution**: chains wired into the narrator (ancestors of the main output) run inside
  the turn, as today. **Trigger-rooted chains are excluded from turn runs** and execute headlessly
  when their trigger fires (commit-boundary evaluation, depth cap, state-mediated coordination —
  all per ADRs 0003/0004, unchanged underneath).
- **Trigger node** = the agent's identity marker, timing config, and off-switch in one. Disabled
  nodes (any node) render dimmed; their downstream reads unwired (existing dead-edge semantics).
- **Module** = a grouped sub-chain: collapsible on the canvas (collapsed = one big node showing
  name + exposed settings + status; expanded = its real nodes in a frame). Exposed settings are
  chosen per inner node at group time and editable later. Grouping is reversible (ungroup).
- **Module files**: export a module → a file carrying the sub-graph, its exposed-settings map,
  and optional bundled table schema/templates. Import drops it into the current doc as a module
  node. Reuses the envelope machinery (structured errors, local capability re-derivation and
  unknown-node blockers at import). Recipes (whole-world setups) reduce to sharing the workflow
  doc itself plus bundles — revisit after modules land.

## The consolidated node set

New canonical nodes (legacy fine-grained nodes stay registered so old docs run):

| Node | Role | Key config |
|---|---|---|
| `trigger` | roots an agent chain; enable/disable | kind: state condition / cadence / manual; params |
| `history input` | extracts chat history | last N floors; roles filter (AI reply + player action) |
| `agent` | one LLM call | role-alternating prompt template (customizable); API preset |
| `parser` | extracts structure from the reply | target format (SQL v0) |
| `SQL ops` | applies table operations | batch/apply mode |

The shipped memory workflows are re-expressed as these five nodes (every-turn = cadence trigger;
async = state-condition trigger on backlog), replacing the builtin packs.

## The editor (THE surface)

- **Left rail**: node palette (drag to canvas) + agent modules section (built-ins + imported) +
  import/export entries + memory template binding.
- **Canvas**: everything at once. Narrator chain + agent chains; collapsed/expanded modules;
  disabled chains dimmed with the trigger showing off-state; live trigger state on trigger nodes
  ("backlog 3 of 6"); last-run status overlaid per node (ran/failed/skipped + duration).
- **Right rail**: settings for the selection — a node's config; a module's exposed settings; the
  "expose in module settings" picker when editing inside a module; trigger params on trigger
  nodes.
- **Bottom drawer**: run history (turns + agent runs interleaved); selecting an entry replays its
  node statuses onto the canvas. The injection/prompt preview attaches to the narrator's prompt
  node (click it → what the next prompt contains).
- The Agents control center, its six rails, Effective mode, and the pack card system are retired.
  The transfer wizard/inspector sheets survive, reframed for modules.

## What is deliberately lost (owner-accepted trade-offs)

- Override sidecars that survive upstream upgrades (module settings live in the user's doc;
  updating a module = re-import/replace).
- Per-chat setting scopes and version-pinned activation (per-world behavior = workflow selection).
- Creator-locked anything (unchanged non-negotiable: the user owns and can edit everything —
  now trivially true because everything is in their doc).

## Kept invariants

- Headless runs never block a turn; committed-state triggers; depth cap (ADR 0003/0004).
- Two-phase inspected import with locally derived capabilities and unknown-node blockers.
- i18n en+zh; token-driven theming; AA contrast; the journey-walk acceptance rule.
