# Variables view v2 — vanilla-jsoneditor — Design

Status: **Design approved (2026-07-01).** Replace the hard-to-use custom tree editor (an always-on wall of
inputs) in the Variables view with a React wrapper around the open-source **`vanilla-jsoneditor`** library —
the same component JSR's *current* variable manager uses (the custom card-tree was JSR's own **deprecated**
approach). Owner referenced JSR's viewer for the UX; on inspection that UX is a permissive third-party
library, not TavernHelper's code, so using it directly is the cleanest path and is compatible with the
project's licensing stance.

Supersedes the interaction model of
[2026-06-30-editable-variables-view-design.md](2026-06-30-editable-variables-view-design.md) (the read-only
inspector + the persistence wiring stay; the editor UI is swapped).

---

## 0. Locked decisions (owner Q&A, 2026-07-01)

1. **Use `vanilla-jsoneditor` directly** (not a hand-rolled clean-room editor). It gives the exact reference
   UX — readable tree by default, click-to-edit, context-menu insert/duplicate/remove, tree⇄text toggle,
   search, undo/redo — for minimal code.
2. **Tabbed layout** (mirrors JSR's own variable manager): one editor visible at a time across
   `[ MVU stat_data · Session KV · Floor vars ]`, replacing the three always-open stacked editors.
3. **Whole-object persistence** (the library emits the whole document): stat_data via a new
   `setFloorStatData` main IPC; session KV via the existing `chatCardVarsSet`. Debounced.
4. **Document the dependency + license** (owner ask): attribution + the ISC notice retained in-repo.

---

## 1. The dependency + licensing (documented per owner ask)

- **Package:** `vanilla-jsoneditor` **v3.12.0**.
- **License:** **ISC** (verified from the npm registry metadata, 2026-07-01). ISC is a permissive,
  MIT-equivalent license: free to use, modify, and redistribute, **provided the copyright notice and the
  permission notice are retained**.
- **Author / source:** Jos de Jong — https://github.com/josdejong/svelte-jsoneditor (the `vanilla-jsoneditor`
  build of `svelte-jsoneditor`).
- **Why this is licensing-clean:** the project's hard constraint (CLAUDE.md) is *"never copy or vendor
  js-slash-runner / TavernHelper (AFPL, non-free)."* `vanilla-jsoneditor` is an **independent** ISC library
  that JSR merely depends on — using it is **not** reusing TavernHelper's code, and ISC imposes no copyleft.
- **Compliance actions (in the plan):**
  - the npm dependency carries its own `LICENSE` in `node_modules/vanilla-jsoneditor/` (npm-standard);
  - add a repo `THIRD-PARTY-NOTICES.md` (create if absent) with an entry: package, version, ISC, author,
    source URL, and the retained ISC copyright + permission text;
  - note the dependency in the SDK/docs where third-party runtime libs are listed (e.g.
    `docs/compat-comparison.md` / a deps note), stating it is ISC and distinct from the AFPL JSR code.

## 2. Grounding — how JSR wraps it (observed, for parity, not copied)

`JS-Slash-Runner/src/panel/component/JsonEditor.vue` (Vue) calls `createJSONEditor({ target, props: {
content: { json }, mode: Mode.tree, parser, validator, onChange } })`, keeps a `prevent_updating_content`
guard so external `content` updates don't feed back as edits, debounces `onChange` (~300ms), and on change
reads `updated.json` (tree mode) or parses `updated.text` (text mode) back into the model. We reimplement the
**same wrapper pattern in React** (createJSONEditor is framework-agnostic vanilla JS). We do **not** copy the
Vue file; we write our own React effect around the public `createJSONEditor` API.

RPT-side write paths that stay: `chatCardVarsSet` (preload) for session KV; `chatStore.floors` as the
stat_data source ([StatusView/VariablesView] read `floors[last].variables.stat_data`).

## 3. Component: `JsonEditor` (new React wrapper)

`src/renderer/src/components/workspace/JsonEditor.tsx`:

```ts
interface JsonEditorProps {
  value: unknown                       // the JSON to show
  onChange?: (json: unknown) => void   // fired (debounced) with the whole updated doc; omit for read-only
  readOnly?: boolean
}
```

- **Mount:** `createJSONEditor({ target: ref, props: { content: { json: value }, mode: 'tree', readOnly,
  onChange: debounced } })`. The `onChange` reads the updated content's `json` (and, in text mode, parses
  `text` — invalid JSON is ignored, no persist) and calls `props.onChange(json)`.
- **External updates:** a `React.useEffect` on `value` calls `editor.update({ json: value })` **guarded** by
  an `isApplyingExternal` ref so the resulting `onChange` doesn't loop back as a persist (mirrors JSR's
  `prevent_updating_content`).
