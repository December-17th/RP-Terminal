# Node Workflow Engine — Phase 2b: Generation Integration — Plan (DRAFT for review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **STATUS: DRAFT.** This documents the *approach, slicing, and the extraction map* for the parity milestone,
> plus the Phase 2b-1a task outline. The bite-sized, full-code TDD tasks for 2b-1a are expanded only after
> the owner approves the extraction boundaries + parity strategy below (that review is the high-value
> checkpoint — the rest is mechanical once the boundaries are set).

**Goal:** Route `generationService.generate()` through the Phase 2a workflow engine running a built-in
**default graph** that reproduces today's generation pipeline byte-for-byte, proven by a **parity
characterization test**.

**Architecture:** Follow CLAUDE.md's mandate — *extract behind an interface, keep tests green at each step*.
First refactor the `generate()` monolith into a sequence of coarse, side-effect-honest stage functions
(behavior-preserving; pinned by a characterization test). Then wrap each stage as a default-graph node that
delegates to it, build the default graph, and re-plumb `generate()` to run the engine — with the parity test
guaranteeing the graph output equals the pre-refactor baseline.

**Tech Stack:** TypeScript, Vitest. No new runtime dependencies. Builds on Phase 2a (`workflowEngine`,
node registry) + Phase 1 (`shared/workflow`), both now in `main`.

## Global Constraints

- **Parity is the contract.** The default graph MUST produce a byte-identical `sendMessages` array and an
  identical persisted `FloorFile` (request, response, variables, events, metrics) as today's `generate()`,
  for the same inputs. Any intended behavior change is out of scope for Phase 2b.
- **Never-block-a-turn invariant.** Memory compaction stays post-response / async / fail-open (today's
  `void maybeCompact(...)` after `appendFloor`, generationService.ts:445). In the graph this is the
  post-response phase (Phase 2a `onResponseReady` boundary).
- **Module boundaries.** Engine + nodes live in `src/main`; may import `src/shared/workflow`; never
  `src/renderer`. `check:deps` clean. No card-facing surface changes (no `docs/sdk/` or i18n impact).
- **Verification gate:** `npm run typecheck && npm run check:deps && npm run test` all pass before done.
- **Prettier:** no semicolons, single quotes, 2-space indent, no trailing commas.
- **Fan-in (settled 2026-07-01):** multiple edges into one input port is a validation error; multi-input
  nodes (`merge.messages`) use DISTINCT input ports.

---

## Slicing (three plans)

Phase 2b is too large for one plan; it splits into three, each independently testable:

