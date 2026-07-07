# RF-01 — Wire the manual-trigger "Run now" path (IPC + preload + node-card button)

Status: ready-for-human
Priority: P0 (functional hole)

## Problem

`runManualDoc` (`src/main/services/headlessRunService.ts:882`) is the documented "run now" hook for
`trigger.manual` nodes — but it is exported and never called: no IPC handler, no preload binding,
no UI. A `trigger.manual` node can be placed, configured, and toggled, yet no user action can fire
it. Its live badge reports `met: false` forever by design (headlessRunService.ts:937), so the button
is the only intended fire path.

## Grounding (verified 2026-07-06)

- `runManualDoc(profileId, chatId, docId, triggerNodeId)` already implements ALL guards: doc must be
  the chat's resolved active doc; node must exist, be `trigger.manual`, and not disabled. Failures
  log and no-op — they never throw. It `await`s the headless run to completion.
- IPC precedent: `src/main/ipc/agentPackIpc.ts:102` (`'workflow-explain-doc-triggers'`) already
  imports from headlessRunService — add the new handler there.
- Preload precedent: `src/preload/index.ts:204` (`explainDocTriggers`) + matching type in
  `src/preload/index.d.ts:223`.
- The canvas already computes exactly the gate this button needs: `FlowCanvas.tsx:340-370` fetches
  `resolveWorkflowId` and only badges when the OPEN doc IS the chat's resolved doc.
- Run records with `origin: 'manual'` already render in the RunDrawer — `runs.origin.*` i18n keys
  exist (KEEP-ALIVE list, handoff 2026-07-04).
- Existing test files for this service: `test/headlessRunService.test.ts`,
  `test/headlessDocTriggers.test.ts`.

## Changes

### 1. IPC — `src/main/ipc/agentPackIpc.ts`

Add next to the `workflow-explain-doc-triggers` handler (import `runManualDoc` from
`../services/headlessRunService`):

```ts
// Fire ONE trigger.manual node's chain on explicit user action (RF-01). All validity guards
// (active doc, node kind, disabled) live in runManualDoc itself — they log + no-op, never throw.
ipcMain.handle(
  'workflow-run-manual-trigger',
  (_, profileId: string, chatId: string, docId: string, triggerNodeId: string) =>
    runManualDoc(profileId, chatId, docId, triggerNodeId)
)
```

### 2. Preload — `src/preload/index.ts` + `src/preload/index.d.ts`

```ts
runManualTrigger: (profileId: string, chatId: string, docId: string, triggerNodeId: string) =>
  ipcRenderer.invoke('workflow-run-manual-trigger', profileId, chatId, docId, triggerNodeId),
```

Type: `runManualTrigger: (profileId: string, chatId: string, docId: string, triggerNodeId: string) => Promise<void>`.
Place both adjacent to the existing `explainDocTriggers` entries.

### 3. Canvas — `src/renderer/src/components/workflow/FlowCanvas.tsx`

a. In the trigger-badge effect (lines 340-370), also record whether the gate passed: add local state
   `const [docIsActive, setDocIsActive] = React.useState(false)`; set `false` at effect start and on
   the early-returns, `true` after `resolvedId === currentId` passes.

b. New prop on `FlowCanvasProps`: `onManualRun?: () => void` (thread through `FlowCanvas` →
   `FlowCanvasInner`).

c. Handler in `FlowCanvasInner`:

```ts
const runManual = useCallback(
  async (nodeId: string): Promise<void> => {
    if (!activeChatId || !currentId) return
    await window.api.runManualTrigger(profileId, activeChatId, currentId, nodeId)
    onManualRun?.()
  },
  [profileId, activeChatId, currentId, onManualRun]
)
```

d. Extend `RptNodeData` with `manualRun?: { enabled: boolean; disabledReason: string | null; run: () => void }`.
   Populate it in the `rfNodes` memo ONLY for nodes with `editorNode.type === 'trigger.manual'`.
   `enabled` = `docIsActive && !dirty && !editorNode.disabled` (read `dirty` from the store).
   `disabledReason` (for the tooltip): `dirty` → `t('workflowEditor.runNowSaveFirst')`;
   `!docIsActive` → `t('workflowEditor.runNowInactiveDoc')`; node disabled → null (the switch
   already communicates that). NOTE: `t` is not available in the memo — pass raw reason CODES
   (`'saveFirst' | 'inactiveDoc' | null`) and translate inside `RptNode`.

