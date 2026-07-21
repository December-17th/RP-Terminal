# The effective graph is an editable projection, not an artifact

**Status: Superseded by ADR 0020 (2026-07-18).**

Users enabling packs expected to see them in the Workflow view; ADR 0001 keeps the effective
graph un-stored, so the graph editor showed an unchanged narrator and pack activity was invisible
until a run's trace. The owner asked for an **editable effective graph inside the Workflow view**
(2026-07-03).

We decided the Workflow view gains an **Effective mode**: it renders the live composition for the
active chat (narrator + every gate-open pack, via the same `resolveEffectiveDoc` the engine uses)
and routes every edit back to the artifact that owns it:

- **Narrator nodes** → the narrator workflow doc, with the editor's existing semantics.
- **Pack nodes and pack wiring** (internal edges, attachment splices) → a **copy-on-edit fork** of
  that pack (ADR 0006): new library entry with lineage, the world repoints, other worlds untouched.
- **Removing a pack's whole region** → not a doc edit at all; it maps to closing the pack's gate.

ADR 0001's core holds: no composed doc is ever persisted — the projection is recomposed from its
sources after every write-through. Pack regions render visually grouped and attributed (the
`pack:<packId>:` id prefixes are the mapping), so the projection is also the missing visibility
surface.

## Considered options

- **Read-only preview.** Rejected by the owner: seeing without touching breaks the "advanced users
  can edit everything" non-negotiable at the exact surface where they'd want to.
- **Flatten-to-workflow button** (bake the composition into a real doc). Rejected: honest but
  destroys the model — the flattened doc loses gates, overrides, upgrades, and attribution; every
  pack becomes permanently forked into an unmaintainable monolith.

## Consequences

- The pack service needs the fork operation (copy fragment + manifest, record upstream lineage,
  repoint the editing world's activation) earlier than phase 4 planned; the export wizard reuses
  it.
- The editor needs an id-mapping layer (prefix ↔ owner) and must recompose after every
  write-through; edit latency budgets apply.
- Deleting/adding the splice edges themselves is a pack-fork operation (attachments are pack
  manifest data), which the editor must communicate ("this forks Async Table Memory").
- Trigger-only machinery (headless chains with no checkpoint attachments) appears in Effective
  mode only as pack metadata, not spliced nodes — the projection must still represent those packs
  (e.g. a detached grouped region) or users will again ask "where is my pack".
