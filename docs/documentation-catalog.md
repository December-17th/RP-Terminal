# RP Terminal — Documentation Catalogue

**Status:** Living catalogue. Update in place whenever documentation is added, removed, renamed, or changes
lifecycle state.
**As of:** 2026-07-19

This catalogue answers two questions: which document is authoritative for a subject, and whether a file is
living, implemented history, planned work, deferred work, superseded, or a point-in-time snapshot.
[Current Status](current-status.md) is the implementation/release summary; this page is the documentation
map.

## Lifecycle labels

| Label               | Meaning                                        | Maintenance rule                                                     |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Living              | Current behavior or contributor contract       | Edit in place with the code change.                                  |
| Implemented history | Design/plan whose scoped work shipped          | Preserve the body; keep a truthful completion header.                |
| Partial             | Some scoped work shipped; named work remains   | Keep the status header and phase table current.                      |
| Planned             | Approved or proposed work not on `main`        | Do not describe it as current behavior.                              |
| Deferred            | Intentionally parked                           | Record why and the condition for revisiting.                         |
| Superseded          | Replaced or removed                            | Keep for history with a link to the replacement.                     |
| Snapshot            | Dated audit, report, handoff, or execution log | Do not rewrite historical findings; supersede with a new dated file. |

## Authoritative living documentation

| Document                                                                                                                  | Subject                                                      | Status / caveat                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| [README](../README.md)                                                                                                    | Product overview, architecture, setup, verification          | Living; early-development overview.                    |
| [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md)                                                                   | Contributor and agent rules                                  | Living.                                                |
| [CONTEXT.md](../CONTEXT.md)                                                                                               | Current Agent Runtime vocabulary                             | Living; ADR 0019 terminology wins.                     |
| [PRODUCT.md](../PRODUCT.md)                                                                                               | Product definition and direction                             | Living.                                                |
| [Current Status](current-status.md)                                                                                       | Current implementation, gaps, and release state              | Living source of status truth.                         |
| [Card SDK index](sdk/README.md)                                                                                           | Card-facing documentation maintenance map                    | Living.                                                |
| [SDK component inventory](sdk/component-inventory.md)                                                                     | Card runtime, environment, format, transforms, game surfaces | Living; status markers are contractual.                |
| [Card & Script API](rpt-api.md)                                                                                           | TavernHelper/MVU/EJS-style runtime method reference          | Living; transport differences must be explicit.        |
| [Plugin API](plugin-api.md)                                                                                               | `rpt.v1` card-script and standalone-plugin API               | Living stable contract.                                |
| [Compatibility comparison](compat-comparison.md)                                                                          | RPT vs TavernHelper vs ST-Prompt-Template                    | Living compatibility summary.                          |
| [Table templates](sdk/table-templates.md)                                                                                 | SQL-table memory import/edit/write/export/backfill contract  | Living; implemented except documented deferred items.  |
| [Workflow module format](sdk/workflow-module-format.md)                                                                   | Legacy creator-facing workflow/module format                 | Implemented and frozen; removal approved by ADR 0019.  |
| [World Card design](world-card-design.md)                                                                                 | Bundle/container format and phase status                     | Partial; status header and phase table are living.     |
| [Runtime theme API](runtime-theme-api-design.md)                                                                          | Card-callable play/message theming                           | Implemented contract; maintain with `rpt-api.md`.      |
| [Agent issue tracker](agents/issue-tracker.md), [triage labels](agents/triage-labels.md), [domain docs](agents/domain.md) | Local project-process conventions                            | Living.                                                |
| [Third-party notices](../THIRD-PARTY-NOTICES.md) and [card libraries](../resources/cardlibs/README.md)                    | Redistribution attribution and vendored card assets          | Living; notices remain incomplete until release audit. |

## Current implementation examples and manual artifacts

| Document                                            | Status                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `workflows/decomposed-default.rptflow`              | Implemented legacy example; removal approved by ADR 0019.                              |
| `workflows/memory-fill.rptflow`                     | Implemented legacy example; removal approved by ADR 0019.                              |
| `workflows/memory-fill-async.rptflow`               | Implemented legacy example; removal approved by ADR 0019.                              |
| `workflows/memory-maintain.rptflow`                 | Implemented legacy example; removal approved by ADR 0019.                              |
| `workflows/table-memory-default.rptflow`            | Implemented legacy example; removal approved by ADR 0019.                              |
| [Seam-slice demo](design/seam-slice-demo/README.md) | Current manual WCV geometry/seam test; standalone artifact.                            |
| [Workflow manual tests](workflow-manual-tests.md)   | Snapshot from 2026-07-02; partially outdated by the full-window editor and Default v2. |

## Implemented design and plan history

