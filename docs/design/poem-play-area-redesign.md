# Poem of Destiny — Play-Area Redesign & Seamless Multi-Panel Spec

**Status:** Design locked 2026-07-05 (interactive mock approved). Point-in-time spec.
**Build progress:** **P0 RPT seam primitives BUILT 2026-07-05** — (a) seamless `panel_ui` mode
(`panel_ui.seamless` + per-slot `chrome`; `StaticWorkspace` / `staticLayout.ts` / `.ws-bare`); (b)
panel-geometry host API (`window.rptHost.getPanelGeometry()` / `onPanelGeometry` / `rpt:panelgeometry`,
plumbed `wcvManager` → `wcvIpc` → `wcvPreload`; pure contract in `wcvGeometry.ts`). Slicing verification
card: `docs/design/seam-slice-demo/`. Open decision §8.2 (geometry feasibility) is **resolved: feasible**
— the host already knows each slot's window-relative bounds + content size, so §4.2 (recommended) stands,
no fall back to Alt A. Tests: `staticLayoutChrome`, `wcvGeometry`.
**P1 SELF surface BUILT 2026-07-05** (card-side) — [`docs/sdk/examples/poem-self-surface.html`](../sdk/examples/poem-self-surface.html):
portrait band (geometry-sliced) + lean stats (HP/MP/SP/EXP + FP + gold + status chips) + fold drawer
(属性/持有/登神长阶) + tabs; fold collapses the band, stats slide up, drawer fills the freed zone, tabs
pinned bottom. The `poemState(stat_data)` adapter is grounded in the **real** 状态栏 schema
(`FrontEnd-for-destined-journey-TPR-STS/src/data_schema`): FP = top-level `命运点数`; EXP =
`累计经验值`/`升级所需经验`(`MAX`@Lv25); 登神长阶 rendered as its true gate (要素≤3→权能≤1→法则 + 神位/神国),
not fake 0–1 bars; 品质 → the 7 rarity tiers. Reads via `getVariables().stat_data`, re-renders on
`mag_variable_updated`/`message_updated`, portrait via `assetUrl('主角','立绘')`; opens standalone
(mock fallback) for preview. Wire beside native chat with:
`{ mode:'static', seamless:true, grid:{cols:12,rows:12}, slots:[ {id:'self',view:'wcv',entry:'…/poem-self-surface.html',rect:[0,0,3,12]}, {id:'story',view:'chat',rect:[3,0,9,12]} ] }`.
**P2 STAGE band BUILT 2026-07-05** — RPT-generic sibling-event channel + the card `stage` surface:
- RPT: `window.rptHost.broadcastEvent(name,payload)` (WCV) fans a card event to sibling panels on the
  chat (ctx-resolved, excludes sender), received via `eventOn(name,cb)`. Name is opaque → card-agnostic.
  `wcvIpc` `wcv-host-broadcast-event` → `wcvManager.notifyEvent(…, exceptWebContentsId)`.
