# Poem of Destiny — play-area v4 "灯下舞台" (full-bleed stage)

**Status:** Design draft 2026-07-06; **owner decision 2026-07-07 (rev 2): THREE player-selectable
UI modes are LOCKED** — the player chooses per session:
1. **群像模式 (ensemble)** = the v3 band layout (`poem-play-area-redesign.md`) — kept deliberately:
   it is the only mode that shows MANY portraits simultaneously and displays a huge panoramic
   artwork for the current location (the full-width band). Its PF-01/02/04 fixes are back IN scope.
2. **小说模式 (novel)** = the v4 base layout (§2, this doc) — default.
3. **剧场模式 (theater)** = Mode B galgame/ADV (§4) — optional, presentation-only.
v4 does NOT retire v3; the two specs are sibling modes. Remaining §6 items 3–4 resolved by design
review 2026-07-07 (gilt plate; 26vh band, fade-in beats — see §6). Point-in-time doc.
**Mock:** [`poem-play-area-mock-v4.html`](./poem-play-area-mock-v4.html) — interactive (fold tabs,
palette swatches, click a 同行 row to hand the stage to that character). The mock is the source of
truth for base-layout look; this doc records why + the variants still to mock.
**Owner design authority delegated** ("full control of the design of the character card custom ui")
— but Mode B below and the ensemble staging need one more owner pass before build.

---

## 1. Why v3 failed (owner complaints, all verified by rendering)

1. **The story column got squeezed** — the full-width 33% stage band left prose ~55% of the height.
2. **The band's ~4.2:1 aspect is hostile to art** — a 16:9 背景 crops to a sliver; a full-body 立绘
   at 285px tall is a miniature. The band was the root problem, not its tuning.
3. **立绘 never showed** — root cause found: `window.assetUrl` DOES work in WCV panels (runtime
   spread over `wcvHost`; `rptasset://` privileged on the WCV session), but the SELF surface asks
   for the literal name `'主角'` which no imported asset matches, and `img.onerror` silently
   removes the element. Fix: resolve the user portrait by persona name with `'主角'` as fallback;
   add a dev-visible diagnostic for failed lookups.
4. **No background pathway** — the asset layer already has location types (`背景`, `全景` —
   `src/shared/worldAssets/types.ts`), but the stage only read `stat_data.stage.background`, which
   nothing writes. Fix: resolve automatically from `世界.地点` (location name → 背景/全景 asset),
   override via `stage.background`, themed gradient as the final fallback.

## 2. The v4 base layout (as mocked)

**Concept: the whole play area is the scene.** One full-bleed background (cover-cropped 16:9-friendly)
spans everything; characters stand FULL HEIGHT in the side corridors at real VN scale; the info
surfaces float over the scene as night-glass.

