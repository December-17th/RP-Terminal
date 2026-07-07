# PM-F1 — 首页 home screen collapses to a thin strip on load (was PF-10)

Status: needs-info (owner) — DO NOT DISPATCH
Priority: P1 once unblocked
Scope: app

## What

Pre-existing: the card's 首页 (credits/start screen in the STORY chat slot) renders as a thin
horizontal strip until a stray repaint fixes it. Diagnosis + the two fix options (delayed
re-measure vs `fill`-sizing for viewport-filling overlays) are in
`docs/design/poem-play-area-status.md` §OPEN A, with the exact files.

## Blocked on (owner answers)

1. After a full load — before any screenshot/interaction — does it self-correct on its own, or
   only on interaction/resize?
2. Is the home screen the card's own cream/parchment design, or bare white?

Answer 1 picks option 1 (nudge) vs option 2 (root fix); answer 2 confirms whether the `.play-root`
leak fix already handled its background.
