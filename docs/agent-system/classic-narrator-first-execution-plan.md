# Classic Narrator first execution plan

**Status:** Active point-in-time execution plan, approved for execution on `agent-system` on
2026-07-19. This plan reorders Session 8 ahead of Agent Runtime debloating. It does not approve the
plot/memory node conversion described below.

## Outcome and ordering

Classic Narrator is the first production consumer of the Agent Harness. The first implementation slice
must route the existing assembled Classic request through the Harness without changing the
provider-visible message sequence. That evidence determines which runtime behavior is load-bearing
before anything is deleted or generalized further.

The order is:

1. preserve and characterize the current Classic request;
2. pass that exact request through a one-call, tool-less Harness path;
3. prove Classic parity at the existing player-generation boundary;
4. only then decide which workflow and Agent Runtime facilities survive;
5. separately design, but do not implement, parser-backed built-in Agents for plot and memory nodes.

No card Agent, Agent-callable tool, `runPlan`, schema compatibility layer, or Workspace surface is added
by this plan. There is no approved consumer for those facilities yet.

## Current path and first seam

```text
generationService.generate
  -> resolveEffectiveDoc -> buildTurnContext -> runWorkflow
  -> generation/assemble
  -> resolveDispatchMessages / providerShape
  -> applyDispatchTransforms
  -> runLlmCall -> callModelResilient
  -> apiService.streamProvider / ProviderDispatch
  -> generation/parseResponse -> generation/persistFloor
  -> response-ready return -> detached workflow memory/table work
```

The first seam is deliberately inside that path:

```text
final post-transform messages + resolved parameters
  -> PlayerGeneration Harness adapter
  -> AgentHarness one-call text execution
  -> existing ProviderDispatch
  -> existing generation/parseResponse and persistFloor
```

The Adapter owns only translation of the final dispatch request to the narrow Harness Interface.
Provider shaping, high-trust late dispatch transforms, preset substitution, and resilient-call policy
must still happen exactly once. The Adapter does not own prompt construction, history policy, floor
incorporation, scheduling, or memory. The first slice does not use `InvocationRuntime.run()`: that
interface assumes a background invocation owned by an existing floor, while Classic creates the next
floor.

## Execution protocol

Each milestone uses one fresh-context `gpt-5.6-sol` agent at medium reasoning effort, with no child
agents. After its exit checks complete, a different fresh-context Sol/medium agent performs a read-only
review. Findings are fixed within the milestone and rechecked before the next milestone starts.

Implementation agents investigate the affected path in maximum depth, then make the smallest patch.
Reviewers reject provider-visible message changes, parallel frameworks, new unconsumed public surfaces,
mock-only production claims, and deletion before Classic evidence.

Behavior milestones run focused tests plus:

```text
npm.cmd run typecheck
npm.cmd run check:deps
npm.cmd run test
```

Documentation milestones also run `npm.cmd run check:docs`.

## Milestones

### Milestone 0 — freeze this plan

Scope is this document, the catalogue, and living status sequence. Exit requires explicit ordering,
exact-message seam, independent review protocol, design-only plot/memory conversion, owner deferrals,
and no new broken documentation link beyond the recorded 61-link repository baseline.

Review gate: no implied approval for runtime deletion or plot/memory Agent implementation.

### Milestone 1 — exact-message Classic Harness slice

Goal: make a normal Classic model request execute through `AgentHarness` while the surrounding workflow
remains intact.

Investigate before editing:

- capture the exact post-`applyDispatchTransforms` messages and resolved parameters passed to
  `runLlmCall`;
- trace Provider Dispatch shaping, preset selection, streaming, RPM/concurrency, abort, usage, and retry
  ownership;
- trace every Harness path that could prepend, append, normalize, or rebuild messages;
- locate the existing workflow trace used for byte-accurate prompt/response debugging.

Minimal patch:

- add one internal prepared-request Harness Interface, or equally small Adapter, accepting the final
  transformed message array and resolved parameters without adding Harness policy, input, history, or
  tool messages;
- preserve provider shaping, late dispatch transforms, preset substitution, and resilient-call behavior
  exactly once while using the existing Provider Dispatch;
- execute one text step with no tools or Harness scheduling;
- keep existing parse, persistence, streaming, abort, usage, regenerate/swipe, and detached workflow
  behavior;
- retain exact post-transform provider-bound request and response bytes; derived/redacted views may
  coexist but cannot replace the exact debugging evidence;
- do not use background Invocation Runtime or Result Incorporation.

Tests prove identical ordered final provider messages with and without a registered dispatch transform,
streaming and final-text parity, cancellation, distinct provider-error/abort behavior, no
tool/plan/floor/card call, and existing Classic parity.