- Card: [`docs/sdk/examples/poem-stage-surface.html`](../sdk/examples/poem-stage-surface.html) — present
  NPCs over the geometry-sliced background (continuous with SELF's top band), active-speaker bright +
  nameplate + 正在交谈, silent members dimmed; scene tag (时间·地点). Cast = `关系列表[*].在场===true`
  (real signal); speaker = card-authored `stat_data.stage.speaking` else highest-好感度 present;
  scene bg via optional `stat_data.stage.background`. Listens `self:fold` (dims the stage while the
  SELF drawer is open) + `stage:cast-changed`/`mag_variable_updated` (refresh). `self.html` now emits
  `self:fold` on toggle. P2 layout: `self[0,0,3,12]` · `stage[3,0,9,4]` · `story(chat)[3,4,9,8]`.
**P3 WORLD surface + chat serif register BUILT 2026-07-05:**
- Card: [`docs/sdk/examples/poem-world-surface.html`](../sdk/examples/poem-world-surface.html) — the right
  info column: 世界 (`世界.时间/地点`), 同行 (present `关系列表` members + `好感度` bar, mapped −100..100 →
  0..100, 命定契约 mark, avatar via `assetUrl(name,'头像')`), 委托 (`任务列表` TaskSchema: 目标/状态/进展/奖励,
  关注度 → left-border accent). Re-renders on `mag_variable_updated`/`message_updated`. (Mock's 记忆 has no
  schema backing — 事件/新闻 exist but out of scope; noted in the file.)
- RPT (§8.5 resolved): the card `css` currently reaches only card HTML frames (`HtmlFrame`), NOT the
  native markdown prose, and §6a applied only colors — so the serif register needed a small extension.
  Chose the **safe token path** over an arbitrary-CSS escape-hatch (keeps §6a's trust model): new
  `--rpt-chat-font-family` consumed by `.message-content`, settable via the theme token `chat-font`/
  `prose-font` (`cardTheme.ts`). Colored 你/name spans stay the card's display-regex job (already
  supported). Tests: `cardTheme` (+2). Full layout now: `self[0,0,3,12]` · `stage[3,0,9,4]` ·
  `story(chat)[3,4,6,8]` · `world[9,4,3,8]`.
**Play-area palettes BUILT 2026-07-05** — the 3 surfaces are now skinnable across **4 palettes** (dusk
黄昏 / frost 霜垣 / ember 烬火 / verdant 苍林), extracted into one shared token file
[`docs/sdk/examples/poem-themes.css`](../sdk/examples/poem-themes.css) `@import`'d by all three (a palette
is defined once). What varies per theme = chrome (neutrals + text ramp + the destiny accent + ember +
FP); what's **constant** = resource colours (HP/MP/SP/EXP) and the 7 rarity tiers (they encode data,
not mood). Switch via `document.documentElement.dataset.poemTheme`; SELF owns a 4-swatch switcher that
persists to the per-chat KV `poem.theme` and broadcasts `poem:theme` so STAGE/WORLD re-skin live over
the P2 event channel (standalone: URL `?theme=` / localStorage). Adding a 5th theme = one CSS block.
**Next: P4 (motion — speaker-swap transition + fold↔stage dim polish), and card-side packaging (the
`theme` tokens incl. `prose-font`, fonts, assets, and one shared `poemState` module for the 3 pages).**
**Branch context:** work sits on `ui-facelift`. The chrome/IA facelift + §6a card themes are already
committed there (`88af494`); this spec is the *next* body of work and depends on some of it.
**Reference mock:** [`poem-play-area-mock.html`](./poem-play-area-mock.html) — open it in a browser.
It is the v3 "VN stage" design, interactive (click the left fold-tabs 属性/持有/登神长阶). Everything
below describes how to turn that mock into a real, buildable feature.

> **Cold-start note (read me first).** This was written because the implementing session starts a week
> later with no memory of the discussion. The mock is the source of truth for *look & interaction*;
> this doc is the source of truth for *architecture & the decisions still open*. If the mock and this
> doc disagree on a pixel, the mock wins; if they disagree on how it's composed, this doc wins.

---

## 0. What the owner asked for (verbatim intent)

1. Redesign the **play area for the 命定之诗 (Poem of Destiny) card**, with our own distinctive UI.
2. **Hard requirement:** the message (story) area is in the **center** and takes **exactly 50%** —
   confirmed to mean **50% of the width** (the center column). Verified in the mock at 680/1360.
3. **Galgame presentation:** reserve the **top** of the layout for character portraits — the **user's
   portrait** on the left and the **present character(s)** on the right — visual-novel style, over a
   **background**. Make it **multi-character**, and let the stage **extend across the full width**,
   "all the way to the user portrait" (one continuous stage, not boxed per-column).
4. **Lean always-on stats:** show only **HP, MP, SP, FP, EXP, status effects, and gold** normally.
   Fold everything else (attributes, inventory, ascension ladder) into **sub-menus**.
5. **Fold interaction:** opening a sub-menu **collapses the portrait, slides the stats up, and expands
   the sub-menu content into the freed portrait zone.**
6. **Seamlessness (key constraint):** it is fine to compose the play area from **multiple WebContentsView
   (WCV) panels**, **but the seams between them must be invisible** — the VN stage in particular must
   read as one continuous surface.