```
┌────────────────────────────────────────────────────────────────────┐
│ scene tag ⌜暮·戌时·艾瑟嘉德·大雨⌟                    palette ●●●●   │
│                                                                    │
│ [user     ┌──────────────────────────┐  ┌世界/同行/委托 cards┐     │
│  sprite,  │ STORY — 50% wide, FULL   │  └───────────────────┘     │
│  full     │ height, night-glass      │        [speaker sprite,    │
│  height,  │ (82% tint + blur):       │         full height,       │
│  left     │ chapter head · serif     │   [2nd,  tucks BEHIND      │
│  corridor]│ prose 16.5px/2.0 ·       │   dim]   the story glass]  │
│ ┌────────┐│ choices 壹/贰/叁 ·        │       ┌────────────────┐   │
│ │SELF HUD││ composer                 │       │◤薇拉 nameplate  │   │
│ │(bottom-││                          │       │ 灰隐者·好感64   │   │
│ │left)   ││                          │       │ +正在交谈 pill  │   │
│ └────────┘└──────────────────────────┘       └────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

What this buys, point by point:
- **Story column: full height** (verified 680×820 at 1360×820) — complaint 1 solved. ~37 CJK
  chars/line at 16.5px/2.0 — the ideal prose measure.
- **Background: whole-viewport cover** — a 16:9 image fits naturally. **Sprites: full-height side
  corridors** (25vw ≈ exactly a standing sprite's aspect at 96vh) — complaint 2 solved.
- SELF becomes a **bottom-left HUD card stack** (idplate + HP/MP/SP/EXP + `◆FP · ⛃G` + chips) with
  the fold drawer rising ABOVE it over the (dimmed) user sprite. Tabs are glass buttons below.
- WORLD is a **top-right card stack** (世界 / 同行 with center-axis affection bars / 委托).
- **Signature:** the speaker stands half BEHIND the story glass (corridor sprite wider than the
  corridor, `right:-2vw; width:32vw`) — the one depth cue that sells "one scene behind surfaces".
  The gilt nameplate + 正在交谈 pill sit ON the sprite in the corridor (kept out of the story
  column so it never covers choices).
- Placeholder 立绘 = large ghosted serif glyph (亚/薇/恩), raised so the head zone clears the
  HUD/nameplate; real art replaces at full corridor height.
- Tokens/typography carry over from `poem-themes.css` (4 palettes; data colors constant) + new
  per-theme `--scene-a/-b/-glow` and `--glass` values (already in the mock).

## 3. Multi-character staging (owner requirement, 2026-07-06)

Play can involve SEVERAL present characters interacting at once — the reason the owner wanted a
large portrait area. Two mechanisms, layered:

**3a. Ensemble arrangement (base mode).** Present cast beyond the speaker doesn't crowd into one
corridor: the speaker holds the right corridor (front, lit); up to two more stand progressively
further behind the story glass (`right:20vw`, `right:34vw`, dimmed + desaturated, visible through
the corridor gaps and AS SILHOUETTES behind the glass edges); the rest are avatar chips in 同行.
Clicking a 同行 row hands the front slot to that character (already in the mock). The user sprite
always holds the left corridor.

**3b. "Look up from the page" (stage reveal).** A one-key/one-click gesture (e.g. clicking the
scene tag, or holding Space) temporarily drops the story glass to a thin strip: the FULL ensemble
spreads across the whole width over the background, nameplates on each. Release/click returns to
reading. This gives the "large portrait displayer" moment on demand without permanently taxing the
prose column. (Cheap: it's a CSS state on the same layers.)

## 4. Mode B — the galgame/ADV option (owner proposal, aggressive)

Instead of showing the whole reply as a novel page: **sequential presentation**. The story panel
shrinks to a bottom letterbox band; the portraits own the screen; text reveals beat by beat.

```
┌────────────────────────────────────────────────────────────────────┐
│  [scene, full width]        ⌜薇拉⌟ ○ speech bubble near speaker    │
│  [user]      [恩里克]     [薇拉 lit, front]        [world chips]   │
│                                                                    │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ ADV band (~26vh): narration line(s) · ▸ advance · auto/skip    │ │
│ │ choices appear as overlay buttons when the beat ends           │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

- **Segmentation:** the model's reply is already fully available per floor — split into beats:
  `「…」` quotes attributed to a speaker (attribution = nearest preceding 关系列表 name in the
  paragraph; robust path = the card agent writes `stage.dialogue = [{who, text}, …]` via a
  workflow extractor node), everything else = narration.
