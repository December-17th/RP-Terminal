# Poem play-area — three player-selectable UI modes (2026-07-07)

**Source:** Owner decision 2026-07-07 + design review 2026-07-07 (rendered pass on the v4 mock at
1360×820, all 4 palettes, interactions exercised; findings in
`docs/design/poem-play-area-redesign-v4.md` §6/§6a). Base branch:
`claude/nifty-mcclintock-6e6a1b` at `9ed5a2b` (= ui-facelift merge `3197016` + PF-01/04 groundwork
`77b53b3` + the v4 docs commit).

**The locked direction:** THREE play-area modes for 命定之诗, chosen by the PLAYER per session:

| Mode | Layout | Why it exists |
|---|---|---|
| 群像 ensemble | v3 band (`docs/design/poem-play-area-redesign.md`) — full-width portrait band + SELF/STORY/WORLD triad | Only mode showing MANY portraits at once + a huge panoramic location artwork |
| 小说 novel (default) | v4 base (`docs/design/poem-play-area-redesign-v4.md` §2) — full-bleed scene, sprite corridors, full-height story glass | Full-height prose + real VN-scale art |
| 剧场 theater | v4 Mode B (v4 doc §4) — ADV letterbox band, beat-by-beat reveal, speech plates | Galgame presentation, optional |

> **RE-SCOPE 2026-07-07 (rev 3, owner):** 小说 (novel) implementation is DELAYED. **Finish 群像
> (ensemble/v3) first**, and **port the v4 UI upgrades into it** (scene tokens, night-glass card
> language, asset resolution, contrast/size discipline). Active now: PM-B1→B2→B7→B4→B6→B3→B5
> (strict order, same files) + PM-A4/A5 (independent app fixes). Deferred: PM-A1/A2/A3,
> PM-C1/C2/C3, PM-D1/D2, PM-E1 (specs stay valid for when novel resumes). PM-F1 still needs-info.
> After the B-chain lands: controller runs `--apply`, owner re-imports and does the in-app pass.

