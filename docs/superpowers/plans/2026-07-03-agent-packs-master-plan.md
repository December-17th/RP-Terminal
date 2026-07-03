# Agent Packs — Master Implementation Plan

Date: 2026-07-03
Status: planned, not started (owner: plan first, no implementation yet as of 2026-07-03)
Spec: `docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-3.md`
Decisions: ADRs 0001–0009 in `docs/adr/`; glossary in root `CONTEXT.md`
Executor profile: **Opus 4.8 agents at medium effort** — see "How this plan is cut" below.

## How this plan is cut (read this before dispatching any WP)

Work packages (WPs) are sized for a capable agent that will NOT deeply re-derive the design:

- **One WP = one module = one PR.** No WP touches more than one architectural layer
  (`shared/workflow` vs `main` services vs `renderer`). Boundaries are enforced by
  `npm run check:deps`; a WP that wants to cross a boundary is mis-scoped — stop and re-plan.
- **Every WP starts with a "Read first" list.** The agent must read those files/sections before
  writing code (CLAUDE.md grounding rule). The spec + the named ADRs are the requirements; this
  plan only sequences them.
- **Every WP ends with the same gate:** `npm run typecheck && npm run check:deps && npm run test`,
  plus the WP's own acceptance checks. Characterization tests that must change are listed in the
  WP; changing any OTHER characterization test is a red flag — stop and report.
- **Every user-facing string** goes through `t('key')` with entries in BOTH
  `src/renderer/src/i18n/locales/en.ts` and `zh.ts`. Suggested zh terms below in the UX brief.
- **Do-not list for all WPs:** don't refactor neighboring code "while here"; don't touch
  `shared/thRuntime`, `cardBridge`, `wcvPreload` (card runtime is out of scope for this feature);
  don't add dependencies without flagging; don't delete a failing characterization test.

Dispatch order within a phase is the listed order unless marked parallel-safe. Each phase ends
with the built-in packs demonstrably running through the new machinery — same visible behavior as
today, proven by the existing characterization suites staying green (except where a WP explicitly
updates them).

## Verified grounding (file map for all WPs)

- Pure graph model: `src/shared/workflow/types.ts` (WorkflowDoc has `kind?: 'turn' | 'subgraph'`),
  `docSchema.ts`, `graph.ts`, `validate.ts`, `trace.ts` (WorkflowRunTrace; broadcast-only today).
- Engine: `src/main/services/workflowEngine.ts` (phase `'pre' | 'post'`; pre = main-output node +
  ancestors, any pre-phase failure fatal, post fails open; subgraph runs inside parent phase).
- Selection/persistence: `src/main/services/workflowService.ts` (`resolveWorkflowDoc`: session →
  world → global → builtin), `workflowStore.ts` (`BUILTIN_WORKFLOW_ID`), `generationService.ts:124`
  (the single call site that resolves the doc for a turn).
- Trace transport: `src/main/services/workflowEvents.ts` (`notifyWorkflowTrace` broadcast; the
  renderer keeps only the latest trace per chat — there is NO persisted run history today).
- Builtin nodes: `src/main/services/nodes/builtin/*` (defaultGraph.ts spine:
  `ctx → assemble → llm → parse → apply → write(isMainOutput)`; table/lorebook/vars/context/
  subgraph/control node families).
- Renderer views: `src/renderer/src/components/workspace/viewRegistry.tsx` (`ViewRegistry` map —
  new views register here), workflow editor in `src/renderer/src/components/workflow/`
  (FlowCanvas, NodeConfigPanel, WorkflowEditorView).
- Theming: `src/renderer/src/theme.ts` (`--rpt-*` base tokens, three themes: dark/carbon/light).
- i18n: `src/renderer/src/i18n/` (`useT()`, locales/en.ts + zh.ts).

---

## UX brief (applies to every renderer WP; the "excellent UI" bar)

**North star:** the Agents workspace must feel like a polished control room, not a debug panel.
The owner has explicitly rejected debug-grade UI before (Variables view v1 was deleted for this).
Every renderer WP is judged on states, not just the happy path.

### Information architecture

One new registered view: `agents` (title key `agents.title`; en "Agents", zh 「智能体」). Inside it,
a left rail + content area (not tabs-in-tabs):

