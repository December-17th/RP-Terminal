# PM-A2 — `panel_ui.backdrop`: app-painted scene behind the play area

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P0 (blocks PM-C*, PM-E1)
Dispatch: opus-4.8/medium
Scope: app

## What

A card-declared backdrop the APP paints on `.play-root`, behind the native STORY column and all
WCV slots (v4 doc §5.1 option a). Card-agnostic.

- Schema: `panel_ui.backdrop` (and per-variant once PM-A1 lands — coordinate; whichever lands
  second wires the two together): `{ asset?: string, gradient?: string }`. `asset` resolves via
  the World Assets layer (`rptasset://` name conventions); `gradient` is a CSS background value
  (sanitize: background-image values only).
- Renderer: paint on `.play-root` (it already paints `var(--rpt-bg-primary)` — see
  `assets/index.css`, the theme-leak fix). Cover-crop, center. Keep the existing color as the
  fallback layer under the image.
- The existing `getPanelGeometry` slicing keeps working for WCV surfaces — the backdrop must be
  the SAME image they slice, so expose the resolved backdrop URL to WCV slots (extend the
  geometry payload or a sibling getter — ground `wcvGeometry.ts` + `wcvPreload.ts` first).

## Grounding

`src/main/types/character.ts`, `src/main/services/wcvGeometry.ts`, `src/main/services/wcvManager.ts`,
`src/preload/wcvPreload.ts`, `src/renderer/src/assets/index.css` (`.play-root`),
`src/shared/worldAssets/` (asset name→URL), v4 doc §5.

## Acceptance

- A card declaring `backdrop.asset` shows the image behind the native chat and the WCV panels;
  a WCV slot can read the same backdrop URL + its own geometry and render a pixel-continuous
  slice (extend `docs/design/seam-slice-demo/` or add a test page).
- No backdrop declared ⇒ exactly today's behavior. SDK docs updated same commit. Gate green.
