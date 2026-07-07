# PM-A5 — titlebar height single-source (was PF-09)

Status: ready-for-human
Priority: P2
Dispatch: opus-4.8/medium
Scope: app

## What

The 44px bar height and the 138px overlay padding are magic numbers spread across files, and the
workflow-editor header still reserves 48px. Define one source of truth (a `--rpt-titlebar-h`
token in `theme.ts` + one exported constant for the main-process `titleBarOverlay` height — they
cannot literally share a variable across processes, so add a comment pairing them and a test that
asserts they match) and replace every hardcoded 44/48/138 derived from it.

## Grounding

`src/main/index.ts` (overlay height 44 — set 2026-07-05, commit `ec6ddb9`), the `.tstrip` styles,
`App.tsx` overlay effect, the workflow editor header CSS (`workflowEditor.css`). Grep for
`44`/`48`/`138` in those areas — verify each hit is actually titlebar-derived before changing it.

## Acceptance

- One definition each side, paired test, workflow header aligns with the strip. Gate green.

## Comments

Commit `450f6c2` on `claude/nifty-mcclintock-6e6a1b`.

### What 138 decomposed into (NOT titlebar-derived — deliberately LEFT as literal 138px)

The three `padding: 0 138px 0 <n>` right-paddings (`.top-nav`, `.lc-bar`, `.tstrip`) reserve the
**horizontal width** of the Windows OS window-control button cluster (min/max/close), so the
strip's own content doesn't slide under it. That is control-strip *width*, orthogonal to the
title-bar *height* this issue single-sources. It's the same kind of reservation the workflow
header does more robustly via `env(titlebar-area-*)`. Not touched — out of scope for PM-A5 (a
future "control-strip width" token could unify the three, but that's a separate concern).

### Paired single-source locations

- **Main:** `export const TITLEBAR_OVERLAY_HEIGHT = 44` in new module `src/main/windowChrome.ts`
  (kept side-effect-free so the test imports it cheaply); consumed by `titleBarOverlay.height` in
  `src/main/index.ts`.
- **Renderer:** `--rpt-titlebar-h: '44px'` in `src/renderer/src/theme.ts` (dark/carbon/light —
  theme-independent, same value) + the `:root` first-paint fallback in
  `src/renderer/src/assets/index.css`.
- Both carry a paired comment pointing at the other + at the matching test.

### Every replaced titlebar-derived site → token/constant

- `src/main/index.ts` — `height: 44` → `TITLEBAR_OVERLAY_HEIGHT`.
- `src/renderer/src/assets/index.css` `.tstrip` — `height: 44px` → `var(--rpt-titlebar-h)` (live
  play-mode strip, `TopStrip.tsx`).
- `src/renderer/src/assets/index.css` `.lc-bar` — `height: 44px` → `var(--rpt-titlebar-h)` (live
  launcher bar, `Launcher.tsx`).
- `src/renderer/src/components/workflow/workflowEditor.css` `.rpt-wfe-overlay-header` —
  `min-height: 48px` → `var(--rpt-titlebar-h)`. **This was the misalignment bug**: it reserved
  48px against a 44px strip (over-reserved 4px). Comments there also fixed (they said "48px" and
  cited a stale `main/index.ts:43`).

### Deliberately LEFT (coincidental / dead 44/48/138)

- `index.css:31` `color-mix(... 48%, ...)` — combat AOE opacity, unrelated.
- `index.css` `.rpt-duel-card-glyph { font-size:44px }` — glyph size, unrelated.
- `index.css` `.top-nav { height: 48px }` — **dead CSS** (no JSX references `top-nav` anymore;
  replaced by `.tstrip`). Titlebar-conceptual but inert, and at the stale pre-`ec6ddb9` 48px;
  left untouched to avoid silently mutating a value nothing renders. Flag for a dead-CSS sweep.
- `index.css` `padding: 40px 24px 48px` and `margin: 48px auto 0` — layout paddings, unrelated.
- The three `138px` right-paddings — see decomposition above.

### Gate

`npm run typecheck` ✓, `npm run check:deps` ✓ (394 modules), `npm run test` ✓ **2060/221**
(was 2057/220; +3 tests / +1 file from `test/titlebarHeight.test.ts`).
