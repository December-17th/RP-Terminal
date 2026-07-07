# RF-07 — Define the missing --rpt-accent-soft theme token

Status: ready-for-human
Priority: P2 (one-line-per-theme fix)

## Problem

`ChatView.tsx:331-332` styles the combat-cue banner with
`var(--rpt-accent, #5b8def)` / `var(--rpt-accent-soft, rgba(91,141,239,0.12))`, but
`--rpt-accent-soft` is defined nowhere (verified: no hits in `theme.ts` or `index.css`). The
hardcoded fallback keeps the banner blue-tinted on every theme — including Carbon (teal accent) and
Daylight — so the element ignores theming.

## Grounding (verified 2026-07-06)

- Theme registry: `src/renderer/src/theme.ts` — three token sets (dark #5b8def blue,
  carbon #2dd4bf teal, light #2563eb blue). Established pattern for soft washes:
  the `--rpt-agent-region` tokens use `rgba(<accent-rgb>, 0.06–0.16)` per theme.
- First-paint defaults live in `index.css :root` (theme.ts header comment, lines 3-5).
- `--rpt-accent-soft` is currently the ONLY consumer-side token with no definition; grep to be sure
  no second definition/consumer appeared since.

## Changes

1. `theme.ts` — add to each token set (keep alongside `--rpt-accent`):
   - dark: `'--rpt-accent-soft': 'rgba(91, 141, 239, 0.12)'`
   - carbon: `'--rpt-accent-soft': 'rgba(45, 212, 191, 0.12)'`
   - light: `'--rpt-accent-soft': 'rgba(37, 99, 235, 0.10)'`
   Add a one-line comment stating what it drives (soft accent wash — cue banners / subtle
   accent-tinted fills).
2. `index.css` `:root` — add the dark value as the first-paint default, in the token block that
   mirrors theme.ts's dark set.
3. Leave the `var(..., fallback)` fallbacks in ChatView untouched (harmless defense).

## Tests

None (no CSS test harness). Note in the PR: verified by switching all three themes and checking
the combat-cue banner tint follows the accent.

## User journey (PR description, for the owner pass)

In a chat where a `combat_cue` banner shows (or temporarily force one), switch theme
dark → carbon → light in Settings → Preferences: the banner wash follows each theme's accent.

## NON-GOALS

- No new consumers of the token; no refactor of the banner's inline style into a class (RF-09
  territory is the workflow editor only; the banner style stays as-is).
- No changes to the `--rpt-agent-*` token family.

## Size budget

≤ 15 lines diff.

## Comments

Defined `--rpt-accent-soft` in all three theme sets in `theme.ts` (dark
`rgba(91,141,239,0.12)`, carbon `rgba(45,212,191,0.12)`, light `rgba(37,99,235,0.10)`),
each with a one-line comment, plus the dark first-paint default in `index.css :root`.
ChatView fallbacks left untouched. 8 lines added, within budget. Gates green:
`npm run typecheck` + `npm run check:deps` (no violations) + `npm run test`
(2023 tests / 215 files passed). Owner: verify the combat-cue banner wash follows the
accent when switching dark → carbon → light.
