# `memory.maintain` node — implementation plan — 2026-07-07

**Spec:** `../specs/2026-07-07-memory-maintain-node-design.md` (owner-reviewed 2026-07-07).
**Branch/worktree:** `claude/inspiring-euclid-c951f0` (`.claude/worktrees/eloquent-feistel-0673e3`).
**Process:** one module per WP; `npm run typecheck && npm run check:deps && npm run test` green at each
step; characterization tests updated deliberately, never deleted to go green.

## §0 Resolved decisions (from spec sign-off)

- **Migration = auto-replace v1** (owner): supersede a live v1 default doc with v2 for every profile;
  hand-edits lost (accepted); tombstones still win (a deleted memory default is not resurrected).
- **Per-table editor = in the node panel** (owner): edits the bound template via `table-template-update`.
- **Preview** via a small dedicated read IPC (`memory-maintain-preview`).
- **Placeholder** = `{{tables}}` canonical, `{{input}}` accepted as alias (verbatim prompt transfers).

## §0.1 Grounding recap (files the WPs touch)

- Node registry/catalog: `nodes/builtin/index.ts` (`:20,37,72,88`), `nodes/catalog.ts`.
- Shared cores to REUSE (extract, don't copy): `tableMaintenance.ts` (`renderTableBlock:33-51`,
  `MAINTAINER_RULES`), `agentNodes.ts` (`history.recent:66-86`, compose `208-294`), `messageNodes.ts`
  (`interpolate:37-64`), `generationNodes.ts` (`runLlmCall`), `parseNodes.ts` (`extractTagAll:34`),
  `tableNodes.ts` (`table.apply:61-`, `table.read:324-370`), `tableSql.ts` (`applySqlBatch`),
  `tableOpsService.ts` (`tryBeginTableWrite/appendOps/endTableWrite`), `tableProgressService.ts`
  (`advanceProgress/resolveUpdateFrequency`), `genContext.ts` (`buildGenContext`).
- Template + IPC: `types/tableTemplate.ts` (`TableDef:55-83`, `TableDefPatchSchema:95-116`),
  `tableMemoryIpc.ts` (`table-template-get:25`, `table-template-update:31`, `chat-table-template-get:50`),
  `tableTemplateService.ts` (`updateTableTemplate:121`).
- Seeding: `workflowService.ts` (`seedDefaultMemoryWorkflow:146-179`, `MEMORY_NODE_TYPES` guard `:163`,
  `_selection.json` `seededTombstones`, `deleteWorkflow` tombstone `:452`), `defaultMemoryTemplate.ts`.
- Panel: `NodeConfigPanel.tsx` (node-type branches `:900,907`; `AssemblePreview` precedent),
  `detailsPanelModel.ts` (`visibleTabs:38`, `PROMPT_PLACEHOLDERS:51`), `PromptEditor.tsx`.
- Debug-prompt trace channel already landed: `NodeResult.debug` (`b1906ae`).

## WP0 — Extract shared cores behind interfaces (refactor; behavior-preserving)

Pull the two internals `memory.maintain` shares with existing nodes into pure/small-seam helpers so
there is ONE implementation, then re-point the existing nodes at them (their characterization tests must
stay green — proves no behavior change).

1. **History slice** → `recentTranscript(gen, { lastNFloors, include })` in a shared module (e.g.
   `services/memoryMaintenance.ts` or extend `agentNodes` helpers). `history.recent.run` becomes a thin
   wrapper. Reuse `stripThinking` exactly.
2. **Table-edit apply-core** → `applyTableEdit(gen, sql, { advanceProgress })` factored out of
   `table.apply.run` (busy-guard + `applySqlBatch` + `appendOps` + progress advance + A/B error
   mapping). `table.apply.run` becomes a thin wrapper returning the same outputs/errors.

Tests: existing `table.apply` + `history.recent`/`memoryFillChain` characterization green unchanged; add
a direct unit test for each extracted helper. **Files:** `agentNodes.ts`, `tableNodes.ts`, new shared
helper module. Gate green.

## WP1 — The `memory.maintain` node

`nodes/builtin/memoryNodes.ts`: the node per spec §1.

- Descriptor: `type:'memory.maintain'`, `title:'Memory'`, `promptFields:['messages']`,
  `inputs:[{when:Signal}]`, `outputs:[{report:Text},{error:Error}]`.
- `configSchema = llmCallConfigSchema.extend({ messages, lastNFloors?, max_rows?, include_rules?,
  advance_progress?, temperature? })`.
- `run()`: self-seed `buildGenContext`; no template → silent no-op; render `tablesBlock` via
  `renderTableBlock` loop (parity with `table.read`); `recentTranscript` (WP0); compose messages
  (`interpolate` with `{{tables}}`/`{{input}}` alias + `{history}` splice + `providerShape`);
  `runLlmCall`; `extractTagAll(reply,'TableEdit')[0]`; `applyTableEdit` (WP0); `debug['prompt (sent)']`;
  emit `report` ("applied N stmts / M tables") + route failures to `error`.
