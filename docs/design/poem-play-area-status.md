# Poem play-area redesign — build status & handoff

**Point-in-time snapshot, 2026-07-05.** Spec: [`poem-play-area-redesign.md`](./poem-play-area-redesign.md).
Branch: `claude/objective-agnesi-46e41d` (6 commits ahead of `main`, unmerged, worktree).

## What's built (and where)

### RPT-generic primitives (reusable by any card — committed, tested)
| Primitive | Files | Commit |
| --- | --- | --- |
| Seamless `panel_ui` mode (`seamless` + per-slot `chrome`) | `types/character.ts`, `workspace/staticLayout.ts`, `StaticWorkspace.tsx`, `assets/index.css` (`.ws-bare`) | `eb6ecde` (P0) |
| Panel-geometry host API (`rptHost.getPanelGeometry` / `onPanelGeometry` / `rpt:panelgeometry`) | `services/wcvGeometry.ts`, `wcvManager.ts`, `ipc/wcvIpc.ts`, `preload/wcvPreload.ts` | `eb6ecde` (P0) |
| Sibling-event channel (`rptHost.broadcastEvent`) | `wcvIpc.ts` (`wcv-host-broadcast-event`), `wcvManager.notifyEvent` (+`exceptWebContentsId`), `wcvPreload.ts` | `071ac7f` (P2) |
| Chat prose font token (`--rpt-chat-font-family`, alias `chat-font`/`prose-font`) | `cardTheme.ts`, `MessageContent.tsx` (`.message-content`), `index.css` | `ef8f523` (P3) |

Tests added: `staticLayoutChrome`, `wcvGeometry`, `cardTheme` (+2). Gate green at **2026 tests** /
`typecheck` / `check:deps`.

### Card-side example surfaces (NOT wired to any card — reference/preview only)
All in `docs/sdk/examples/`:
- `poem-self-surface.html` — SELF: portrait band (geometry-sliced) + lean stats + fold drawer + tabs +
  the 4-swatch theme switcher. Emits `self:fold`.
- `poem-stage-surface.html` — STAGE: present NPCs (`关系列表[*].在场`) over the sliced background,
  speaker emphasis, `self:fold` dim link. `DIM_SILENT=false` (all present shown bright).
- `poem-world-surface.html` — WORLD: 世界 / 同行 (好感度 bars) / 委托 (`任务列表`).
- `poem-themes.css` — shared tokens + 4 palettes (dusk/frost/ember/verdant); `@import`'d by all three.
- `seam-slice-demo/` — P0 pixel-alignment verification page.

Each page's `poemState`/`stageState`/`worldState` adapter is grounded in the **real** schema
(`FrontEnd-for-destined-journey-TPR-STS/src/data_schema`): FP = top-level `命运点数`; EXP =
`累计经验值`/`升级所需经验`; 装备 keyed by item name (`位置`=slot); 登神长阶 = 要素≤3→权能≤1→法则; etc.

## Verified vs. NOT verified
- ✅ Unit tests + browser-preview (folds, stats, cast, quests, all 4 themes + live switch **standalone**).
- ❌ **In-app: nothing.** No card's `panel_ui` references these files (`grep` clean), no card declares
  `seamless`, so the running app has no instruction to render any of it. The opt-in RPT primitives are
  dormant without a card using them. This is the gap the bundling work closes.

## What "not viewable in the app" means (diagnosis)
Three independent reasons, any one sufficient: (1) the surfaces are unreferenced `docs/` files — no
`panel_ui` points at them; (2) the RPT primitives are opt-in and no card opts in; (3) the branch is a
worktree 6 ahead of `main` and the `src/main`+`src/preload` changes need a rebuild+restart.

## Remaining work
1. **Card bundling (IN PROGRESS)** — assemble the surfaces into a loadable card: a `panel_ui` (seamless,
   4 slots) + the pages served at reachable `entry` URLs + `theme` tokens (incl. `prose-font`) + fonts +
   立绘/背景 assets + one shared `poemState` module. Open question: how the multi-file pages are served
   to the WCV (the `rpt-card://` scheme serves one HTML per path, so relative `@import`/`fetch` needs an
   external origin or an inlining build). See the bundling notes below (to be filled as this progresses).
2. **In-app verification pass** — seam alignment SELF↔STAGE, live MVU reads, cross-panel broadcasts.
3. **P4 motion** (declined for now) and **PR**.

## Bundling notes

**Delivery mechanism (decided).** The redesign uses a `panel_ui` static grid (NOT the regex-injected
panel that `poem-party-panel` uses). Each WCV slot loads ONE self-contained document, served from the
storage origin (`wcvManager.decodeDataHtml` decodes a `data:text/html,…` entry → `rpt-card://card/<slot>`).
Relative `@import`/`fetch` do NOT resolve there, so the shared `poem-themes.css` must be **inlined** per
page at build time. Assets (立绘/背景) stay external — resolved at runtime via `window.assetUrl` →
`rptasset://` (World Assets layer), so they are not inlined.

**Build (done).** [`build-poem-play-area.cjs`](../sdk/examples/build-poem-play-area.cjs):
- inlines `poem-themes.css` into each of the 3 surfaces → self-contained HTML (verified: the inlined
  page renders + all 4 themes switch, identical to the multi-file source);
- assembles the `data.extensions.rp_terminal` fragment = `panel_ui` (seamless; slots
  `self[0,0,3,12]` wcv · `stage[3,0,9,4]` wcv · `story[3,4,6,8]` **native chat** · `world[9,4,3,8]` wcv,
  entries = `data:text/html` URLs) + `theme` (dusk-gilt shell tokens + the `prose-font` serif register);
- writes `docs/sdk/examples/dist/` (git-ignored — the script is the record, the artifact regenerable):
  `poem-{self,stage,world}.html` + `poem-play-area.rpt.json` (~117 KB).
- Apply: `node build-poem-play-area.cjs --apply [src.png] [out.png]` merges `{ panel_ui, theme }` into
  the card's `chara`+`ccv3` tEXt chunks (PNG surgery per `patch-poem-card.cjs`). **Never in place** —
  the 命定之诗 asset folder is shared across worktrees + gitignored, so it always writes a NEW copy and
  refuses if `out === src`. Default src = `…/命定之诗/v4.2.1+combat+party+duel.png`.
- **APPLIED 2026-07-05** → `…/命定之诗/v4.2.1+combat+party+duel+playarea.png` (source untouched). Verified
  the output card's `rp_terminal` keys = `combat, left_panel, panel_ui, theme` — pre-existing `combat` +
  `left_panel` preserved (Object.assign), `panel_ui` (seamless, 4 slots) + `theme` added. `left_panel`
  (the legacy docked party panel) is inert while a `mode:'static'` `panel_ui` is active (App.tsx renders
  StaticWorkspace, not the resizable Workspace) — no conflict, just unused in this layout.

**Known limitations / follow-ons.**
- The 4-palette switcher reskins the 3 WCV surfaces; the native chat (STORY) + shell use the STATIC
  `theme` (dusk). Syncing the shell to the picked poem palette would need RPT to let a card drive the
  runtime theme (not built) — out of scope for now.
- The 3 pages still carry per-file `poemState`/`stageState`/`worldState` adapters (spec §6.4 wants ONE
  shared module). A shared module needs the same inlining treatment; deferred.
- Not yet done: apply to the real card + the in-app verification pass (seam alignment, live MVU,
  cross-panel broadcasts).