**Intent:** each issue is a self-contained work package for one implementing agent
(**Opus 4.8, medium effort** — name model+effort in the dispatch, e.g. "PM-A1 layout variants
[opus-4.8/medium]"). Agents execute the spec; they don't redesign. If reality contradicts an
issue's grounding, **stop and report**.

## Ground rules (all issues)

1. **Gate:** `npm run typecheck && npm run check:deps && npm run test` green before done.
2. **One issue per commit**, on the current branch; no new branches, no pushing.
3. **Keep RPT generic** — poem look/data lives in the card surfaces (`docs/sdk/examples/poem-*`);
   app-side issues must be card-agnostic and reusable by any card.
4. **Card surfaces are inert until rebuilt.** Editing `poem-*.html` / `poem-themes.css` changes
   nothing in-app until `node docs/sdk/examples/build-poem-play-area.cjs --apply` re-embeds them.
   **Agents do NOT run `--apply` and NEVER touch the card asset folder**
   (`E:\Projects\RP Terminal\example sillytarvern character card…\命定之诗\` — shared, gitignored).
   The controller runs `--apply` once after all surface issues land.
5. **Visual verification for surface issues.** The worktree lives INSIDE the main repo, so the
   simplest route is: `preview_start` (`docs-static`, serves the main checkout root) and navigate
   to `/.claude/worktrees/funny-burnell-e11355/docs/sdk/examples/poem-<x>-surface.html` (or the
   mock under `/docs/design/`). Alternative (PM-B1's route): `npx serve -l <free-port> .` rooted
   at the worktree. Either way leave `.claude/launch.json` unchanged. Resize to the slot size in
   the issue, check all 4 palettes (`?theme=frost|ember|verdant` or the swatches).
   **Tooling gotcha:** `preview_screenshot` can hang on these pages even with
   `*{backdrop-filter:none!important}` injected — prefer `preview_eval` bounding-box +
   computed-style measurement (more accurate for layout anyway); treat screenshots as
   best-effort.
6. **App-side schema/API changes update `docs/sdk/` in the SAME commit** (repo contract —
   `docs/sdk/README.md` has the touch-X-update-Y map). App-side user-facing strings go through
   `t()` + BOTH `en.ts`/`zh.ts` (parity test enforces). Card surfaces carry their own language.
7. **`.scratch/` is NOT actually gitignored in this worktree** (verified with `git check-ignore`,
   despite what the previous PRD said). Never `git add -A` / `git add .`; stage explicit paths
   only. Update your issue file's `Status:` + `## Comments` in place, uncommitted.
8. **Contrast discipline (design review):** any text ≤12px must hit ≥4.5:1 against its real
   backdrop in ALL 4 palettes; `--gold-dim`/`--faint` at 11px generally fail — bump color, size,
   or weight. WCAG-AA is a hard project constraint.

## Architecture decisions the issues rely on (do not relitigate)

- **Mode switching is an RPT-generic primitive**: named layout variants inside `panel_ui`
  (PM-A1). The card declares variants; the app renders a picker; choice persists per session.
  Poem's three modes are three variants in ONE card.
- **The scene backdrop behind the native STORY column is app-painted** (PM-A2, v4 doc §5.1
  option a). Side surfaces keep slicing via the existing `getPanelGeometry` primitive.
- **WCVs composite ABOVE the window DOM** (v4 doc §6a feasibility): sprites "tuck behind" the
  story glass by being CLIPPED at their WCV edge — accepted; rear ensemble actors stay inside
  corridor x-ranges; the §3b stage reveal uses a temporary full-viewport overlay state.
- **剧场 mode is ONE full-viewport card WCV** (no native chat visible): the card renders scene,
  sprites, ADV band, plates, choices, and its own composer internally. Zero seam problems by
  construction. Input send path must be verified against the real runtime surface (PM-D2).
- **Mode B presentation calls are closed** (v4 doc §6.3/6.4): gilt speech plate (no comic
  bubbles); 26vh ADV band; fade-in beats ~240ms, no typewriter; reduced-motion ⇒ instant;
  click/Space advance, hold-Space skip, "show full text" escape always available.

## Issues

| # | Issue | Priority | Scope |
|---|-------|----------|-------|
| PM-A1 | `panel_ui` layout variants + player mode picker | P0 | app |
| PM-A2 | `panel_ui.backdrop` — app-painted scene behind the play area | P0 | app |
| PM-A3 | Chat-column glass: `--rpt-*` token coverage for panel bg/blur | P1 | app |
| PM-A4 | WCV freeze-frame under TopStrip dropdowns (was PF-08) | P1 | app |
| PM-A5 | Titlebar height single-source (was PF-09) | P2 | app |
| PM-B1 | v3 SELF: swatch/HP-row collision (was PF-02) | P1 | card v3 |
| PM-B2 | v3: theme-scoped scenery gradients + avatar placeholders (was PF-03) | P1 | card v3 |
| PM-B3 | Contrast pass, BOTH surface generations (was PF-05 + §6a findings) | P1 | card |
| PM-B4 | 好感度 center-axis bar in v3 WORLD (was PF-06) | P2 | card v3 |
| PM-B5 | CJK ≤11px audit, BOTH generations (was PF-07) | P2 | card |
| PM-B6 | v3 asset resolution: band 背景/全景 by 地点 + portrait by persona name | P0 | card v3 |
| PM-B7 | v3 visual refresh: port the v4 night-glass card language | P0 | card v3 |
| PM-A6 | `assetUrl` category inferred from type (PM-B6 in-app blocker) | P0 | app |
| PM-B8 | v3 layout rev 2: full-height WORLD [9,0,3,12], user portrait into the band [0,0,9,4], lean SELF [0,4,3,8] (owner 2026-07-07). NOTE: a true single unified panel is impossible while story is native chat (rectangular WCVs above DOM); seamless 3-slot composition is the mechanism. | P0 | card v3 + assembler |
| PM-C1 | 小说 SELF corridor surface (user sprite + HUD stack + drawer) | P0 | card v4 |
| PM-C2 | 小说 speaker corridor + WORLD stack surface | P0 | card v4 |
| PM-C3 | 小说 scene resolution (背景/全景 by 地点; portrait by persona name) + stage reveal | P1 | card v4 |
| PM-D1 | 剧场 mode mock (letterbox band + gilt plates over the v4 scene) | P1 | design |
| PM-D2 | 剧场 surface build (beat parser + ADV band + plates + composer/send) | P1 | card v4 |
| PM-E1 | Bundle assembler: 3 layout variants in one card fragment | P0-final | build |
| PM-F1 | 首页 home collapse on load (was PF-10) | needs-info | app |

## Sequencing & conflicts (rev 3 — ensemble first)

- **ACTIVE v3 chain (same files, strict order):**
  PM-B1 (swatch home) → PM-B2 (scene tokens) → PM-B7 (glass language port) → PM-B4 (affection
  axis) → PM-B6 (asset resolution) → PM-B3 (contrast audit) → PM-B5 (CJK size audit).
  Rationale: structural/visual changes land before the two audits, so the audits run once.
- PM-A4/A5 independent, any time. PM-F1 blocked on owner answers — do not dispatch.
- **After the chain:** controller runs `build-poem-play-area.cjs --apply` once (current v3
  single-layout output — PM-E1's variant work is deferred with PM-A1), owner re-imports.
- **DEFERRED until novel resumes:** PM-A1 and PM-A2 first (PM-C1/C2/C3 + PM-E1 depend on both;
  PM-D2 depends on A1); 小说 chain PM-C1 → PM-C2 → PM-C3; 剧场 PM-D1 (design gate) → PM-D2;
  PM-E1 last.

## Deliberately out of scope

- Runtime shell↔palette sync (shell stays on the static card `theme`; needs a
  card-drives-runtime-theme design first).
- The shared state-adapter module (spec §6.4; surfaces keep inlining their projections).
- P4 motion beyond what the mocks already show (owner declined); sourcing real 立绘/背景 art.
- MVU refactoring of any kind.