- **Presentation:** dialogue beats render as a bubble/plate anchored to the speaking sprite
  (sprite brightens, others dim); narration beats render in the ADV band. Click/Space advances;
  auto-play + "show full text" (fall back to Mode A's column) always available — sequential must
  never trap the reader.
- **HUD/world:** SELF HUD stays bottom-left (shrinks to one row?); WORLD collapses to chips that
  expand on hover — TBD in the Mode B mock.
- **Cost:** presentation-only over stored floors (no storage/format change); streaming can reveal
  beats as they arrive. The beat parser is card-side JS; the app needs nothing new beyond what v4
  already needs.
- **Positioning (LOCKED 2026-07-07, rev 2):** Mode B is one of THREE per-session player-selectable
  modes (群像 ensemble = v3 band / 小说 novel = v4 base / 剧场 theater = Mode B) — the owner is
  explicitly aiming for player-chosen UI modes, not a replacement. Build order: 小说 first (it's
  the substrate: scene, corridors, cast, HUD all shared), 剧场 as the follow-on that swaps the
  center column for the ADV band + bubbles; 群像 already exists (v3 build) and needs its PF fixes.

## 5. App-side primitives needed (RPT-generic, keep-engine-generic compliant)

1. **Backdrop continuity behind the native STORY column.** The side surfaces are WCVs and can
   slice the full-viewport background via the existing `getPanelGeometry` primitive (it provides
   x, y, viewportWidth/Height — verified `wcvGeometry.ts`). The CENTER is native chat. Options:
   (a) app paints the same backdrop on `.play-root` behind everything (new `panel_ui.backdrop`
   asset declaration, card-agnostic) — preferred; the story glass is 82% opaque so tiny mismatches
   vanish; (b) attempt transparent WCVs (spike; if it works, side surfaces stop slicing entirely).
2. **Asset-name conventions, documented:** user portrait = persona name, fallback `'主角'`;
   background = `世界.地点` name (背景 normal / 全景 wide), override `stage.background`; NPC 立绘 =
   character name (+mood). Ship in `docs/sdk/` with the Asset Manager pointing at it.
3. **Story column glass styling** comes from the card theme/css (already supported §6a) — needs
   `--rpt-*` coverage check for the chat column backdrop (blur/tint on the native panel).

## 6. Decisions (all closed 2026-07-07)

1. **OWNER — three modes, player-chosen per session:** 群像 (v3 band — unique: many portraits at
   once + huge panoramic location art) / 小说 (v4 base, default) / 剧场 (Mode B). v3 is NOT
   retired; its PF-01/02/04 fixes are back in scope. PF-03 scenery vars, PF-05 contrast
   discipline, PF-06 affection axis, PF-07 CJK sizes apply to BOTH generations of surfaces.
2. **OWNER — Mode B is IN, optional.** Ensemble staging (§3a) + stage reveal (§3b) are part of
   小说, not a substitute for 剧场. Build 小说 first (substrate), 剧场 follows, 群像 fixes in
   parallel.
3. **DESIGN REVIEW — gilt plate, not comic bubble.** The speech container anchored to the speaking
   sprite reuses the gilt nameplate language (serif text, 「」 quote glyph, thin gold rule,
   night-glass fill with a faint parchment warm-mix) — ONE signature element reused, consistent
   with the ink/gold register; a comic bubble would break the register and read cartoonish over
   the night-glass aesthetic.
4. **DESIGN REVIEW — ADV band 26vh letterbox; beats fade in (no typewriter).** Narration fades
   per beat (~240ms); typewriter is rejected (noisy at 16.5px/2.0 CJK serif, hostile to fast
   readers). `prefers-reduced-motion` ⇒ instant. Advance: click / Space; hold-Space = skip;
   auto-play timer optional; "show full text" always exits to the 小说 column. Bubble plate and
   band tuning are re-checkable in the Mode B mock before its build issue dispatches.

## 6a. Design-review findings 2026-07-07 (rendered pass, all 4 palettes, 1360×820)

Verified interactively in-browser (fold drawer, palette switch, speaker handoff all work):
- **Palette system holds in v4** — per-theme `--scene-a/-b/-glow` reskin the scene coherently in
  ember/verdant (the v3 PF-03 hardcoded-dusk clash is solved by construction in v4; PF-03 still
  needs porting to the v3 surfaces).
- **Contrast:** nameplate name/tag pass AA comfortably; but 11px `--gold-dim` ornaments (e.g.
  `.choice .n` 壹/贰/叁 numerals ≈3.2:1) FAIL AA, and 11px `--faint` meta (`.chap-meta` ≈4.7:1)
  is borderline — v4 surfaces must adopt the PF-05/PF-07 discipline (≥4.5:1 at 11–12px, or
  bump size/weight).
- **Feasibility flag (architecture, affects the build plan):** WCVs composite ABOVE the window
  DOM, so a corridor sprite cannot literally sit BEHIND the native story glass. The tuck-behind
  reads instead as a hard CLIP at the WCV edge = visually equivalent at 82% glass opacity, BUT
  (a) the ghost-through-glass silhouette of rear ensemble members does NOT transfer — rear actors
  must be repositioned inside corridor x-ranges (behind the front sprite) or dropped to 同行
  chips; (b) the §3b stage reveal needs a temporary full-viewport overlay WCV (fine: the story
  glass is collapsed during reveal, so occluding native chat is acceptable).
- **Tooling note:** heavy `backdrop-filter` blur can hang headless capture — mock/CI screenshots
  should disable it; irrelevant to the app.

## 7. Trace / provenance

- v4 mock rendered + iterated 2026-07-06 in-browser at 1360×820 (screenshots in session log):
  fixed placeholder glyph scale/position, moved nameplate out of the story column, added the
  tuck-behind speaker.
- Asset/pathway findings verified against `wcvIpc.ts:552-560`, `wcvHost.ts:138`,
  `thRuntime/index.ts:472`, `worldAssets/types.ts`, `main/index.ts:19-27` (scheme privileges).
- Prior plan `.scratch/poem-ui-fixes-2026-07-06/` — PF-01/02/04 are v3-band-specific and are
  OBSOLETE under v4; PF-03/05/06/07 carry over conceptually; PF-08/09/10 (app-side) unaffected.
