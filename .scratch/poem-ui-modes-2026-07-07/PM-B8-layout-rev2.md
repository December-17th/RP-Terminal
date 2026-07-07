# PM-B8 — v3 layout rev 2: full-height WORLD, user joins the band, lean SELF

Status: ready-for-human
Priority: P0 (owner request 2026-07-07, post-merge)
Dispatch: opus-4.8/medium
Scope: card v3 surfaces (all three) + the assembler layout fragment
Owner intent (verbatim): expand the world/quest panel all the way to the top (shrink the main
portrait panel); split the user panel — stats/items stay, user portrait merges into the main
portrait band; keep the stats/items expand animation.

## New grid (12×12, seamless — old → new)

| Slot | Old rect | New rect |
|---|---|---|
| stage | [3,0,9,4] | **[0,0,9,4]** (full top-left; now includes the USER portrait) |
| self  | [0,0,3,12] | **[0,4,3,8]** (stats/items only, no portrait band) |
| story (chat) | [3,4,6,8] | [3,4,6,8] (unchanged) |
| world | [9,4,3,8] | **[9,0,3,12]** (full height) |

Rects live in the assembler (`docs/sdk/examples/build-poem-play-area.cjs` — the `panel_ui`
fragment). Update the layout comment there and any doc line in the two files' headers that
states the old rects.

## Surface changes

1. **STAGE (`poem-stage-surface.html`):** add the USER as a band member at the far LEFT,
   visually distinct from NPCs (stable position, never the "active speaker"): portrait resolved
   by persona name with `'主角'` fallback + warn — REUSE the exact resolution PM-B6 built in
   `poem-self-surface.html` (move/copy that code here; it leaves SELF in step 2). Ghost-glyph
   placeholder on miss (first char of persona name). The `self:fold` listener that dims the
   stage stays — with the user now in the band, fold-open dims the user's own sprite too, which
   is the v4 mock's behavior anyway. Cast layout: user pinned far left; present NPCs spread over
   the remaining width as today; keep the speaker emphasis + nameplate logic untouched.
2. **SELF (`poem-self-surface.html`):** remove the portrait band + its geometry slicing + the
   band's collapse mechanics. The panel becomes: identity plate at top (the PM-B7 gilt idplate,
   now a normal card at the top of the stats stack — user name/Lv/tags move here from the old
   band overlay), then stats/FP/gold/chips card, then the fold drawer + tabs (with the PM-B1
   swatches). **KEEP the drawer expand/collapse animation exactly as it behaves now**
   (max-height/opacity transition from 77b53b3) — opening a tab expands the drawer over the
   freed space between stats and tabs; there is no portrait to collapse anymore, the stats stay
   put (owner: "user stats/item stays where it is"). Remove now-dead band CSS/JS (scene
   gradient, getPanelGeometry slicing, portrait <img> wiring) — do not leave orphans.
3. **WORLD (`poem-world-surface.html`):** now 340×820 (was 340×547). No structural change
   required; verify the three cards breathe at the taller size (the 委托 list gets the extra
   room — if the sections currently hard-cap or look stranded, let 委托 flex to fill; keep the
   card stack cadence).

## Constraints

- All prior chain rules hold: PM-B3 contrast rules (poem-themes.css header), PM-B5 sizes (no
  pure-CJK <12px), tokens only, no new hex literals, resource/rarity colors constant.
- `poem:theme` broadcast/persist (SELF owns swatches) and `stage:cast-changed`/
  `mag_variable_updated` wiring stay intact.
- Do NOT restructure into fewer/one WCV panel — the three-rectangle seamless composition is the
  decided mechanism (a native chat center makes a true single panel impossible; recorded in the
  PRD).

## Verification (PRD rule 5)

preview_start (docs-static) → /.claude/worktrees/funny-burnell-e11355/docs/sdk/examples/…
- stage at 1020×273: user far left + NPCs + speaker nameplate; user resolves/falls back; fold
  event dims.
- self at 340×547 (its new height at 1360×820 ≈ 8 rows): idplate + stats + drawer expand
  animation on each tab, swatches functional, all 4 palettes.
- world at 340×820: no overflow, 委托 fills.

## Acceptance

New rects in the assembler fragment; user portrait lives in the band; SELF has no portrait but
keeps the animated drawer; WORLD clean at full height; all palettes; gate green at 2060/221 or
higher.

## Comments

Implemented in commit `930f0a3` (4 files, +189/-182). Gate green:
`typecheck` clean · `check:deps` clean (394 modules, no violations) · `test` 2060 passed / 221 files.

**Assembler (`build-poem-play-area.cjs`)** — slot rects updated to the rev-2 grid and the layout
comment rewritten:
- stage `[3,0,9,4]` → `[0,0,9,4]`, self `[0,0,3,12]` → `[0,4,3,8]`, story `[3,4,6,8]` unchanged,
  world `[9,4,3,8]` → `[9,0,3,12]`. Verified in `dist/poem-play-area.rpt.json` after a no-`--apply`
  build. Slot ordering in the array is now stage, self, story, world (verify still asserts 4 slots).

