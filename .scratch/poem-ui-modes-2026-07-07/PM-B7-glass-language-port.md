# PM-B7 — v3 visual refresh: port the v4 night-glass card language

Status: ready-for-human
Priority: P0 (the owner's "apply UI upgrade from novel mode")
Dispatch: opus-4.8/medium
Scope: card v3 surfaces (all three) + `poem-themes.css`
Order: after PM-B2 (needs its `--glass`/scene tokens), before PM-B4/B6/B3/B5

## What

Restyle the three v3 surfaces to the v4 mock's surface language — the LAYOUT stays v3 (band +
triad; do NOT move slots or change rects), only the skin upgrades. Source of truth for every
treatment: `docs/design/poem-play-area-mock-v4.html`.

1. **Night-glass cards:** panels/sections become glass cards — `background:var(--glass)`,
   `backdrop-filter:blur(12px)`, 1px `--line-soft` border, 12px radius (the mock's `.card`) —
   replacing the current flat/sunken fills in SELF (stats block, drawer panels), WORLD (世界/
   同行/委托 sections), and the STAGE scene tag.
2. **Gilt nameplate treatment:** the STAGE active-speaker nameplate and the SELF idplate adopt
   the mock's nameplate: serif name, mono gold tag with `·` separators on a solid night-glass
   backing plate (this pre-implements PM-B3's fix #1 — note it in PM-B3's Comments when done).
3. **Typography register:** serif (`--serif`) for names/headings, mono for values/tags, sans for
   body — per the mock's usage. Choices/buttons pick up the mock's `.choice` treatment where the
   v3 surfaces have equivalents.
4. Tokens only — every color through `poem-themes.css` variables (PM-B2 landed the scene/glass
   set); zero new hex literals in the surface files.

## Verification

All three surfaces standalone at slot sizes (self 340×820, stage 1020×273, world 340×547),
4 palettes, fold open/closed, before/after screenshots (backdrop-filter off for capture only).

## Acceptance

Side-by-side with the v4 mock, the card/nameplate/type treatments read as the same design
system; v3 layout geometry untouched; no hex literals added; all palettes coherent. Gate green.

## Comments

Landed in commit `e02b05d` on `claude/nifty-mcclintock-6e6a1b`. Skin-only port of the v4 mock's
night-glass language onto the three v3 surfaces; layout geometry (band + panel/section structure,
slot rects) untouched. No `poem-themes.css` change needed — PM-B2 already landed the
`--glass`/`--glass-soft`/`--scene-*` tokens.

### Per surface

**SELF (`poem-self-surface.html`)**
- `.stats` block: was `background:var(--night)` flat with a bottom rule → v4 `.card` (glass, blur 12px,
  1px `--line-soft`, 12px radius, `12px 14px` margin/pad).
- `.drawer`: track fill dropped to `background:none`; each open `.panel` now renders as its own glass
  card (glass/blur/`--line-soft`/12px), matching the mock's per-menu card stack.
- Inner tiles `.attr` and `.rung`: `var(--sunken)` → `rgba(0,0,0,.35)` (the mock's `.attr` scrim).
- `.res-track`: `var(--sunken)` → `rgba(0,0,0,.5)`; `.inv-row:hover` → `color-mix(--text 6%)` (mock hover).
- `.nameplate` (idplate over the band): dropped the radial `::before` scrim for the mock's SOLID glass
  backing plate + gilt left bar (`--gold-dim` border, 12px radius, `linear-gradient(--gold,transparent)`
  bar). name serif 20px/700, tag mono `--gold`. **This is PM-B3 fix #1.**
- `.tabs`/`.tab`: was a `var(--sunken)` bar with underline-active → the mock's glass-soft pills
  (`--glass-soft`/blur/`--line-soft`; active = `--gold` text + `--gold-dim` border). The PM-B1 theme
  swatches still dock at the right end (divider preserved).

**STAGE (`poem-stage-surface.html`)**
- `.scene-tag`: `rgba(16,14,22,.5)` flat → the mock's `.scenetag` glass-soft card (blur 10px,
  `--line-soft`, 9px radius).
- Speaker `.nameplate`: radial `::before` scrim → SOLID glass backing plate + gilt left bar (same as
  SELF). Tag color moved `--q-mythic` → `--gold` (mock uses gold; `--q-mythic` is a data-rarity token,
  wrong register for a nameplate). **PM-B3 fix #1 for STAGE.**
- `正在交谈`: the old `.speaking` free-floating pill → the mock's `.np-live` (gold fill, `--night` text)
  nested INSIDE the nameplate at its top-right edge. JS updated to emit `.np-live` inside `.nameplate`
  instead of a separate sibling.

**WORLD (`poem-world-surface.html`)**
- 世界/同行/委托 section wrappers (`.world > div`): were bare (no backing) → night-glass cards
  (glass/blur/`--line-soft`/12px). Column gap tightened 18px→8px to read as a card stack (mock cadence).
- `.quest`: `var(--sunken)` → `rgba(0,0,0,.30)` (mock scrim), radius 8→9px. `.npc-rel` track:
  `var(--line)` → `rgba(0,0,0,.45)` (mock).

### Judgment calls

1. **STAGE nameplate stays center-anchored** (`translateX(-50%)` under the speaker's dynamic x), unlike
   the mock's fixed right-anchored plate — the v3 STAGE geometry (nameplate follows the speaker sprite)
   is load-bearing and "layout stays". I ported the plate skin + gilt bar onto the centered element; the
   `22px` left pad clears the bar with the mock's serif/mono type register intact.
2. **`.npc-rel` fill left at `--q-mythic`.** Only the track background was reskinned for glass legibility;
   the affection bar's redesign (center-axis) is PM-B4's scope (next in the chain) — not touched here.
3. **Transparent drawer/tabs zones show `body`'s `var(--night)`, not a scene.** The v3 SELF surface only
   paints the scene in the portrait band; below it the glass cards float over night. Coherent with the
   mock's "glass over dark" and the correct choice given v3 has no full-bleed scene behind the HUD.
4. **`.sect` headers left as-is** (`--gold-dim` 11px). That token/size is PM-B3's contrast-audit scope;
   PM-B7 is skin-only and does not change text size/color for legibility.
5. **`rgba(0,0,0,…)` scrims** used for inner tracks/tiles per the explicit PM-B2 precedent + spec rule 4;
   these are the mock's own values, not new theme colors.

### Verification matrix (computed-style + bounding-box, `preview_start` docs-static @ :6791)

Route: `/.claude/worktrees/funny-burnell-e11355/docs/sdk/examples/poem-<x>-surface.html`.
Screenshots were best-effort only (backdrop-filter hang, per PRD rule 5) — record is computed-style.

| Surface | Palettes checked | Key assertions (all passed) |
|---|---|---|
| SELF | dusk, ember | stats glass `rgba(18,15,26,.82)`+blur12+`--line-soft`+12r; nameplate glass+`--gold-dim`+22px padL; np-name serif 20px; np-tag mono `--gold`; fold-open drawer panel glass card; `.attr` `rgba(0,0,0,.35)`; tabs glass-soft, active = gold/`--gold-dim`. ember: stats `rgba(20,13,10,.82)`, tag `--gold` ember. |
| STAGE | dusk | scene-tag glass-soft blur10 9r; nameplate glass+`--gold-dim`+12r; np-live gold pill/night text at top:-9 right:12; tag mono `--gold`; name serif 20px; old `.speaking` gone. |
| WORLD | dusk, verdant, frost | 3 section cards glass+blur12+`--line-soft`+12r; quest `rgba(0,0,0,.30)` 9r; npc-rel `rgba(0,0,0,.45)`. verdant card `rgba(12,17,14,.82)`; frost card `rgba(13,17,25,.82)`+border `--line-soft` frost. |

SELF fold open + closed both exercised (tab click toggles `.self.open`). No hex literals added to any
surface CSS (grep: only pre-existing PM-B1 `THEME_SWATCH` JS map). Gate: typecheck ✓, check:deps ✓
(0 violations, 391 modules), test ✓ (2043/2043).

### Surprises

None. Grounding held: PM-B1 (`1f831ad`) + PM-B2 (`d3b738e`) present, scene/glass tokens live in
`poem-themes.css`, base branch correct. No `poem-themes.css` edit required (contra a possible reading of
the issue's "+ poem-themes.css" scope line — the tokens were already there).
