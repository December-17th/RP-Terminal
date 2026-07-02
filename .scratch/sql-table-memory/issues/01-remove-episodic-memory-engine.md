# 01 — Remove the episodic-memory engine

Status: ready-for-agent

## Parent

[PRD.md](../PRD.md) — SQL-table memory, blended into the workflow engine.

## What to build

Retire the flagged-off episodic-memory engine entirely so the table-memory system replaces it rather than coexisting with it. Remove the memory entries store, the compaction and retrieval services, the per-turn recall stage, the whole `memory.*` node family (recall, compact, gate, extract, write, query), the `memory` settings block and its defaults, the memory IPC surface and its view, and the default graph's gated compaction chain (the default graph ends at the write-floor node plus its remaining post steps). The engine never ran live (`memory.enabled` has always defaulted off), so there is no data migration; drop the store's table from the schema.

Behavior after this slice: the app builds, runs, and generates normally; the workflow editor's node catalog no longer offers memory nodes; saved workflow docs referencing removed node types fail validation with the existing unknown-node-type handling (verify, don't assume, what that handling is — and make sure the shipped default/example graphs are updated so nothing built-in references them).

This is the prefactor slice: it must land before the table-memory slices so the settings/model surface is free for the new system.

## Acceptance criteria

- [ ] No `memory.*` node types remain in the built-in registry or node catalog.
- [ ] Memory store/compaction/retrieval services, memory IPC, and the memory view are deleted; no dead imports or dangling i18n keys remain.
- [ ] The `memory` settings block and collection types are removed from the settings model and defaults.
- [ ] The default graph no longer wires recall or the compaction chain and still passes its parity/characterization tests (updated deliberately in the same commit).
- [ ] Characterization tests covering removed behavior are removed/updated in the same commit — never deleted merely to go green on unrelated changes.
- [ ] Docs updated: episodic-memory design doc superseded with a pointer note (point-in-time policy); any SDK/README references to memory nodes removed.
- [ ] `npm run typecheck && npm run check:deps && npm run test` all pass.

## Blocked by

None - can start immediately.