e. In `RptNode`'s title row (after the trigger on/off switch, `FlowCanvas.tsx:114-129`): when
   `data.manualRun` exists, render a `▶` button, className `rpt-node-run-now`, with
   `e.stopPropagation()` in onClick (same idiom as the switch), `disabled={!manualRun.enabled}`,
   `title` = translated reason or `t('workflowEditor.runNow')`. While the returned promise is
   pending, disable the button (local `running` state) — no spinner needed.
   After completion, toast `t('workflowEditor.runNowDone')` via `useToastStore`.

f. CSS: add `.rpt-node-run-now` to `workflowEditor.css`, matching the trigger-switch scale
   (~16px tall, token colors: `var(--rpt-accent)` glyph, disabled → `var(--rpt-text-tertiary)`).

### 4. Editor view — `src/renderer/src/components/workflow/WorkflowEditorView.tsx`

Pass `onManualRun={() => setRefreshToken((n) => n + 1)}` to `<FlowCanvas>` (line ~513). The shared
token already refetches BOTH the RunDrawer and the trigger badges — the manual run then appears in
the drawer with the `manual` origin chip.

### 5. i18n — BOTH locale files

| key | en | zh |
|---|---|---|
| `workflowEditor.runNow` | `Run now` | `立即运行` |
| `workflowEditor.runNowDone` | `Manual run finished — see the run list` | `手动运行完成——请查看运行记录` |
| `workflowEditor.runNowSaveFirst` | `Save the workflow before running` | `请先保存工作流再运行` |
| `workflowEditor.runNowInactiveDoc` | `This doc is not the active workflow for the open chat` | `此文档不是当前会话激活的工作流` |

## Tests (named)

Extend `test/headlessRunService.test.ts` (or a new `test/workflow/runManualDoc.test.ts` if that
file's harness doesn't accommodate — stop and report which):

1. `runManualDoc` no-ops (and appends NO run record) when `docId` ≠ the chat's resolved active doc.
2. No-ops when the node id is not a `trigger.manual` node.
3. No-ops when the trigger node is `disabled: true`.
4. Happy path: runs the trigger's forward closure and appends a run record with
   `origin: 'manual'`, `trigger: 'manual'`.

(1–4 pin the service behavior the button now depends on; they may partially exist — extend, don't
duplicate.)

## User journey (PR description, for the owner pass)

Open a chat whose active workflow contains a `trigger.manual` chain → open the workflow editor →
the manual trigger node shows ▶ → click → chain runs headlessly → RunDrawer shows a new `manual`
run → replay paints it on the canvas. Verify ▶ is disabled with the right tooltip when (a) the doc
is dirty, (b) a different doc is open than the chat's active one.

## NON-GOALS

- No "run any trigger now" (state/cadence stay evaluator-fired only — ADR 0004).
- No streaming/progress UI for the headless run; completion toast only.
- No RunDrawer changes beyond the existing refresh token.

## Size budget

≤ 220 lines diff across the 6 files (excl. tests). If you exceed it, stop and report why.

## Comments

Done 2026-07-06 (opus-4.8/medium). All 6 change sections implemented as specced; 132 src lines added
(well under the ≤220 budget).

- IPC handler `workflow-run-manual-trigger` + `runManualDoc` import in `agentPackIpc.ts`.
- Preload `runManualTrigger` binding (`index.ts`) + `Promise<void>` type (`index.d.ts`).
- `FlowCanvas.tsx`: `docIsActive` state set in the trigger-badge effect; `onManualRun` prop threaded
  through; `runManual` handler (toasts `runNowDone`, calls `onManualRun`); `RptNodeData.manualRun`
  with raw reason CODES (`'saveFirst' | 'inactiveDoc' | null`); ▶ button in `RptNode` translating the
  code inside (where `t` is available), with local `running` guard.
- `WorkflowEditorView.tsx`: `onManualRun={() => setRefreshToken((n) => n + 1)}`.
- `.rpt-node-run-now` CSS (16px, token colors, disabled → `--rpt-text-tertiary`).
- 4 i18n keys in both `en.ts` + `zh.ts`.

**Deviation (test file):** the spec named `test/headlessRunService.test.ts`, but that harness mocks the
PACK path and does NOT mock `workflowService.resolveWorkflowDoc`, which `runManualDoc` requires. The
correct harness is `test/headlessDocTriggers.test.ts` (it mocks `resolveWorkflowDoc`), where cases 2
(non-manual no-op) and 4 (happy path: origin/trigger `manual`, packIds []) ALREADY existed. Per the
spec's own "extend, don't duplicate" instruction, I added the two missing named cases there:
`runManualDoc no-ops (and appends NO run record) when docId is not the chat active doc` and
`runManualDoc on a disabled manual trigger is a logged no-op`. No new test file created.

Gate: `npm run typecheck` ✓, `npm run check:deps` ✓ (388 modules, no violations),
`npm run test` ✓ (215 files / 2025 tests pass).
