# PM-B2 — v3: theme-scoped scenery gradients + avatar placeholders (was PF-03)

Status: ready-for-human
Priority: P1
Dispatch: opus-4.8/medium
Scope: card v3 surfaces + shared tokens

## What

The v3 STAGE/SELF scene gradients and the WORLD avatar placeholder hardcode dusk hues, so
switching to ember/verdant reskins chrome but not scenery. The v4 mock already solved this
pattern: per-theme `--scene-a`, `--scene-b`, `--scene-glow`, `--glass` variables (see
`docs/design/poem-play-area-mock-v4.html` `:root` blocks — verified coherent in all 4 palettes in
the 2026-07-07 review). Port those tokens into `docs/sdk/examples/poem-themes.css` (single
definition per palette) and make the v3 surfaces consume them instead of literal colors.

## Verification

All 3 v3 surfaces standalone at their slot sizes, 4 palettes each; the band gradient and avatar
placeholders must follow the palette. (Slot sizes: self 340×820, stage 1020×273, world 340×547
at 1360×820.)

## Acceptance

No hardcoded scene hues left in the three v3 surfaces (grep hex literals; resource/rarity colors
stay constant BY DESIGN — don't tokenize those per theme). `poem-themes.css` gains the scene
block per palette, matching the v4 mock values. Gate green.

## Comments

Commit: `d3b738e`.

### What changed
- **`docs/sdk/examples/poem-themes.css`** — added `--scene-a`, `--scene-b`, `--scene-glow`,
  `--glass`, `--glass-soft` to the default `:root` and all four palette blocks
  (dusk/frost/ember/verdant). Values copied verbatim from
  `docs/design/poem-play-area-mock-v4.html`'s `:root` blocks: dusk `#33436a / #4a3350 /
  rgba(200,104,63,.20)`, frost `#2c4763 / #334666 / rgba(140,200,216,.14)`, ember `#5a3524 /
  #6b3a2a / rgba(209,80,58,.22)`, verdant `#27493a / #2f5a44 / rgba(201,138,74,.16)`, plus each
  theme's `--glass`/`--glass-soft`. Updated the file header comment to document the new scene
  group.
- **`poem-self-surface.html`** + **`poem-stage-surface.html`** — the `.scene` band gradient
  swapped its four literals for tokens: `#33436a`→`var(--scene-a)`, `#4a3350`→`var(--scene-b)`,
  `rgba(200,104,63,.18)`→`var(--scene-glow)`, and the dusk base
  `linear-gradient(180deg,#1b1626,#160f1f)`→
  `linear-gradient(180deg, color-mix(in srgb, var(--scene-a) 26%, var(--night)), var(--night) 78%)`
  (the v4 mock's token-driven formula, so the base tint tracks the palette).
- **`poem-world-surface.html`** — the `.npc-av` avatar-placeholder gradient
  `radial-gradient(120% 100% at 35% 25%, #5a3a52, #201622 70%)` →
  `radial-gradient(..., var(--scene-b), var(--sunken) 70%)`, mirroring the mock's card-avatar rule.

### Deliberately left literal (not scenery, by design)
Legibility scrims/shadows (`rgba(0,0,0,…)`, nameplate `rgba(16,14,22,…)`, glyph
`rgba(233,227,212,.9)`), the `.fig.active` mythic glow `rgba(215,107,143,.35)`, and the JS
`THEME_SWATCH` identity hexes. The v4 mock leaves its equivalents literal too. Resource
(HP/MP/SP/EXP) and the 7 rarity tiers untouched per spec.

### Verified
- `grep` for every dusk scene literal (`#33436a`, `#4a3350`, `#1b1626`, `#160f1f`, `#5a3a52`,
  `#201622`, `rgba(200,104,63,…)`) across the three surfaces → **no matches** post-edit.
- Token block present + verbatim in all 5 palette definitions (default + 4 themes); values
  distinct per palette, so any surface consuming `var(--scene-*)`/`var(--night)`/`var(--sunken)`
  resolves to a different gradient per `data-poem-theme` — the SELF/STAGE band and WORLD avatar
  necessarily reskin per palette.
- Served the worktree root with `npx serve -l 4599 .` (per PRD rule 5 — leaves
  `.claude/launch.json` untouched); confirmed all three surfaces + `poem-themes.css` load 200.
- **Deviation from verification note:** the Chrome preview browser was unavailable this session
  (`claude-in-chrome` not connected; `preview_list` empty), so I could not capture live
  `getComputedStyle` reads per palette × surface. Verification is by static token-resolution proof
  (grep-clean surfaces + distinct per-palette token values) rather than in-browser computed-style.
  An in-app / in-browser palette sweep at the slot sizes (self 340×820, stage 1020×273, world
  340×547) is still recommended before the controller's `--apply` pass.
- Gate: `npm run typecheck` ✔, `npm run check:deps` ✔ (no violations, 391 modules), `npm run test`
  ✔ (2043 passed / 219 files).
