# PF-08 — Strip-menu WCV ducking: freeze-frame instead of blanking (owner-reported)

Status: ready-for-agent
Priority: P1 (owner-reported UX issue)

## Problem

**Owner report:** "when clicking on dropdowns in the title strip the panel below it will be
temporarily disabled." Root cause: WCV card panels are native views that paint ABOVE the DOM, so a
strip dropdown would be occluded; the merged `ebec542` fix ducks (hides) ALL WCVs while any strip
menu is open (`TopStrip.tsx` → `useWcvSuppression(open)`). Correct z-order fix, but the card panels
visibly vanish/blank for the menu's lifetime — jarring, and it reads as breakage.

## Approach (chosen): freeze-frame

While suppressed, each ducked WCV is replaced by a **static snapshot image** rendered in its DOM
slot — the panel appears frozen (non-interactive) instead of blank. Interaction loss is fine: any
click outside the menu closes it anyway.

## Grounding required first (this issue is main+preload+renderer — read before designing)

- `src/main/services/wcvManager.ts` — how suppression currently works (the refcounted duck used by
  Modal/overlays; find the hide/show mechanism and what identifies a view: slot id / chat id).
- `src/renderer/src/components/useWcvSuppression.ts` and `src/renderer/src/components/workspace/WcvPanel.tsx`
  (+ `CardScriptWcvHost` — the HIDDEN engine WCV must be excluded: it's off-screen, snapshotting it
  is wasted work).
- `src/main/ipc/wcvIpc.ts` — the suppression channel(s).
- Electron: `webContents.capturePage()` → `NativeImage` → `toDataURL()`. **Capture BEFORE hiding**
  (a hidden view may capture blank).

If the suppression path differs materially from this sketch (e.g. suppression is not centralized in
wcvManager), stop and report.

## Changes (sketch — refine against grounding)

1. **wcvManager**: on suppress (refcount 0→1), for each VISIBLE docked view: `capturePage()` →
   `toDataURL()` → push `wcv-frozen { slotId, dataUrl }` to the renderer (same webContents that
   hosts the panels), THEN hide the view. On restore (1→0): show views, push `wcv-unfrozen { slotId }`.
   Captures are async — hide each view as its capture resolves (or after a 120ms cap) so the menu
   never waits.
2. **preload/ipc**: renderer-side event subscription (mirror an existing `onWcv*` pattern in
   `src/preload/index.ts` + `index.d.ts`).
3. **WcvPanel**: subscribe; while frozen, render `<img src={dataUrl}>` absolutely filling the panel
   body (`object-fit: fill`, the capture is exactly the view's size) with a subtle
   `filter: brightness(.92)` so it reads as "paused" rather than live; remove on unfreeze.
4. Perf guard: skip snapshots for views whose bounds are 0/off-screen (the hidden engine WCV).
5. i18n: none (no visible text). If you add an aria-label to the img, route it through `t()` in
   BOTH locales per repo rule.

## Tests (named)

Main-side logic that is pure/mockable: extend the existing wcvManager test file (find it; if none
covers suppression, add `test/wcvFreezeFrame.test.ts`) with: (a) suppress captures-then-hides
visible views and skips zero-bounds views; (b) restore shows views and emits unfreeze; (c)
refcounted nesting (menu inside modal) freezes once, unfreezes once. Mock `capturePage`.

## Verification

Gate green. Live behavior needs the rebuilt Electron app — write the owner steps in `## Comments`:
open the poem card session (3 WCV panels) → open the Preset dropdown → panels keep showing their
content (slightly dimmed, non-interactive) instead of blanking → close menu → panels live again.

## NON-GOALS

- No rect-based partial suppression (only-intersecting-views) — recorded as a possible v2; the
  freeze-frame alone answers the report.
- No change to modal/overlay suppression call sites (they inherit the improvement for free).
- No interactivity through the snapshot.

## Size budget

≤ 260 lines across main/preload/renderer (excl. tests).