7. **Keep RPT generic** (standing project rule): all Poem-specific look/terminology/content is delivered
   **by the card** (theme + panel_ui + assets + card-authored UI), never hard-coded into RPT modules.
8. MVU: an evaluation was done (don't drop it, demote it to a compat adapter over an owned typed store)
   but the owner said **ignore MVU for now** — out of scope here.

---

## 1. The design (what it looks like)

A fixed **SELF | STORY | WORLD** triad at **25% / 50% / 25%**, with a **full-width VN stage band across
the top** holding multiple characters over one shared dusk background.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  VN STAGE  (full width, one continuous dusk background, ~33% of height)     │
│  [亚瑟 you]                 [恩里克 dim]            [薇拉 active + nameplate] │
├───────────────┬──────────────────────────────────┬────────────────────────┤
│ SELF (25%)    │           STORY (50% width)       │   WORLD (25%)          │
│               │                                   │                        │
│ HP ▓▓▓▓▓ 380  │  第三章 · 黄昏的抉择   复兴纪元·暮   │  世界                   │
│ MP ▓▓▓▓▓ 100  │                                   │   时辰 暮·戌时          │
│ SP ▓▓▓▓  140  │  <serif second-person narration>  │   地点 艾瑟嘉德          │
│ FP ▓▓▓   500  │  你 … 薇拉 …                       │   天候 大雨             │
│ EXP ▓▓▓▓ 7.2k │                                   │  同行                   │
│ ⛃1250G [战斗祝福]│  ▸ choice 1                       │   薇拉 ▓▓▓  恩里克 ▓▓    │
│               │  ▸ choice 2                       │  委托 / 记忆            │
│ [属性][持有][登神]│  ▸ choice 3                       │                        │
│               │  [ 你要做什么？        ➤ ]         │                        │
└───────────────┴──────────────────────────────────┴────────────────────────┘
```

### 1.1 The VN stage band (top)
- **One continuous background** spanning the full width (a dusk/location scene from card assets).
- **Multiple character 立绘** placed over it: the **user** on the far left, **present NPCs** across the
  center and right. The **active speaker** is bright + has a nameplate ("薇拉 · 灰隐者 · 好感 64") and a
  "正在交谈" tag; **present-but-silent** party members are dimmed (`opacity .4; saturate .5`).
- Band height ≈ **one third of the play-area height** (mock uses `--band-h: 284px` at 820px tall; in the
  real grid it is `rowSpan 4 / 12 ≈ 33%`, so it scales with the window).
- The band's bottom edge **fades into the columns** (a `linear-gradient(..., transparent, night)` at the
  bottom of the background) so there is no hard line.

### 1.2 SELF column (left 25%)
- **Top:** the user's portrait (its slice of the stage band) with a nameplate ("亚瑟 · 你 · 史诗 · Lv 12").
- **Always-on stats (only these):** HP, MP, SP, FP, **EXP** bars (mono values), **gold** (⛃ 1250 G), and
  **status-effect chips** (战斗祝福 · 12). Nothing else is shown by default.
- **Fold-tabs (bottom):** `属性` (attributes) · `持有` (inventory) · `登神长阶` (ascension ladder).

### 1.3 STORY column (center, exactly 50% width)
- Card-styled **narration** (serif, second-person 你 in destiny-gold, NPC names in rare-blue), **choice
  options**, and the **composer**. This is the *message area* the 50% requirement refers to.
- **Generation stays native** (see §4.5): this is RPT's real chat, *styled* by the card — not a
  re-implemented chat loop.

### 1.4 WORLD column (right 25%)
- **Top:** the present-character's slice of the stage (the active NPC 立绘 + nameplate).
- **Below:** 世界 (time / location / weather), 同行 (party with relationship bars), 委托 (quests), 记忆 (memory).

### 1.5 The fold interaction (exact behavior in the mock)
Opening a fold-tab (e.g. 持有):
1. the **user portrait collapses** (`max-height 284px → 0`, 0.4s ease),
2. the **stats block slides up** to the top (natural flex reflow as the portrait shrinks),
3. the **sub-menu drawer expands into the freed zone** (`max-height 0 → 100%`, opaque `--night`
   background so it covers the portrait/background beneath),
4. clicking the active tab again reverses it (portrait returns).
The **other characters on the stage stay put** — only the user's segment closes.

### 1.6 Visual language (all card-delivered)
- **Palette (dusk-gilt):** `--night #14121b`, `--raise #1d1a27`, `--sunken #100e16`, `--line #2e2a3d`,
  **`--gold #d9b56b`** (destiny accent), `--text #e9e3d4` (warm parchment), `--dim #a89f8c`,
  `--ember #c8683f`. Resource colors: HP `#cf5a6d`, MP `#6a86d8`, SP `#5fb98a`, FP `#d9b56b`,
  EXP `#a274e0`. 7 rarity tiers: common `#b8b0a0`, uncommon `#6fae72`, rare `#5f90d8`, epic `#a274e0`,
  legendary `#d9b56b`, mythic `#d76b8f`, unique `#e0913f`.
- **Type:** serif display (`Noto Serif SC`) for names + narration, sans body (`Noto Sans SC`),
  **mono for all numbers** (`ui-monospace`).
- **Signature:** the galgame stage itself + the destiny-gilt life-tier nameplates. (An earlier v1 used a
  circular "destiny seal" medallion; v2/v3 replaced it with the portraits per owner.)
- These are shipped as the card's **`theme` tokens** (the §6a pipeline — see §4.5) + **fonts** + **assets**.

---

## 2. Data contract (what the HUD reads, and from where)

The HUD is a **projection of session state**. For the Poem card that state is MVU `stat_data` today
(carried on each floor's `variables.stat_data`; see `mvuParser.ts`). The HUD should read a **typed view**
of it — do NOT scatter raw path lookups through the UI. Define one adapter `poemState(stat_data)` → the
shape below, so a future state-pipeline change (the parked MVU work) only touches the adapter.

```ts
interface PoemHudState {
  self: {
    name: string; portraitAsset: string; lifeTier: string /* 史诗… */; level: number; gold: number
    hp: Bar; mp: Bar; sp: Bar; fp: number; exp: Bar           // Bar = { value: number; max: number }
    status: Array<{ name: string; turns?: number; kind: 'buff'|'debuff' }>
    attrs: Record<string,'力'|'敏'|'体'|'智'|'精' extends never ? number : number> // 力敏体智精 → number
    inventory: Array<{ name: string; rarity: Rarity; slot?: string; qty?: number }>
    ladder: { element: number; power: number; law: number }   // 登神长阶, 0..1 each
  }
  cast: Array<{                                                 // who is ON STAGE right now
    id: string; name: string; tag: string; portraitAsset: string
    role: 'self'|'ally'|'foe'|'neutral'; speaking: boolean; affinity?: number; dim: boolean
  }>
  scene: { backgroundAsset: string; time: string; location: string; weather: string }
  world: { party: NpcRel[]; quests: Quest[]; memory: string[] }
}
```

**Who is "present"/"speaking"** is the one genuinely new signal the card must maintain in state (the
existing 命定之诗 card tracks characters + relationships but may not tag *on-stage* / *speaking*). The
card's agent/prompt should write a small `stage` block (`present: id[]`, `speaking: id`, `background`) per
turn. If it can't, fall back: infer "present" from the last floor's mentioned characters and "speaking"
from the last dialogue attribution — but a card-authored signal is far more stable.

---

## 3. RPT composition primitives (grounded in code)

- **`panel_ui`** (`src/main/types/character.ts` → `RPTerminalExtSchema.panel_ui`): the card declares
  `{ mode:'static', grid:{cols,rows}, slots: [{ id, view, rect:[col,row,colSpan,rowSpan], entry?, title? }] }`.
  `view` is a native view id (`chat`, `status`, …) **or** `'wcv'` + an `entry` URL. Consumed by
  `App.tsx` → `StaticWorkspace`.
- **`StaticWorkspace`** (`src/renderer/src/components/workspace/StaticWorkspace.tsx`): renders a CSS grid
  `repeat(cols,1fr) / repeat(rows,1fr)` with **`gap:6` + `padding:6`**, and wraps every slot in a
  **`.ws-panel`** (border, radius) with a **`.ws-panel-head`** title bar. ⚠️ **These are the seams.**
- **`WcvPanel`** (`.../workspace/WcvPanel.tsx`): mounts an out-of-process `WebContentsView`, positioned to
  match its host `<div>`'s window rect (reported via `window.api.wcvEnsure` / `wcvSetBounds` on
  resize/layout change). ⚠️ **The WCV paints OPAQUELY over the div and ignores DOM z-order** (see also
  `useWcvSuppression` — WCVs cover modals). So "put a shared background in the renderer behind the WCVs"
  does **not** work; the background must live *inside* the WCV surfaces.
- **Card theme (§6a)** already built: `src/renderer/src/cardTheme.ts` derives play-mode tokens from the
  card's `theme` and applies them to the `.play-root` wrapper (App.tsx). The Poem palette rides this.

---

## 4. Architecture — how to build it seamlessly

### 4.1 The seam problem, precisely
Two independent WCV surfaces cannot share a DOM background (WCVs are opaque overlays). So a stage that
spans multiple WCVs will show a hard edge **unless** either (a) it is a **single** WCV, or (b) each WCV
**redraws the same full-width background offset by its own screen-x** ("background slicing") so the slices
line up into one image. Additionally, RPT's `StaticWorkspace` adds a 6px gap + panel chrome that must be
**suppressed** for stage slots.

### 4.2 Recommended layout (grid math) — "full-height SELF + center/right stage band"
`grid: { cols: 12, rows: 12 }`, slots:

| slot     | view    | rect `[col,row,colSpan,rowSpan]` | width | notes |
|----------|---------|----------------------------------|-------|-------|
| `self`   | `wcv`   | `[0, 0, 3, 12]`  | 25% | **full height**; owns portrait (top) + stats + fold drawer + tabs → the fold works in ONE surface |
| `stage`  | `wcv`   | `[3, 0, 9, 4]`   | 75% × ~33% | the center+right top band; the NPC 立绘 over the shared background |
| `story`  | `chat`  | `[3, 4, 6, 8]`   | **50%** | native chat, lower-center — the message area (hard req satisfied: colSpan 6 = 50%) |
| `world`  | `wcv`   | `[9, 4, 3, 8]`   | 25% | world info (time/party/quests/memory) |

The **continuous stage** across the top row (rows 0–3) is formed by two surfaces: the top of `self`
(cols 0–2) and `stage` (cols 3–11). They read as one because both draw the **same full-width background
sliced to their x-range** (§4.4). Characters are placed **within** a surface's bounds (user in `self`'s
25%, NPCs anywhere in `stage`'s 75%) so no sprite straddles the seam.

Why this shape:
- **Message = exactly 50% width** (`story` colSpan 6). ✔
- **Fold-into-portrait works exactly** because `self` is one full-height surface. ✔
- **Multi-character across center+right** (the `stage` surface is continuous over 75% of the width). ✔
- **Generation stays native** (`story` = the `chat` view). ✔

### 4.3 Alternative layouts (documented; not recommended, but decide consciously)
- **Alt A — single full-width stage band `[0,0,12,4]` + separate `self` stats `[0,4,3,8]`.** Simplest
  seam story (one band WCV, no slicing needed, characters anywhere incl. dead-center). **Cost:** the fold
  can no longer grow *into* the portrait (portrait is in the band WCV, stats in a different slot); the
  fold would expand within the stats slot and, at most, emit an event that dims the user's sprite in the
  band. Pick this if the exact fold-into-portrait is not worth the slicing work.
- **Alt B — full "takeover": one WCV for the entire play area**, card renders stage+stats+story+world and
  drives generation via the TH runtime API (send / stream / history / swipes). Highest fidelity + fully
  seamless (one surface), but the card must re-implement the message loop and RPT must expose a robust
  enough TH chat API. This is the roadmap "full-takeover viewport mode." Pick this only if we commit to
  that mode; otherwise §4.2 keeps native chat and is far cheaper.

### 4.4 Seamlessness mechanism — background slicing (the enabling primitive)
Each stage-participating WCV renders the **same** background image, positioned by its own screen offset:
```css
.stage-bg {
  background-image: var(--scene-url);
  background-size: var(--vw) var(--band-h);     /* full VIEWPORT width, band height */
  background-position: calc(-1 * var(--panel-x)) 0;
}
```
For this the WCV page needs its **panel geometry**: `panel-x` (its left edge in window coords), the
**viewport width** `--vw`, and the band height. Today `WcvPanel` sends the rect to **main** (to place the
view) but does **not** hand it to the **page**. → **New host API required** (§5, item 2). With it, the
`self`-top and `stage` surfaces align pixel-perfectly and the band is seamless. (An earlier idea — a
native renderer background showing through transparent WCVs — is **rejected**: WCVs are opaque and cover
DOM; even with WCV transparency, z-order between a DOM layer and a WCV is not controllable here.)

### 4.5 Where each piece lives (keep-RPT-generic)
- **Card extension (the Poem card):** the `panel_ui` declaration; the WCV pages for `self`, `stage`,
  `world` (HTML/CSS/JS using the card runtime `window.rptHost` + ST/Mvu globals via `wcvPreload`); the
  `theme` tokens; fonts; and assets (立绘 per character + scene backgrounds). The `poemState()` adapter.
- **RPT (generic, reusable by any card):** the `panel_ui` seamless mode; the panel-geometry host API; the
  present/speaking + fold host events; applying the card `theme` to the **native chat** message DOM so the
  center reads in the card's serif register (extend §6a: today §6a themes tokens on `.play-root`; the chat
  message container already inherits those tokens — additionally allow the card's scoped `css`/display
  regex to style `.floor-block`/prose, which RPT already supports via display-regex beautification).
