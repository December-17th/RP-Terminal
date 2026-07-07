# PM-B1 — v3 SELF: theme swatches overlap the HP row when a fold tab is open (was PF-02)

Status: ready-for-human
Priority: P1
Dispatch: opus-4.8/medium
Scope: card v3 surface

## What

In `docs/sdk/examples/poem-self-surface.html` the 4-swatch theme switcher is absolutely
positioned top-right; when a fold tab collapses the portrait band, the swatches land on the HP
row. Note `77b53b3` already reworked the drawer collapse (and added `.self.open .stats
{padding-top:30px}` as a stopgap) — build on that state, not the older one. Move the swatches to
a home that survives both folded and unfolded states (e.g. into the tabs row or the band's scene
tag line); remove the stopgap padding if it becomes redundant.

## Verification

Serve via `docs-static`, open `/docs/sdk/examples/poem-self-surface.html` at 340×820 (the
[0,0,3,12] slot at 1360×820 ≈ 25% width), toggle each fold tab, screenshot all 4 palettes.
Screenshot gotcha: inject `*{backdrop-filter:none!important}` first.

## Acceptance

No overlap in any fold state × palette; swatches still switch + persist + broadcast `poem:theme`.
Gate green (surface files have no tests — gate still must pass).

## Comments

Done — commit `1f831ad`.

### What I changed (`docs/sdk/examples/poem-self-surface.html`, 5 lines net)
- Moved `#themeSwatches` out of its absolutely-positioned top-right home
  (`position:absolute; top:8px; right:8px`) into the **always-visible tabs row**
  (`.tabs`), appended after the three fold-tab buttons at the right end. The tabs row
  is `flex: 0 0 auto` and present in both fold states, so the swatches are always
  reachable and can never overlap the HP row.
- Restyled `.theme-swatches` from absolute to an inline flex group
  (`flex:0 0 auto; align-items:center`) with a hairline `border-left` separator so it
  reads as a distinct affordance beside the tabs.
- **Removed the stopgap** `.self.open .stats { padding-top: 30px }` — it was only there
  to keep the HP row clear of the old absolute swatches; now redundant.
- Retargeted the `.sw.on` selection ring inner colour from `--night` to `--sunken`,
  because the swatches now sit on the `.tabs` background (`var(--sunken)`), not the
  `--night` body — keeps the ring contrast correct in all palettes.

Switch/persist/broadcast logic in the `<script>` was untouched.

### Verified (via preview_eval bounding-box + computed-style measurement)
- **16 combinations = 4 palettes (dusk/frost/ember/verdant) × 4 fold states
  (closed / 属性 / 持有 / 登神长阶): `overlapHP` = false in every one.** Closed: swatches
  in the tabs row at top≈449, HP row at top≈292. Open (band collapsed to 0): HP row rises
  to top≈13, swatches stay in the bottom tabs row at top≈783 — no collision.
- All 4 swatches render (14×14px), fully within the 340px-wide viewport, correctly
  titled (黄昏/霜垣/烬火/苍林).
- Switch/persist/broadcast intact: clicking a swatch updates
  `documentElement.dataset.poemTheme`, writes `localStorage['poem.theme']`, moves the
  `.on` ring, and (with a stubbed `window.rptHost`) fires `broadcastEvent('poem:theme',
  {id})` with the right id.
- Gate: `npm run typecheck` ✓, `npm run check:deps` ✓ (no violations, 391 modules),
  `npm run test` ✓ (2043/2043 passed).

### Notes / surprises
- Viewport at **340×820** as specified.
- `preview_screenshot` timed out even after injecting `*{backdrop-filter:none!important}`
  (plus `filter:none`) — a tooling hang, not a page issue (console clean). Verification
  used `preview_eval` bounding-box + computed-style reads instead, which the PRD calls
  more accurate for layout anyway.
- **Serve-root gotcha:** `preview_start` serves from the MAIN repo checkout
  (`E:\Projects\RP Terminal`), not this worktree, and `poem-self-surface.html` does not
  exist on the main checkout's branch — so it 404'd. Worked around by running
  `npx serve` rooted at the worktree on a side port and pointing the preview browser at
  it. `.claude/launch.json` was left unchanged (a temporary port edit was reverted).
- No spec deviation. The one judgment call beyond the literal spec: retargeting the
  `.sw.on` ring colour to `--sunken` so the selection ring stays visible on the new
  background — required for the "swatches remain reachable/legible" intent.
