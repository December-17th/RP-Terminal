# PM-B5 — CJK ≤11px audit, both generations (was PF-07)

Status: ready-for-human
Priority: P2
Dispatch: opus-4.8/medium
Scope: card surfaces + v4 mock

## What

Pure-CJK labels at 11px are below comfortable legibility (11px CJK ≈ 9px latin in stroke
density). Audit every `font-size` ≤11px across the three v3 surfaces + the v4 mock: pure-CJK
text moves to ≥12px; mono/latin-digit runs (values, timestamps) may stay 11px. The 2026-07-05
readability pass already bumped sub-11px to 11px — this issue finishes the job for CJK.
Coordinate with PM-B3 (same files, land after it; PM-B3 owns color, this owns size).

## Verification

Standalone screenshots at slot sizes before/after, dusk + one other palette; check nothing
overflows its container after the bump (the WORLD 委托 cards are the tight spot).

## Acceptance

No pure-CJK run under 12px in the four files; no clipped/overflowing labels. Gate green.

---

## Comments (commit d83a96b)

Audited **every** `font-size ≤11px` (regex-swept, then classified by the text each rule actually
renders — read from the markup + the JS that fills it, not from class names). Decision key:
**CJK-bump** = pure/CJK-led content → 12px · **stays-mono** = latin/digit numeric payload → 11px.

### Audit table — all ≤11px rules found across the four files

| File | Selector | px→ | Renders (verified) | Decision | Why |
|---|---|---|---|---|---|
| self | `.np-tag` | 11→12 | `你`·生命层级(史诗)·Lv N·A 级·命定 | CJK-bump | CJK-led nameplate tag |
| self | `.res-k` | 11 | HP/MP/SP/EXP/FP | stays-mono | pure latin labels |
| self | `.res-v` | 11 | `380 / 400`, `MAX`, `7.2k` | stays-mono | numeric value |
| self | `.chip` | 11→12 | 状态效果 names (战斗祝福…), 无状态 | CJK-bump | status names are CJK |
| self | `.sect` | 11→12 | 属性/装备/背包/登神长阶 | CJK-bump | CJK headers (mono+upper, still CJK glyphs) |
| self | `.empty` | 11.5→12 | 暂无装备/背包空空如也/尚未踏上… | CJK-bump | CJK empty-state prose |
| self | `.attr-k` | 11→12 | 力量/敏捷/体质/智力/精神 | CJK-bump | CJK attr labels (tightest grid — verified fits) |
| self | `.attr-free` | 11.5→12 | 可分配属性点 **N** | CJK-bump | CJK label |
| self | `.inv-meta` | 11→12 | 位置/类型 (主手/身体/饰品) or ×N | CJK-bump | mixed, but 位置/类型 payload is CJK |
| self | `.rung-k` | 11→12 | 要素/权能/法则 | CJK-bump | CJK rung labels |
| self | `.rung-n` | 11 | `2/3`, `0/1`, `0` | stays-mono | numeric count |
| self | `.rung-tag` | 11→12 | 烈焰/星辉 (element names) | CJK-bump | CJK |
| self | `.rung .empty` | 11→12 | `—` | CJK-bump* | *not CJK; bumped only to match the bumped `.empty` cadence (same empty-state), avoid re-shrink |
| self | `.asc-crown` | 11.5→12 | 神位 **X**　神国 **Y** | CJK-bump | CJK labels |
| self | `.tab` | 11→12 | 属性/持有/登神长阶 | CJK-bump | CJK tab labels; 登神长阶=4 CJK, fits 69px col |
| stage | `.np-tag` | 11→12 | 职业(灰隐者)·好感 N·命定 | CJK-bump | CJK-led |
| stage | `.np-live` | 10.5→12 | 正在交谈 | CJK-bump | pure CJK (was the smallest rule) |
| stage | `.scene-tag` | 11.5→12 | 时间·地点 (暮·戌时·艾瑟嘉德) | CJK-bump | CJK |
| world | `.sect` | 11→12 | 世界/同行/委托 | CJK-bump | CJK headers |
| world | `.empty` | 11.5→12 | 未知/此刻无人同行/暂无委托 | CJK-bump | CJK |
| world | `.npc-name .role` | 11→12 | 职业/身份 (灰隐者…) | CJK-bump | CJK |
| world | `.npc-pact` | 11→12 | ◈ 命定 | CJK-bump | CJK |
| world | `.npc-aff` | 11 | `64`, `-46` | stays-mono | numeric affection |
| world | `.quest-focus` | 11→12 | 高/中/低 (关注度) | CJK-bump | CJK |
| world | `.quest-goal` | 11→12 | quest-goal prose | CJK-bump | CJK prose |
| world | `.quest-meta` | 11→12 | 状态/进展/奖励 + values (进行中…) | CJK-bump | CJK labels+values |
| v4 | `.chap-meta` | 11→12 | 复兴纪元·暮·艾瑟嘉德 | CJK-bump | CJK |
| v4 | `.choice .n` | 11→12 | 壹/贰/叁 | CJK-bump | CJK numerals |
| v4 | `.idplate .tag` | 11→12 | 你·史诗·Lv 12·A 级 | CJK-bump | CJK-led |
| v4 | `.res-k` | 11 | HP/MP/SP/EXP | stays-mono | latin labels |
| v4 | `.res-v` | 11 | `380/400`, `7.2k/10k` | stays-mono | numeric |
| v4 | `.npc-pact` | 11→12 | ◈ 命定 | CJK-bump | CJK |
| v4 | `.npc-aff` | 11 | `64`, `38` | stays-mono | numeric |
| v4 | `.np-tag` | 11→12 | 灰隐者·好感 64·命定 | CJK-bump | CJK |
| v4 | `.np-live` | 10.5→12 | 正在交谈 | CJK-bump | pure CJK |
| v4 | `.scenetag` | 11.5→12 | 暮·戌时·艾瑟嘉德·大雨 | CJK-bump | CJK |

