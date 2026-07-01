# Variables View v2 (vanilla-jsoneditor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom always-on tree editor in the Variables view with a React wrapper around `vanilla-jsoneditor` (ISC), in a tabbed layout, persisting whole-object edits.

**Architecture:** A thin React `JsonEditor` wraps `vanilla-jsoneditor`'s framework-agnostic `createJSONEditor` (tree mode, debounced onChange, guarded external updates), themed by mapping `--jse-*` CSS vars to `--rpt-*` tokens. `VariablesView` becomes tabs `[stat_data · Session KV · Floor vars]`; stat_data persists via a new `setFloorStatData` main IPC, session KV via the existing `chatCardVarsSet`. The previous custom editor is deleted.

**Tech Stack:** React 19, Zustand, `vanilla-jsoneditor@3.12.0` (ISC), TypeScript, Vitest, Electron IPC.

## Global Constraints

- Verification gate (before declaring a task done): `npm run typecheck && npm run check:deps && npm run test`. Tasks 1 and 3 also run `npm run build` (renderer + new dependency).
- **Dependency + license (documented):** add `vanilla-jsoneditor@3.12.0` — **ISC** license, by Jos de Jong (https://github.com/josdejong/svelte-jsoneditor). Retain its notice: add a repo `THIRD-PARTY-NOTICES.md` entry (Task 1). This ISC library is independent of and distinct from the AFPL js-slash-runner code the project forbids — using it is licensing-clean.
- **No new CSP relaxation.** The app CSP (`src/renderer/index.html`) already allows `style-src 'self' 'unsafe-inline' https:`, which covers the library's injected styles. Do NOT add `'unsafe-eval'` or weaken the CSP.
- **Module boundaries (`check:deps`):** the wrapper + view are renderer-only; the new stat_data write is a normal `renderer → preload → main` IPC. No renderer→main-internal import.
- **i18n:** any new user-facing string via `t()` in BOTH `en.ts` and `zh.ts`.
- **Whole-object persistence:** stat_data → `setFloorStatData`; session KV → `chatCardVarsSet`. Debounced ~300ms inside the wrapper.

**Verified facts (this session):**
- JSR wraps the lib as `createJSONEditor({ target, props: { content: { json }, mode, onChange } })`, updates via `editor.update(...)`/`updateProps(...)`, `editor.destroy()` on unmount, with a `prevent_updating_content` guard + debounce (`JS-Slash-Runner/src/panel/component/JsonEditor.vue`).
- `applyVariableOps` (`generationService.ts:521`) shows the floor read/write pattern: `getFloor(profileId, chatId, floor)` → mutate `f.variables` → `saveFloor(profileId, chatId, f)` → return the `FloorFile`. `getFloor`/`saveFloor`/`FloorFile` are already imported there.
- `chatStore.applyVariableOps` (`chatStore.ts:178`) folds a returned floor back: `set(s => ({ floors: s.floors.map(f => f.floor === target ? updated : f) }))`.
- `chatCardVarsSet`/`chatCardVarsGet` exist in preload (`preload/index.ts:347-350`). `apply-variable-ops` IPC handler is in `chatIpc.ts:25`.
- RPT theme tokens: `--rpt-bg-primary/-secondary/-tertiary/-elevated`, `--rpt-text-primary/-secondary/-tertiary`, `--rpt-border`, `--rpt-accent` (`assets/index.css`).

---

## File Structure

- **Create** `src/renderer/src/components/workspace/JsonEditor.tsx` — the React wrapper (one responsibility: mount/update/destroy the vanilla editor).
- **Create** `THIRD-PARTY-NOTICES.md` (repo root) — the ISC attribution.
- **Modify** `package.json` — add the dependency.
- **Modify** `src/renderer/src/assets/index.css` — `.rpt-json-editor` `--jse-*`→`--rpt-*` mapping.
- **Modify** `src/main/services/generationService.ts` — `withStatData` (pure) + `setFloorStatData`.
- **Modify** `src/main/ipc/chatIpc.ts`, `src/preload/index.ts`, `src/renderer/src/stores/chatStore.ts` — the stat_data write path.
- **Modify** `src/renderer/src/components/workspace/VariablesView.tsx` — tabbed rewrite.
- **Delete** `src/renderer/src/components/workspace/JsonTreeEditor.tsx`, `.../jsonTreeEdit.ts`, `test/jsonTreeEdit.test.ts`.
- **Modify** `src/renderer/src/i18n/locales/{en,zh}.ts` — drop the tree-editor-only keys.
- **Test** `test/floorStatData.test.ts` — the pure `withStatData`.

---

## Task 1: Add dependency + `JsonEditor` wrapper + license notice

**Files:**
- Modify: `package.json` (add `vanilla-jsoneditor`)
- Create: `src/renderer/src/components/workspace/JsonEditor.tsx`
- Modify: `src/renderer/src/assets/index.css` (append the `.rpt-json-editor` block)
- Create: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Produces: `JsonEditor: React.FC<{ value: unknown; onChange?: (json: unknown) => void; readOnly?: boolean }>`.

No new unit test (library integration); the gate is `typecheck + check:deps + build`.

- [ ] **Step 1: Install the dependency**

Run: `npm install --save-exact vanilla-jsoneditor@3.12.0`
Expected: `package.json` gains `"vanilla-jsoneditor": "3.12.0"` under dependencies; install succeeds. Confirm the license: `node -e "console.log(require('vanilla-jsoneditor/package.json').license)"` → prints `ISC`.

- [ ] **Step 2: Write the wrapper**

Create `src/renderer/src/components/workspace/JsonEditor.tsx`:

```tsx
// React wrapper around vanilla-jsoneditor (ISC, https://github.com/josdejong/svelte-jsoneditor).
// Tree mode, debounced whole-doc onChange, guarded external updates (mirrors JSR's Vue wrapper pattern;
// no code copied — this uses the public createJSONEditor API). Themed via --jse-*→--rpt-* in index.css.
import React from 'react'
import { createJSONEditor, Mode, type Content } from 'vanilla-jsoneditor'

const parseText = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined // invalid JSON mid-typing → don't persist
  }
}

export interface JsonEditorProps {
  value: unknown
  onChange?: (json: unknown) => void
  readOnly?: boolean
}

export const JsonEditor: React.FC<JsonEditorProps> = ({ value, onChange, readOnly }) => {
  const targetRef = React.useRef<HTMLDivElement>(null)
  const editorRef = React.useRef<ReturnType<typeof createJSONEditor> | null>(null)
  const applyingExternal = React.useRef(false)
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Create the editor once for this component instance.
  React.useEffect(() => {
    if (!targetRef.current) return
    const editor = createJSONEditor({
      target: targetRef.current,
      props: {
        content: { json: value },
        mode: Mode.tree,
        readOnly: !!readOnly,
        onChange: (updated: Content) => {
          if (applyingExternal.current) return
          const json = 'json' in updated ? updated.json : parseText((updated as { text?: string }).text)
          if (json === undefined) return
          if (debounceRef.current) clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(() => onChangeRef.current?.(json), 300)
        }
      }
    })
    editorRef.current = editor
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      editorRef.current = null
      void editor.destroy()
    }
    // Create-once: external value changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push external value changes into the editor, guarded so the resulting onChange doesn't echo back.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    applyingExternal.current = true
    void editor.update({ json: value })
    const id = setTimeout(() => {
      applyingExternal.current = false
    }, 0)
    return () => clearTimeout(id)
  }, [value])

  return <div ref={targetRef} className="rpt-json-editor" />
}
```

- [ ] **Step 3: Theme mapping**

Append to `src/renderer/src/assets/index.css`:

```css
/* vanilla-jsoneditor (Variables view) — map its CSS vars to RPT theme tokens so the editor follows the
   active theme (dark/carbon/light) with WCAG-AA contrast. See docs/superpowers/specs/2026-07-01-variables-view-jsoneditor-design.md */
.rpt-json-editor {
  height: 100%;
  --jse-theme-color: var(--rpt-bg-secondary);
  --jse-theme-color-highlight: var(--rpt-bg-tertiary);
  --jse-background-color: var(--rpt-bg-primary);
  --jse-panel-background: var(--rpt-bg-secondary);
  --jse-panel-color: var(--rpt-text-primary);
  --jse-text-color: var(--rpt-text-primary);
  --jse-text-color-inactive: var(--rpt-text-secondary);
  --jse-main-border: 1px solid var(--rpt-border);
  --jse-key-color: var(--rpt-text-secondary);
  --jse-value-color: var(--rpt-text-primary);
  --jse-value-color-string: var(--rpt-accent);
  --jse-value-color-number: var(--rpt-text-primary);
  --jse-value-color-boolean: var(--rpt-accent);
  --jse-value-color-null: var(--rpt-text-tertiary);
  --jse-delimiter-color: var(--rpt-text-tertiary);
  --jse-selection-background-color: var(--rpt-bg-tertiary);
  --jse-context-menu-background: var(--rpt-bg-elevated);
  --jse-context-menu-color: var(--rpt-text-primary);
  --jse-font-size: 12px;
}
```

- [ ] **Step 4: License notice**

Create `THIRD-PARTY-NOTICES.md`:

```markdown
# Third-Party Notices

This project bundles third-party open-source software. Their licenses are reproduced/attributed below.

## vanilla-jsoneditor

- Version: 3.12.0
- License: ISC
- Author: Jos de Jong
- Source: https://github.com/josdejong/svelte-jsoneditor

Used (unmodified, via npm) for the JSON editor in the Variables view. ISC is a permissive license; the
copyright and permission notice is retained here and in `node_modules/vanilla-jsoneditor/LICENSE.md`.

> ISC License — Copyright (c) Jos de Jong.
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is
> hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
> INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. …

(Note: this component is distinct from the AFPL-licensed js-slash-runner / TavernHelper, which this project
does NOT copy or vendor — see CLAUDE.md.)
```

After creating it, verify the reproduced ISC text matches the installed license: `cat node_modules/vanilla-jsoneditor/LICENSE.md` and reconcile any wording difference (use the installed text verbatim for the quoted block).

- [ ] **Step 5: Verify the gate + build**

Run: `npm run typecheck && npm run check:deps && npm run build`
Expected: all PASS (the wrapper compiles; the dependency resolves; no dep-cruiser violations). Note in your report: the app CSP (`src/renderer/index.html`) already allows `style-src 'unsafe-inline'`, so the library's injected styles need no CSP change.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/renderer/src/components/workspace/JsonEditor.tsx src/renderer/src/assets/index.css THIRD-PARTY-NOTICES.md
git commit -m "feat(vars): JsonEditor React wrapper around vanilla-jsoneditor (ISC) + notice"
```

---

## Task 2: `setFloorStatData` write path (main IPC + store action)

**Files:**
- Modify: `src/main/services/generationService.ts` (add `withStatData` + `setFloorStatData`)
- Modify: `src/main/ipc/chatIpc.ts` (handler)
- Modify: `src/preload/index.ts` (bridge)
- Modify: `src/renderer/src/stores/chatStore.ts` (`setStatData` action)
- Test: `test/floorStatData.test.ts`

**Interfaces:**
- Consumes: `getFloor`, `saveFloor`, `FloorFile` (already imported in generationService).
- Produces: `withStatData(floor: FloorFile, statData: unknown): FloorFile` (pure); `setFloorStatData(profileId, chatId, floor, statData): FloorFile | null`; `window.api.setFloorStatData(profileId, chatId, floor, statData)`; `chatStore.setStatData(profileId, json): Promise<void>`.

- [ ] **Step 1: Write the failing test (pure helper)**

Create `test/floorStatData.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withStatData } from '../src/main/services/generationService'

