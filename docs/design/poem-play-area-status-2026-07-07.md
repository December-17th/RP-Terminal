# Poem play-area — status & design record, 2026-07-07

**Point-in-time snapshot; supersedes [`poem-play-area-status.md`](./poem-play-area-status.md)
(2026-07-05).** Branch: `ui-facelift` (= `claude/nifty-mcclintock-6e6a1b`, worktree
`.claude/worktrees/funny-burnell-e11355`), head `930f0a3` + this doc. Pushed to
`RP-Terminal/ui-facelift`; **not on `main`** (no PR yet).

---

## 1. The locked design decisions (owner, 2026-07-07)

1. **THREE player-selectable play-area modes** (chosen per session, not a replacement chain):
   - **群像 ensemble** — the v3 band layout. Kept deliberately: the only mode that shows MANY
     portraits simultaneously and a huge panoramic location artwork (the full-width band).
   - **小说 novel** — the v4 "灯下舞台" full-bleed stage
     ([`poem-play-area-redesign-v4.md`](./poem-play-area-redesign-v4.md) §2), intended default.
   - **剧场 theater** — v4 Mode B galgame/ADV (v4 doc §4), optional.
2. **Ensemble ships FIRST** (rev 3): 小说/剧场 implementation deferred; the v4 *surface language*
   (night-glass cards, gilt nameplates, scene tokens, asset resolution) was ported into the v3
   surfaces instead.
3. **Mode B presentation calls** (closed by design review, for when 剧场 builds): gilt speech
   plate anchored to the sprite (no comic bubbles — one signature element, the nameplate,
   reused); 26vh ADV letterbox band; beats fade in ~240ms (no typewriter;
   `prefers-reduced-motion` ⇒ instant); click/Space advance, hold-Space skip, "show full text"
   escape always reachable.
4. **v3 layout rev 2** (owner, same day, after the chain landed): WORLD full height, the user
   portrait merges into the band, SELF becomes a lean stats panel — see §3.
5. **NOT one unified panel.** A literal single-panel interface is impossible while the story
   column is native chat: WCV panels are rectangles compositing ABOVE the window DOM, and the
   region around a native center is L-shaped. The decided mechanism is the seamless multi-slot
   composition (zero gap/chrome + shared scene). A true single panel is the deferred 剧场
   architecture (the card renders everything, no native chat).

## 2. Design-review findings that shaped the work (2026-07-07, rendered pass)

- **WCVs composite above the DOM** ⇒ v4's "sprite tucks behind the story glass" becomes a clip
  at the WCV edge (visually equivalent at 82% glass opacity); ghost-through-glass ensemble
  members don't transfer; the stage-reveal gesture needs a temporary full-viewport overlay.
- **The real AA offender is `--gold-dim` as ≤12px text** (~3:1 everywhere; worst 2.97:1). The
  earlier worry about `--faint` was wrong once backdrops were composited honestly (≥4.9:1).
  Contrast rules now live as the header comment of
  [`poem-themes.css`](../sdk/examples/poem-themes.css).
- **`assetUrl` could never resolve location art**: both card transports hardcoded the
  `'character'` category, so 背景/全景 lookups always missed — found by PM-B6, fixed app-side
  (PM-A6) by inferring category from type via the one shared `categoryForType`.
