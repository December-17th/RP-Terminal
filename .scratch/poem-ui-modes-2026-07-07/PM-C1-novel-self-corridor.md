# PM-C1 — 小说 SELF corridor surface (user sprite + HUD stack + drawer)

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P0 (needs PM-A1 + PM-A2 landed)
Dispatch: opus-4.8/medium
Scope: card v4 surface (new file `docs/sdk/examples/poem-novel-self-surface.html`)

## What

The left 25% column of 小说 mode as ONE WCV surface (slot rect `[0,0,3,12]` on the 12×12 grid),
implementing the v4 mock's left side (`poem-play-area-mock-v4.html` is the source of truth for
look; the v4 doc §2 for rationale):

- Background: slice the PM-A2 backdrop by own geometry (`getPanelGeometry` — same pattern the v3
  band uses; see `poem-self-surface.html` for a working example of the slicing code).
- User sprite: full-height, bottom-anchored; resolve by PERSONA NAME with `'主角'` fallback via
  `assetUrl(name,'立绘')`, ghosted serif glyph placeholder on lookup failure + a dev-visible
  console diagnostic (v4 doc §1.3 — the silent `img.onerror` removal was the old bug).
- HUD card stack bottom-left: idplate, HP/MP/SP/EXP bars, `◆FP · ⛃G`, status chips — reuse the
  `poemState(stat_data)` adapter from `poem-self-surface.html` (copy it; the shared module is
  deliberately out of scope). Fold drawer (属性/持有/登神长阶) rises ABOVE the HUD, user sprite
  dims (`self-open` state in the mock); glass tab buttons below the HUD.
- Theme: `@import poem-themes.css` (inlined at build time); emits `self:fold`, owns the 4-swatch
  switcher exactly as the v3 SELF does (per-chat KV `poem.theme`, broadcast `poem:theme`).
- Obey the PM-B3 contrast rules + PM-B5 size rules from day one.

## Grounding

v4 mock + doc §2/§6a; `poem-self-surface.html` (adapter + slicing + KV/broadcast patterns);
real schema `E:\Projects\FrontEnd-for-destined-journey-TPR-STS\src\data_schema\{schema,utils}.ts`.

## Verification

Standalone at 340×820 (mock-data fallback like the v3 surfaces have); fold, palettes, missing-
asset placeholder path. Screenshot each.

## Acceptance

Pixel-faithful to the mock's left column at 1360×820; standalone-previewable; all four palettes;
no hardcoded scene hues; adapter reads only verified schema keys. Gate green.
