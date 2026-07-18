# RP Terminal — Current Status

**Status:** Living implementation and release-status summary. Update in place.
**As of:** 2026-07-17
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

## Designed or queued locally

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

## Superseded or retired

- The removed episodic/vector-memory engine is superseded by SQL-table memory.
- Agent packs, fragments, checkpoints, attachments, activation gates/scopes, recipes as a distinct
  artifact, and effective-graph projections are retired user-facing concepts. ADR 0011's one-canvas,
  trigger-rooted agent model replaces them; some underlying code remains for compatibility/internal reuse.
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
