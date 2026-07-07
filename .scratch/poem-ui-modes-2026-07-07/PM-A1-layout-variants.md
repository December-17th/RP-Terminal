# PM-A1 — `panel_ui` layout variants + player mode picker

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P0 (blocks PM-C*, PM-D2, PM-E1)
Dispatch: opus-4.8/medium
Scope: app (main types + renderer workspace + play-shell chrome)

## What

Let ONE card declare multiple named play-area layouts, and let the player switch between them
per session. Card-agnostic: nothing poem-specific in RPT.

- Schema (`src/main/types/character.ts`, `RPTerminalExtSchema.panel_ui`): add an optional
  `variants` shape — a list of `{ id, label, panel_ui-fields }` (each variant carries the same
  fields panel_ui has today: mode/grid/slots/seamless/backdrop…), plus a `default` variant id.
  Backward compatible: a card with the current flat `panel_ui` keeps working unchanged (treat it
  as a single implicit variant).
- Renderer: `staticLayout.ts` / `StaticWorkspace.tsx` resolve the ACTIVE variant, falling back to
  `default`. Read the existing code first — do not infer its behavior from names.
- Picker: a small mode switcher in the play-area chrome, visible ONLY when the card declares >1
  variant. Labels come from the card's `label` (card content = its own language); the picker's own
  chrome strings (tooltip etc.) go through `t()` + both locale files.
- Persistence: the chosen variant id persists **per session in app storage** (ground where
  session-scoped state lives — the session/chat record on the main side is the likely home; do
  NOT store it in card variables). Switching re-renders the workspace layout live; WCV slots are
  created/destroyed accordingly (ground `wcvManager` lifecycle before touching it).

## Grounding (read before coding)

`src/main/types/character.ts` (RPTerminalExtSchema), `src/renderer/src/.../workspace/staticLayout.ts`,
`StaticWorkspace.tsx`, `src/main/services/wcvManager.ts`, `docs/sdk/component-inventory.md`.

## Acceptance

- A test card with 2 variants renders the default, the picker shows, switching swaps layouts and
  survives app restart for the same session; a legacy single-`panel_ui` card shows no picker.
- Schema change documented in `docs/sdk/` in the same commit (README map says which file).
- Gate green; tests added for variant resolution (pure logic, no Electron).