- **Overview** (default): active packs at a glance, last-run health, setup checklist, errors.
- **Installed** : the pack list (below).
- **Runs**: the timeline.
- **Preview**: next-prompt injection preview.
- Workflow Studio is reached via "Customize…" on a pack — never a top-level tab here.

### The pack card (the core visual unit)

Each pack renders as a card/row with, in order: **gate toggle** (the single most important
control — large hit target, instant optimistic flip, `--rpt-accent` when on), name + creator +
version, **attachment badges** (read-only: "before reply" / "after reply" / "headless · every 3
floors" — structure, not settings, per rev-3 §Settings), **capability chips** (derived; muted
`--rpt-text-secondary` chips, danger-tinted chip for write capabilities), and a **health dot**
(last run ok / failed / never ran → `--rpt-success` / `--rpt-danger` / `--rpt-text-tertiary`).

Disabling a pack with dependents opens a confirm popover listing the cascade ("Also turns off:
Memory Injector — and the main reply" when inline), computed from reachability — never a bare
toggle for destructive-feeling actions, never a blocking modal for safe ones.

### Settings with provenance

Three visible groups matching the spec tiers: System, Creator ("Pack settings"), Advanced (a
"Customize in Workflow Studio" escape hatch with fork explanation). Every overridden value shows a
provenance chip ("this chat" / "this world" / "default") with one-click "reset to default".
Trigger parameters (the N in a cadence) render as System settings on headless packs only.

### Runs timeline

Reverse-chronological entries; turns and headless runs interleaved. Entry = pack avatar/initial,
one-sentence outcome in plain language ("Memory Keeper updated 2 tables after floor 38", "World
Simulation ran: 1 month passed"), duration in seconds (`formatTraceSeconds` convention), expandable
to per-node detail (reuse trace data; localized node titles already exist in the editor). Skipped/
gated entries say WHY ("skipped — table writes denied"). Headless entries carry a trigger caption
("trigger: backlog > 10").

### Injection preview

Per-section list of what enters the next prompt: section name, source attribution chip (pack name /
lorebook / memory table), token count right-aligned, per-section expand to full text. Sections
contributed via `prompt-assembly` rejoins are attributable by construction (ADR 0002). A muted
"omitted" group shows what did NOT make it and why (budget, gate, denial).

### Visual + accessibility rules

- Colors ONLY via `--rpt-*` tokens; add derived domain tokens `--rpt-agent-*` (e.g.
  `--rpt-agent-gate-on`, `--rpt-agent-headless`) in `theme.ts` for all three themes.
- WCAG-AA contrast in all three themes is a hard constraint (owner-locked). No color-only
  signaling: health dots pair with text, capability chips have labels.
- Empty states are designed, not blank: Overview with no packs explains what packs are and points
  at the built-ins; Runs with no history explains when entries appear.
- Loading = skeleton rows, not spinners; failures = inline with a retry affordance.
- Microcopy: plain language, no engine jargon ("runs by itself when its condition is met", not
  "headless trigger evaluation"). zh terms: 智能体 (agent), 智能体包 (agent pack), 检查点
  (checkpoint), 触发器 (trigger), 世界书 (lorebook), 正则 (regex), 预设 (preset) — flag any new
  term for owner review in the PR description.

---

## Phase 1 — Engine substrate

Goal: the builtin narrator gains checkpoints; the engine can compose and gate fragments; shipped
workflows become built-in packs. No new UI beyond what exists.

### WP1.1 — Shared model: checkpoints, attachments, fragment docs

- **Read first:** rev-3 spec §Runtime Model; ADR 0002, 0009; `src/shared/workflow/types.ts`,
  `docSchema.ts`, `validate.ts`.
- **Build (all in `src/shared/workflow/`):** `CHECKPOINTS` const (`context-ready`,
  `prompt-assembly`, `reply-parsed`, `turn-committed`) with the value PortType at each; extend
  `WorkflowDoc.kind` with `'fragment'`; new `AttachmentDecl` type (checkpoint entry {checkpoint,
  mode: 'branch' | 'inline'}, rejoin {checkpoint}, or trigger — trigger shape stubbed until WP2.1);
  fragment validation (a fragment must declare ≥1 attachment; entries/rejoins must name known
  checkpoints; inline attachments must type-check against the checkpoint's value type).
- **Acceptance:** validation unit tests for good/bad fragments; `'turn'`/`'subgraph'` docs
  completely unaffected (characterization stays green).

### WP1.2 — Shared model: effective-graph composition (pure)

- **Read first:** ADR 0001, 0002, 0009; WP1.1 output; `graph.ts`.
- **Build:** `src/shared/workflow/compose.ts`: `composeEffectiveGraph(narrator: WorkflowDoc,
  fragments: {doc, gateOpen, deniedEdges}[]) → WorkflowDoc` — splices entry/rejoin edges at
  checkpoint anchor nodes, prefixes fragment node ids with the pack id (trace attribution derives
  from this prefix), closed gate = fragment simply not spliced, denial = listed entry edges not
  spliced. Also `findCheckpointAnchors(doc)`: locates checkpoint anchors in a narrator (for the
  builtin spine: `context-ready` = `ctx` output, `prompt-assembly` = `assemble` input,
  `reply-parsed` = `parse` output, `turn-committed` = `write` output) and reports which
  checkpoints a custom narrator is missing.
- **Acceptance:** compose(narrator, []) === narrator (id-stable); golden tests: one branch
  fragment, one inline fragment, one multi-attachment fragment, one gated-off, one with a missing
  checkpoint (composes minus that attachment + returns a warning list). Pure — no Electron/main
  imports (check:deps).

### WP1.3 — Engine: branch fail-open + composition wiring

- **Read first:** ADR 0002 consequences; `workflowEngine.ts` (phase computation + failure
  handling), `generationService.ts:124`, `workflowService.ts` (`resolveWorkflowDoc`).
- **Build (main only):** engine learns per-node failure policy derived from composition metadata
  (nodes on a branch sub-path fail open even in pre-phase: sub-path is marked failed/skipped in
  trace, main flow continues; inline fragment nodes keep fatal semantics). `resolveWorkflowDoc`
  gains a sibling `resolveEffectiveDoc(profileId, chatId)` that fetches enabled fragments (WP1.4
  store) and calls `composeEffectiveGraph`; `generationService` switches to it. With zero packs
  installed the effective doc IS the narrator doc — byte-identical behavior.
- **Acceptance:** new engine tests: branch fragment throws pre-reply → reply still produced, trace
  shows the failed sub-path; inline fragment throws → turn aborts (existing fatal behavior).
  **Characterization impact:** engine phase/failure characterization tests gain the branch case —
  update deliberately in the same PR, listing each changed assertion in the PR description.

### WP1.4 — Main: pack library + activation store

- **Read first:** ADR 0005, 0006 (store must anticipate forks/lineage), 0009 (per-pack gate);
  `workflowStore.ts`, `workflowService.ts` selection sidecar (the pattern to mirror); the SQLite
  access pattern used there.
- **Build (main only):** `agentPackStore.ts` (SQLite): `packs` (id, version, lineage/upstream id,
  builtin flag, manifest JSON, fragment doc JSON), `pack_activation` (pack id, world id, chat id
  nullable, gate state, denial set), `pack_overrides` (pack id, scope, setting id, value). Service
  `agentPackService.ts`: list/install/uninstall (builtin = uninstallable), setGate, setOverride
  with nearest-scope-wins resolution, `enabledFragmentsFor(profileId, chatId)` consumed by WP1.3.
  Typed IPC surface following the existing pattern (grep how `workflow` IPC channels are exposed
  and mirror it).
- **Acceptance:** store unit tests incl. override layering (global < world < chat) and gate
  resolution; IPC surface visible to renderer via the typed layer only (check:deps).

### WP1.5 — Write locks for tables and floor variables

- **Read first:** ADR 0003 consequences; `tableNodes.ts` (`table.apply`), `varsNodes.ts`
  (`vars.save`), the services they call.
- **Build (main only):** a keyed async mutex (per chat × resource kind) acquired inside the
  table-write and vars-write service paths (not in node code — the lock must also cover
  non-workflow writers). Held per write operation, not per run.
- **Acceptance:** concurrency test: two interleaved writers serialize, no lost update. Zero
  behavior change single-writer (characterization green). Parallel-safe with WP1.4.

### WP1.6 — Built-in packs: re-express shipped workflows as fragments

- **Read first:** rev-3 §Pack Creation Path (built-ins are packs); the decomposed-default example
  workflow and the table-memory workflow (find via `workflowStore.ts` seeds / example docs);
  ADR 0009.
- **Build:** the table-memory workflow's non-narrator parts become a built-in pack (fragment +
  minimal manifest, seeded by `agentPackStore` migration); the narrator stays a plain workflow.
  Turn-by-turn output with the pack enabled must match the current monolithic workflow —
  characterization test asserting effective-graph equivalence (same node set modulo ids, same
  execution order).
- **Acceptance:** with the built-in pack enabled, existing table-memory behavior tests pass
  unchanged; disabling the pack cleanly removes its trace nodes. This WP is the ABI dogfood — any
  awkwardness here is design feedback to surface, not to code around.

## Phase 2 — Headless runs and triggers

### WP2.1 — Shared model: triggers

- **Read first:** ADR 0003, 0004; WP1.1 `AttachmentDecl`.
- **Build (`shared/workflow`):** `TriggerDecl` = state condition (a small declarative predicate
  over floor-variable paths / table stats — comparison ops only, NO arbitrary EJS), cadence
  (everyNFloors), manual. Validation + unit tests. Document the predicate grammar in the file
  header.
- **Acceptance:** parse/validate tests; grammar documented.

### WP2.2 — Main: trigger evaluator + headless runner

- **Read first:** ADR 0003, 0004; `workflowEngine.ts` run entry; `generationService` post-commit
  point; WP1.4 service.
- **Build (main only):** `headlessRunService.ts`: `evaluateTriggers(chatId, cause)` called after a
  turn commits and after a headless run commits (depth cap, default 3, runtime constant); a
  matched trigger executes the fragment as its own engine run with a minimal Context input and no
  main-output requirement; failures never surface to the chat flow (log + run record only).
  Reuses WP1.5 locks for all writes.
- **Acceptance:** integration test: floor-var write that satisfies a condition → headless run
  executes → its table write lands; chain test capped at depth; a turn started mid-headless-run
  never blocks on it (reads committed state).

### WP2.3 — Main: persisted run history

- **Read first:** `trace.ts` (WorkflowRunTrace), `workflowEvents.ts` (broadcast-only today);
  ADR 0003 (timeline shows headless runs).
- **Build (main only):** `runHistoryStore.ts` (SQLite, ring-capped per chat, e.g. last 200 runs):
  persists every WorkflowRunTrace annotated with `origin` (turn | headless | manual), pack
  attributions (from the WP1.2 node-id prefixes), trigger description, and gate/denial skip
  reasons. IPC: `listRuns(chatId, cursor)`. Keep the existing live broadcast untouched.
- **Acceptance:** turns and headless runs both recorded with correct attribution; cap enforced;
  existing trace panel behavior unchanged. Parallel-safe with WP2.2 after the annotation shape is
  agreed (land the shape in `shared/workflow/trace.ts` first).

### WP2.4 — Built-in pack: async table memory (the flagship)

- **Read first:** rev-3 §Memory as an Agent Capability; ADR 0009 (this is its motivating case);
  the table-memory backfill/progress services (progress pointer already exists — find it in the
  table service layer before inventing one).
- **Build:** the flagship pack: headless compactor (trigger: unsummarized backlog > N, N a system
  trigger param), inline trimmer at `context-ready` (trims history up to the committed progress
  pointer; carries full history if compaction hasn't landed — fail-soft), branch injector at
  `prompt-assembly` (memory table export block). Ships as a built-in pack, default OFF.
- **Acceptance:** end-to-end test: exceed backlog → headless compaction commits → next turn's
  assembled prompt contains the memory block and trimmed history; kill the compactor mid-run →
  next turn uses untrimmed history and nothing corrupts. This validates ADR 0003's entire
  coordination story.

## Phase 3 — Agents workspace (the UX payoff; UX brief above is the spec)

### WP3.1 — Agents view shell + Installed list

- **Read first:** UX brief; `viewRegistry.tsx`; `theme.ts`; an existing polished view for idiom
  (DuelView or the Tables view); i18n locales.
- **Build (renderer only):** register `agents` view; left-rail navigation (Overview / Installed /
  Runs / Preview); Installed list with the full pack card treatment (gate toggle with optimistic
  update + cascade confirm popover, attachment badges, capability chips, health dot); add
  `--rpt-agent-*` tokens to all three themes; every string in en+zh.
- **Acceptance:** all states rendered (no packs, packs disabled, gate cascade incl. "disables the
  main reply" inline warning); keyboard navigable; AA contrast in all three themes (check computed
  styles, not vibes).

### WP3.2 — Pack detail: tiered settings with provenance

- **Read first:** UX brief §Settings; rev-3 §Settings Tiers; WP1.4 IPC (overrides + scopes).
- **Build (renderer only):** detail panel with System / Pack / Advanced groups; provenance chips +
  reset-to-default per setting; trigger params surfaced for headless packs; "Customize in Workflow
  Studio" hand-off (opens the existing editor on the fragment; the fork flow itself is phase 4 —
  until then the button carries an "advanced" warning and opens read-only).
- **Acceptance:** override written at chat scope shows "this chat" chip and wins over world value;
  reset clears exactly one scope; settings render from manifest schema (no hardcoded pack names).

### WP3.3 — Runs timeline

- **Read first:** UX brief §Runs; WP2.3 IPC; `trace.ts` + the editor's localized node titles.
- **Build (renderer only):** timeline per the brief (interleaved turns/headless, plain-language
  one-liners, expandable node detail, skip reasons, trigger captions, seconds formatting).
- **Acceptance:** renders real history incl. a failed branch run ("Plot Planner failed — reply was
  not affected"), a gated skip, a headless entry with trigger caption; empty state; infinite
  scroll via cursor.

### WP3.4 — Injection preview

- **Read first:** UX brief §Injection preview; `prompt.assemble` + `prompt.preset` composition
  path in `generationNodes.ts`/`presetNodes.ts` (verify how assembled sections are represented
  before designing the IPC — cite lines in the PR).
- **Build:** main: `previewNextPrompt(chatId)` — runs the pre-reply portion of the effective graph
  in a dry-run mode (no LLM call, no state writes; needs an engine dry-run flag — coordinate with
  WP1.3's composition metadata) returning sections with source attribution + token counts.
  Renderer: the Preview pane per the brief. This is the one phase-3 WP allowed to touch main and
  renderer (the IPC is its deliverable); keep the engine change to the dry-run flag.
- **Acceptance:** preview lists sections with per-pack attribution chips and token counts; an
  omitted-by-budget section appears in the omitted group; preview causes zero state writes
  (assert via store snapshot).

### WP3.5 — Overview + explain-why + polish pass

- **Read first:** UX brief §north star; WP3.1–3.4 outputs; run history + gate/denial state.
- **Build (renderer only):** Overview (active packs, health, setup checklist, latest errors with
  guided recovery actions: retry / open runs / open settings); "why did/didn't this update?"
  popover on pack cards and memory tables (answer assembled from gate state, denial, trigger
  evaluation history, last run trace); a final polish pass over phase 3 (spacing rhythm, focus
  states, motion: 150–200ms ease-out on gate flips and expansions, reduced-motion respected).
- **Acceptance:** explain-why produces a correct sentence for: disabled, denied capability,
  trigger not met (with current vs required value), upstream gate cascade, last run failed.
  Owner does a visual pass — schedule a checkpoint here before phase 4.

## Phases 4–6 (sketch — each gets its own dated plan when reached)

- **Phase 4 — Pack format v0 + wizard + import.** `shared/workflow/capabilities.ts` (derivation +
  denial-soundness tests), single-JSON envelope with `formatVersion`, contract-aware export wizard
  (attachment + capability preview, narrator-bound export refused), import flow with the
  inspection screen, copy-on-edit forks (ADR 0006) and the Studio fork banner. SDK docs update:
  packs become a documented surface.
- **Phase 5 — Card cartridge + recipes.** Cartridge embedding under
  `data.extensions.rp_terminal` (schema in `src/main/types/character.ts` — update `docs/sdk/` in
  the same change per CLAUDE.md), suggested-activation import UX, `.rptrecipe`
  bundle-for-transport (ADR 0008).
- **Phase 6 — Versioning/upgrade UX.** Upstream-diff view, update offers, override reapply
  reporting.

## Amendments (running log — controller decisions during execution)

- **2026-07-03, after WP1.1:** checkpoint pins landed as `context-ready`=Context,
  `prompt-assembly`=Text (the `block` input), `reply-parsed`/`turn-committed`=Any (the real ports
  are Any — compile-time protection there is weak; ABI-sharpening deferred). `WorkflowSummary.kind`
  in `workflowService.ts` was widened one word (mechanically forced); WP1.4 must decide whether
  fragment-kind docs are filtered out of the normal workflow list UI.
- **2026-07-03, after WP1.2:** (1) **Fan-in limit:** only ONE pack can rejoin at
  `prompt-assembly.block`; a second is skipped with a `fanin-unmergeable` warning. Fine for the
  phase-1/2 spine (the flagship needs one injector) but must be fixed before the multi-pack world —
  **new WP1.7 (backlog): text-merge node + compose auto-insert on fan-in.** (2) **Stacked inline
  fragments at one checkpoint:** contract documented as fragments-array-order = chain order; full
  multi-inline wiring deferred. (3) **Per-node failure attribution** (`nodeModes` +
  `rejoinEdges` in meta.composition) added to WP1.2's deliverable — WP1.3's fail-open policy
  depends on it because a rejoining branch is an ancestor of the main output, so graph ancestry
  cannot identify load-bearing nodes. (4) Fragment boundary ports are designated inline on the
  attachment decl (`entryPort`/`outPort`/`rejoinPort`), NOT via subgraph.input/output boundary
  nodes (those are validation-forbidden outside subgraph docs).

- **2026-07-03, after WP1.3:** the fail-open policy is one guarded condition at the engine's
  single fatal branch (`state.failOpen` from `meta.composition.nodeModes`, computed at run start);
  "failed branch's rejoin behaves as unwired" falls out of existing dead-edge propagation —
  `rejoinEdges` metadata is redundant FOR THE ENGINE (kept for WP2.3/3.4 attribution).
  `resolveEffectiveDoc` + `setEnabledFragmentsProvider` seam live in workflowService; WP1.4
  registers the real provider. `resolveEffectiveDoc` returns the NARRATOR's id (effective graph
  has no id); duplicate packIds would silently overwrite in compose — WP1.4 must guard.
- **2026-07-03, after WP1.5:** locks live at the service layer — `applySqlBatch`
  (`table:<chatId>`), `saveFloor` + `setChatCardVars` (`vars:<chatId>`); key builders
  `tableLockKey`/`varsLockKey` exported for WP2.2. `withLock` has a SYNCHRONOUS FAST PATH
  (uncontended sync bodies complete in-call, no lingering tail) — load-bearing for the ~20 sync
  callers; do not "simplify" it away. The mutex is NON-REENTRANT: **WP2.2 must NOT wrap a critical
  section in `withLock(key)` and then call `saveFloor`/`applySqlBatch` (same key) inside — that
  deadlocks.** WP2.2 either relies on the services' own per-op locks, or we add reentrant/tryLock
  support first — decide at WP2.2 dispatch.

- **2026-07-03, after WP1.4:** store landed (agent_packs / agent_pack_activation /
  agent_pack_overrides in db.ts SCHEMA; world = the chat's character_id; override scope encoding
  `'global' | 'world:<id>' | 'chat:<id>'` — a deliberate widening of the two-tier selection
  sidecar). **Recorded debt:** `agent_packs` PK is id-per-profile, so same-id different-version
  packs cannot coexist and install() treats a new version as a dedupe no-op — conflicts with
  ADR 0008's version pinning. MUST be reworked (PK id+version, activation pointing at a specific
  entry) before phase 5 recipes; acceptable through phase 4. Overrides are stored+resolved but not
  yet materialized into fragment docs (later WP).

- **2026-07-03, after WP1.6 (the dogfood finding + decision):** the table-memory monolith
  decomposed into fragment + 11 attachments with 10/11 boundary edges expressed cleanly; built-in
  pack seeded gate-closed; gate-closed removal is object-identical. THE finding: the monolith
  injects via `assemble.entries` (placement-carrying LorebookEntry[] on the world-info machinery),
  but `prompt-assembly` was pinned to `block: Text` — placement-carrying injection was
  inexpressible, and WP2.4's flagship injector needs it. **Decision (WP1.6b): `prompt-assembly`
  becomes ONE checkpoint with TWO named anchor ports — `block` (Text, default) and `entries`
  (placement-carrying) — not a fifth checkpoint.** CheckpointSpec supports multiple anchor ports;
  rejoin decls gain an anchor-port selector defaulting to block. Note the FANIN limit applies per
  anchor port (one pack per port until WP1.7's merge work). Minor UX note for the pack-authoring
  wizard: a fragment reading Context in N places needs N entry decls — verbose but correct.

- **2026-07-03, after WP2.1–2.2:** trigger model landed with grounded table stats
  (unprocessed/processed/nextExpected from TableProgress only) and the MVU bracket-aware vars-path
  dialect. Controller ruling: multiple triggers on a pack are INDEPENDENT (OR), deduped to one run
  per pack per boundary. Headless runner: `runSubgraph` could not feed arbitrary entry ports, so
  fragments run via an ADAPTER (synthetic `subgraph.input` seed nodes, ids `__headless_seed_*` —
  **WP3.3 must filter these from the timeline display**). Guard split is load-bearing: public
  `evaluateTriggers` is per-chat-guarded, the chain continues through guard-free `evaluatePass` —
  do not "simplify" into one guarded function (kills chains). Rapid consecutive turns: a turn
  landing mid-chain SKIPS evaluation (the chain's own commit re-evaluates); WP2.4 must not assume
  an immediate dedicated eval per turn. buildGenContext reads all floors per headless Context —
  fine, not free. Traces broadcast as `headless:<packId>`, unstored (WP2.3's job).

- **2026-07-03, after WP2.4 (flagship complete):** builtin.async-memory landed — inline
  `context.trimProcessed` (the ONE pre-authorized new node) at context-ready, branch export →
  entries-lane rejoin, state trigger `table summary.unprocessed gte 6`. End-to-end + fail-soft +
  never-trim-past-pointer proven through the real engine. **ABI observation for phase 4:** a
  headless-only sub-chain that needs turn Context must self-seed via its own `input.context` node
  (an entry attachment would also splice it into turns — WP2.4's first cut double-compacted
  in-band); a dedicated "headless entry" attachment mode is the cleaner future ABI. **Phase-3
  settings dependencies (WP3.2):** backlog N + watched-table sqlName (v0 placeholder 'summary' —
  the top usability blocker) + trimmer scope, all needing override→doc materialization. Both
  memory packs enabled at once = documented-unsupported (double-summarize + trimmed feed).

- **2026-07-03, owner request after WP3.1 review:** "editable effective graph inside the Workflow
  view" — accepted as **ADR 0010** (effective graph = editable projection; edits write through:
  narrator nodes → narrator doc, pack nodes/wiring → copy-on-edit fork per ADR 0006, region
  removal → gate). Pulls the pack **fork operation** forward from phase 4 into new WPs:
  **WP3.6a** (fork service + effective-projection IPC + Effective mode rendering: grouped pack
  regions, gate chips, narrator write-through; pack nodes locked with "fork to edit" affordance)
  then **WP3.6b** (pack-edit routing through fork + repoint + live recompose). Owner's WP3.1
  visibility complaint ("enabling them doesn't show in the workflow") is answered by this plus
  WP3.3/3.4.

## Risks and watchpoints

- **WP1.3 is the highest-risk change** (engine failure semantics). It must land behind the
  zero-packs-identical guarantee; if the characterization diff sprawls beyond the listed branch
  cases, stop and re-plan rather than force green.
- **Checkpoint value shapes** are pinned during WP1.1/1.2 against the real `Context`/`Messages`
  port types — if they don't carry what the trimmer/injector need, surface it as an ABI question
  (rev-3 open question) instead of widening types ad hoc.
- **The trigger predicate grammar** (WP2.1) is the most tempting scope-creep point. Comparison
  ops only in v1; anything richer is a spec change the owner approves first.
- **UI review cadence:** owner reviews after WP3.1 (the pack card is the design keystone) and at
  WP3.5, not only at the end.
