# RF-03 — Workflow editor safety: undo/redo, Ctrl+S, Esc guard

Status: ready-for-human
Priority: P1 (data-loss adjacent)

## Problem

Three related gaps in the one-canvas editor, all "don't lose my graph":

1. **No undo/redo** anywhere in `workflowEditorStore.ts` — while Delete/Backspace node deletion IS
   wired (`FlowCanvas.tsx:611`). One stray keypress on a selected node is unrecoverable.
2. **No Ctrl+S** — Save is only a small top-bar button; the `dirty` chip is the only guard.
3. **Esc closes the overlay from anywhere** (`WorkflowEditorOverlay.tsx:32-39` listens on `window`
   unconditionally) — pressing Esc while focused in a config textarea slams the editor shut.
   (Store state survives close/reopen — `init` only refreshes `nodeTypes`/`workflows`, and the
   auto-open effect is gated on `!currentId` — but the user cannot know that.)

## Grounding (verified 2026-07-06)

- Store: `src/renderer/src/stores/workflowEditorStore.ts` (618 lines). Mutating actions (interface
  lines 93-141): `addNode`, `moveNode`, `connect`, `removeEdge`, `removeNode`, `setNodeConfig`,
  `setNodeDisabled`, `setNodePanel`, `setMainOutput`, `setDocName`, `groupSelection`, `ungroup`,
  `renameGroup`, `toggleGroupCollapsed`, `moveGroup`, `exposeSetting`, `unexposeSetting`,
  `insertModule`. **Read the store first** — the exact `set()` shapes matter for the snapshot.
- Editable state = `{ nodes, edges, doc }` (groups + name live on `doc`; `editorToDoc` reconstructs
  on save). Snapshots of those three references are cheap (structural sharing).
- `moveNode` fires on EVERY mid-drag position change (FlowCanvas.tsx:502-505 comment) and
  `setNodeConfig` fires per keystroke (NodeConfigPanel writes the full config each edit) — both
  need coalescing.
- React Flow position changes carry `dragging?: boolean` — usable for drag-start detection.
- Save path: `WorkflowEditorView.tsx:177-180` `onSave` (save + bump refreshToken).
- Esc handler + 48px header: `WorkflowEditorOverlay.tsx:32-39` and 58-79.

## Changes

### 1. History in `workflowEditorStore.ts`

Add to the store (hand-rolled, no new dependency):

```ts
interface HistEntry { nodes: EditorNode[]; edges: EditorEdge[]; doc: WorkflowDoc | null }
// state additions:
past: HistEntry[]        // capped at 50, oldest dropped
future: HistEntry[]
lastHistKey: string | null   // coalescing key of the most recent push
```

Internal helper (not on the public interface):

```ts
/** Push the CURRENT {nodes,edges,doc} onto `past` before a mutation. A repeated non-null `key`
 *  coalesces (skip the push) so per-keystroke/per-drag-tick mutations form ONE undo step. Any
 *  push clears `future`. */
pushHistory(key?: string): void
```

Rules:
- `pushHistory(key)`: if `key != null && key === lastHistKey` → do nothing. Else push snapshot,
  set `lastHistKey = key ?? null`, truncate `past` to 50, clear `future`.
- Public actions `undo()` / `redo()`: swap current state with `past`/`future` tops; on restore set
  `dirty: true`, `lastHistKey: null`, clear `selectedNodeId/selectedNodeIds/selectedGroupId` if the
  selected ids no longer exist; recompute `errors` **only if the existing mutating actions do**
  (match current behavior — read the store; if mutations don't live-validate, don't add it).
- Public selectors: `canUndo` / `canRedo` derived (`past.length > 0` / `future.length > 0`) — plain
  computed reads are fine.
- Instrument the mutating actions:
  - `pushHistory()` (no key): `addNode`, `connect`, `removeEdge`, `removeNode`, `setNodeDisabled`,
    `setNodePanel`, `setMainOutput`, `groupSelection`, `ungroup`, `toggleGroupCollapsed`,
    `exposeSetting`, `unexposeSetting`, `insertModule`.
  - `pushHistory('cfg:' + id)`: `setNodeConfig`.
  - `pushHistory('name')`: `setDocName`. `pushHistory('grpname:' + groupId)`: `renameGroup`.
  - `moveNode` / `moveGroup`: **no push** (see drag hooks below).
- Two small public actions for the canvas: `snapshotForDrag(): void` → `pushHistory('drag')`;
  `endDrag(): void` → `set({ lastHistKey: null })` (so two separate drags are two undo steps).
- Reset history (`past: [], future: [], lastHistKey: null`) in `open`, `openFragment`. NOT in
  `save` (undoing past a save is allowed; `dirty` goes true again).

### 2. Drag hooks in `FlowCanvas.tsx`

In `handleNodesChange` (lines 483-518): keep a `React.useRef(new Set<string>())` of ids currently
dragging. For each position change: if `change.dragging === true` and the id is not in the set →
add it and call `snapshotForDrag()` once; if `change.dragging` is false/undefined → remove the id,
and when the set becomes empty call `endDrag()`. Module drags flow through the same handler
(`moduleIds` branch) — apply the same rising-edge logic there so a module drag is one undo step.

### 3. Keyboard — `WorkflowEditorView.tsx`

Add a `useEffect` window keydown listener (the view only exists while the overlay is open):

```ts
const inEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
```