| Document                                                                                                                                                      | Status                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Card-script WCV surfaces](card-script-wcv-surfaces-design.md)                                                                                                | Phases 1–4 implemented; OAuth/private publishing deferred.            |
| [Combat system](combat-system-design.md)                                                                                                                      | Implemented design with documented as-built deltas.                   |
| [MVU support](mvu-support-design.md)                                                                                                                          | Implemented historical design.                                        |
| [MVU panel workspace](mvu-panel-workspace-design.md)                                                                                                          | Implemented historical design.                                        |
| [Plugin system](plugin-system-design.md)                                                                                                                      | P1–P5 implemented; PNG-cartridge installation remains future work.    |
| [ST extension parity](st-extension-parity-design.md)                                                                                                          | TH-1 through TH-8 implemented; documented long-tail gaps remain.      |
| [ST Prompt Template plan](st-prompt-template-plan.md)                                                                                                         | Phases A–E implemented historical plan.                               |
| [UI rehaul](ui-rehaul-design.md)                                                                                                                              | Foundation implemented; documented manager/scope follow-ups deferred. |
| [Token/cache meter design](token-cache-meter-design.md) and [plan](token-cache-meter-plan.md)                                                                 | Implemented historical design/plan; live streaming counter deferred.  |
| [Agent & memory UX design](superpowers/specs/2026-07-07-agent-memory-ux-design.md) and [plan](superpowers/plans/2026-07-07-agent-memory-ux-plan.md)           | Implemented point-in-time work package.                               |
| [`memory.maintain` design](superpowers/specs/2026-07-07-memory-maintain-node-design.md) and [plan](superpowers/plans/2026-07-07-memory-maintain-node-plan.md) | Implemented point-in-time work package.                               |
| [Refill lifecycle test surface](superpowers/plans/2026-07-15-refill-lifecycle-test-surface-plan.md)                                                     | Implemented in the working tree; pending owner review and commit.     |

## Partial, planned, and deferred designs

| Document                                                         | Status                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Agent Runtime](agent-system/agent-runtime-design.md)            | Approved; Milestones 1–3, Sessions 0-7 are implemented/reviewed; working-tree commits pending. |
| [Implementation plan](agent-system/implementation-plan.md)       | Active on `agent-system`; Sessions 0-7 are implemented. Sessions 8-12 remain planned.           |
| [Classic Narrator first execution plan](agent-system/classic-narrator-first-execution-plan.md) | Active point-in-time plan; Session 8 validation precedes debloating and plot/memory conversion remains design-only. |
| [Parser-backed built-in Agent design](agent-system/parser-backed-agent-design.md) | Design only and UNAPPROVED; Milestone 5 deliverable. Only memory maintenance is proposed for conversion; recall, notes, backfill, and refill are deferred. |
| [Agent Runtime debloat audit](agent-system/debloat-audit.md) | Decision-support report only; Milestone 6 deliverable. No deletion is approved or performed. Classifies each runtime facility Keep/Collapse/Reduce/Defer/Remove against real Classic consumers. |
| [Agentic mode](agentic-mode-design.md)                           | Partially superseded: manual FSM shipped; unshipped tool-loop design replaced by Agent Runtime.         |
| [Card custom UI](card-custom-ui-design.md)                       | Partial predecessor design; inline/WCV/static-layout work shipped, native declarative view kit remains. |
| [Grep notes memory](grep-notes-memory-design.md)                 | Planned prototype; partially superseded by Agentic Plot Recall.                                         |
| `plot-recall-memory-design.md`                                   | Local untracked planned design; implementation plan lives under `.scratch/plot-recall/`.                |
| [Prompt-cache optimization](prompt-cache-optimization-design.md) | Deferred/stashed; baseline remains selected.                                                            |
| [Prompt-cache harness/L1 plan](prompt-cache-harness-l1-plan.md)  | Implemented experimental scaffolding, now parked by the stashed cache decision.                         |

## Superseded documentation

| Document                                                 | Replacement                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Episodic memory design](episodic-memory-design.md)      | SQL-table memory and the table-memory SDK docs.                                     |
| [Original health check](codebase-health-check.md)        | `codebase-health-check-2026-06-24.md`, then later dated reviews.                    |
| [Original maintainability plan](maintainability-plan.md) | `maintainability-plan-2026-06-26.md` and its execution log.                         |
| Workflow/agent ADRs 0001–0011                            | [ADR 0019](adr/0019-agent-runtime-replaces-workflow-system.md).                    |
| [Agent & memory UX design](superpowers/specs/2026-07-07-agent-memory-ux-design.md) | [Agent Runtime design](agent-system/agent-runtime-design.md).             |

### ADR register

