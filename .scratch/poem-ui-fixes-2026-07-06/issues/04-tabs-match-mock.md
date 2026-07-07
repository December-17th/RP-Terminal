# PF-04 — SELF tabs: match the approved mock (under-stats when closed)

Status: ready-for-human
Priority: P1
Depends on: PF-02 landed (same file)

## Problem

The spec's rule is "the mock wins on look & interaction" (`poem-play-area-redesign.md` cold-start
note). The mock (`docs/design/poem-play-area-mock.html:67-69`) collapses the drawer when closed —
`.drawer { flex:1 1 auto; max-height:0; opacity:0 }` → the 属性/持有/登神长阶 tabs sit **directly
under the stats**; opening expands the drawer and the tabs ride to the bottom. The built surface
(`poem-self-surface.html:147-153`) keeps `.drawer { flex:1 1 auto }` always → tabs are permanently
bottom-pinned with a large dead zone between stats and tabs when closed (verified at 400×856).

## Change

In `poem-self-surface.html`, transplant the mock's drawer behavior:

```css
.drawer { flex: 1 1 auto; min-height: 0; overflow-y: auto; background: var(--night);
  padding: 0 16px; max-height: 0; opacity: 0;
  transition: max-height .4s cubic-bezier(.4,0,.2,1), opacity .3s ease, padding .3s ease; }
.self.open .drawer { max-height: 100%; opacity: 1; padding: 14px 16px 18px; }
```

- Remove the now-redundant `.panel { opacity: 0 }` fade (the drawer itself fades) — keep the
  `display:none` / `[data-menu]` panel switching exactly as is.
- Add the drawer transition to the existing `prefers-reduced-motion` block.
- The `.tabs` bar itself is unchanged (it naturally sits under the collapsed drawer).
- Note: below the tabs, the leftover column space is `--night` via the `.self` root — verify no
  different-colored void appears under the tabs when closed; if the root doesn't paint, give
  `.self` an explicit `background: var(--night)` (it has one on `body` already — check).

## Decision recorded for the owner (do not implement)

The FP row is shaped like an empty bar next to four real bars (mock-locked). If the owner prefers,
a follow-up can render FP as a plain `◆ 500` line like gold. Leave a one-line note in
`## Comments` pointing at this paragraph.

## Verification

Preview at 400×856: closed → band + stats + tabs immediately under stats (compare the mock
side-by-side at the same size); open 属性 → band collapses, drawer expands, tabs at the bottom —
identical to the mock's open state; PF-02's swatch fix still holds in both states. Screenshots
before/after both states. Gate green.

## NON-GOALS

- No changes to fold event broadcasting (`emitFold`) or tab switching logic.
- No stats/band changes. No `--apply`.

## Comments

Implemented 2026-07-07:
- Updated `docs/sdk/examples/poem-self-surface.html` so the drawer collapses when closed (`max-height: 0`, `opacity: 0`) and expands when `.self.open`.
- Removed the redundant panel opacity transition while preserving the existing display/menu switching.
- Verified via localhost at 400x856 with `?theme=ember`: closed tabs gap from stats was 0px; open attrs drawer filled the middle and tabs ended at the viewport bottom; PF-02 swatch/HP overlap remained false.
- FP row note: the issue records a possible follow-up to render FP as plain text instead of an empty bar, but this change leaves it mock-locked.
- Verified `npm.cmd run typecheck`, `npm.cmd run check:deps`, `npm.cmd run test`, and `git diff --check`.

## Size budget

≤ 25 lines, one file.
