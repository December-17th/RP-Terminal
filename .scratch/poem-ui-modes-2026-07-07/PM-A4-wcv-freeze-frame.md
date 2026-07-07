# PM-A4 — WCV freeze-frame under TopStrip dropdowns (was PF-08)

Status: ready-for-human
Priority: P1 (owner-reported)
Dispatch: opus-4.8/medium
Scope: app (main + preload + renderer)

## What

Opening a TopStrip dropdown currently BLANKS the card panels below (wholesale WCV ducking via
`useWcvSuppression` — WCVs composite above the DOM, so they must yield to menus). Replace the
blank with a freeze-frame: capture each suppressed WCV (`webContents.capturePage()`), show the
captured bitmap in the slot's DOM placeholder while the WCV is hidden, drop it on restore.
Card-agnostic; no per-card logic.

## Grounding

`src/renderer/src/.../TopStrip.tsx` (`useWcvSuppression(open)`), the suppression path in
`src/main/services/wcvManager.ts`, the slot placeholder DOM in `StaticWorkspace.tsx`.
Read the 2026-07-05 ducking commit (`ebec542`) first for why suppression exists.

## Acceptance

- Opening any strip menu leaves the panels visually in place (static), menu renders above,
  closing restores live WCVs; no flicker loop on rapid open/close (debounce/cancel in-flight
  captures). Acceptance is code+tests (capture path mockable); owner verifies in-app.
- Gate green; i18n untouched (no new strings expected).

## Comments (implementation — commit 6ad5803)

**Grounding confirmed.** Suppression works exactly as the issue described: `useWcvSuppression(open)`
(refcounted) → `window.api.wcvSetAllVisible(false)` → `wcvManager.setAllVisible(false)` hides every
WCV. WCVs paint above the DOM, so hiding them left the DOM `.play-root`/placeholder showing through
(the blank). One nuance worth noting: `wcvSetAllVisible` is shared by BOTH the TopStrip dropdowns AND
the workflow-editor overlay (both use `useWcvSuppression`), so the freeze-frame now applies to both —
harmless for the workflow editor (its full-screen overlay hides the frames anyway), card-agnostic.

**Design of the capture flow.** The invariant is unchanged: *while a menu is open, live WCVs are
hidden* (the menu must never be occluded). The freeze-frame is a cosmetic backfill painted in the DOM
*behind* the hidden native view. Sequence per suppression episode:
1. `suppress()` snapshots the currently-visible views and captures each with
   `webContents.capturePage()` **while still on screen** (a hidden view captures blank).
2. When the captures resolve AND we're still in the same episode → hide the live views and push the
   bitmaps (`wcv-freeze-show`). Capturing before hiding means the menu appears one capture-latency
   later, but never over a blank/half-frozen stage.
3. `restore()` bumps the episode token (cancelling any in-flight capture from being applied), shows
   the live views, clears the frames (`wcv-freeze-clear`).

**Debounce/cancel + failure handling.**
- *Rapid open→close:* if the menu closes before the capture lands, the stale-episode guard drops the
  result and the views were **never hidden** → no flicker, live the whole time.
- *Close→reopen mid-capture:* episode 1's late capture is discarded; episode 2 runs its own fresh
  capture. Tested.
- *Capture fails / empty* (view mid-load, zero-size, destroyed): that one slot gets **no bitmap** and
  still hides → falls back to today's blank for that panel only. If *every* capture fails, `showFreeze`
  is never called (pure blank, unchanged behavior). All `capturePage`/`isEmpty`/`getSize` guards are
  wrapped in try/catch main-side.

**Architecture / seam.** The orchestration is a pure, injectable module
(`src/main/services/wcvFreezeFrame.ts` — `createFreezeController(effects)`): all Electron side effects
(capture, show/hide live view, push/clear bitmaps) are injected, so the debounce/cancel/failure logic
is fully unit-testable without Electron. `wcvManager.ts` supplies the real effects (`freezeTargetFor`
builds a capture+setVisible per slot; `visibleTargets` enumerates the slot map). The old `allHidden`
flag + inline `ensure` hide-check were replaced by `freezeController.onTargetCreated` (a view created
under an open menu still starts hidden, no freeze — it wasn't on screen to capture).

**IPC additions** (host→renderer only; NOT card-facing, so no `docs/sdk/` change per the
touch-X-update-Y map):
- `wcv-freeze-show` (payload: `Record<slotId, dataUrl>`) and `wcv-freeze-clear`.
- Preload: `onWcvFreeze(cb)` returns an unsubscribe; subscribed once in `App.tsx`, routed to the new
  `wcvFreezeStore`. `WcvPanel` reads its own frame by `slotId` (the same id it reports to main:
  `static:<id>` / `card-scripts:…`) and paints it as an absolutely-positioned `<img objectFit:cover>`
  over the placeholder.

**Test coverage.** `test/wcvFreezeFrame.test.ts` — 10 tests on the pure controller: capture→hide→push;
restore; single-capture-failure (still hidden, no bitmap for it); all-fail blank fallback; rapid
open→close discard (never hidden); close→reopen stale-drop; no-visible-views no-op; nested
suppress/restore idempotency; late-created view starts hidden; late-created-while-live left alone.

**Gate:** `npm run typecheck` ✓, `npm run check:deps` ✓ (no boundary violations — renderer talks to
main only via preload `window.api`), `npm run test` ✓ **2057 passed / 220 files** (was 2047 / 219).

**i18n:** untouched — the freeze-frame is a bitmap; the `<img alt="">` is decorative. No new strings.

**What the owner should check in-app (I can't drive the Electron app):**
- Open each TopStrip dropdown (persona / preset / lorebook / settings) over the poem play area: the
  card panels should stay VISIBLE (a static snapshot) instead of blanking; the menu renders above.
- Rapid-fire open/close a dropdown: no flicker, no blank flash, no stale frame left behind.
- Close the dropdown: the live (interactive) WCVs come back and respond normally.
- On a fresh/mid-loading card where a panel hasn't painted yet, opening a menu should fall back to the
  old blank for that panel (graceful), not a broken image.
- Sanity: the workflow-editor overlay (also uses this suppression path) still opens correctly.
