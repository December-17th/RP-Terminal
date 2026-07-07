# PF-06 — 好感度 bar: make the −100..100 scale readable

Status: ready-for-agent
Priority: P2

## Problem

`poem-world-surface.html:127` maps 好感度 −100..100 linearly onto a 0..100% bar
(`affPct(38) = 69`), so a mid affection renders as a two-thirds-full bar — the most
gameplay-relevant meter in the WORLD column systematically overstates relationships, and a
NEGATIVE affection still shows a partially-full bar (`affPct(-40) = 30`).

## Change — `poem-world-surface.html`

Fill from the center, signed:

1. `.npc-rel` becomes a centered track: keep the grey track; add a 1px midpoint tick
   (`.npc-rel::before { content:''; position:absolute; left:50%; top:-1px; bottom:-1px; width:1px;
   background: var(--line); }` — slightly lighter than the fill so it reads as an axis).
2. The fill `<i>`: width `Math.min(50, Math.abs(aff)/2)%`; positive → `left:50%`,
   `background: var(--q-mythic)` (unchanged hue); negative → `right:50%`,
   `background: var(--hp)`; zero/null → no fill.
   Implement via a class on the row (`aff-neg`) + inline width, mirroring the existing
   inline-width pattern.
3. The numeric `.npc-aff` label already shows the signed value — unchanged.
4. Keep the `transition: width` and its reduced-motion opt-out.

## Verification

Preview WORLD at 400×571 with the mock data (薇拉 64 → right-fill 32% of track, 恩里克 38 →
right-fill 19%); temporarily eval a negative value
(`document.querySelectorAll` won't do it — edit the MOCK object in DevTools-style via preview_eval
re-render, or temporarily set 恩里克.好感度 = -40 in MOCK, verify red left-fill, then restore).
Screenshot. Gate green.

## NON-GOALS

- No change to the STAGE nameplate's "好感 64" text or speaker-pick sort (`stageState`).
- No new colors beyond the existing tokens. No `--apply`.

## Size budget

≤ 30 lines, one file.
