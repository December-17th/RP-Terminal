# PF-10 — 首页 (card home screen) collapses to a thin strip on load

Status: needs-info
Priority: P1 once unblocked (pre-existing; status doc §OPEN A)

## Problem (carried over from docs/design/poem-play-area-status.md — do not dispatch yet)

The card's 首页 (credits/start screen in the STORY slot) first renders as a thin horizontal strip;
a stray repaint corrects it. Diagnosis (status doc): it is almost certainly a viewport-filling
`position:fixed/absolute` overlay with ~zero in-flow height, so the auto-sizing card frame
(`WcvMessageFrame` via `onWcvSlotSize` / `InlineCardFrame` ResizeObserver) collapses to content
height.

## Owner questions (blockers — answer these, then flip to ready-for-agent)

1. After a full load (no screenshot/interaction), does the 首页 self-correct on its own, or only on
   interaction/resize?
2. Is the home screen the card's own cream/parchment design, or bare white? (Confirms whether the
   `.play-root` background fix already covers its backdrop.)

## The two fix options (status doc; pick per the answers)

- **Option 1 (low-risk):** schedule a few delayed re-measures after card load in `wcvPreload`'s
  layout bridge and/or `InlineCardFrame` — helps any slow-layout card.
- **Option 2 (root fix):** treat a full-screen home as `fill`-sized (viewport height) instead of
  fit-to-content — touches `cardFrameHeight.ts` + the render-mode resolution in
  `MessageContent.tsx`.

Relevant files: `WcvMessageFrame.tsx`, `InlineCardFrame.tsx`, `cardFrameHeight.ts`,
`preload/wcvPreload.ts` (`startLayoutBridge`/`reportHeight`), `MessageContent.tsx`.

## Comments

(waiting on owner answers)
