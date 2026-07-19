# RP Terminal — Current Status

**Status:** Living implementation and release-status summary. Update in place.
**As of:** 2026-07-19
**Grounded revision:** `33b9080bef1f` (`main`). The current `feat/persona-presets` branch (PR 99) is
described separately below and is not yet merged.

This is the current status source of truth. Git history remains authoritative for exact changes; the
[documentation catalogue](documentation-catalog.md) classifies the supporting contracts, designs, plans,
and historical records.

## Product status

RP Terminal is in early development and is not release-ready. The main application architecture and its
major gameplay/content subsystems are implemented, but release hardening, manual verification, card
compatibility qualification, packaging/data-recovery checks, and product-scope decisions remain.

## Implemented on `main`

- Electron main/preload/React renderer architecture with typed IPC, SQLite + portable file storage,
  profiles, launcher/play workspace, settings modal, semantic themes, custom title bar, and English/Chinese
  app i18n.
- Packaged builds perform a fail-soft, cached check of GitHub's latest published stable release and show a
  dismissible world-chooser notice for newer strict semantic versions. The notice opens only the
  main-validated official release page; downloading and installation remain manual.
- Main-process streaming generation pipeline for OpenAI-, Anthropic-, and Gemini-compatible providers,
  with resilient calls, RPM/concurrency limits, usage metrics, and per-floor token/cache history.
- MVU/Zod state support, QuickJS EJS templates, ST prompt markers/macros, and a clean-room TavernHelper-like
  runtime shared by inline and WCV card transports. Most behavior is shared; transport adapters still have
  explicit capability differences, notably inline regex writes being a no-op. ST-style
  `chatMetadata.variables` and `saveMetadata()` persist through the shared per-chat card-variable store.
- Card-authored inline/WCV UI, trusted-card routing, runtime play/message theming, overlays, world assets,
  card scripts, standalone plugins, slash commands, plugin storage, and allow-listed network access.
- World portrait assets support a conventional `舞台` 立绘 variant with automatic base-立绘 fallback;
  `.jpe` joins the accepted image extensions.
- Pure deterministic tactical-combat and deckbuilder engines with native workspace views.
- One-canvas workflow/agent engine, trigger-rooted headless chains, run history, reusable modules,
  SQL-table memory, the consolidated `memory.maintain` node, and importable example workflows.
- Partial World Card support: lossless card import, bundled regex/preset/lorebook/agent routing, and JSON
  world export.

## Implemented on `feat/persona-presets` (PR 99)

- Settings provide a saved persona library with one active persona mirrored into the generation settings;
  the active entry can be created, edited, selected, deleted, or duplicated under a fresh id
  ([`PersonaPanel.tsx`](../src/renderer/src/components/PersonaPanel.tsx)).
- `{{persona}}` always expands to the active description in authored preset/card/lore/history content,
  including when persona prompt injection is disabled. The inject toggle gates only the raw
  `persona_description` marker/safety-net block, matching SillyTavern's separate macro and IN_PROMPT
  behavior ([`promptBuilder.ts`](../src/main/services/promptBuilder.ts)).
- Inline and WCV card transports expose the same ungated `personaDescription` host value
  ([inline host](../src/renderer/src/cardBridge/host.ts),
  [WCV handler](../src/main/ipc/wcvIpc.ts)). Prompt preview recognizes raw persona markers with
  Prompt Manager role overrides and newline-delimited same-role merged envelopes
  ([`previewSections.ts`](../src/main/services/generation/previewSections.ts)).

## Partially implemented or constrained

| Area                      | Current state                                                             | Remaining work                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Card-runtime parity       | One shared runtime, two adapters                                          | Inline `replaceTavernRegexes`/`updateTavernRegexesWith` remain no-ops; several long-tail TH/ST APIs are partial or stubbed. |
| World Card                | S1, S3, and JSON-side S4 are on `main`                                    | Scope model, remaining bundle slots, and S5 PNG-cartridge import/export are not on `main`.                                  |
| Agentic scene/tool mode   | Manual Explore/Dialogue/Combat FSM is implemented                         | Automatic routing, model-called tool loop, and lore mutation gatekeeper remain planned.                                     |
| Prompt-cache optimization | Measurement/layering scaffolding exists                                   | App-side optimization is stashed; settings remain pinned to baseline pending evidence.                                      |
| Card custom UI            | Inline/WCV execution, static layouts, overlays, and runtime theming exist | Declarative native StatusMenuBuilder view kit and some dynamic panel APIs remain deferred.                                  |
| Release hardening         | Trust-boundary coverage and a packaged-build release notifier landed      | Owner in-app trust pass, packaged data-dir verification, automatic update helper/recovery UX, and broader release gates remain. |

## Designed or queued

