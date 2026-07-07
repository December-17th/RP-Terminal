# Poem play-area redesign — build status & COLD-START HANDOFF

**Snapshot 2026-07-05.** Written as a cold-start handoff — the next session resumes with no memory of
this work. Read this top-to-bottom first, then the spec.

- **Spec (design intent):** [`poem-play-area-redesign.md`](./poem-play-area-redesign.md) (§ refs below).
- **Real MVU schema (source of truth for all data):**
  `E:\Projects\FrontEnd-for-destined-journey-TPR-STS\src\data_schema\{schema,utils}.ts`.
- **Branch:** `claude/objective-agnesi-46e41d` — a git **worktree** at
  `E:\Projects\RP Terminal\.claude\worktrees\objective-agnesi-46e41d`, **13 commits ahead of `main`,
  unmerged, no PR**.

### Golden rules (don't trip on these)
1. **The app must run FROM this branch, rebuilt.** Several changes are in `src/main` + `src/preload`
   (Electron main/preload) — they need a **rebuild + full restart**, not hot-reload. Renderer changes
   (`src/renderer`) hot-reload via Vite. From `main` the card loads but **degraded** (chromed panels,
   unaligned backgrounds, no cross-panel events, base-theme leak).
2. **Card asset folder is shared + gitignored — NEVER modify a source in place; always add a new copy.**
   Folder: `E:\Projects\RP Terminal\example sillytarvern character card, presets, extensions and scripts\命定之诗\`.
   It is NOT in the repo (binary artifacts). The build script only ever writes a NEW `…+playarea.png`.
3. **Surface changes require rebuilding the card.** The 3 HTML surfaces are INLINED into the card PNG at
   build time — editing a surface does nothing in-app until you re-run `--apply` (below) and re-import.
4. **Keep RPT generic.** Poem-specific look/data lives in the card (surfaces + theme + panel_ui); RPT
   only gains card-agnostic primitives. Don't hard-code poem stuff into RPT modules.

---

## Commit map (main..HEAD, newest first)

| Commit | What |
| --- | --- |
| `48e67ee` | Readability pass on the 3 surfaces (bump sub-11px → 11px, section labels weight 600, lift `--faint`) |
| `ebec542` | **fix:** `.play-root` paints card bg (theme-leak) + duck WCVs under strip menus |
| `ec6ddb9` | **fix:** composer auto-grow + titlebar-overlay match + transparent inline card iframe |
| `7f97f12` | build: `--apply` mode patches the card PNG to a new copy |
| `13bbebe` | build: play-area bundle assembler + this status doc |
| `efee1f4` | 4 selectable palettes + live switcher |
| `eba0223` | stage: show all present members full-brightness (`DIM_SILENT` flag) |
| `ef8f523` | **P3** WORLD surface + chat prose serif token |
| `071ac7f` | **P2** STAGE band + sibling-event channel |
| `b95ea2d` | **P1** SELF surface |
| `eb6ecde` | **P0** seamless `panel_ui` + panel-geometry host API |
| `e62e1b4` | the redesign spec + persisted mock (design only) |
| `88af494` | (prior) boot-terminal facelift — the base this sits on |

Gate: `typecheck` + `check:deps` + `test` **green at 2026 tests** as of `48e67ee`. Tests added:
`test/staticLayoutChrome.test.ts`, `test/wcvGeometry.test.ts`, `test/cardTheme.test.ts` (+2 cases).

---

## Architecture — three layers

### 1. RPT-generic primitives (reusable by any card)
| Primitive | Files |
| --- | --- |
| Seamless `panel_ui` (`panel_ui.seamless` + per-slot `chrome`) — drops grid gap/padding + panel chrome | `main/types/character.ts`, `renderer/.../workspace/staticLayout.ts` (`slotIsChromed`), `StaticWorkspace.tsx`, `assets/index.css` (`.ws-bare`) |
| Panel geometry — `window.rptHost.getPanelGeometry()` / `onPanelGeometry(cb)` / `rpt:panelgeometry` DOM event. Lets a WCV page slice a full-viewport background by its own window-x (seam continuity) | `main/services/wcvGeometry.ts` (pure), `wcvManager.ts` (push on bounds change + `geometryFor`), `ipc/wcvIpc.ts` (`wcv-get-panel-geometry-sync`), `preload/wcvPreload.ts` |
| Sibling-event channel — `window.rptHost.broadcastEvent(name, payload)` fans a card event to sibling WCVs on the same chat (ctx-resolved, excludes sender), received via `eventOn(name, cb)`. Name opaque → card-agnostic | `ipc/wcvIpc.ts` (`wcv-host-broadcast-event`), `wcvManager.notifyEvent` (+`exceptWebContentsId`), `wcvPreload.ts` |
| Chat prose font token — `--rpt-chat-font-family` on `.message-content`, settable via card theme token `chat-font`/`prose-font` (the story serif register) | `renderer/cardTheme.ts` (ALIAS + guard), `MessageContent.tsx`, `index.css` |
| `.play-root` paints `var(--rpt-bg-primary)` — the play-area backdrop = card bg (fixes the theme leak) | `index.css` |
| Card-theme titlebar sync + strip-menu WCV suppression | `App.tsx` (overlay effect), `TopStrip.tsx` (`useWcvSuppression(open)`), `main/index.ts` (overlay height 44) |

SDK docs updated per the maintenance contract: `docs/sdk/component-inventory.md` §2/§4,
`docs/ui-rehaul-design.md` §6a (the `prose-font` token).

### 2. Card surfaces (`docs/sdk/examples/`, standalone-previewable)
- `poem-self-surface.html` — SELF `[0,0,3,12]`: portrait band (geometry-sliced) + lean stats
  (HP/MP/SP/EXP + FP + gold + status chips) + fold drawer (属性/持有/登神长阶) + tabs + the **4-swatch
  theme switcher**. Emits `self:fold`; owns theme selection (persists per-chat KV `poem.theme`,
  broadcasts `poem:theme`).
- `poem-stage-surface.html` — STAGE `[3,0,9,4]`: present NPCs (`关系列表[*].在场===true`) over the sliced
  background, active-speaker emphasis + nameplate + 正在交谈, scene tag. `DIM_SILENT=false` (all present
  shown bright — flip to re-enable silent-member dimming). Listens `self:fold` (dims stage) +
  `stage:cast-changed`/`poem:theme`.
- `poem-world-surface.html` — WORLD `[9,4,3,8]`: 世界 (`世界.时间/地点`) / 同行 (present `关系列表` +
  `好感度` bar, −100..100→0..100, 命定契约) / 委托 (`任务列表` TaskSchema).
- `poem-themes.css` — shared fonts + tokens + **4 palettes** (dusk 黄昏 / frost 霜垣 / ember 烬火 /
  verdant 苍林). Per-theme = chrome + accent + FP; CONSTANT = resource + rarity colours. `@import`'d by
  all three (inlined at build time).
- `seam-slice-demo/` — P0 pixel-alignment verification page (2 slices).

**Grounded schema keys** (all verified, not guessed): `主角`.{生命值,法力值,体力值 (+上限), 累计经验值,
升级所需经验 (number|'MAX'@Lv25), 金钱, 属性{力量,敏捷,体质,智力,精神}, 属性点, 状态效果{name:{类型,效果,
层数,剩余时间}}, 背包/装备(keyed by item name; `位置`=slot), 登神长阶{是否开启,要素≤3,权能≤1,法则,神位,神国},
生命层级, 等级}. Top-level: `命运点数` (=FP), `世界{时间,地点}`, `关系列表[name]{在场,好感度,命定契约,职业,…}`,
`任务列表[name]{状态,关注度,进展,目标,奖励}`. 品质 tiers: 普通/优良/稀有/史诗/传说/神话/唯一.

### 3. The card bundle (assembler)
`docs/sdk/examples/build-poem-play-area.cjs`:
- **inlines** `poem-themes.css` into each surface → self-contained pages (a `panel_ui` WCV slot serves
  ONE html per slot; relative `@import`/`fetch` don't resolve there);
- **assembles** the `data.extensions.rp_terminal` fragment: `panel_ui` (seamless, entries =
  `data:text/html` URLs, `story` = native `chat`) + `theme` (dusk-gilt shell tokens + `prose-font`);
- writes git-ignored `docs/sdk/examples/dist/` (regenerable — the script is the record).
- **`node build-poem-play-area.cjs --apply`** → merges the fragment into the card's `chara`+`ccv3` tEXt
  chunks (PNG surgery per `patch-poem-card.cjs`), preserving existing `rp_terminal` (combat/left_panel),
  writing a NEW `…+playarea.png`. Default src = `…/命定之诗/v4.2.1+combat+party+duel.png`.
- **APPLIED** → `…/命定之诗/v4.2.1+combat+party+duel+playarea.png` (re-run after any surface edit).

---

## In-app testing — how to run
1. Run the app **from this branch/worktree, rebuilt** (main+preload changes → full restart).
2. Import/select `v4.2.1+combat+party+duel+playarea.png`, open a session.
3. Expect: SELF column (portrait + stats + fold + swatches) · seamless STAGE band across the top ·
   native chat centre (serif) · WORLD column right. Click a swatch → the 3 surfaces reskin together.

---

## In-app pass 1 (2026-07-05) — FIXED
- ✅ **Composer auto-grows** 1→5 lines then scrolls (`ec6ddb9`).
- ✅ **Titlebar overlay** height 48→44 (flush with `.tstrip`), colour tracks active theme (card theme in
  play, else base) (`ec6ddb9`).
- ✅ **The "leaking white/black background"** — root cause: transparent seamless STORY slot fell through
  to the base-theme `<body>` (that's why it flipped white↔black with the APP theme). Fixed by painting
  `var(--rpt-bg-primary)` on `.play-root` (`ebec542`). NOTE: the earlier transparent-iframe change
  (`ec6ddb9`) was a symptom-level attempt; the `.play-root` fix is the real one.
- ✅ **Top-strip dropdowns occluded** by the play area (WCVs paint above DOM) — duck WCVs while a strip
  menu is open (`useWcvSuppression`, `ebec542`).
- ✅ **Readability** — sub-11px text → 11px, section labels weight 600, `--faint` lightened (`48e67ee`).
  (Card content → rebuilt + re-applied.)

## OPEN — next week starts here

### A. 首页 (home) squeezes to a thin strip on load (UNFIXED — needs a decision)
**Symptom:** the card's 首页 (credits/start screen, shown in the STORY chat slot) renders as a tiny
horizontal strip at first; a repaint (the owner noticed a screenshot did it) corrects it.
**Diagnosis:** the 首页 is almost certainly a **viewport-filling `position:fixed`/absolute overlay**,
which has ~zero *in-flow* height. The card frame auto-sizes to *content* height (`WcvMessageFrame` via
`onWcvSlotSize`, or `InlineCardFrame` via its ResizeObserver), so it collapses. The stray repaint fires
a late re-measure once layout settles.
**Two fix options (pick one, then build):**
1. *Low-risk nudge* — schedule a few delayed re-measures after the card loads (in `wcvPreload`'s layout
   bridge and/or `InlineCardFrame`) so it doesn't depend on a stray repaint. Safe, helps any slow card.
2. *Root fix* — treat the 首页 as `fill`-sized (viewport height) instead of `fit`-to-content, since it's
   a full-screen home. More correct for this card; touches the sizing path (`cardFrameHeight`, the
   render-mode resolution in `MessageContent`).
**Need one detail from owner first:** after full load (before any screenshot) does it self-correct on
its own, or only on interaction/resize? And is the home the card's OWN cream/parchment design or bare
white? Answer picks option 1 vs 2 and confirms whether the leak fix already handled its background.
**Relevant files:** `WcvMessageFrame.tsx`, `InlineCardFrame.tsx`, `cardFrameHeight.ts`,
`preload/wcvPreload.ts` (`startLayoutBridge`/`reportHeight`), `MessageContent.tsx` (render-mode split).

### B. In-app verification still pending
Seam alignment SELF↔STAGE (geometry slicing), live MVU reads in all 3 surfaces, cross-panel broadcasts
(`self:fold`, `poem:theme`) — these only work between real sibling WCVs, untested live.

### C. P4 motion (declined) + open the PR when the owner is happy.

---

## Known limitations / deferred
- **Theme sync gap:** the 4-swatch switcher reskins the 3 WCV surfaces, but the native chat (STORY) +
  app shell use the STATIC card `theme` (dusk). Syncing the shell to the picked poem palette would need
  RPT to let a card drive the *runtime* theme (not built).
- **Adapter duplication:** each surface inlines its own `poemState`/`stageState`/`worldState` (spec §6.4
  wants ONE shared module). A shared module needs the same build-time inlining; deferred.
- **Assets:** 立绘/背景 resolve at runtime via `window.assetUrl` → `rptasset://` (World Assets layer),
  not inlined. The card must carry those assets by name convention for portraits to show.