- Tooling: `preview_screenshot` hangs on heavy `backdrop-filter` pages; computed-style/
  bounding-box assertions are the reliable verification route (recorded in the plan's rules).

## 3. What was built — the implementation chain (all commits on `ui-facelift`)

Dispatched per `.scratch/poem-ui-modes-2026-07-07/` (PRD + per-issue files, worktree-local),
one Opus-4.8 agent per issue, every issue `ready-for-human` with detailed Comments. Gate
(`typecheck` + `check:deps` + `test`) green at every step; final **2060 tests / 221 files**.

| Commit | Issue | What it did |
|---|---|---|
| `77b53b3` | PF-01/04 groundwork | Stage glyph %→vh sizing bug; SELF drawer collapse rework |
| `9ed5a2b` `78e03bb` | docs | v4 design doc + interactive mock; ensemble-first build order |
| `1f831ad` | PM-B1 | Theme swatches docked in the tabs row (HP-row collision gone) |
| `d3b738e` | PM-B2 | Per-palette scene tokens (`--scene-a/-b/-glow`, `--glass`) into `poem-themes.css`; surfaces de-hardcoded |
| `e02b05d` | PM-B7 | **The v4 night-glass language ported to all three v3 surfaces** (glass cards, gilt nameplate backing plates, serif/mono/sans register) — skin only, layout untouched |
| `31fd88d` | PM-B4 | Honest center-axis 好感度 bar (positive right `--q-mythic`, negative left `--ember`, 0 = empty at tick) |
| `a10b31a` | PM-B6 | 地点-driven band art (override → 全景 → 背景 → gradient) + persona-name portrait with 主角 fallback; loud `console.warn` on misses |
| `a7b9771` | PM-A6 | App fix: `assetUrl` category inferred from type in both transports (+4 tests, SDK docs same commit) |
| `395d2c8` | PM-B3 | Scripted WCAG audit; 16 `--gold-dim`→`--gold`/`--dim` bumps (now 6.8–7.4:1); rules block in `poem-themes.css` |
| `d83a96b` | PM-B5 | CJK size audit: 26 pure-CJK labels ≤11px → 12px; 5 numeric/mono runs stay 11px; no overflow |
| `6ad5803` | PM-A4 | App fix: WCVs freeze-frame (capture-while-visible + episode-token cancel) instead of blanking under TopStrip dropdowns; pure controller + 10 tests |
| `450f6c2` | PM-A5 | Titlebar height single-sourced (`--rpt-titlebar-h` + `TITLEBAR_OVERLAY_HEIGHT` in `windowChrome.ts`, paired test); workflow header 4px misalignment fixed; 138px identified as window-controls WIDTH (left as-is) |
| `930f0a3` | PM-B8 | **Layout rev 2** — see below |

### Layout rev 2 (`930f0a3`) — the current v3 grid (12×12, seamless)

```
┌───────────────────────────────────────────────┬───────────┐
│ STAGE [0,0,9,4] — user far-left (你 pill,      │ WORLD     │
│ never speaker) + present NPCs + speaker        │ [9,0,3,12]│
│ nameplate, over 地点-resolved panoramic art    │ 世界      │
├───────────┬───────────────────────────────────┤ 同行      │
│ SELF      │ STORY (native chat)               │ 委托      │
│ [0,4,3,8] │ [3,4,6,8]                         │ (flex-    │
│ idplate + │                                   │  fills)   │
│ stats +   │                                   │           │
│ drawer +  │                                   │           │
│ tabs      │                                   │           │
└───────────┴───────────────────────────────────┴───────────┘
```

- The user portrait moved INTO the band (pinned `USER_X=8%`, cool gilt rim + 你 pill, drawn
  first, never `.active`); PM-B6's persona resolution moved with it.
- SELF lost the portrait band + geometry slicing entirely (dead code removed, grep-verified);
  it is now idplate → stats/FP/gold/chips → fold drawer → tabs. **The drawer expand animation
  is preserved byte-identical** (A/B probed against git-HEAD). Known preview artifact: in a
  bare browser the drawer's `max-height:100%` resolves to 0 (no definite parent height) — 
  pre-existing, works in-app where the WCV slot supplies pixel height.
- WORLD spans full height; the 委托 card flex-fills the extra room.

## 4. Current artifacts

- **Playable card:** `…/命定之诗/v4.2.1+combat+party+duel+playarea-2026-07-07b.png` (rev-2
  layout; the `-2026-07-07.png` one is the pre-rev-2 chain; the 07-05 `+playarea.png` and the
  source are untouched — the asset folder is shared + gitignored, never modify in place).
- **Bundle assembler:** `docs/sdk/examples/build-poem-play-area.cjs` (`--apply [src] [out]`).
- **Plan + per-issue records:** `.scratch/poem-ui-modes-2026-07-07/` (worktree-local,
  deliberately uncommitted; PRD has the ground rules + sequencing, each PM-* file has
  implementation Comments).

## 5. Owner verification pending (the next session's checklist)

1. Rebuild + FULL restart from `ui-facelift` (PM-A4/A5/A6 touch main+preload — no hot-reload).
2. Import `…+playarea-2026-07-07b.png`, open a session. Expect the §3 grid with glass cards.
3. Band art: needs a 全景 (or 背景) asset named exactly after the `世界.地点` value and a 立绘
   named after the persona; console warns the exact keys tried on a miss.
4. TopStrip dropdowns over the play area: panels hold a frozen snapshot (not blank); rapid
   open/close must not flicker (full checklist in PM-A4's issue file).
5. SELF drawer: tabs expand/collapse smoothly in-app (§3 preview-artifact note).
6. Workflow editor header aligns flush with the strip (PM-A5).

## 6. Open / deferred

- **首页 home collapse (PM-F1, needs-info):** blocked on two owner answers — after full load
  does it self-correct without interaction? Is the home the card's own design or bare white?
  (Diagnosis + fix options in the 07-05 status doc §OPEN A.)
- **小说 + 剧场 modes (deferred, specs ready):** restart with PM-A1 (`panel_ui` variants +
  player mode picker) and PM-A2 (`panel_ui.backdrop`), then C1–C3 / D1–D2 / E1 per the PRD.
- **Dead-CSS sweep:** started, candidate list built (`top-nav`/`nav-*`, old shell classes,
  `rpt-agentdetail-*`), triage interrupted — the `react-flow__*` and dynamically-composed
  families (`kind-`, `lvl-`, `rpt-port-`, `tone-`, `is-`) are ALIVE, do not delete them.
- The v1 mock (`poem-play-area-mock.html`) intentionally not updated by the chain (out of
  scope); the v4 mock got the contrast/size fixes.