- **Center message:** native `chat` view. Do **not** rebuild chat in a WCV (Alt B only). The Poem look on
  the message comes from card theme tokens + the card's display-regex/CSS beautification (the same
  mechanism the 艾莉亚 beautification uses).

---

## 5. Required RPT changes (the enabling work — a checklist)

1. **Seamless `panel_ui` mode.** Add an opt-in (e.g. `panel_ui.seamless: true` or per-slot
   `chrome:false`) so `StaticWorkspace` drops `gap`/`padding` and renders bare slots (no `.ws-panel`
   border/radius, no `.ws-panel-head`) for stage slots. Grounding: `StaticWorkspace.tsx` lines ~48–78.
   Keep the default (chromed) behavior for existing cards.
2. **Panel-geometry host API (for background slicing).** Expose to each WCV page its window rect +
   viewport size, updated on resize/layout: `window.rptHost.getPanelGeometry()` →
   `{ x, y, width, height, viewportWidth, viewportHeight }`, plus a `panelgeometry` event. Plumb from
   `WcvPanel` (it already computes the rect for `wcvEnsure`/`wcvSetBounds`) through `wcvPreload`.
   **This is the one non-trivial new primitive; verify feasibility first (spike).**
3. **Stage/HUD host events (card-agnostic).** A tiny event channel so the card's WCV surfaces coordinate:
   `stage:cast-changed` (present/speaking/background), and a `self:fold` event (open/close + which menu)
   so a stage surface can react (e.g. dim the user sprite when the SELF fold opens). Reuse the existing
   host-broadcast bridge (`cardBridge/hostBroadcast` / `wcvBroadcastVars`) rather than a new transport.