- Agentic plot recall (`docs/plot-recall-memory-design.md` and `.scratch/plot-recall/`) is designed and
  ready for implementation but is not part of `main`.
- The AI-called function/tool loop in `.scratch/ai-called-functions/PRD.md` needs triage.
- POD card-side game-engine work under `.scratch/pod-game-engine/` spans this repository and the separate
  POD repository. Cartridge import and card-code serving exist on local feature branches only; they are
  not current `main` behavior.
- SQL-table-memory refill overhaul: a chunk-committed, resumable refill engine replaces the append-only
  backfill paths, with per-table cadence gating and
  injection policy/cap controls. It ships alongside a full-window Memory Manager overhaul (refill
  workbench, floor-grouped History, staged Structure edits). The refill lifecycle now has an instance
  interface with a deterministic completion handle and real-SQLite lifecycle coverage for success,
  stop-and-resume failure, cancellation, discard, and transcript-staleness recovery. The test-surface
  refactor is implemented and gate-green in the working tree, pending owner review/commit and an in-app
  manual pass.
- The [Agent Runtime design](agent-system/agent-runtime-design.md) and
  [ADR 0019](adr/0019-agent-runtime-replaces-workflow-system.md) are approved. Implementation has
  started on `agent-system`; Milestones 1-4, Sessions 0-7, are implemented, reviewed, accepted, and
  committed. Session 0 baseline evidence is complete and
  reviewed. The current foundation is internal only: Agent contracts, provider
  normalization/selection, the Harness, scripted characterization fixtures, the profile-wide Agent
  Catalog, floor-owned immutable Run Records, the typed Agent Activity read/cancel surface, general
  `floor_operations` with persisted pre-floor baselines and non-destructive `vars_ops` compatibility,
  atomic suffix replay across model/card/user/Agent state paths, and the production
  `InvocationRuntime`. The runtime provides floor-ordered per-Agent lanes, sequence and flat-parallel
  plan semantics, duplicate coalescing, deletion/cancellation, stale-source restarts, one shared
  corrective retry budget, atomic `RunStore`/result/FloorState incorporation, Next-turn Barriers, and
  activity stop/shutdown. Unified floor deletion removes floors, state journals, and Run Records in
  one transaction while cancelling affected work. Sessions 8-12 remain planned and unimplemented;
  the public card Agent API now provides scoped run/plan calls, live card tools, cancellation, and exact-once floor commit scheduling with inline/WCV parity. Player Generation cutover and workflow removal are not implemented, so
  Classic and Yuzu still use the workflow-backed product path.
  The [Classic Narrator first execution plan](agent-system/classic-narrator-first-execution-plan.md)
  reorders Session 8 validation ahead of debloating. Its Milestone 1 is implemented and reviewed in the
  current working tree, but is not yet committed: the assembled request from the `llm.sample` node
  executes through a one-call, tool-less `AgentHarness.executePrepared`
  seam, with identical ordered messages and identical serialized OpenAI/Anthropic/Gemini body bytes.
  This covers Classic's default graph and, because they embed the same node type, the memory group
  template and the async-memory/table-memory packs; `agent.llm`, memory, notes, and recall nodes are
  unchanged. The workflow still owns assembly, parse, persistence, and secondary nodes, and no retry,
  concurrency, or provider-selection layer was duplicated.
  The original [implementation plan](agent-system/implementation-plan.md) remains the broader
  session record. Plot/memory node conversion is design-only until separately approved.
  The planned cutover replaces every model-backed operation with one provider-neutral Harness,
  moves variable/time scheduling to card-side logic, and removes the workflow runtime, canvas, node
  formats, examples, and compatibility surface before merge. There is no migration or dual-runtime
  release; legacy workflow data remains inert on disk.

## Superseded or retired

- The removed episodic/vector-memory engine is superseded by SQL-table memory.
- The entire workflow/agent graph product model—packs, fragments, checkpoints, attachments,
  activation gates/scopes, recipes, effective graphs, one-canvas workflows, trigger-rooted chains,
  nodes, and modules—is superseded by ADR 0019. The implementation remains present only until the
  approved atomic Agent Runtime cutover; no new workflow features are planned.
- The June maintainability plans and dated reviews are historical records, not current backlogs.

## Current documentation and release risks

- Card-facing docs must distinguish shared-runtime API shape from transport-specific adapter support.
- A current compatibility test matrix against representative supported cards is still needed.
- Third-party redistribution notices are incomplete; `THIRD-PARTY-NOTICES.md` currently records only
  `vanilla-jsoneditor`.
- The project still needs an owner-selected license and a `LICENSE` file.

## Verification

Audit run on 2026-07-10:

- `npm.cmd run typecheck` — passed.
- `npm.cmd run check:deps` — passed; 421 modules and 1,743 dependencies, zero violations.
- `npm.cmd run test` — passed; 247 test files and 2,575 tests.