Exit: production Classic sampling reaches `AgentHarness`; workflow still owns assembly, parse,
persistence, and secondary nodes; exact evidence is inspectable; no duplicate retry/concurrency layer.

Review gate: inspect real production composition. A mock-only Harness call does not pass.

### Milestone 2 — characterize the remaining workflow dependency

Use the live Classic Harness path to inventory everything `runWorkflow` still contributes: assembly,
parse/persist, response-ready timing, traces, plot recall, memory recall/maintenance, table fill/refill,
and every other reachable node.

For each, record trigger, input, output, side effect, failure policy, user requirement, and existing
non-workflow service/parser. Node availability, mocks, and historical design text do not prove a Classic
requirement.

Exit: evidence distinguishes synchronous load-bearing work, detached work, and unreachable nodes.
Changes are limited to characterization tests/status; nothing is removed.

### Milestone 3 — direct Classic player-generation orchestration

After Milestones 1-2 prove the minimum sequence, remove `runWorkflow` from synchronous Classic
generation:

```text
generationService
  -> existing context and prompt assembly
  -> PlayerGeneration Harness adapter
  -> existing parse and persist-floor transaction
  -> existing renderer result/stream surface
```

Reuse existing services; do not add a pipeline, graph, hook bus, or scheduler. Preserve normal generate,
regenerate, swipe, preemption, cancellation, streaming, response timing, provider parameters/limits,
current Yuzu-overlay assembly, MVU/template writes, persistence, metrics, errors, and byte-accurate
evidence.

Exit: no synchronous Classic call reaches `runWorkflow`, and parity compares provider bytes and
persisted floor state, not only returned text.

### Milestone 4 — active-work exit warning

Derive one `hasActiveBackgroundWork` signal from the authoritative live-run registry. Intercept reachable
app-close/session-exit actions and confirm that active work may be discarded. With no active work,
behavior is unchanged. Do not add recovery, resumption, negotiation, or a lifecycle framework.

Tests cover active/inactive close, cancelling close, confirming exit, and cleanup.

### Milestone 5 — parser-backed built-in Agent design only

Produce a separately approvable design for current model-backed plot recall/planning, memory recall,
memory maintenance, and SQL memory table filling/refill nodes. Do not implement or register them.

The proposed built-in kind is tool-less and parser-backed:

```text
typed input
  -> existing operation prompt builder
  -> one prepared Harness text request
  -> existing operation parser
  -> typed parsed result
  -> existing deterministic apply service
```

It does not call tools, schedule itself, write floors directly, or own retries beyond a demonstrated
parser-correction need. The design names the real trigger, parser, and apply service for every candidate.
A candidate missing those paths is deferred.

Deliver: consumer/trigger matrix, exact inputs and parsed outputs, reachable parser failures, side-effect
boundary, response-ready ordering/cancellation, node migration/deletion map, and nodes that should
collapse into existing services or be removed.

Exit: docs only; no runtime, Agent definition, schema, table, or transport changes. Reject generic tool,
node-adapter, graph, or parser frameworks.

### Milestone 6 — evidence-driven debloat decision

Re-run the audit with Classic as a real consumer, classifying Provider Dispatch, Harness,
InvocationRuntime, FloorState, tools/transports, Run Records, catalogue schema, retries, lifecycle hooks,
configuration, IPC, and tests as Keep, Collapse, Reduce, Defer, or Remove.

Default dispositions remain:

- `runPlan`: Defer;
- card Agents and Agent-callable tools/transports: placeholder-only or Defer;
- unused schemas and Workspace edit/version lifecycle: Defer;
- exact request/response logs: Keep;
- active-work close/session warning: Keep at the minimum Interface;
- unreachable hypothetical errors: Remove with their tests.

Exit: owner receives deletions, estimates, real risks, and verification. No debloating implementation
begins without approval.

## Smallest target architecture

```text
Classic -> existing assembly -> provider shaping + late dispatch transforms
        -> prepared one-call AgentHarness -> existing ProviderDispatch
        -> existing parse/persist

Future parser-backed operation -> existing prompt builder -> same Harness Interface
                               -> existing parser -> existing deterministic service
```

The Harness does not become the owner of prompt policy, floor replay, transports, tools, scheduling, or
workflow composition.

## Owner gates

Owner approval is required before:

- implementing the plot/memory built-in Agent design;
- deleting or changing existing post-response memory behavior;
- debloating Agent Runtime facilities after the evidence report;
- adding card Agents, Agent-callable tools, `runPlan`, Workspace editing, or schema compatibility;
- changing exact-log retention or redaction policy.

No additional approval is required to execute the bounded milestones above in order, provided each
independent review passes and its patch stays within the stated boundary.
