# RF-06 — In-app ConfirmDialog; replace native confirm() in the launcher

Status: ready-for-human
Priority: P2

## Problem

Deleting a world or a session from the launcher uses the OS-native `confirm()`
(`Launcher.tsx:122`, `Launcher.tsx:195`) — a synchronous OS dialog inside the carefully styled
boot-terminal launcher. Deleting a WORLD destroys all its sessions and deserves a proper in-app
confirm.

## Grounding (verified 2026-07-06)

- `Modal` (`src/renderer/src/components/Modal.tsx`, 30 lines) already provides overlay + panel +
  header + WCV suppression; body is free-form children.
- Existing button classes: `btn-ghost`, `btn-ghost danger`, `btn-accent` (index.css).
- Existing strings reusable as the dialog body: `world.confirmDelete` (takes `{{name}}`),
  `sessions.confirmDelete`, plus `world.deleteTitle` / `sessions.deleteTitle` for titles.
- `common.*` namespace exists (`common.delete`, `common.save`, …) but has NO `common.cancel`.
- Nine other components also call `confirm()` (ApiSettingsPanel, LorebookManager ×2,
  PluginsPanel ×2, PresetManager ×2, RegexPanel, CardScriptHost ×2) — explicitly OUT of scope
  (PRD "out of scope"); this issue establishes the component they migrate to later.

## Changes

### 1. NEW `src/renderer/src/components/ConfirmDialog.tsx`

```tsx
interface ConfirmDialogProps {
  title: string
  body: string
  confirmLabel?: string   // default t('common.delete') is NOT assumed — caller passes; fallback t('common.confirm')
  danger?: boolean        // true → confirm button uses the danger style
  onConfirm: () => void
  onCancel: () => void
}
```

Built ON `Modal` (title + onClose=onCancel). Body: the message paragraph; footer row
(right-aligned, gap 8): Cancel (`btn-ghost`, `t('common.cancel')`, autoFocus) then Confirm
(`danger ? 'btn-danger' : 'btn-accent'`). Enter confirms only when the confirm button is focused
(native button behavior — no global key handler); Esc/overlay-click cancels via Modal's onClose.

Add `.btn-danger` to `index.css` next to `.btn-accent`, token-driven:
`background: var(--rpt-danger); color: #fff;` + hover/disabled states mirroring `.btn-accent`'s
structure. Check `--rpt-danger` legibility on all three themes (values in theme.ts — all are
mid-dark reds, white text passes).

### 2. `Launcher.tsx`

- Local state: `const [confirming, setConfirming] = useState<{ kind: 'world' | 'chat'; id: string; name: string } | null>(null)`.
- The two 🗑 buttons set `confirming` instead of calling `confirm()`.
- Render `<ConfirmDialog>` when `confirming != null`:
  - world: title `t('world.deleteTitle')`, body `t('world.confirmDelete', { name })`,
    confirmLabel `t('common.delete')`, danger.
  - chat: title `t('sessions.deleteTitle')`, body `t('sessions.confirmDelete')`, danger.
  - onConfirm → the existing `deleteCharacter(profileId, id)` / `deleteChat(profileId, id)`, then
    `setConfirming(null)`.
- NOTE the launcher renders in two branches (world list AND session list) — either render the
  dialog in both branches or lift it below the branch return; lifting is cleaner: restructure the
  two `return`s minimally (wrap both in a fragment with the shared dialog) WITHOUT changing the
  branch markup.

### 3. i18n — BOTH locale files

| key | en | zh |
|---|---|---|
| `common.cancel` | `Cancel` | `取消` |
| `common.confirm` | `Confirm` | `确认` |

(`common.delete`, `world.*`, `sessions.*` keys already exist — reuse, don't duplicate.)

## Tests

No component harness exists; no new test. The RF-05 parity test covers the new keys.

## User journey (PR description, for the owner pass)

Launcher → hover a world row → 🗑 → styled in-app dialog names the world → Cancel keeps it →
confirm deletes it. Same inside a world's session list. Esc and clicking outside cancel.

## NON-GOALS

- Not converting the other nine `confirm()` call sites (follow-up, listed in the PRD).
- No undo-toast pattern; a blocking confirm is the chosen UX here.
- No `alert()`/`prompt()` sweep.

## Size budget

≤ 180 lines diff.

## Comments

Implemented 2026-07-06 (opus-4.8/medium).

- NEW `src/renderer/src/components/ConfirmDialog.tsx` — built on `Modal`; Cancel (`btn-ghost`,
  autoFocus) + Confirm (`danger ? 'btn-danger' : 'btn-accent'`, fallback `t('common.confirm')`).
- `assets/index.css` — added `.btn-danger` (+ `:hover` / `:disabled`) mirroring `.btn-accent`
  at line ~1012, token-driven `var(--rpt-danger)`, white text.
- `Launcher.tsx` — added `confirming` state; both 🗑 buttons now `setConfirming(...)`; a single
  lifted `confirmDialog` element rendered in both branches (each `return` wrapped in a fragment,
  branch markup unchanged).
- i18n — added `common.confirm` (`Confirm` / `确认`) to both locales. **Grounding correction:**
  the spec (lines 20–21, and the i18n table) claims `common.cancel` is missing — it already
  exists in BOTH `en.ts` (L423) and `zh.ts` (L410), so only `common.confirm` was added. Not a
  blocker; reused the existing `common.cancel`.

Gates all green: `typecheck` OK, `check:deps` OK (no violations), `test` 2036 passed / 217 files
(incl. i18nParity). Diff well under the 180-line budget. Not manually run in-app (agent can't
drive the dev Electron app) — owner journey pass pending.
