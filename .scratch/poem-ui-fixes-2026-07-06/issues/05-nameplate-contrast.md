# PF-05 — Nameplate legibility over the light placeholder glyph (SELF + STAGE)

Status: ready-for-agent
Priority: P2
Depends on: PF-01, PF-02, PF-03, PF-04 landed (same files)

## Problem

The nameplate tag line (`.np-tag`, gold `var(--gold)` ≈ `#d9b56b`) sits over the giant parchment
placeholder glyph (`rgba(233,227,212,.9)`) — measured ≈1.24:1 contrast where they overlap. At
400×856 the SELF nameplate's "史诗 · Lv 12" is barely readable against the 你 glyph. The existing
radial scrim (`.nameplate::before`, `poem-self-surface.html:105-108` / stage `:81-84`) only darkens
the bottom-left corner. Real 立绘 art may or may not have the same problem — the fix must work for
both.

## Change — both `poem-self-surface.html` and `poem-stage-surface.html`

Strengthen the nameplate's own backdrop rather than dimming the glyph (the glyph IS the art
stand-in):

1. Widen + deepen the scrim so it covers the full tag line:
   `inset: -12px -22px -12px -12px;` and
   `background: radial-gradient(140% 160% at <existing origin>, rgba(16,14,22,.94), rgba(16,14,22,.55) 55%, transparent 78%);`
   (keep each surface's existing gradient origin — SELF is left-anchored, STAGE center-anchored).
2. Give `.np-name` and `.np-tag` a tighter halo:
   `text-shadow: 0 1px 3px rgba(0,0,0,.9), 0 2px 12px rgba(0,0,0,.8);`
3. Do NOT change the gold; the scrim carries the contrast.

Acceptance bar: with the scrim, the effective backdrop behind the tag is dark enough that
`--gold` clears **≥ 3:1** (verify by `preview_inspect`-ing computed colors / eyedropping the
screenshot at the tag's position, on dusk AND frost — frost's `--gold` `#8cc8d8` is the lightest).

## Verification

Preview SELF 400×856 + STAGE 1200×285, dusk + frost: name and tag fully legible directly over the
glyph's lightest stroke; the scrim reads as ambient shadow, not a box. Screenshots before/after.
Gate green.

## NON-GOALS

- No plate/chip UI behind the nameplate (keep the VN ambience) unless the scrim provably can't
  reach 3:1 — then stop and report with the screenshot.
- No glyph dimming or recolor. No `--apply`.

## Size budget

≤ 20 lines across two files.
