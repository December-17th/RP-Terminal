# PF-09 — Title-bar geometry: one source of truth (44px + env() padding)

Status: ready-for-agent
Priority: P2

## Problem

Three independent copies of title-bar geometry now exist after the merge:

- `src/main/index.ts:44` — `titleBarOverlay: { …, height: 44 }` (the agnesi fix; was 48).
- `index.css` — `.lc-bar { height: 44px; padding: 0 138px 0 16px }` and
  `.tstrip { height: 44px; padding: 0 138px 0 14px }` — the 138px is a magic number for the
  Windows control cluster.
- `workflowEditor.css` — `.rpt-wfe-overlay-header` still reserves `min-height: 48px` (written when
  the overlay was 48) but correctly uses `env(titlebar-area-x/width)` for the right padding.

Result: the workflow editor header is 4px taller than the strip it replaces, and the strips use a
hardcoded 138px where the editor uses the proper `env()` calc.

## Changes

1. `index.css :root` — add `--rpt-titlebar-h: 44px;` with a comment naming `main/index.ts` as the
   paired constant (grep-able cross-reference both ways; add the mirror comment in main/index.ts).
2. Use it: `.lc-bar { height: var(--rpt-titlebar-h) }`, `.tstrip { height: var(--rpt-titlebar-h) }`,
   `.rpt-wfe-overlay-header { min-height: var(--rpt-titlebar-h) }` (48 → 44 — verify the header's
   content still fits at 44px: it's one row of 12.5px buttons, it does; screenshot to confirm).
3. Replace both 138px right paddings with the editor's proven formula:
   `padding-right: calc(16px + (100vw - env(titlebar-area-x, 100vw - 138px) - env(titlebar-area-width, 0px)));`
   — NOTE the fallbacks must reproduce ≈138px when `env()` is unavailable; work out the exact
   fallback arithmetic against the existing `.rpt-wfe-overlay-header` implementation (it solved
   this already — copy its shape, keep each bar's own left padding).
4. Do NOT change the 44 value itself or `main/index.ts` logic.

## Verification

Gate green. `npm run dev`-level visual check is owner territory; in `## Comments` list the owner
checks: launcher bar / play strip / workflow editor header all flush with the native window
controls; nothing clipped at a narrow window. (The env() vars only resolve in the Electron WCO
window — the fallback path is what a plain browser shows; both must look sane.)

## NON-GOALS

- No height redesign; 44 stays 44.
- No macOS/Linux conditionals (overlay is Windows-only today; env() degrades via the fallback).

## Size budget

≤ 30 lines across index.css, workflowEditor.css, main/index.ts (comment only).