**26 CJK-bumps, 5 stays-mono (`.res-k`, `.res-v`, `.rung-n`, `.npc-aff`, + v4 `.res-*`/`.npc-aff`).**
Every bumped rule carries an inline `/* PM-B5: … */` comment in the CSS.

### Not touched (deliberately)
- `.np-name` / `.chap` / `.attr-v` etc. — already ≥17px.
- `.rung .empty` "—" is not CJK; bumped only for empty-state cadence consistency (noted `*` above).
- Mixed nameplate/idplate tags contain CJK segments (你/史诗/命定/职业), so classified CJK-led → bumped
  as a unit; the interleaved latin (`Lv 12`, `A 级`) rides the same run.

### Overflow / clipping checks (PRD rule 5 — bounding-box reads, `scrollWidth` vs `clientWidth`)
Preview `docs-static` (port 6791); measured computed font-size == 12px AND overflow flags on the tight
containers, all clean:

| Surface | Slot | Palettes | Result |
|---|---|---|---|
| WORLD (委托 tight spot) | 340×547 | dusk, ember | no overflow; `.quest`/`.quest-h`/`.quest-meta` all fit; meta wraps to 2 lines cleanly (flex-wrap), scrollH==clientH (no vertical clip) |
| SELF closed (tabs+swatches) | 340×820 | dusk | tabs row scrollW==clientW==340 with swatches at 83px; `登神长阶` fits its 69px flex col |
| SELF open (attrs/inv/asc) | 340×820 | dusk, ember | 5-col `.attrs` grid, rungs, inv rows — no overflow in either palette |
| STAGE (nameplate/scene-tag) | 1020×273 | dusk, ember | nameplate + `正在交谈` pill + scene-tag fit, nothing off-viewport |
| v4 mock (full) | 1360×820 | dusk, frost | idplate/hud-foot, choices, nameplate, scenetag, attrs grid, self+world stacks — all clean |

### Gate
`npm run typecheck` ✓ · `npm run check:deps` ✓ (391 modules, no violations) ·
`npm run test` ✓ **2047 passed / 219 files**.

### Notes / surprises
- **PM-B3 confirmed no size changes** (commit 395d2c8, color-only) — sizes were exactly as the
  earlier chain left them; PM-B5 is the first size pass since the 2026-07-05 ≤11px readability bump.
  PM-B3's colors left untouched; larger text only improves the same ratios, so no contrast follow-up.
- Card asset folder NOT touched; `--apply` NOT run (controller's job — surfaces stay inert until re-embedded).
- Staged explicit paths only (4 files); `.scratch/` left unstaged/uncommitted.
- The v1 mock (`docs/design/poem-play-area-mock.html`) is OUT of PM-B5's named scope (spec lists only
  the v4 mock + 3 v3 surfaces) — left alone, same as PM-B3.
