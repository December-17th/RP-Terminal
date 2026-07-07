# PF-07 — Bump pure-CJK 11px labels to 12px across the three surfaces

Status: ready-for-agent
Priority: P2
Depends on: PF-01..05 landed (same files; this goes last among surface issues)

## Problem

The `48e67ee` readability pass lifted sub-11px text to 11px, but 11px is the floor for LATIN/mono
numerals, not for 汉字 — dense CJK glyphs at 11px lose strokes. Verified renders show tabs
(属性/持有/登神长阶), section labels (装备/背包/世界/同行/委托), quest meta (状态/进展/奖励),
and nameplate tags at 11px.

## Change — all three `poem-*-surface.html` files

Audit every `font-size: 11px` / `11.5px` rule; bump to **12px** the ones whose content is
pure/mostly CJK; LEAVE at 11px the ones that are mono numerals/latin:

BUMP to 12px (verified selectors): `.tab` (SELF), `.sect` (SELF + WORLD — note its
`letter-spacing:.22em` is tuned for sparse text; reduce to `.18em` if 12px + 装备 overflows its
row), `.chip` (SELF status chips), `.quest-focus`, `.quest-goal` (11 → 12), `.quest-meta`,
`.np-tag` (SELF + STAGE), `.attr-k`, `.rung-k`, `.rung-tag`, `.rung .empty`, `.empty` (11.5 → 12),
`.npc-name .role`, `.npc-pact`, `.speaking` (正在交谈).

KEEP at 11px (numeric/latin mono): `.res-k` (HP/MP/SP/FP/EXP letters), `.res-v` (380/400),
`.rung-n` (2/3), `.npc-aff` (64), `.inv-meta` ONLY when numeric — it mixes ×3 with 消耗品; bump it
to 12px since it carries CJK. `.scene-tag` carries CJK (暮·戌时) → bump.

This list was compiled from the current files — re-verify each selector's actual content while
grounding; where a selector mixes both, CJK wins (bump).

## Verification

Preview all three surfaces at slot sizes (SELF 400×856, STAGE 1200×285, WORLD 400×571), dusk:
nothing wraps, truncates, or overflows — pay attention to (a) the three tabs fitting at 400px,
(b) `.sect` rows with the gradient rule still on one line, (c) quest cards not growing ugly,
(d) the stats-foot row (gold + chips) not wrapping with a 12px chip. Screenshots before/after per
surface. Gate green.

## NON-GOALS

- No font-family or weight changes; no layout restructuring.
- No app-side (`index.css`) changes — this is surfaces only.
- No `--apply`.

## Size budget

≤ 40 changed lines across three files.
