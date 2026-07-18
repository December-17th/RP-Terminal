# Fragments attach at narrator checkpoints; disabling gates the entry edge

**Status: Superseded by ADR 0019 (2026-07-18).**

ADR 0001 left the attachment contract (the pack ABI) open. We decided the narrator's main path is
punctuated by **named checkpoints**. A fragment enters at a checkpoint as its own sub-path — by
default a **branch** (the main flow does not depend on it; it rejoins by contributing a value at a
later checkpoint or ends in side effects), optionally **inline** (the main message flow is wired
through it). Disabling an agent closes a **gate** on its entry edge: everything reachable only
through that edge is skipped, including fragments chained after it. Gating an inline fragment also
cuts the main reply path — permitted, but the user is warned, and the warning is computed from
graph reachability, never creator-declared.

The wiring is real, visible edges in Workflow Studio (creators wire; users only toggle gates), but
because entries and rejoins land on well-known checkpoints rather than raw node ids, packs stay
portable across narrators that expose the same checkpoints.

## Considered options

- **Typed sockets that auto-splice into prompt assembly (contract-only, invisible wiring).**
  Rejected: hides composition from Studio; the effective graph would contain edges no one drew.
- **Free wiring against raw node ids, no standard anchors.** Rejected: packs become bound to one
  specific narrator doc, and enable/disable cannot be mechanical.

## Consequences

- Checkpoint names + value shapes are the compatibility surface; changing them breaks packs, so
  the vocabulary must be versioned and grown deliberately.
- A custom narrator workflow is composable exactly to the extent it exposes checkpoints; a
  narrator missing one cannot host fragments that need it (visible warning, not silent breakage).
- Failure semantics follow attachment mode, per edge: branch fragments fail open even before the
  reply; inline fragments are load-bearing and block the reply on failure. This refines the
  current engine rule (verified `src/main/services/workflowEngine.ts:171-203`: any pre-phase
  failure is fatal, post-phase fails open) — the engine must learn to fail open on branch
  sub-paths in the pre-reply region.
- The disable/cascade UI ("turning off X also turns off Y — and the main reply") is derived from
  gate reachability, consistent with the derived-capabilities trust stance.
