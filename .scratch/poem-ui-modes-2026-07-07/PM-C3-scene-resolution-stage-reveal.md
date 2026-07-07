# PM-C3 — 小说 scene resolution + stage reveal

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P1 (after PM-C1 + PM-C2)
Dispatch: opus-4.8/medium
Scope: card v4 surfaces (+ possibly a tiny app follow-up — stop and report if so)

## What

1. **Scene resolution (v4 doc §1.4):** the backdrop image resolves automatically from `世界.地点`
   — location name → `背景` (normal) or `全景` (wide) asset via the World Assets name convention;
   card override via `stat_data.stage.background`; themed gradient fallback (the mock's). Decide
   WHERE this resolution runs given PM-A2's shape: if PM-A2's `backdrop.asset` is static, the
   card surfaces need a way to update it at runtime (e.g. the surfaces resolve the URL and the
   app accepts a `panel_ui` backdrop update via an existing write path) — ground PM-A2's landed
   implementation FIRST; if the app side needs a new write path, STOP and report (that's an
   app-scope decision, not yours to improvise).
2. **Stage reveal (v4 doc §3b):** a click on the scene tag (and hold-Space when a surface has
   focus) temporarily drops the story glass to a thin strip and spreads the present cast across
   the width. Per §6a this needs a temporary full-viewport overlay WCV state — implement the
   card side (a `stage:reveal` broadcast + a full-cast layout inside the corridors' surfaces
   expanding to the overlay), and ground what the app already allows for slot resize/overlay
   before building; if the app lacks it, STOP and report with the exact gap.

## Grounding

PM-A2 as landed; `src/shared/worldAssets/types.ts` (背景/全景 types exist — verified in the v4
doc trace); v4 doc §1.4/§3b/§5.

## Acceptance

Location change swaps the backdrop (standalone: mock the asset map); override + fallback paths
work; reveal state shows the full cast and returns cleanly. Gate green.
