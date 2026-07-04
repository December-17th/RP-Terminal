# Session handoff — owner manual pass, day 1 (2026-07-04)

Point-in-time reference for resuming the manual pass. Supersedes nothing; complements
`docs/handoff-2026-07-04-agent-workflow.md` (the agent-workflow build handoff, still valid).
Supersede with a new dated file; don't rewrite.

## Where things stand

- **main = `d268fd9`** (2026-07-04): the manual-pass PR stack #50 → #52 → #53 → #54 is merged
  (owner-confirmed), plus the independent #55 (codex TavernHelper compat report).
- Gate at last merge: typecheck clean, dependency-cruiser 0 violations (387 modules), **1993 tests**.
- Findings tracker: `.scratch/manual-pass-2026-07-04/issues/` (see `docs/agents/issue-tracker.md`
  conventions). Working worktree was competent-lalande-0925d5.

## What was fixed today (findings 1–3, all merged)

1. **PR #50** — 命定之诗 start-button infinite loop: card `setChatMessages` with unchanged text
   re-fired the card's own MVU events. Fixed: no-op guard in `chatWriteService.setChatMessages` +
   `card-write` echo tagging (wcvIpc sender exclusion; new `chatStore.refreshFloors` replaces the
   full `setActiveChat` on host reload). Pin: `test/cardChatEditFeedbackLoop.test.ts`.
2. **PR #52** — table-template prompts (note + 4 op rules), 维护频率, and the full exportConfig are
   now viewable/editable inline in the Tables view (`table-template-update` IPC; structural fields
   ddl/sqlName/headers/initialRows immutable).
3. **PR #53** — card variable writes journaled (`vars_ops` app-DB table, patch|replace) and replayed
   after each floor's model fold in `reevaluateVariables` — card writes now SURVIVE edits/deletes/
   swipes/re-evaluate. `truncateFloors` clamps the journal. Variables-view `setFloorStatData` stays
   deliberately unlogged. Pin: `test/varsOpsReplay.test.ts`.
4. **PR #54** — `updateFrequency` is shujuku-faithful: `-1` = global default (new
   `settings.tables.default_update_frequency`, default 3, Settings-panel field), `0` = off; resolver
   `tableProgressService.resolveUpdateFrequency` (leaf placement; re-exported from
   `tableStatusService`) feeds gate/status/maintainer header; per-table cadence moved to each Tables-
   view table HEADER (all visible at once: 全局 (N) / 关 / 每 N 轮).

## Open items, in priority order

1. **Retest findings 1–3 in-app** (nothing has been clicked since the merges):
   (a) poem card start button → one clean re-render, no flashing, no repeating
   `MVU re-evaluate → wcv setChatMessages → write-back` log cycle;
   (b) make start-button choices, then edit/delete a later message → floor-0 variables survive
   (log shows `replayed N card write(s)`);
   (c) Tables view → header frequency controls + 模板提示词 editor work; Settings → 默认维护频率.
2. **Continue the manual pass** — the three agent-workflow journeys from
   `docs/handoff-2026-07-04-agent-workflow.md` §Open-items-1 (build/group/toggle a memory agent;
   `.rptmodule` export/re-import; `memory-fill-async` headless run + drawer replay) are untouched.
3. **Issue 04 remainder** (`.scratch/manual-pass-2026-07-04/issues/04`, needs owner triage): the
   other shujuku `updateConfig` knobs still dropped at import — `contextDepth` (update-scope window),
   `skipFloors` (settling lag), `batchSize`, `groupId` (tables sharing one LLM call) — plus
   `globalInjection` (imported, consumed by nothing). Decision: absorb into RPT's workflow-driven
   maintenance vs declare workflow authoring (`table.gate` `every` etc.) the official replacement and
   document it. Clean-room semantics notes are in the issue file — **do NOT read E:\Projects\shujuku
   code for implementation (no LICENSE; observed-behavior notes only)**.
4. **Pre-existing backlog** (from the agent-workflow handoff, unchanged): Tier-2 pack-machinery
   cleanup (dormant until it costs); parked `.rptrecipe` rethink / module viewport-center insertion /
   `editorToDoc` base-spread refactor; never-started card-cartridge module bundling (touches the card
   contract → `docs/sdk/` in the same change), module versioning, fan-in text-merge node.
5. **Older threads**: DuelView polish (owner said "OK but needs more polish" — ask for specifics
   first); SQL-table-memory + node-workflow owner passes partially covered by this manual pass.

## Process rules in force (unchanged, also in auto-memory)

- Implementers are **Opus 4.8 medium** agents; dispatch descriptions name model+effort.
- Controller grounds code first, writes prescriptive specs (exact files/signatures/tests/NON-GOALS +
  size budget with stop-and-report), re-runs the full gate before every commit, commits via heredoc.
- Gate: `npm run typecheck && npm run check:deps && npm run test`.
- Every finding gets an issue file under `.scratch/manual-pass-2026-07-04/issues/` with a `Status:`
  triage line BEFORE a fix is dispatched.

## Gotchas discovered this session

- **A card's own writes must never echo back as event-firing origins.** The WS-3 pattern (exclude
  `e.sender.id`, tag `card-write`) now covers apply-vars AND the chat-write handlers — any NEW
  card-initiated mutation path must follow it (`wcvIpc.ts` `pushVars`/`afterChatMutation`).
- **The varsWrite runaway guard doesn't catch alternating signatures** (sig A,B,A,B… resets the
  streak). It's a backstop only; fix loops at the origin.
- **`saveTableTemplate` overwrites in place only when passed an explicit id** — without it, it
  writes a NEW uuid file (the import path's behavior).
- **`tableStatusService` must not gain imports reachable from `nodes/builtin`** (dep cycle through
  `workflowService`); pure helpers shared with table nodes belong in leaf `tableProgressService`.
- **vars_ops / table_ops parity**: both journals are floor-keyed, clamped by `truncateFloors`,
  FK-cascaded on chat delete. If a new floor-dropping path ever bypasses `truncateFloors`, both
  journals desync — audit callers when touching floor lifecycle.
