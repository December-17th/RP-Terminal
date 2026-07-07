# Poem play-area + app-chrome fixes 2026-07-06

> **SUPERSEDED 2026-07-07 by `.scratch/poem-ui-modes-2026-07-07/`** (the three-mode plan). All
> PF issues were re-scoped there: PF-01/04 groundwork committed as `77b53b3`; PF-02→PM-B1,
> PF-03→PM-B2, PF-05→PM-B3, PF-06→PM-B4, PF-07→PM-B5, PF-08→PM-A4, PF-09→PM-A5, PF-10→PM-F1.
> Do not dispatch from this file.

**Source:** UI/UX review 2026-07-06 of the 命定之诗 custom play-area UI (rendered pass on the three
card surfaces + the approved mock, at real slot sizes, all four palettes) and the boot-terminal app
chrome. Base branch: `ui-facelift` at merge `3197016` (= 12 review fixes + the poem play-area
branch, both lines unified). Background docs: `docs/design/poem-play-area-redesign.md` (spec; mock
wins on look), `docs/design/poem-play-area-status.md` (build handoff + golden rules).

**Intent:** each issue is a self-contained work package for one implementing agent (**Opus 4.8,
medium effort** — name model+effort in the dispatch description, e.g. "PF-01 stage glyph size
[opus-4.8/medium]"). Agents execute the spec; they don't redesign. If reality contradicts an
issue's grounding, **stop and report**.

## Ground rules (all issues)

1. **Gate:** `npm run typecheck && npm run check:deps && npm run test` green before done.
2. **One issue per commit.** Work directly on the current branch; do not create branches or push.
3. **Keep RPT generic** — poem-specific look/data lives in the card surfaces
   (`docs/sdk/examples/poem-*`), never in RPT modules. App-side issues (PF-08/09) must stay
   card-agnostic.
4. **Card surfaces are inert until rebuilt.** Editing `poem-*-surface.html` / `poem-themes.css`
   changes nothing in-app until `node docs/sdk/examples/build-poem-play-area.cjs --apply` re-embeds
   them in a NEW card PNG. **Agents do NOT run `--apply` and do NOT touch the card asset folder**
   (`E:\Projects\RP Terminal\example sillytarvern character card…\命定之诗\` — shared, gitignored,
   never modify in place). The controller runs `--apply` ONCE after all surface issues land.
5. **Visual verification is expected for surface issues** — the surfaces open standalone.
   `.claude/launch.json` has a `docs-static` config (npx serve on port 6780, repo root); use the
   preview tools: `preview_start` → navigate to
   `/docs/sdk/examples/poem-<self|stage|world>-surface.html`, resize to the slot size given in the
   issue, screenshot before/after. Palettes switch via `?theme=frost|ember|verdant` or the swatches.
6. **No i18n concerns for card surfaces** (card content carries its own language). App-side issues
   (PF-08/09) follow the repo i18n rule: new user-facing strings через `t()` + BOTH locale files
   (the parity test enforces it).
7. `.scratch/` is gitignored — update your issue file's `Status:` + `## Comments`, never commit it,
   never `git add -f`.

## Findings → issues

| # | Issue | Priority | Finding |
|---|-------|----------|---------|
| 01 | stage-glyph-size | P0 | STAGE placeholder figures render ~10px (`%` font-size bug) — band shows a floating nameplate over nothing |
| 02 | swatch-collision | P0 | SELF theme swatches overlap the HP row whenever a fold tab is open |
| 03 | theme-scoped-scenery | P1 | Scene gradients + WORLD avatar placeholder hardcode dusk hues; ember/verdant clash mid-band |
| 04 | tabs-match-mock | P1 | Built SELF pins tabs to bottom; the approved mock puts them under the stats (spec: mock wins) |
| 05 | nameplate-contrast | P2 | Gold nameplate tag ≈1.2:1 where it overlaps the light placeholder glyph (SELF + STAGE) |
| 06 | affection-midpoint | P2 | 好感度 −100..100 → 0..100 bar makes 38 read as 69% full |
| 07 | cjk-11px-audit | P2 | Pure-CJK labels at 11px across all three surfaces |
| 08 | wcv-freeze-frame | P1 | **Owner-reported:** opening a TopStrip dropdown blanks the card panels below (wholesale WCV ducking) |
| 09 | titlebar-single-source | P2 | 44px bar height + 138px overlay padding are magic numbers; workflow-editor header still reserves 48px |
| 10 | home-screen-collapse | needs-info | 首页 renders as a thin strip on load (pre-existing, status doc §OPEN A — needs owner answers) |

## Sequencing & conflicts

- **SELF surface chain (same file): PF-02 → PF-04 → PF-05 → PF-07.** Land in that order.
- **STAGE surface chain: PF-01 → PF-03 → PF-05.** (PF-05 touches both SELF and STAGE nameplates —
  it comes after both chains' earlier issues.)
- PF-06 (WORLD only), PF-08, PF-09 are independent; PF-08 is main+preload+renderer (needs app
  rebuild to test live — its acceptance is code+tests, owner verifies in-app).
- PF-10 is blocked on owner input — do not dispatch.
- **After PF-01..07 land:** controller runs `build-poem-play-area.cjs --apply` once, owner
  re-imports the new `…+playarea.png`.

## Deliberately out of scope

- Runtime shell↔palette sync (the 4-swatch switcher reskins surfaces only; shell stays on the
  static card theme — status-doc "Known limitations", needs a card-drives-runtime-theme design).
- The shared state-adapter module (spec §6.4; each surface inlines its projection — deferred).
- FP-row shape (looks like an empty bar next to real bars) — owner taste call; keep as-is unless
  the owner asks; noted in PF-04's comments section for the decision.
- P4 motion (owner declined), card-side 立绘/背景 asset sourcing.
