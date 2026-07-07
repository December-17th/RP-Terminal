# PM-B4 — 好感度 center-axis bar in v3 WORLD (was PF-06)

Status: ready-for-human
Priority: P2
Dispatch: opus-4.8/medium
Scope: card v3 surface

## What

`poem-world-surface.html` maps 好感度 −100..100 onto a 0..100 fill, so 38 reads as 69% full — the
bar lies about the data. The v4 mock already uses the honest design: a center-axis bar (`.npc-rel`
with a center tick; fill extends right for positive, left for negative, width = |value|/100 of the
half). Port that exact treatment to the v3 WORLD 同行 rows (keep the numeric label).

## Verification

Standalone world surface at 340×547 with mock data including a negative 好感度; screenshot.

## Acceptance

0 renders as an empty bar at the tick; +38 fills 38% of the right half; negatives fill left in a
distinct tone (mock uses `--ember`); label unchanged. Gate green.

## Comments

Done in commit `31fd88d` (one file: `docs/sdk/examples/poem-world-surface.html`).

**Implementation.** Replaced `affPct` (the −100..100 → 0..100 remap) with `affFill(v)` returning
`{ pct: |clamp(v,-100,100)|/2, neg: v<0 }`. `pct` is `|v|/100 × 50` = the value's share of *its half*
of the track, so a fill of `pct%` of the full-width track occupies `|v|%` of the half. Render emits
`<i class="pos|neg" style="width:pct%">`. CSS: added `.npc-rel::before` (1px center tick at `left:50%`,
`var(--line)`, matching the mock); `.npc-rel > i` is now `position:absolute` with `.pos{left:50%}` (grows
right) and `.neg{right:50%; background:var(--ember)}` (grows left). Numeric label untouched. Extended the
standalone MOCK with two present partners — 赛琳 `-46` (negative) and 渡鸦 `0` (axis) — so the preview
naturally exercises all three states; committed, per PRD rule 5's allowance.

**Positive-tone call (the one flagged in the issue).** The mock's `.npc-rel>i` is `--ember` and always
extends right, but the mock carries no negative data — there, `--ember` is simply the only/positive tone.
The issue's own acceptance criteria *reserve* `--ember` for the NEGATIVE fill. Using `--ember` for both
would make positive and negative indistinguishable, breaking the "distinct tone" requirement. So the
literal mock positive tone (`--ember`) conflicts not with PM-B7 but with the acceptance criteria itself;
I resolved it by keeping PM-B7's `--q-mythic` (`#d76b8f`, constant across palettes) for positive and using
`--ember` for negative. This is the only assignment that satisfies both "positive right / negative left"
AND "distinct tone." If the owner prefers positive = `--ember` too, the two directions would need another
differentiator (e.g. a tint/opacity split) — flag it and I'll adjust.

**Verification.** `docs-static` preview at 340×547; `preview_eval` bounding-box + computed-style
(screenshots hang on this page per the PRD gotcha). dusk: 薇拉 +64 → `pos`, fill starts at center
(offset 116px = half-width), width 74px ≈ 64% of the 116px half; 恩里克 +38 → 44px ≈ 38%; 赛琳 −46 →
`neg`, ends at center, extends left 53px ≈ 46%, bg `rgb(200,104,63)` = dusk `--ember`; 渡鸦 0 → width 0
(empty at tick). Positive bg `rgb(215,107,143)` = `--q-mythic`. ember palette: geometry identical,
negative bg = `rgb(209,80,58)` = ember `--ember`, positive still `--q-mythic` — distinct tones confirmed
in both palettes.

**Gate.** `npm run typecheck` clean; `npm run check:deps` no violations (389 modules); `npm run test`
2012 passed / 213 files.

**Not touched.** Card asset folder; `--apply` not run (surface stays inert until the controller rebuilds).