| ADR                                                                                                     | Status                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [0001 — Agent packs compose](adr/0001-agent-packs-compose-into-one-effective-graph.md)                  | Superseded by 0019.                                 |
| [0002 — Fragment checkpoints/gates](adr/0002-fragments-attach-at-checkpoints-disable-gates-the-edge.md) | Superseded by 0019.                                 |
| [0003 — Headless runs](adr/0003-headless-runs-are-turn-decoupled-and-state-mediated.md)                 | Superseded by 0019.                                 |
| [0004 — Trigger commit boundaries](adr/0004-triggers-evaluate-at-commit-boundaries-only.md)             | Superseded by 0019.                                 |
| [0005 — Pack activation scopes](adr/0005-install-globally-activate-per-world-override-per-chat.md)      | Superseded by 0019.                                 |
| [0006 — Copy-on-edit forks](adr/0006-forks-are-copy-on-edit.md)                                         | Superseded by 0019.                                 |
| [0007 — Capability-denial gates](adr/0007-capability-denial-closes-gates.md)                            | Superseded by 0019.                                 |
| [0008 — Recipes](adr/0008-recipes-bundle-for-transport-reference-internally.md)                         | Superseded by 0019.                                 |
| [0009 — Pack attachments](adr/0009-one-pack-one-graph-many-attachments.md)                              | Superseded by 0019.                                 |
| [0010 — Effective-graph projection](adr/0010-effective-graph-is-an-editable-projection.md)              | Superseded by 0019.                                 |
| [0011 — One canvas](adr/0011-one-canvas-trigger-rooted-agents.md)                                       | Superseded by 0019.                                 |
| [0012 — Unknown HTML tags](adr/0012-unknown-html-tags-are-stripped-globally-in-message-markdown.md)     | Accepted.                                           |
| [0013 — WCV channel spec](adr/0013-wcv-transport-derives-from-a-channel-spec.md)                         | Accepted.                                           |
| [0014 — Lenient YSS parse](adr/0014-yuzu-scene-language-lenient-yss-parse.md)                           | Accepted.                                           |
| [0015 — YSS v0 grammar](adr/0015-yuzu-scene-script-yss-v0.md)                                           | Accepted.                                           |
| [0016 — Frozen ST 1.18.0 parity](adr/0016-parity-is-frozen-st-1180-assembly-only.md)                    | Accepted.                                           |
| [0017 — Import trust boundary](adr/0017-import-is-the-trust-act-remote-code-isolated-realm.md)          | Accepted.                                           |
| [0018 — Lossless preset envelopes](adr/0018-presets-persist-as-lossless-envelopes-edited-in-place.md)  | Accepted.                                           |
| [0019 — Agent Runtime cutover](adr/0019-agent-runtime-replaces-workflow-system.md)                       | Accepted; approved target architecture.             |

Implementation code may be reused behind the new runtime, but workflow concepts and formats do not
survive the ADR 0019 cutover.

## Point-in-time records

- Health and structure: `codebase-health-check-2026-06-24.md`,
  `codebase-structural-review-2026-06-26.md`, `maintainability-plan-2026-06-26.md`, and
  `structural-cleanup-log-2026-06-26.md`.
- Session handoffs: `handoff-2026-07-04-agent-workflow.md` and
  `handoff-2026-07-04-manual-pass.md`.
- Reviews/reports: `project-review-2026-07-09.md`,
  `tavernhelper-compat-report-2026-07-04.md`, and the final
  [Comprehensive Project Review — 2026-07-14](project-review-2026-07-14.md) snapshot.
- Performance: [Application Performance Audit — 2026-07-14](performance-audit-2026-07-14.md) snapshot.
- `progress-log.md` is a curated historical highlights log; git history and `current-status.md` are the
  current sources.

## Local-only working documentation

These files intentionally remain local and are not product contracts:

- `.scratch/ai-called-functions/` — unimplemented PRD needing triage.
- `.scratch/card-trust-boundary/` — merged implementation record with remaining owner manual checks.
- `.scratch/memory-node-2026-07-07/` — superseded design-session context.
- `.scratch/plot-recall/` — current local implementation plan and deferred progression report.
- `.scratch/pod-game-engine/` — cross-repository, branch-specific design/plan/handoff/checklists.
- `.superpowers/sdd/` — completed transient implementation briefs, diffs, and reports; not current docs.
- `.local-notes/` — explicitly local comparative notes.

## Maintenance checklist

When documentation changes:

1. Update this catalogue and, if implementation/release state changed, `current-status.md`.
2. Update living SDK/API contracts in the same change as card-facing code.
3. Give new ADRs and plans an explicit lifecycle status near the title.
4. Keep historical bodies intact; add supersession/completion headers instead of rewriting history.
5. Check local links from the repository root:

   ```text
   npm.cmd run check:docs
   ```

   `scripts/check-doc-links.mjs` resolves repository-local targets relative to the document containing
   them; external URLs and heading anchors are excluded.

6. Run `npm.cmd run typecheck`, `npm.cmd run check:deps`, and `npm.cmd run test` for behavior-affecting
   changes.
