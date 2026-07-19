# Agent Runtime replaces the workflow system

**Status: Accepted — 2026-07-18.**

The implemented workflow/node system made ordinary agent behavior difficult to learn, author, and
debug. RP Terminal will replace it completely with the provider-neutral Agent Harness, uniquely named
Agent Definitions, full-path Input Bindings and Result Slots, card-owned scheduling, and restrictive
Invocation Plans described in the
[Agent Runtime design](../agent-system/agent-runtime-design.md).

## Decision

- Every model-backed operation, including Classic Narrator and Yuzu Scene Director, executes through
  the same mandatory Agent Harness.
- Invocation Plans support only a top-level sequence and flat parallel groups. They are validated JSON
  values, not graphs or installed runtime objects.
- Cards decide when variable- or time-based work should run. RP Terminal supplies asynchronous
  execution, per-Agent lanes, retries, transactions, floor ownership, and deterministic Forward
  Replay.
- The workflow runtime, node registry, canvas, workflow formats, seeded examples, import/export,
  selection, triggers, and compatibility surface are removed before the cutover branch merges.
- There is no converter, legacy execution mode, compatibility period, or release containing two
  selectable runtimes.
- Existing workflow data remains inert on disk. RP Terminal neither loads nor automatically deletes
  it.

## Considered options

- **Keep the workflow engine as the Harness.** Rejected because graph execution, ports, node schemas,
  and graph persistence preserve the complexity this decision is intended to remove.
- **Embed DeepSeek Reasonix.** Rejected because Reasonix is intentionally DeepSeek-oriented and its
  cross-session compaction and escalation behavior do not fit floor-isolated RP Terminal Agents.
  Selected repair and cache mechanisms are reimplemented behind provider-neutral adapters.
- **Offer a migration period or graph converter.** Rejected because it would require maintaining two
  mental models and either preserve the legacy runtime or produce lossy conversions.
- **Delete the workflow system before the replacement runs.** Rejected because Classic generation
  currently executes through the workflow engine. The branch cuts over atomically: build the
  replacement, switch Classic and Yuzu, then delete workflow code before merge.

## Consequences

- ADR 0011 and the future-facing workflow/module authoring model are superseded.
- Existing workflow features remain truthful current implementation until the atomic cutover ships,
  but receive no new feature work.
- Agent identity, customization, activity, and role binding become profile-wide concepts.
- Background results are floor-owned state, not detached jobs: deletion cancels them, late results
  replay later floors, and Run Records disappear with their floor.
- General control flow stays in card-side scripts. The Agent Runtime deliberately does less in order
  to make its guarantees stronger and its authoring surface smaller.
