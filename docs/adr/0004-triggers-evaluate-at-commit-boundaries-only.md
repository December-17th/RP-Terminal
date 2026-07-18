# Triggers evaluate at commit boundaries only

**Status: Superseded by ADR 0019 (2026-07-18).**

ADR 0003 left the trigger vocabulary and evaluation point open. We decided v1 triggers are a
**state condition** (a predicate over floor variables / table state), a **cadence** (every N
floors — sugar over a state condition), or a **manual action**. The runtime evaluates every
installed pack's trigger at exactly two moments: after a turn commits, and after a headless run
commits. Headless commits being evaluation points allows deliberate chains (world-sim writes "a
month passed" → another agent's condition matches); a per-chain depth cap prevents two packs from
ping-ponging forever.

## Considered options

- **Wall-clock schedules ("every 10 minutes while the app is open").** Rejected for v1: this is a
  local app that is frequently closed, "while away" semantics are muddy, and every motivating
  example (world-sim on in-game time, compaction backlog) is state-driven — in-game time only
  advances because something committed a write.
- **Reactive state watching (fire the moment any write touches watched state).** Rejected: buys
  latency nobody perceives and costs reentrancy — triggers observing other runs' uncommitted or
  mid-flight writes.

## Consequences

- Triggers only ever see committed state; a fragment can never be started by a value that later
  rolls back.
- Trigger chains are a supported pattern but bounded by a depth cap; the cap is a runtime rule, not
  per-pack configuration.
- Adding wall-clock scheduling later is an additive ABI change (a new trigger kind), not a
  breaking one.
