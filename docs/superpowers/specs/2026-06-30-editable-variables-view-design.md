# Editable Variables view — Design

Status: **Design approved (2026-06-30).** Turn the read-only Variables view
([VariablesView.tsx](../../../src/renderer/src/components/workspace/VariablesView.tsx), added this session)
into an **interactive JSON tree editor**: collapsible objects/arrays with per-node **insert / modify /
delete** on nested lists, objects, and values. Two editable layers — the active chat's **MVU `stat_data`**
(persisted via the existing `applyVariableOps`) and the **per-chat session KV** (persisted via
`chatCardVarsSet`) — with edits persisted **immediately per edit**.

---

## 0. Locked decisions (owner Q&A, 2026-06-30)

1. **Editable layers: `stat_data` + session KV.** The derived floor-variables blob stays **read-only**
   (it's a snapshot containing stat_data/delta/cue — editing it is redundant and can desync).
2. **Persist immediately per edit** — each insert/modify/delete applies and saves right away. No staged
   Save/Revert.
3. **Approach: a small custom recursive tree editor** — no new dependency (`react-json-view`/`jsoneditor`
   rejected: dependency weight + Electron CSP/theming friction), and not a raw-JSON textarea (rejected: no
   per-item collapse/insert/delete). Full control over `--rpt-*` tokens + i18n, and the edit logic is a pure,
   unit-testable helper.

---

## 1. Grounding (verified this session)

- **`applyVariableOps(profileId, chatId, floor, ops: JsonPatchOp[]): FloorFile | null`**
  ([generationService.ts:521](../../../src/main/services/generationService.ts)) applies RFC-6902 ops to that
  floor's `stat_data` via `applyJsonPatch`, drops no-ops, guards runaway loops, `saveFloor`s, and returns the
  updated floor. Op vocabulary that matters: `replace` (modify a value), `add` (insert an object key **or**
  append to an array via the `/-` token), `remove` (delete a key/array item). Exposed as
  `window.api.applyVariableOps` (preload) and already called by `chatStore.applyVariableOps`.
- **`window.api.chatCardVarsSet(profileId, chatId, vars)`** (preload:349) writes the **whole** per-chat card
  KV object; **`chatCardVarsGet`** reads it (already used by VariablesView's "Session KV" section).
- **`shared/objectPath`** exports `clone` — usable renderer-side for immutable copies.
- VariablesView already renders three sections (MVU stat_data / floor variables / session KV) from
  `chatStore.floors[last].variables` + `chatCardVarsGet`, refetched on chat change.

## 2. Component: `JsonTreeEditor` (new)

`src/renderer/src/components/workspace/JsonTreeEditor.tsx` — a **controlled**, recursive tree over one JSON
value.

**Props**
```ts
interface JsonTreeEditorProps {
  value: unknown
  onEdit: (next: unknown, op: JsonPatchOp) => void   // fired once per atomic edit
  readOnly?: boolean                                  // renders the tree with no edit affordances
}
// Local structural type (renderer owns it; IPC passes it as-is):
type JsonPatchOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }
```

**Rendering**
- Each node shows its key (or array index) and value.
- **Objects/arrays** render a ▸/▾ **collapse** toggle + a child count; collapsed by default below a depth
  threshold is out of scope — default expanded, user collapses.
- **Scalars** (string / number / boolean / null) render an inline editor with a small **type selector** so a
  value's type can change on modify.

**Edit affordances (when not `readOnly`)**
- *scalar*: edit in place → `replace`.
- *object*: **+ key** (prompt name + pick an initial value: scalar / `{}` / `[]`) → `add /…/<key>`;
  **✕** on a child → `remove`.
- *array*: **+ item** (append, pick initial value) → `add /…/-`; **✕** on an item → `remove`.

**The one pure helper (unit-tested):**
```ts
// Given the current root value, the JSON-Pointer segments to the edit site, an action, and a payload,
// return the immutably-updated root AND the JSON-Patch op describing the change.
applyEdit(root, segments, action: 'replace' | 'insertKey' | 'appendItem' | 'delete', payload?):
  { next: unknown; op: JsonPatchOp }
```
- Builds the JSON Pointer from `segments` with correct `~0`/`~1` escaping.
- `insertKey` → `{ op:'add', path:'/…/<key>' }`; `appendItem` → `{ op:'add', path:'/…/-' }`;
  `replace`/`delete` → `replace`/`remove` at the pointer.
- `next` is produced by an immutable update (via `clone` + local mutation) so React re-renders.

Both consumers get everything from `onEdit(next, op)` — **no renderer-side JSON-Patch *applier* is needed**
(stat_data uses `op`; session KV uses `next`), which avoids duplicating `applyJsonPatch`.

## 3. Wiring in `VariablesView`

- **MVU stat_data** → `<JsonTreeEditor value={statData} onEdit={onStatEdit} />`:
  ```
  onStatEdit(_next, op) → window.api.applyVariableOps(profileId, chatId, latestFloor, [op])
    → returns updated FloorFile → push into chatStore.floors (replace last).
  ```
  `latestFloor = floors[floors.length-1].floor`. If there are no floors, the stat_data editor renders
  `readOnly` with a hint (nothing to write to); session KV stays editable.
- **Session KV** → `<JsonTreeEditor value={cardKv} onEdit={onKvEdit} />`:
  ```
  onKvEdit(next) → setCardKv(next as Record); window.api.chatCardVarsSet(profileId, chatId, next).
  ```
- **Floor variables** section → `<JsonTreeEditor value={latest} readOnly />` (or the current `<pre>`) — stays
  read-only.
- A failed persist surfaces a toast (`useToastStore`) and the section refetches to the last-good value; no
  silent divergence.

## 4. Boundaries, testing, non-goals

- **Renderer-only.** Reuses the existing `applyVariableOps` + `chatCardVarsSet` IPCs (no main change) and
  `shared/objectPath.clone`. `npm run check:deps` stays clean (no renderer→main-internal import; `JsonPatchOp`
  is a local structural type, passed over IPC as data).
- **Tests** (vitest) on the pure `applyEdit` helper: `replace` a scalar; `insertKey` into an object;
  `appendItem` to an array (asserts `/-`); `delete` a key and an array index; pointer escaping (`~0`/`~1`);
  and that `next` reflects the change without mutating the input. Component interaction is covered by
  `typecheck` + `build`.
- **i18n:** every new label (`+ key`, `+ item`, delete tooltip, type names, empty/hint) via `t()` in both
  `en.ts` + `zh.ts`.
- **Non-goals:** editing the derived floor-vars blob (read-only); undo/history; schema/type validation of
  edited values beyond the type selector; bulk import/export (copy buttons already exist); reordering
  object keys / array items.

## 5. Related
- The read-only view being extended: `VariablesView.tsx` (this session).
- Write paths: `applyVariableOps` (`generationService.ts:521`), `chatCardVarsSet` (preload), `applyJsonPatch`
  (`mvuParser.ts`, main-side applier the stat_data path relies on).