describe('withStatData', () => {
  it('replaces stat_data, resets delta_data, preserves other floor fields, does not mutate input', () => {
    const floor: any = {
      floor: 3,
      chat_id: 'c1',
      variables: { stat_data: { a: 1 }, delta_data: [{ path: '/a' }], other: true },
      response: { content: 'hi' }
    }
    const next = withStatData(floor, { b: 2 })
    expect(next.variables.stat_data).toEqual({ b: 2 })
    expect(next.variables.delta_data).toEqual([])
    expect(next.variables.other).toBe(true) // untouched sibling
    expect(next.response).toEqual({ content: 'hi' }) // untouched top-level field
    expect(next.floor).toBe(3)
    // input untouched
    expect(floor.variables.stat_data).toEqual({ a: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/floorStatData.test.ts`
Expected: FAIL — no export `withStatData`.

- [ ] **Step 3: Implement `withStatData` + `setFloorStatData`**

In `src/main/services/generationService.ts`, add just after `applyVariableOps` (near line 565):

```ts
/** Pure: return a copy of the floor with stat_data replaced and delta_data cleared (a manual whole-doc
 *  edit has no AI-turn delta). Other variables + floor fields are preserved. */
export const withStatData = (floor: FloorFile, statData: unknown): FloorFile => ({
  ...floor,
  variables: { ...floor.variables, stat_data: statData, delta_data: [] }
})

/** Replace a floor's stat_data wholesale (the Variables-view editor's write path) and persist. */
export const setFloorStatData = (
  profileId: string,
  chatId: string,
  floor: number,
  statData: unknown
): FloorFile | null => {
  const f = getFloor(profileId, chatId, floor)
  if (!f) return null
  const updated = withStatData(f, statData)
  saveFloor(profileId, chatId, updated)
  return updated
}
```

(If `FloorFile` / `getFloor` / `saveFloor` are not already imported in this file, add them from the same modules `applyVariableOps` uses — check the existing imports; do NOT add duplicates.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/floorStatData.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire IPC → preload → store**

In `src/main/ipc/chatIpc.ts`, after the `apply-variable-ops` handler (line ~25):

```ts
  ipcMain.handle('variables-set-stat-data', (_, profileId, chatId, floor, statData) =>
    generationService.setFloorStatData(profileId, chatId, floor, statData)
  )
```

In `src/preload/index.ts`, next to `applyVariableOps` (line ~34):

```ts
  setFloorStatData: (profileId: string, chatId: string, floor: number, statData: unknown) =>
    ipcRenderer.invoke('variables-set-stat-data', profileId, chatId, floor, statData),
```

In `src/renderer/src/stores/chatStore.ts`, add to the store interface (near `applyVariableOps`, line 58):

```ts
  setStatData: (profileId: string, json: unknown) => Promise<void>
```

and the implementation (after `applyVariableOps`, line ~185):

```ts
    setStatData: async (profileId, json) => {
      const { activeChatId, floors } = get()
      if (!activeChatId || floors.length === 0) return
      const target = floors[floors.length - 1].floor
      const updated = await window.api.setFloorStatData(profileId, activeChatId, target, json)
      if (updated) set((s) => ({ floors: s.floors.map((f) => (f.floor === target ? updated : f)) }))
    },
```

- [ ] **Step 6: Verify the gate**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: all PASS (new test + full suite).

- [ ] **Step 7: Commit**

```bash
git add src/main/services/generationService.ts src/main/ipc/chatIpc.ts src/preload/index.ts src/renderer/src/stores/chatStore.ts test/floorStatData.test.ts
git commit -m "feat(vars): setFloorStatData write path (whole-object stat_data persist)"
```

---

## Task 3: Tabbed `VariablesView` + remove the old editor

**Files:**
- Modify: `src/renderer/src/components/workspace/VariablesView.tsx` (rewrite)
- Delete: `src/renderer/src/components/workspace/JsonTreeEditor.tsx`, `.../jsonTreeEdit.ts`, `test/jsonTreeEdit.test.ts`
- Modify: `src/renderer/src/i18n/locales/en.ts`, `locales/zh.ts` (remove tree-editor-only keys)

**Interfaces:**
- Consumes: `JsonEditor` (Task 1); `chatStore.setStatData` (Task 2); `window.api.chatCardVarsSet`/`chatCardVarsGet`.

No new unit test (view wiring); gate is `typecheck + check:deps + test + build`.

- [ ] **Step 1: Delete the old custom editor**

```bash
git rm src/renderer/src/components/workspace/JsonTreeEditor.tsx src/renderer/src/components/workspace/jsonTreeEdit.ts test/jsonTreeEdit.test.ts
```

- [ ] **Step 2: Rewrite `VariablesView`**

Replace the entire contents of `src/renderer/src/components/workspace/VariablesView.tsx` with:

```tsx
import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { JsonEditor } from './JsonEditor'

/**
 * Variable inspector + editor for the active chat, tabbed by layer:
 *  - MVU stat_data (editable → whole-object persist via chatStore.setStatData),
 *  - Session KV / per-chat card KV (editable → chatCardVarsSet),
 *  - Floor variables (read-only; derived snapshot).
 * Uses vanilla-jsoneditor (ISC) via the JsonEditor wrapper. Chat-scoped; session KV refetched on chat change.
 */
const api = (): any => (window as unknown as { api: any }).api
type Tab = 'stat' | 'kv' | 'floor'

export const VariablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()
  const [tab, setTab] = React.useState<Tab>('stat')
  const [cardKv, setCardKv] = React.useState<Record<string, unknown> | null>(null)

  const loadKv = React.useCallback(async () => {
    if (!activeChatId) {
      setCardKv(null)
      return
    }
    try {
      setCardKv((await api().chatCardVarsGet(profileId, activeChatId)) ?? {})
    } catch {
      setCardKv({})
    }
  }, [profileId, activeChatId])

  React.useEffect(() => {
    void loadKv()
  }, [loadKv, floors.length])

  if (!activeChatId) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  const latest = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = (latest as Record<string, unknown> | undefined)?.stat_data ?? {}
  const hasFloor = floors.length > 0

  const onStatChange = (json: unknown): void => {
    void useChatStore
      .getState()
      .setStatData(profileId, json)
      .catch(() => useToastStore.getState().push(t('variables.editFailed')))
  }
  const onKvChange = (json: unknown): void => {
    setCardKv(json as Record<string, unknown>)
    void api()
      .chatCardVarsSet(profileId, activeChatId, json)
      .catch(() => {
        useToastStore.getState().push(t('variables.editFailed'))
        void loadKv()
      })
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'stat', label: t('variables.mvuState') },
    { id: 'kv', label: t('variables.sessionKv') },
    { id: 'floor', label: t('variables.floorVars') }
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 8,
          marginBottom: 8
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map((x) => (
            <button
              key={x.id}
              className={tab === x.id ? 'btn-accent' : 'rpt-duel-secondary'}
              style={{ fontSize: 12, padding: '3px 10px' }}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 8px' }}
          onClick={() => void loadKv()}
        >
          {t('variables.refresh')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'stat' &&
          (hasFloor ? (
            <JsonEditor value={statData} onChange={onStatChange} />
          ) : (
            <div style={{ opacity: 0.5, fontSize: 12 }}>
              <em>{t('variables.readOnlyHint')}</em>
            </div>
          ))}
        {tab === 'kv' && <JsonEditor value={cardKv ?? {}} onChange={onKvChange} />}
        {tab === 'floor' && <JsonEditor value={latest ?? {}} readOnly />}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Remove now-unused i18n keys (both locales)**

In `src/renderer/src/i18n/locales/en.ts` and `locales/zh.ts`, delete the tree-editor-only keys that no longer have a consumer: `variables.keyName`, `variables.addKey`, `variables.addItem`, `variables.delete`, `variables.copy`, `variables.copied`. Keep `variables.heading` (unused now but harmless — leave it), `variables.mvuState`, `variables.sessionKv`, `variables.floorVars`, `variables.refresh`, `variables.readOnlyHint`, `variables.editFailed`, `variables.empty`. (Grep the renderer for each key before deleting to confirm no other consumer: `git grep "variables.copy"` etc.)

- [ ] **Step 4: Verify the gate + build**

Run: `npm run typecheck && npm run check:deps && npm run test && npm run build`
Expected: all PASS (the deleted `jsonTreeEdit.test.ts` drops 8 tests → suite still green at ~854; renderer builds with the new editor).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vars): tabbed VariablesView on vanilla-jsoneditor; remove custom tree editor"
```

---

## Self-Review

**1. Spec coverage:**
- §1 dependency + ISC license documented → Task 1 (install, THIRD-PARTY-NOTICES, verify license). ✓
- §3 `JsonEditor` wrapper (tree mode, debounced onChange, guarded external update, destroy, `--jse-*`→`--rpt-*` theme) → Task 1. ✓
- §4 tabbed VariablesView (stat_data · Session KV · Floor read-only) + Refresh, drop copy buttons → Task 3. ✓
- §5 persistence: stat_data → `setFloorStatData`; session KV → `chatCardVarsSet`; debounced → Task 2 + wrapper (Task 1). ✓
- §6 cleanup (delete JsonTreeEditor/jsonTreeEdit/test; i18n) → Task 3. ✓
- §7 CSP (already permits inline styles; no change) → Global Constraints + Task 1 Step 5; boundaries → each gate; `setFloorStatData` unit test → Task 2. ✓

**2. Placeholder scan:** No TBD/TODO; complete code in each code step; commands + expected output. The one conditional ("if FloorFile/getFloor/saveFloor not already imported") gives an explicit check, not a placeholder — they ARE imported (applyVariableOps uses them), so it's a safety net.

**3. Type consistency:** `JsonEditor` prop `{ value, onChange?, readOnly? }` defined in Task 1, consumed unchanged in Task 3 (`onStatChange`/`onKvChange` are `(json: unknown) => void`, matching `onChange?`). `withStatData(floor, statData): FloorFile` + `setFloorStatData(...): FloorFile | null` (Task 2) match the IPC/preload/store signatures. `chatStore.setStatData(profileId, json)` defined Task 2, called Task 3. `window.api.setFloorStatData(profileId, chatId, floor, statData)` consistent across preload (Task 2) and the store action (Task 2).