- Register in `index.ts`; add catalog hints in `catalog.ts` (grouping/section like `agent.llm`).

Tests: compose/apply parity (block byte-equals `table.read`; `{{tables}}`==`{{input}}` alias);
integration mirroring `memoryFillChain.test.ts` (SQL lands, pointer advances, debug carries block +
history, `error` routes on bad batch). **Files:** `memoryNodes.ts`, `index.ts`, `catalog.ts`, tests.
Gate green.

## WP2 — Custom details panel + preview + i18n

- `NodeConfigPanel.tsx`: add `node.type === 'memory.maintain' && <MemoryMaintainPanel/>` (AssemblePreview
  precedent).
- `MemoryMaintainPanel.tsx`: resolve active chat's template (`chat-table-template-get` →
  `table-template-get`); header "editing template: <name>" + per-chat-binding caveat; one collapsible
  section per table with editable `note/initNode/insertNode/updateNode/deleteNode` (+ `updateFrequency`),
  debounced `table-template-update` writes; empty states for no-chat / no-template.
- Preview: new read IPC `memory-maintain-preview(profileId, chatId, nodeConfig)` → main composes exactly
  as the node does (reusing the same helpers) and returns the composed prompt string; panel renders it
  like `AssemblePreview`.
- `detailsPanelModel.ts`: add `{{tables}}` to `PROMPT_PLACEHOLDERS`.
- i18n: all new UI strings in `en.ts` + `zh.ts` (使用 ST 术语). Per-table prompt CONTENT stays as
  authored (not localized).

Tests: pure model bits (template resolution, patch payload shaping) unit-tested; preview IPC handler
unit; a light renderer test if the panel has non-trivial logic. **Files:** `NodeConfigPanel.tsx`,
`MemoryMaintainPanel.tsx`, `tableMemoryIpc.ts` (+ preload/api types), `detailsPanelModel.ts`, locale
files, tests. Gate green.

## WP3 — Seeded default doc v2 + auto-replace migration

- `defaultMemoryTemplate.ts`: `buildDefaultMemoryDocV2()` + `export const DEFAULT_MEMORY_SEED_MARKER_V2 =
  'default-memory-v2'`. Same graph as v1 minus `{history,read,agent,sql,tableapply,log-apply}` → one
  `memory.maintain` node gated by `mode.fired`, `memory.maintain.error → util.log`. Group `exposed`:
  Mode/Cadence/Backlog + `memory.maintain.api_preset_id`. Keep v1 builder for the characterization test
  history but stop seeding it.
- `workflowService.ts` `seedDefaultMemoryWorkflow` → supersede logic:
  1. If `seededTombstones` includes v2 marker → return.
  2. Scan docs: v2 marker present → return; **v1 marker present → SUPERSEDE** (seed v2 first; if the v1
     doc was the global selection, repoint global to the new v2 id; then unlink the v1 file + push v1
     marker to `seededTombstones`); a non-marked doc using `MEMORY_NODE_TYPES` → return (own setup).
  3. If v1 marker tombstoned (deleted) and no live doc → return (respect deletion — no resurrection).
  4. Else seed v2 fresh; select globally only when nothing selected.
- Add `'memory.maintain'` to `MEMORY_NODE_TYPES` (so a v2/own doc counts as opted-in).
- Crash-safety: seed v2 BEFORE unlink+tombstone v1, so no window with zero default doc.

Tests: fresh profile seeds v2; a profile with a live v1 doc supersedes → exactly one default doc, v2
marker, v1 tombstoned, global repointed; v1-tombstoned profile is NOT resurrected; v2-tombstoned blocks
reseed; idempotent across `resetMemorySeedGuardForTest`. Update `defaultMemoryTemplate.test.ts`
deliberately (v2 turn-run trace-equivalent to `DEFAULT_GRAPH` with mode off). **Files:**
`defaultMemoryTemplate.ts`, `workflowService.ts`, tests. Gate green.

## WP4 — SDK docs + example flow

- `docs/sdk/`: add `memory.maintain` to the node catalog / `workflow-module-format` (it is card-facing —
  `docs/sdk/README.md` mapping). Note the `{{tables}}`/`{{input}}` placeholder + template-file edit model.
- `docs/workflows/`: a `memory-maintain.rptflow` example (trigger → control.mode → memory.maintain) for
  reference/import parity with the seeded v2.
- Update `docs/rpt-api.md` if the node surface is listed there.

Tests: none new (docs); ensure any `.rptflow` fixture loaded by a test parses. Gate green.

## Sequencing & risk

WP0 → WP1 are the spine (node works headless, gate green, PR-able). WP2 (panel) and WP4 (docs) are
independent follow-ons. WP3 (migration) is the riskiest (destructive supersession) — land it last, with
the crash-safe ordering and the full tombstone matrix tested. Owner manual pass after WP1 (node runs)
and again after WP2/WP3 (panel + default doc). Nothing pushed until owner sign-off (branch is local-only).
