# PF-02 — SELF theme swatches overlap the HP row when a fold is open

Status: ready-for-human
Priority: P0

## Problem

The 4 palette swatches are pinned `position:absolute; top:8px; right:8px; z-index:5` on `.self`
(`docs/sdk/examples/poem-self-surface.html:53`). Opening any fold tab collapses the band
(`.self.open .band { max-height: 0 }`), the stats slide to the top, and the swatches land directly
on the HP row — "380/400" is illegible under them (verified in-browser at 400×856).

## Change

CSS-only, in `poem-self-surface.html`:

```css
/* fold open: the band is gone, so clear the swatch row's height above the stats */
.self.open .stats { padding-top: 30px; }
```

(The swatch row is 14px dots at top 8px → 22px tall; 30px total keeps a small gap. The swatches
stay top-right in BOTH states — consistent location, no relocation logic.)

If the 30px shelf looks awkward in preview, the recorded alternative is moving the swatches into
the tabs bar while open (`.self.open .theme-swatches { top:auto; bottom:9px; right:12px }` + right
padding on `.tabs`) — implement the padding version first; only switch if it visibly fails, and say
so in `## Comments`.

## Verification

Preview at 400×856: open 属性 → HP row fully legible, swatches clear of it; close → band returns,
swatches unchanged over the scene. Check all three fold tabs and one alternate palette
(`?theme=ember`). Screenshots before/after. Gate green.

## NON-GOALS

- No swatch redesign (size/labels/tooltips unchanged).
- No drawer/tab layout changes (PF-04 owns that — and lands AFTER this; keep the diff minimal so
  PF-04 rebases cleanly).
- No `--apply`.

## Comments

Implemented 2026-07-07:
- Added `.self.open .stats { padding-top: 30px; }` in `docs/sdk/examples/poem-self-surface.html`.
- Verified the SELF surface via localhost at 400x856 with `?theme=ember`: closed state and attrs/inv/asc open states all reported no swatch/HP-value overlap; open states computed `padding-top: 30px`.
- Verified `npm.cmd run typecheck`, `npm.cmd run check:deps`, `npm.cmd run test`, and `git diff --check`.

## Size budget

≤ 8 lines, one file.
