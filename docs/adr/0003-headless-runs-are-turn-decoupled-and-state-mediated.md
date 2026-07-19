# Headless runs are turn-decoupled and state-mediated

**Status: Superseded by ADR 0020 (2026-07-18).**

ADR 0001 composes reply-coupled fragments into one effective graph per turn and rejected
independently scheduled workflows. Some agents don't fit that shape because no player action causes
them: a world-simulation agent that fires when in-game time advances a month, or async memory
compaction that summarizes old exchanges into a memory table while play continues. We decided a
fragment may instead declare a **trigger** (state condition, cadence, or manual action); when it
fires, the runtime executes the fragment as its own **headless run**, parallel to turns.

Headless runs communicate with turns exclusively through durable state. A turn's context build
reads whatever state is *committed* at that moment and never waits: e.g. compaction advances a
progress pointer only when its table write commits, and prompt trimming trims history only up to
that pointer — if the run hasn't landed, the next prompt simply carries the untrimmed history.

This does not reverse ADR 0001. The one-effective-graph rule still governs everything reply-coupled
(anything with a rejoin checkpoint); headless runs are exactly the fragments with no rejoin into
the current turn.

## Considered options

- **Model these as post-phase branches of the turn.** Rejected: the work isn't caused by the turn
  (a trigger may fire with no turn in flight, e.g. manual), and multi-step jobs like compaction can
  outlive the turn that incidentally tripped them.
- **Block the next turn until a pending headless run completes.** Rejected: adds unbounded latency
  to the reply for work that is by definition deferrable; the committed-state fail-soft read gives
  correctness without waiting.

## Consequences

- Multiple engine runs can now be live concurrently, so resource write locks (memory tables, floor
  variables) move from wishlist to required, and turns must read a consistent committed snapshot.
- The Runs timeline must show headless runs alongside turns, attributed to their pack and trigger.
- "Runs headless" and its trigger become part of the derived-capability surface shown at import.
- The trigger vocabulary and its evaluation point become ABI, like checkpoint names, and must be
  chosen deliberately.
