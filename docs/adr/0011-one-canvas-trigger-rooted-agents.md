# One canvas: agents are trigger-rooted chains in the workflow doc

After using the built phase-1–5 system, the owner rejected its user-facing model (2026-07-03):
the trigger → action → result chain was scattered across a control center (settings, runs,
preview rails) and a projection mode, and the pack/checkpoint vocabulary over-complicated the UI.
The original motivation for the workflow model was "one UI where the user sees and adjusts
everything, fully understanding the data flow."

We decided to collapse the two-world split (packs vs workflows) entirely:

- **One workflow doc per world/chat** (existing selection tiers) contains the narrator chain AND
  every agent chain, all visible on one canvas at once — expanded or collapsed, never hidden.
- **An agent is a trigger-rooted chain.** Trigger nodes (state condition / cadence / manual) are
  graph roots; chains rooted at a trigger are excluded from turn execution and run headlessly
  when the trigger fires. Turn-coupled work (e.g. prompt injection) is ordinary wiring into the
  narrator chain and runs inside the turn as a plain ancestor.
- **Disabling = disabling the trigger** (or any node — dead-edge semantics). The disabled chain
  stays on the canvas, visibly off. No gates, no activation rows, no effective-graph composition.
- **A module = grouped nodes.** Selecting linked nodes groups them into a bigger node
  (collapse/expand on the same canvas); the author picks which inner settings are exposed on the
  module's settings panel. Modules import/export as files ("agent modules": subgraph + exposed
  settings + optional bundled table schema), reusing the existing envelope machinery.
- **The workflow editor is THE surface**: node palette left, settings panel right for the
  selection, run statuses overlaid on nodes, run history as a drawer that replays onto the
  canvas, module import and memory template binding in the rail.
- **Consolidated node set** for agent authoring: trigger, chat-history input (AI replies +
  player actions, last N floors), generic agent (role-alternating prompt template + API preset),
  parser (→ SQL), SQL ops. Fine-grained legacy nodes stay registered for compatibility.

## What this supersedes

ADRs 0001/0002/0005/0009/0010 remain accurate history of the phase-1–5 system, but their
USER-FACING concepts (packs, fragments, checkpoints, attachments, gates, activation scopes,
effective-graph projection, fork-vs-override) are retired from the product model. The engineering
underneath survives repurposed: the headless trigger evaluator (drives trigger nodes), subgraph
machinery (grouping), settings materialization (module settings), transfer envelopes (module
files), run history, write locks.

## Considered options

- **Keep packs, consolidate UI onto a Flow view** (controller's first proposal). Rejected by the
  owner: still two worlds (library vs graph) and the full pack vocabulary.
- **Keep the effective-graph projection as the one canvas.** Rejected: a projection of invisible
  artifacts is exactly the indirection the owner objected to — the doc the user edits must BE the
  doc that runs.

## Consequences

- Per-world/per-chat behavior comes free from workflow selection; the 3-scope override system and
  version-pinned activation die with the pack store (module updates = re-import/replace).
- Sharing loses the override-survives-upgrade property (accepted: simplicity wins; module
  settings live in the doc the user owns).
- The engine needs: trigger-rooted-subgraph exclusion from turn runs, a node-disabled flag, and
  the headless evaluator reading trigger nodes from the active doc.
- Every workflow UI surface built in phases 3–5 is re-hosted or deleted; the transfer
  wizard/inspector sheets survive with module framing.