- **Unmount:** `editor.destroy()`; cancel the debounce; an `isUnmounted` guard.
- **Styling / theme:** import the library CSS once; apply the library's `jse-theme-dark` class on the editor
  container when the active RPT theme is dark/carbon, and map the library's `--jse-*` CSS variables to
  `--rpt-*` tokens in `index.css` so it reads correctly (WCAG-AA) across dark/carbon/light.
- **Boundary:** renderer-only; imports the library + i18n; no main import.

## 4. VariablesView → tabs

`VariablesView.tsx` becomes: a header (title + Refresh) + a **tab bar** `[ stat_data · Session KV · Floor
vars ]` + one `JsonEditor` for the active tab.

| Tab | value | editable? | persist |
| --- | --- | --- | --- |
| MVU stat_data | `floors[last].variables.stat_data` | yes (when a floor exists) | `onChange` → `setFloorStatData` |
| Session KV | `chatCardVarsGet` result (local state) | yes | `onChange` → `chatCardVarsSet` |
| Floor vars | `floors[last].variables` | **read-only** | — |

- No-floor / no-active-chat states show a hint (reuse `status.waiting` / `variables.readOnlyHint`).
- The per-section copy button is redundant (the editor has its own menu) — drop it; keep the top-level
  Refresh (reloads session KV; stat_data is reactive via the store).
- The three-collapsible-`<details>` `Section` structure and its `alwaysRender` flag are **removed** (tabs
  replace them).

## 5. Persistence

- **stat_data** — new pure-ish main function + IPC:
  `setFloorStatData(profileId, chatId, floor, statData): FloorFile | null` in `generationService` — loads the
  floor, sets `f.variables = { ...f.variables, stat_data: statData, delta_data: [] }`, `saveFloor`, returns
  it. IPC `variables-set-stat-data` + preload `setFloorStatData`; a `chatStore.setStatData(profileId, json)`
  action targets the latest floor and folds the returned floor into `floors` (mirrors `applyVariableOps`'s
  fold). Whole-object replace is the right fit for a whole-doc editor and is symmetric with session KV; the
  manual-edit case doesn't need the AI-loop guards (`delta_data` reset to `[]`).
- **Session KV** — existing `window.api.chatCardVarsSet(profileId, chatId, json)` (+ optimistic local set,
  toast + refetch on failure, as today).
- Both are **debounced ~300ms** inside the `JsonEditor` wrapper so keystrokes don't hit the DB per character.

## 6. Cleanup

Remove the now-dead custom editor from the previous iteration: `JsonTreeEditor.tsx`, `jsonTreeEdit.ts`, and
`test/jsonTreeEdit.test.ts`. Update the `variables.*` i18n keys (drop the tree-editor-specific ones —
`keyName`/`addKey`/`addItem`/`delete`; keep `heading`/`refresh`/`empty`/`readOnlyHint`/`editFailed`; add tab
labels `variables.mvuState`/`sessionKv`/`floorVars` already exist).

## 7. Risks / boundaries / testing

- **CSP:** RPT has a renderer CSP (`test/rendererCsp.test.ts` + the app CSP). `vanilla-jsoneditor` ships
  normal bundled stylesheets and creates DOM via the standard API (no `eval`), so it should pass; the plan
  **verifies** the editor renders under the app CSP and adjusts `style-src`/`img-src` only if a concrete
  violation appears. No `unsafe-eval` is to be added.
- **Module boundaries (`check:deps`):** the wrapper + view are renderer-only; the new IPC is a normal
  `renderer → preload → main` path. Green.
- **Bundle size:** grows (the library is sizable) — acceptable for a debug view; it's tab-mounted (one
  instance), and text-mode editors load on demand within the library.
- **Testing:** `setFloorStatData` gets a unit test (sets stat_data on the floor + persists + returns it;
  no-op/guard-free). The wrapper + view are integration — covered by `typecheck + check:deps + build` and the
  existing suite staying green. i18n keys in both locales.
- **Non-goals:** Zod schema validation (JSR passes a schema; skip unless requested); scopes beyond the three
  tabs; migrating the granular `applyVariableOps` path (it stays for card-side/WCV callers — only the
  Variables view stops using it).

## 8. Related
- Superseded interaction model: `2026-06-30-editable-variables-view-design.md`.
- Observed reference (parity, not copied): `JS-Slash-Runner/src/panel/component/JsonEditor.vue`.
- Write paths: `chatCardVarsSet` (preload), the new `setFloorStatData` (generationService), `chatStore.floors`.
