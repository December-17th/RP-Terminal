# PM-B3 — contrast pass, both surface generations (was PF-05 + review §6a)

Status: ready-for-human
Priority: P1
Dispatch: opus-4.8/medium
Scope: card surfaces (v3 files now; the rules bind PM-C*/PM-D2 too)

## What

Two confirmed failures + one discipline to install:
1. (PF-05) The gilt nameplate tag reads ≈1.2:1 where it overlaps the light placeholder glyph
   (v3 SELF portrait + STAGE figures). Give the nameplate a solid night-glass backing plate
   (the v4 mock's nameplate already does this — copy its treatment) instead of relying on
   whatever is behind it.
2. (Review §6a, measured) 11px `--gold-dim` ornaments fail AA (`.choice .n` ≈3.2:1 in verdant);
   11px `--faint` meta ≈4.7:1 is borderline. Fix in the v4 MOCK (`poem-play-area-mock-v4.html`)
   and in any v3 surface using `--gold-dim`/`--faint` at ≤12px: bump to `--gold`/`--dim`, or
   raise size/weight until ≥4.5:1 in ALL 4 palettes.
3. Add a short "contrast rules" comment block at the top of `poem-themes.css` recording the
   ≥4.5:1-at-≤12px rule and which token pairs are safe, so later surface work inherits it.

## Verification

Compute ratios from the actual token values per palette (script it in the scratchpad — don't
eyeball); screenshot worst cases before/after.

## Acceptance

All text ≤12px in the v3 surfaces + v4 mock ≥4.5:1 in all palettes; nameplate legible over a
white-ish glyph. Gate green.

---

**Fix #1 pre-landed in PM-B7 (`e02b05d`):** both v3 nameplates (SELF idplate over the band + STAGE
active-speaker plate) now use the v4 mock's solid night-glass backing plate + gilt left bar instead of a
radial scrim, so the gilt tag no longer overlaps the light placeholder glyph. PM-B3 fix #1 is done;
remaining PM-B3 work = fixes #2 (≤12px `--gold-dim`/`--faint` audit) + #3 (contrast-rules comment).

---

## Comments (fixes #2 + #3 — commit 395d2c8)

Scripted the audit (`.scratch/…` node script, kept uncommitted): parsed every palette's tokens,
composited each element's REAL backdrop (glass = `--glass`/`--glass-soft` rgba over `--night`;
inset boxes = rgba(0,0,0,.30–.35) over the glass card; `.choice .n` = `--raise`@62% over glass),
and computed WCAG ratios for every ≤12px text rule across all 4 palettes.

### Key finding — the failure is `--gold-dim`-as-TEXT, NOT `--faint`

The review's guesses were partly off. Composited honestly:
- **`--faint` at 11–11.5px PASSES** everywhere (min **4.90:1** @dusk). The ≈4.7 review estimate
  was pessimistic; `.chap-meta`, `.empty`, `.role`, `.inv-meta`, `.quest-meta` all clear AA.
  **Left untouched** (audit ≠ redesign).
- **`--gold-dim` used as small text FAILS in every palette** (ember is the floor, ~3.1:1). It is a
  border/decor token, not a text token. This is the single systematic offender — it covers the
  review's `.choice .n` (2.97 worst) and PM-B7's deferred `.sect` headers, plus all the gilt `.sep`
  separators and quest labels.

### Before → after (all ≤12px `--gold-dim` TEXT uses; ratio = worst palette = ember)

| File | Selector | px | before (--gold-dim) | fix | after | 
|---|---|---|---|---|---|
| self | `.np-tag .sep` | 11 | 3.14 | →`--gold` | ~7.2 |
| self | `.sect` (drawer header) | 11 | 3.14 | →`--gold` | 7.19 ✓live |
| stage | `.np-tag .sep` | 11 | 3.14 | →`--gold` | ~7.2 |
| stage | `.scene-tag .sep` | 11.5 | 3.12 | →`--gold` | ~7.2 |
| stage | `.empty` (此刻无人在场) | 12 | 3.08 | →`--gold` | ~7.2 |
| world | `.sect` | 11 | 3.14 | →`--gold` | 7.19 ✓live |
| world | `.quest-focus` | 11 | 3.24 | →`--gold` | 7.41 ✓live |
| world | `.quest-meta b` | 11 | 3.24 | →`--dim` | 7.39 ✓live |
| v4 | `.chap-meta .sep` | 11 | 3.14 | →`--gold` | ~7.2 |
| v4 | `.choice .n` (worst offender) | 11 | **2.97** | →`--gold` | 6.80 ✓live |
| v4 | `.idplate .tag .sep` | 12 | 3.14 | →`--gold` | ~7.2 |
| v4 | `.fp-gold .split` | 12 | 3.14 | →`--gold` | ~7.2 |
| v4 | `.sect` | 12 | 3.14 | →`--gold` | 7.19 ✓live |
| v4 | `.quest-focus` | 12 | 3.24 | →`--gold` | ~6.9 |
| v4 | `.np-tag .sep` | 11 | 3.14 | →`--gold` | ~7.2 |
| v4 | `.scenetag .sep` | 11.5 | 3.12 | →`--gold` | ~7.2 |

`✓live` = read back from real computed styles in the ember preview (worst palette). `~` = from the
audit script (same math, spot-checked live where marked).

**Rationale for the two fix flavors:** separators/gilt labels/headers → `--gold` (they sit among
gold text; `--gold` is the brighter sibling and keeps the gilt look). `.quest-meta b` → `--dim`
instead of `--gold`, because its VALUE is `--faint`; a `--gold` label would out-shout the value and
invert hierarchy. `--dim` keeps it a muted label while clearing AA.

### No size bumps → nothing for PM-B5

Every failure was fixed by a color bump alone; I raised NO font sizes. So PM-B5 (CJK ≤11px audit)
inherits the same sizes it would have seen.

### Borderline left in place (all PASS, not my rules to touch)
- `.quest.hi .quest-focus` = **`--ember`** at 11px on inset: **4.61:1** @ember (a hair over AA). This
  is the high-focus semantic-warning override (unchanged by me); passes, so left as-is. Flagging in
  case a future ember-token tweak pushes it under.
- `--faint` cluster: 4.90:1 @dusk — passing but tightest. If dusk `--faint`/`--glass` ever darkens,
  these (`.empty`, `.role`, `.inv-meta`, `.chap-meta`, `.chip.muted`) go first.
- `--hp`/resource keys (`.res-k`): 4.76:1 @frost — passing; constant tokens, out of scope.

### Fix #3 — contrast-rules comment block

Added at the top of `poem-themes.css` (after the existing Contrast note): the hard ≥4.5:1-at-≤12px
rule + the safe-token table (`--gold`/`--text`/`--dim`/`--faint` SAFE; `--gold-dim` = border/decor
only, never ≤12px text). PM-C*/PM-D2 inherit it.

### Surprises
- The card asset folder was NOT touched; `--apply` NOT run (controller's job). Card surfaces stay
  inert until the controller re-embeds.
- The v1 mock (`docs/design/poem-play-area-mock.html`) has the same `--gold-dim` `.sect-h` at 10px
  but is OUT of PM-B3's named scope (spec lists only the v4 mock + 3 v3 surfaces) — left alone.