4. **Card theme on the native chat message DOM.** Confirm the §6a tokens reach the `chat` view (they
   should, via `.play-root`), and allow the card's scoped `css` to target the message/prose containers so
   the center reads in the serif register. Small extension of §6a's deferred `css` escape-hatch (which is
   already on the follow-up list) — scope it to `.play-root` and the chat body.
5. **(Only if Alt B / full-takeover is chosen)** a robust TH chat API surface: submit a turn, stream
   tokens, read history, swipes/edit — enough for a card to own the message loop. Larger; defer unless we
   commit to takeover.

---

## 6. Card-side deliverables (the Poem card extension)

1. `panel_ui` per §4.2 (with the seamless flag).
2. Three WCV pages:
   - **`self.html`** — portrait (top) + stats (HP/MP/SP/FP/EXP + gold + status) + fold drawer
     (属性/持有/登神长阶) + tabs. Owns the fold animation (mock CSS is directly reusable). Reads
     `poemState().self`; renders its stage-background slice at the top via the geometry API.
   - **`stage.html`** — the NPC 立绘 over the shared background slice; active-speaker emphasis; nameplates.
     Reads `poemState().cast` + `.scene`; listens to `stage:cast-changed`.
   - **`world.html`** — 世界/同行/委托/记忆. Reads `poemState().world` + `.scene`.