**STAGE (`poem-stage-surface.html`)** — the USER joined the band:
- Added `.fig.user` / `.fig-ph.user` (cool gilt rim vs the warm NPC glow) + a `.user-tag` "你" pill
  (gold fill, --night text, 12px — mirrors the `.np-live` pattern, AA-safe all 4 palettes).
- `renderUser()` pins the user at `USER_X = 8%`, drawn FIRST so NPCs layer over it if they crowd;
  it is NEVER given `.active` and never gets a nameplate/正在交谈 pill. NPC spread narrowed to
  `lo=30..hi=90` (`xFor`) to clear the far-left anchor.
- `loadUserFig()` + `personaName()` are the exact PM-B6 resolution moved from SELF: persona name
  first, `'主角'` fallback, ghost glyph (first char of persona) + ONE `console.warn` on total miss.
- Standalone stub extended: `?persona=`, `?userart=persona|主角|none`, plus a `SillyTavern`
  substituteParams stub, so all three resolution paths preview in a bare browser.
- The `self:fold` listener is untouched — fold-open still dims the whole stage (now incl. the user's
  own sprite, which is the v4 mock behavior). Header rect/prose comments rewritten to `[0,0,9,4]`.

**SELF (`poem-self-surface.html`)** — portrait band removed, lean stats panel kept:
- Deleted: `.band` / `.scene` / `.fig` / `.fig-ph` / band `.nameplate` overlay CSS; the `:root`
  `--band-h/--vw/--panel-x` fallbacks; `.self.open .band` collapse; `loadPortrait()`; `applyGeometry()`
  and the getPanelGeometry seed/subscribe block; the `assetUrl` stub; the `figPh` glyph line in
  `renderNameplate`. Grep confirms zero dead `band/scene/fig/geometry/assetUrl` references remain
  (only doc-comment mentions).
- Added: `.idplate` night-glass card (v4 mock treatment — gilt left bar, name + 你·层级·Lv·评级 tag)
  promoted to the TOP of the stats stack. Stats card margin adjusted so idplate → stats → drawer →
  tabs stack cleanly; stats stay put (no portrait to collapse).
- **Drawer animation preserved byte-identical.** A/B probe of git-HEAD `orig-self.html` vs the new
  inlined `poem-self.html` returned identical drawer state on open (opacity/maxHeight/padding/
  clientH/scrollH all equal) — the 77b53b3 `max-height/opacity` transition is unchanged. Note: in a
  standalone browser the flex parent has no definite height so `max-height:100%` resolves to 0 and the
  drawer doesn't visibly expand — this is a PRE-EXISTING preview artifact (identical in the original),
  NOT a regression; in-app the WCV slot gives a definite pixel height and the reveal works.

**WORLD (`poem-world-surface.html`)** — verified at full height:
- Only change: `.world > div { flex: 0 0 auto }` + `.world > div:last-child { flex: 1 1 auto; min-height: 0 }`
  so the 委托 card fills the extra room; header rect comment → `[9,0,3,12]`.
- At 340×820: no overflow (`scrollH === clientH`), cards 世界 100 / 同行 230 / 委托 440px, 委托
  `flex-grow:1`. Clean in all 4 palettes.

### Verification matrix (preview via docs-static; iframe harness for the query-driven stubs, since the
static server strips `.html` + query strings — computed-style/bounding-box asserts per PRD rule 5)

| Surface | Size | Checks | Result |
|---|---|---|---|
| STAGE | 1020×273 | user far-left + 2 NPCs + speaker 薇拉 nameplate/正在交谈; user not active | PASS |
| STAGE | 1020×273 | persona-hit 立绘 → img@8%, glyph hidden, no portrait warn | PASS |
| STAGE | 1020×273 | 主角-fallback hit → img@8%, glyph hidden, no portrait warn | PASS |
| STAGE | 1020×273 | total miss → glyph "A"@8% kept + warn `[poem-stage] no 立绘 … keeping the glyph` | PASS |
| STAGE | — | 你 pill 12px, gold-on-night, all 4 palettes | PASS |
| SELF | 340×547 | idplate + 5 stat rows + gold + chip + 3 tabs + 4 swatches; no band/fig remnants | PASS |
| SELF | 340×547 | drawer opens per tab (correct panel, tab active), recloses; animation == original | PASS (parity) |
| SELF | — | idplate name near-white, tag --gold 12px, swatch click drives theme, all 4 palettes | PASS |
| WORLD | 340×820 | no overflow, 委托 flexes to fill, card cadence intact, all 4 palettes | PASS |

### Judgment calls / notes
- User anchor at `USER_X = 8%`; NPC band starts at 30% — chosen so the protagonist keeps clear space
  at the far left without overlapping the leftmost NPC. Distinct-from-NPC treatment is the cool gilt
  rim + the 你 pill (NPCs get warm glow only when speaking).
- Empty-cast case: the user still stands; the 此刻无人在场 note is appended as a centered overlay
  beside the user rather than replacing the whole cast (the user is always on stage now).
- Did NOT run `--apply` and did NOT touch the card asset folder (controller applies). No history
  rewrite, no branch, no push. `.scratch` left uncommitted.
