# RF-10 — First-class Workflow entry on the TopStrip

Status: ready-for-human
Priority: P3

## Problem

The workflow editor — "THE surface" for narrator + agents per the 2026-07-04 handoff — is reached
only via Settings → Automation → Workflow → a launcher card's button
(`SettingsModal.tsx:103-121`), plus a contextual shortcut inside TablesView. The play-mode
TopStrip (`TopStrip.tsx`) has Persona / Preset / Lorebook / Assets / Connection + the gear, but no
workflow entry. (The handoff's "title bar → Workflow" description no longer matches the code.)

## Grounding (verified 2026-07-06)

- TopStrip menus block: `TopStrip.tsx:198-258`. Two trigger styles exist: `StripMenu` (dropdown)
  and plain `tmenu-btn` buttons (the gear, line 251-257).
- Opening the editor: `useUiStore.getState().openWorkflowEditor()` (uiStore.ts:36/58) — the same
  call SettingsModal and TablesView make. The overlay renders app-wide (App.tsx:289), so opening
  from the strip needs nothing else.
- `nav.*` i18n namespace holds the strip labels.

## Changes

1. `TopStrip.tsx` — in the `tstrip-menus` div, after the Connection entry and before the gear,
   add a plain button (no dropdown — it has exactly one action, and a one-item dropdown is the
   pattern's weakness, not something to copy):

```tsx
<button
  className="tmenu-btn"
  onClick={() => useUiStore.getState().openWorkflowEditor()}
  title={t('nav.workflowTitle')}
>
  {t('nav.workflow')}
</button>
```

2. i18n — BOTH locale files:

| key | en | zh |
|---|---|---|
| `nav.workflow` | `Workflow` | `工作流` |
| `nav.workflowTitle` | `Open the workflow & agents editor` | `打开工作流与代理编辑器` |

3. Keep the Settings → Automation → Workflow launcher card as-is (settings remains the
   discoverable home; the strip is the fast path).

## Tests

RF-05's parity test covers the keys. No other tests.

## User journey (PR description, for the owner pass)

In play mode: TopStrip shows "Workflow" between Connection and the gear → click → the full-screen
editor opens over play → Esc/Close returns to the untouched session. Verify the label fits without
crowding at a narrow window width (~1000px); if the strip wraps, report rather than restyle.

## NON-GOALS

- No launcher-screen entry (the launcher has no session context; the editor's run features are
  chat-scoped).
- No removal of the Settings launcher card or the TablesView shortcut.
- No keyboard shortcut (global shortcuts are a separate design question).

## Size budget

≤ 25 lines diff.

## Comments

Implemented 2026-07-06 (RF-10). Plain `tmenu-btn` Workflow button added to the `tstrip-menus`
div between the Connection `openAction` and the gear button; `onClick` calls
`useUiStore.getState().openWorkflowEditor()` (no new imports — both `useUiStore` and `t` were
already in scope). Added `nav.workflow` / `nav.workflowTitle` to both `en.ts` and `zh.ts`.

Grounding note: the spec's file paths were off (it cited `components/play/TopStrip.tsx` and
`store/uiStore.ts`; actual are `components/TopStrip.tsx` and `stores/uiStore.ts`). Same filenames,
same substance — every behavioral claim (tstrip-menus block with Connection entry then gear,
`openWorkflowEditor()` on uiStore, `nav.*` namespace for strip labels) verified true, so I proceeded.

Settings launcher card and TablesView shortcut left untouched. Diff ~13 lines src, within budget.
Gates: typecheck ✓, check:deps ✓ (no violations), test ✓ (2036 passed / 217 files).