3. `theme` tokens (the dusk-gilt palette above), fonts, and assets (`<char>_立绘.png`, `<scene>_bg.png`)
   — assets ride the card's asset layer (`rp_terminal.assets` / `rptasset://`).
4. `poemState(stat_data)` adapter (card-side), so all three pages read one typed shape.

**Reuse the mock:** `docs/design/poem-play-area-mock.html` already contains production-quality CSS for the
stats bars, fold drawer + animation, rarity dots, nameplates, ladder, and the stage background. Split it
into the three WCV pages; the geometry API replaces the mock's single shared `.vn-bg` element.

---

## 7. Build phases (each independently landable, tests green at each step)

- **P0 — RPT seam primitives (spike + build):** (a) seamless `panel_ui` mode; (b) panel-geometry host
  API + slicing demo (two adjacent WCVs showing one continuous image). Ship with a throwaway 2-slice test
  card. **Gate P0 before any Poem UI work** — it de-risks the whole thing.
- **P1 — SELF surface:** portrait + lean stats + fold, as a WCV in a `[0,0,3,12]` slot beside native
  chat. No stage band yet. Validates the fold + stats against real MVU state.
- **P2 — STAGE band:** the `stage` WCV with cast/scene from state, slicing-continuous with SELF's top.
  Add the `stage:cast-changed` + `self:fold` events.
