# PF-01 — STAGE placeholder figures are invisible (font-size % bug)

Status: ready-for-human
Priority: P0

## Problem

At slot size (~1200×285) the STAGE band shows the speaker's nameplate + 正在交谈 tag floating over
an empty gradient. The placeholder glyphs (`.fig-ph`) are sized in JS
(`docs/sdk/examples/poem-stage-surface.html:236`):

```js
ph.style.fontSize = m.speaking ? 'min(30vw, 78%)' : 'min(24vw, 62%)'
```

A **percentage font-size resolves against the PARENT's font size** (~13px), not the band height —
so `78%` ≈ 10px and every placeholder renders as a near-invisible dot. The SELF surface does this
correctly with a length: `font-size: min(46vw, calc(var(--band-h) * .78))`
(poem-self-surface.html:100).

## Grounding (verified 2026-07-06, rendered in-browser)

- The stage band fills its slot: `.stage { height: 100vh }` (the WCV page IS the band), so the
  band height ≡ `100vh` in this document — no `--band-h` var needed.
- The glyphs are created in `render()` (~line 229-237); real 立绘 images replace them via
  `loadFig` only when `window.assetUrl` exists AND returns a URL — the placeholder state is what
  shows standalone and whenever the card lacks portrait assets, so it must look intentional.
- The mock (`docs/design/poem-play-area-mock.html`) shows the intended look: huge serif glyphs
  (恩/薇) filling most of the band height.

## Change

In `poem-stage-surface.html` `render()`, replace the two font-size strings:

- speaker: `'min(30vw, 78vh)'`
- silent: `'min(24vw, 62vh)'`

(`vh` of this document = band height, matching SELF's `--band-h * .78` proportion. The `vw` clamp
keeps glyphs sane on very narrow slots.)

Check `.fig-ph`'s CSS (`bottom: -6px; line-height: .8`) still crops the glyph pleasingly at the new
size — compare against the mock's stage; adjust `bottom` only if the glyph baseline visibly floats.

## Verification

Preview per PRD rule 5: `/docs/sdk/examples/poem-stage-surface.html` at 1200×285 — two glyphs
(薇 large + bright with nameplate/tag, 恩 smaller) filling the band like the mock. Also check
600×200 (narrow slot) for the `vw` clamp. Screenshot before/after into the issue's `## Comments`.
Run the gate (no tests cover card surfaces; typecheck/test must simply stay green).

## NON-GOALS

- No changes to real-image (`loadFig`) sizing — `.fig { max-height:100% }` is already correct.
- No layout changes to nameplate/speaking/scene-tag (PF-05 handles nameplate contrast).
- Do NOT run `build-poem-play-area.cjs --apply` (PRD rule 4).

## Comments

Implemented 2026-07-07:
- Changed `docs/sdk/examples/poem-stage-surface.html` placeholder glyph sizing from `%` to `vh`.
- Verified `npm.cmd run typecheck`, `npm.cmd run check:deps`, `npm.cmd run test`, and `git diff --check`.
- Direct `file://` browser preview was blocked by browser policy; no screenshot artifact was added.

## Size budget

≤ 10 lines, one file.