- `Ctrl/Cmd+S` → `preventDefault()`; if `!readOnly && dirty` → `void onSave()`. Always swallow.
- `Ctrl/Cmd+Z` (no shift) when `!inEditable(e.target)` → `undo()`.
- `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` when `!inEditable(e.target)` → `redo()`.

Add two top-bar buttons next to Save (visible when `sessionType !== 'fragment'` too — history is
session-agnostic): `↶` / `↷`, `disabled` off `canUndo`/`canRedo`, titles
`t('workflowEditor.undo')` + ` (Ctrl+Z)` / `t('workflowEditor.redo')` + ` (Ctrl+Shift+Z)`.

### 4. Esc guard — `WorkflowEditorOverlay.tsx`

Replace the unconditional Esc close (lines 32-39):

- If `inEditable(e.target)` → `(e.target as HTMLElement).blur()` and return (don't close).
- Else if the store is `dirty` → `useToastStore.push(t('workflowEditor.escUnsaved'))`, don't close.
- Else → `close()` as today. The ✕ Close button stays unconditional (state survives anyway).

### 5. i18n — BOTH locale files

| key | en | zh |
|---|---|---|
| `workflowEditor.undo` | `Undo` | `撤销` |
| `workflowEditor.redo` | `Redo` | `重做` |
| `workflowEditor.escUnsaved` | `Unsaved changes — save (Ctrl+S) or use the Close button` | `有未保存的更改——请先保存（Ctrl+S），或点击关闭按钮退出` |

## Tests (named) — `test/workflow/editorHistory.test.ts`

Seed the store directly (`useWorkflowEditorStore.setState`) with a minimal doc/nodes/edges/nodeTypes;
the mutating actions don't touch `window.api` (verify while grounding; if any does, stop and report).

1. `addNode` → `undo()` restores the previous node count; `redo()` reapplies.
2. Consecutive `setNodeConfig` on the SAME node = ONE undo step; on two different nodes = two.
3. `removeNode` on a wired node → `undo()` restores the node AND its edges.
4. `snapshotForDrag()`+`moveNode`×N+`endDrag()` twice = two undo steps.
5. A new edit after `undo()` clears `future` (`canRedo` false).
6. History caps at 50 entries; `open()` resets it.

## User journey (PR description, for the owner pass)

Open editor → drag a node → Ctrl+Z returns it → delete a wired node → Ctrl+Z restores node+edges →
type in a config field, press Esc: field blurs, editor stays open → with unsaved changes press Esc
on the canvas: toast, editor stays open → Ctrl+S saves (chip clears) → Esc now closes.

## NON-GOALS

- No unsaved-changes confirm DIALOG (RF-06's ConfirmDialog is not a dependency; the toast is the
  chosen guard here).
- No history persistence across editor open/close or app restarts.
- No zundo/temporal middleware dependency.

## Size budget

≤ 300 lines diff across store + 3 components (excl. tests).

## Comments

**Completed 2026-07-06** (branch `claude/nifty-mcclintock-6e6a1b`).

All 5 change sections implemented exactly as specced:

1. **History in `workflowEditorStore.ts`** — `HistEntry` + `HISTORY_CAP=50`; `past`/`future`/
   `lastHistKey` state; internal `pushHistory(key?)` (coalesce on repeated non-null key, clear
   `future`, truncate to 50); public `undo`/`redo` (swap with stack top, set `dirty` via
   `restoreValidate()` → `revalidate()`, clear `lastHistKey`, prune vanished selections via
   `pruneSelection()`); public `snapshotForDrag`/`endDrag`. Instrumented every mutating action per
   the spec's key table (`pushHistory()` keyless / `'cfg:'+id` / `'name'` / `'grpname:'+id`;
   `moveNode`/`moveGroup` NOT pushed). Pushes placed AFTER each action's no-op early-returns
   (`connect` verdict, `insertModule` empty, `groupSelection` guards) so a rejected op leaves no
   phantom undo step. History reset in `open`/`openFragment`, NOT in `save`.
   - **Grounding confirmed vs spec:** mutating actions never touch `window.api` (only
     init/open/openFragment/save/cloneAndEdit do); mutations DO live-validate (`revalidate` sets
     `errors`+`dirty`), so undo/redo recompute `errors` to match — as the spec directed.
2. **Drag hooks in `FlowCanvas.tsx`** — `draggingIds` ref; rising-edge in `handleNodesChange`
   (snapshot on first `dragging===true` per id, `endDrag()` when the set drains), covering both node
   and module drags via the shared handler; frame ids excluded.
3. **Keyboard + buttons in `WorkflowEditorView.tsx`** — `inEditable` helper; window keydown effect
   (Ctrl/Cmd+S always-swallow + save-if-dirty; Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo,
   both guarded by `!inEditable`). ↶/↷ top-bar buttons next to Save, disabled off `past`/`future`
   depth, shown in both session kinds.
4. **Esc guard in `WorkflowEditorOverlay.tsx`** — blur-in-field / toast-when-dirty / close-when-clean;
   ✕ button stays unconditional.
5. **i18n** — `workflowEditor.undo|redo|escUnsaved` added to BOTH `en.ts` and `zh.ts`.

Tests: `test/workflow/editorHistory.test.ts`, all 6 named cases pass.

**Gate (all green):** `npm run typecheck` ✔ · `npm run check:deps` ✔ (no violations, 388 modules) ·
`npm run test` ✔ (216 files / 2031 tests).

Diff well under the ≤300-line budget. NON-GOALS respected (no confirm dialog, no persistence, no
zundo). Owner manual pass: walk the User-journey section above.