- **P3 — WORLD surface + theme polish:** world info WCV; card theme on the native chat message DOM (serif
  register); asset wiring.
- **P4 — motion:** speaker-swap transition (dim/step-back + cross-fade) and the fold↔stage dim link.

---

## 8. Open decisions & verifications for next session (do these first)

1. **Layout choice:** §4.2 (recommended: exact fold, needs slicing) vs Alt A (simplest, approximate fold)
   vs Alt B (full takeover). Default to **§4.2** unless the geometry API spike (P0) proves too costly.
2. **VERIFY the geometry API is feasible** — can a WCV page reliably learn its window-x + viewport width,
   updated on resize, through `wcvPreload`? This gates §4.2 vs Alt A. (If not, fall back to Alt A.)
3. **50% = width vs area.** Confirmed *width* in the mock; the top band reduces the message's *height*
   (classic VN tradeoff). If the owner ever means 50% *area*, revisit the whole arrangement (e.g. sprites
   overlaid behind the story rather than a band above it).
4. **Present/speaking signal:** does the current 命定之诗 card already emit on-stage/speaking, or must the
   card's agent be extended to write the `stage` block? (§2.)
5. **Native-chat styling reach:** confirm the card's scoped `css`/display-regex can reach `.floor-block`
   prose so the center reads serif (part of §6a css-escape-hatch follow-up).

---

## 9. References
- Mock (persisted): `docs/design/poem-play-area-mock.html` (v3; open in a browser, click the left tabs).
- RPT primitives: `src/main/types/character.ts` (`RPTerminalExtSchema.panel_ui`),
  `src/renderer/src/components/workspace/StaticWorkspace.tsx`, `.../workspace/WcvPanel.tsx`,
  `src/renderer/src/cardTheme.ts` (§6a), `src/renderer/src/components/App.tsx` (`.play-root` + static layout).
- Card runtime seam: `src/shared/thRuntime`, `wcvPreload`, `cardBridge/hostBroadcast` (host events/vars).
- MVU (parked): `src/main/parsers/mvuParser.ts`. Evaluation summary lives in the session memory
  `rpt-ui-overhaul-2026-07.md`.
- Related design: `docs/ui-rehaul-design.md` (§6a card-bundled themes), `docs/world-card-design.md`.
```