- **2b-1a — Extract + characterize (THIS plan's tasks).** Refactor `generate()` into coarse sequential stage
  functions; build the characterization harness + baseline snapshot that pins current output. No engine
  involvement; `generate()` still calls the stages in order. *Deliverable: identical behavior, now behind
  named seams, with a test that will catch any future drift.*
- **2b-1b — Nodify + parity.** Wrap each stage as a default-graph node (delegating to the 2b-1a functions);
  build the built-in default graph; extend `RunContext` with the domain bundle + wire `nodeStateService`;
  re-plumb `generate()` to `resolveWorkflow → runWorkflow`. *Deliverable: graph-driven generation with the
  parity test green.*
- **2b-2 — Agentic nodes.** The nodes the default graph doesn't need: `prompt.messages`, `merge.messages`,
  `text.template`, `control.if`/`switch`/`when`, `mvu.set`. *Deliverable: multi-call / branching / MVU-trigger
  authoring.* (Tools + editor are later phases per the spec.)

---

## The extraction map (2b-1a) — grounded in the current `generate()`

`generate()` (generationService.ts:111–449) becomes a thin sequence over these stage functions. Each maps to
a future default-graph node (2b-1b). A shared `GenContext` bundle threads the state (it becomes the extended
`RunContext` domain fields in 2b-1b).

| Stage fn (new) | Reproduces generate() lines | Feeds | Future node |
|---|---|---|---|
| `buildGenContext(profileId, chatId, userAction)` | 117–167 (chat/card/settings/preset/mode/lorebooks/floors/workingVars/globals/cache/scanText) | everything | `input.context` |
| `matchWorldInfo(ctx)` | 176–199 (fsm-cached or per-turn `matchAcross` + logging) | assemble | folded into `prompt.assemble` |
| `recallMemory(ctx)` | 204–217 (`selectMemories` + `notifyMemoryRecalled`) | assemble | `memory.recall` |
| `assemblePrompt(ctx, matched, memoryBlock)` | 219–331 (`buildPrompt` → `fitToBudget` → system→user → `mergeConsecutiveRoles` → maxTokens/params → `orderForProvider`) | model | `prompt.assemble` |
| `callModel(ctx, sendMessages, params, onDelta)` | 333–362 (controller + `streamProvider` + abort handling) | parse | `llm.sample` (**main output**) |
| `parseResponse(raw)` | 388–392 (`stripThinking`→`parseContent`→`parseMvuCommands`) | fold | `parse.response` |
| `foldState(ctx, parsed, mvu, raw)` | 396–422 (`applyEvent` + MVU apply + combat cue → variables) | persist | `apply.mvu` (+`apply.regex`) |
| `computeMetrics(ctx, sendMessages, raw, usage)` | 367–382 (`buildFloorMetrics`) | persist | folded into `parse.response` |
| `persistFloor(ctx, userAction, raw, sendMessages, events, variables, metrics)` | 424–441 (`saveGlobals` + build `FloorFile` + `appendFloor`) | — | `output.writeFloor` |
| `compactMemory(profileId, chatId)` | 442–447 (`void maybeCompact`, post-response) | — | `memory.gate`/`extract`/`write` |

**Key parity hazards to preserve exactly:**
- `workingVars` is seeded from the last floor (148), **mutated by `setvar()` during `buildPrompt`** (via the
  `template` context, passed by reference), then folded on top post-response (396–397). The extracted
  `assemblePrompt` MUST take `workingVars` by reference so build-time mutations persist onto the floor — this
  is the single trickiest parity point.
- Abort semantics: an aborted call with empty text returns `null` (357–360); aborted-with-text still persists
  (355). Preserve exactly.
- The stored `request` is `sendMessages` (the provider-ordered array), not the pre-order `messages` (435).
- `saveGlobals` happens after fold, before floor build (424).

---

## Characterization harness (2b-1a) — the parity baseline

There is no full-`generate()` test today (only pure helpers). Build one:
- A `test/workflow/generateParity.fixture.ts` that `vi.mock`s every service dependency `generate()` imports
  (`chatService`, `characterService`, `settingsService`, `presetService`, `lorebookService`, `floorService`,
  `retrievalService`, `compactionService`, `memoryEvents`, `templateService`, `apiService`, `regexService`,
  `promptCacheMetrics`, `logService`) with deterministic fixtures: a fixed card, preset, settings, two prior
  floors, a canned `streamProvider` raw response containing `<thinking>`, an `<UpdateVariable>` block, and an
  `<rpt-event>`. `appendFloor` + `saveFloor` capture the written floor; `streamProvider` captures the
  `sendMessages` it received.
- A test that calls `generate()` and asserts a **snapshot** of `{ sendMessages, writtenFloor }`. This snapshot
  IS the parity baseline. It must stay identical through the 2b-1a extraction and the 2b-1b nodify.
- Deterministic seams: `matchAcross` is called with `Math.random` (182/190) — the fixture injects lorebooks
  with **constant** (non-probabilistic) entries so matching is deterministic; timestamps (`new Date()`) are
  faked via `vi.useFakeTimers()`.

---

## Phase 2b-1a — task outline (to expand to full TDD tasks on approval)

1. **Characterization harness + baseline snapshot.** Build the mock fixture + the snapshot test against the
   *current* `generate()`. (This is the biggest task — it's the safety net everything else leans on.)
2. **Extract `buildGenContext`** (lines 117–167) → returns `GenContext`; `generate()` calls it. Snapshot
   unchanged.
3. **Extract `matchWorldInfo` + `recallMemory`** (176–217). Snapshot unchanged.
4. **Extract `assemblePrompt`** (219–331), taking `workingVars` by reference. Snapshot unchanged. *(The
   parity-critical one.)*
5. **Extract `callModel`** (333–362), preserving abort semantics. Snapshot unchanged.
6. **Extract `parseResponse` + `computeMetrics` + `foldState`** (364–422). Snapshot unchanged.
7. **Extract `persistFloor` + `compactMemory`** (424–447). Snapshot unchanged. `generate()` is now a thin
   sequence over the stage functions.

Each task: keep the characterization snapshot byte-identical (that IS the test), plus the full gate. No new
behavior. Frequent commits.

---

## Phase 2b-1b — outline (separate plan)

- Extend `RunContext` (Phase 2a) with the domain bundle (the `GenContext` fields) + real `streamMain`/
  `emitPanel`/`getNodeState`/`setNodeState` wired to the renderer stream, the reasoning-panel family, and a
  new `nodeStateService` (`node_state` table keyed by `(chat_id, node_id)`, spec §11).
- Implement the default-graph node catalog (`src/main/services/nodes/builtin/*`), each delegating to a 2b-1a
  stage function; register them.
- Build the built-in default graph doc (in code) matching the §6 diagram.
- Re-plumb `generate()`: resolve the active workflow (session → world → global → built-in default), build the
  `RunContext`, `runWorkflow(...)`, map the result to a `FloorFile`. The main-output node's stream drives
  `onDelta`; post-response memory nodes run async.
- **Parity test:** the graph-driven `generate()` produces the *same* baseline snapshot as 2b-1a.

## Phase 2b-2 — outline (separate plan)

- `prompt.messages` (role-tagged message list), `merge.messages` (distinct input ports, per the fan-in rule),
  `text.template`, `control.if`/`switch`/`when` (predicates over Vars via `objectPath`), `mvu.set`.
- Persistence of authored workflows (`workflows` table/service/IPC) may land here or in its own phase per the
  spec (§12).

---

## Open questions for the owner (before expanding 2b-1a tasks)

1. **Extraction location:** keep the stage functions inside `generationService.ts` (smaller diff, one file),
   or split them into a new `src/main/services/generation/` folder (cleaner, but a bigger move)? Draft assumes
   **in-file** for 2b-1a to minimize parity risk, splitting in 2b-1b when they become node bodies.
2. **Characterization fidelity:** is a snapshot of `{ sendMessages, writtenFloor }` sufficient as the parity
   contract, or do you want it to also assert the exact `onDelta` stream chunks and log lines?
