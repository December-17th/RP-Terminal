# RF-08 — Delete the dead workspace/WorkflowView.tsx

Status: ready-for-human
Priority: P2 (dead code, renderer-side, cheap)

## Problem

`src/renderer/src/components/workspace/WorkflowView.tsx` (462 lines) is imported by nothing
(verified 2026-07-06: the only grep hits are its own definition and two index.css comments). It is
the pre-one-canvas "Workflows management pane"; the editor overlay replaced it. Unlike the
main-side Tier-2 pack machinery (whose retirement needs IPC channel relocation — deliberately
dormant per the 2026-07-04 handoff), this deletion is free.

## Grounding (verified 2026-07-06)

- No `import ... WorkflowView` anywhere in `src/`.
- Its exclusive CSS classes: `rpt-workflowmgr-split`, `rpt-workflowmgr-main`,
  `rpt-workflowmgr-trace` — defined in `index.css` ~lines 2784-2795 (block + its
  `@media (max-width:820px)` rule).
- It ALSO uses `rpt-duel-secondary` and possibly other shared classes — those are used elsewhere;
  do not touch them.
- `viewRegistry.tsx` never registered a `workflow` view id (comment at lines 74-77), and Panel.tsx
  resolves unknown saved-layout view ids to a graceful placeholder — no migration needed.
- KEEP-ALIVE warning (handoff 2026-07-04): `runTimeline.ts`, `previewDisplay.ts`, `MemoryPane.tsx`,
  `memoryPaneModel.ts`, `.rpt-agents-chip` css, `agents.cap.*`/`runs.*` i18n keys are load-bearing
  — deleting WorkflowView must NOT cascade into them even if it imports them.

## Changes

1. Delete `src/renderer/src/components/workspace/WorkflowView.tsx`.
2. Delete the `.rpt-workflowmgr-*` CSS block in `index.css` (the three selectors + the media query
   + the block comment above them). Update the OTHER index.css comment (~line 2766) that names
   WorkflowView in its shared-classes explanation — reword to drop the stale reference without
   changing any rule.
3. i18n pruning: list every `t('...')`/`tOpt('...')` key literal in WorkflowView; for each, grep
   the rest of `src/` — delete from BOTH locale files ONLY the keys with zero other usages. Keys
   also used elsewhere (or in the KEEP-ALIVE list above) stay. Record the deleted-key list in the
   PR description.
4. Gate: `npm run typecheck && npm run check:deps && npm run test` — check:deps also proves no
   module imported it.

## User journey (PR description, for the owner pass)

None user-visible. Owner check: open the workflow editor + the Tables view + a duel launch panel —
all render unchanged (they share adjacent CSS).

## NON-GOALS

- No other dead-code hunting (the Tier-2 main-side machinery stays, per the handoff).
- No CSS consolidation beyond removing the three orphaned selectors.

## Size budget

Deletion-dominated; new/edited lines ≤ 20 (comment reword + locale removals).

## Comments

Done 2026-07-06. Re-grounded: `WorkflowView` is imported by nothing (only self-def + 2
index.css comments); `check:deps` (389 modules, 0 violations) confirms no importer.

Deleted:
- `src/renderer/src/components/workspace/WorkflowView.tsx` (462 lines).
- `index.css` `.rpt-workflowmgr-*` block: `.rpt-workflowmgr-split`, `.rpt-workflowmgr-main`,
  `.rpt-workflowmgr-trace` + its `@media (max-width:820px)` rule + the block comment. Reworded
  the shared-classes comment (~line 2784) to drop the `WorkflowView split` reference; no rule changed.

i18n keys deleted from BOTH en.ts + zh.ts (each verified zero other usage in src/):
`workflow.heading`, `workflow.builtin`, `workflow.import`, `workflow.export`, `workflow.clone`,
`workflow.delete`, `workflow.confirmDelete`, `workflow.importFailed`, `workflow.globalDefault`,
`workflow.worldDefault`, `workflow.sessionOverride`, `workflow.inherit`, `workflow.resolved`,
`workflow.trace.heading`, `workflow.trace.empty`, `workflow.trace.total`, `workflow.trace.aborted`,
`workflow.trace.error`, `workflow.trace.postPhase`, `workflow.subgraphBadge`, `workflow.newSubgraph`,
`workflow.invalidBadge`, `workflow.invalidBadgeTitle` (23 keys).

KEPT (other usages): `workflow.trace.status.{ran,skipped,failed}` (FlowCanvas.tsx), `common.edit`,
`workflowEditor.nodeTitle.*`.

Gate: `npm run typecheck` OK · `npm run check:deps` OK (0 violations) · `npm run test` OK
(217 files, 2036 tests; i18nParity green → locales symmetric).
