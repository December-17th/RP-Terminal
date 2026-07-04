# Agent packs compose into one effective graph per turn

The agent-pack design promises independently enable/disable-able agents (memory keeper, planner,
editor...), but the workflow engine executes exactly one workflow doc per generation
(`resolveWorkflowDoc`, session → world → global → builtin). We decided an agent pack's executable
part is a **workflow fragment with a declared attachment point**, and at generation time the runtime
materializes a single **effective graph** — the base narrator workflow plus every enabled fragment
spliced in at its attachment point — executed as one engine run.

## Considered options

- **Pack = full workflow, one active at a time.** Rejected: toggling one agent would swap the whole
  workflow; contradicts independent enable/disable.
- **Pack = independent workflow, separately scheduled around the reply.** Rejected: needs a new
  multi-run scheduler, fragments the trace (which "explain why" depends on), and turns resource
  locks/joins into cross-run coordination.

## Consequences

- The narrator is the base workflow, resolved through the existing selection tiers — native but
  forkable, not itself a pack (at least until this model is proven).
- The attachment-point contract (what ports a fragment sees) becomes the pack ABI and must be
  designed deliberately — it is the compatibility surface pack creators depend on.
- Composition should reuse the existing subgraph machinery (subgraph docs already execute within a
  parent phase).
- One unified trace per turn is preserved, which the Runs timeline and "explain why" surfaces
  require.
