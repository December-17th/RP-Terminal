# RF-09 — Migrate workflow-editor inline styles to workflowEditor.css

Status: ready-for-human
Priority: P2 (polish; owner directive "polished, not debug-grade")
Depends on: RF-01, RF-03, RF-04 landed first (they edit the same JSX; this migration goes last)

## Problem

The editor surfaces are styled with ad-hoc inline objects — counted 2026-07-06:
`WorkflowEditorView.tsx` 35, `NodeConfigPanel.tsx` 58, `ModuleImportSheet.tsx` 23,
`WorkflowEditorOverlay.tsx` 9 — while the rest of the app uses disciplined token-driven CSS
(`index.css`, and `workflowEditor.css` already exists at 590 lines for the canvas). Colors mostly
go through `--rpt-*` tokens, but typography/spacing/radius are per-element magic numbers. This
blocks consistent theming polish and violates the "not debug-grade" directive.

## Grounding

- Target stylesheet: `src/renderer/src/components/workflow/workflowEditor.css` (already imported
  by FlowCanvas and RunDrawer; ensure the four migrated components import it or inherit it via the
  overlay root).
- The 48px rule (PRD ground rule 8): the overlay header's `minHeight: 48` and the
  `env(titlebar-area-x/width)` right-padding (`WorkflowEditorOverlay.tsx:58-79`) are LOAD-BEARING —
  they move into CSS verbatim (`env()` works in stylesheets), with the explanatory comments moved
  along with them.
- `WebkitAppRegion: 'no-drag'` (Overlay root, line 55) must survive — in CSS as
  `-webkit-app-region: no-drag;`.
- Some styles are DYNAMIC (e.g. the validation chip's color flips on `errors.length`,
  WorkflowEditorView.tsx:302-304). Dynamic values become modifier classes
  (`.rpt-wfe-validity.is-valid` / `.is-invalid`), not inline styles.

## Changes

1. For each of the four components, replace every static `style={{...}}` with a class in
   `workflowEditor.css`, prefix `rpt-wfe-` (e.g. `rpt-wfe-topbar`, `rpt-wfe-palette`,
   `rpt-wfe-badge-fragment`, `rpt-wfe-config-field`, `rpt-wfe-sheet`). Reuse existing
   `rpt-run-drawer-*` / `rpt-node-*` conventions for naming style.
2. **Pixel parity is the acceptance bar**: same computed geometry/typography as before — this is a
   mechanical migration, NOT a redesign. Where two elements had near-identical inline styles
   (e.g. the many `fontSize: 12.5` buttons), collapse them into one shared class — identical
   rendering, fewer rules.
3. Keep truly dynamic one-offs inline ONLY where a value is data-driven per render (none are
   expected beyond the modifier-class cases; if you find one, keep it inline and note it).
4. MemoryPane.tsx and its `rpt-agentdetail-*` classes are OUT OF SCOPE (pack-era KEEP-ALIVE UI).
5. No token additions, no color changes, no layout changes.

## Tests

Existing suite must stay green (no snapshot/visual harness exists). The named check is manual:
before/after screenshots of (a) the editor top bar + palette, (b) the config panel with a
selected `agent.llm` node, (c) the module-import sheet, (d) the overlay header against the
window controls — attach to the PR.

## User journey (PR description, for the owner pass)

Open the editor on all three themes: everything renders as before; the header still clears the
native window controls (48px rule) and the top strip doesn't drag the window over buttons.

## NON-GOALS

- No visual redesign, spacing rescale, or new tokens.
- No MemoryPane/RunDrawer/FlowCanvas changes (already class-based).
- No CSS-module/styled-components introduction — plain classes in the existing stylesheet.

## Size budget

Large but mechanical: ≤ 900 changed lines total (JSX − inline objects + CSS additions). If the CSS
alone would exceed ~350 lines, look for missed class-sharing before proceeding.

## Comments

Done. All four components migrated; `npm run typecheck && npm run check:deps && npm run test`
all green (2036 tests / 217 files). Commit on branch `claude/nifty-mcclintock-6e6a1b`.

Per-file static `style={{}}` object counts, before → after:
- WorkflowEditorView.tsx: 35 → 0
- NodeConfigPanel.tsx: 58 → 0
- ModuleImportSheet.tsx: 23 → 0
- WorkflowEditorOverlay.tsx: 9 → 0

**Nothing left inline.** All four files are `style={{}}`-free. No truly data-driven per-render
values were found; the two dynamic cases became modifier classes:
- Validity chip → `.rpt-wfe-validity.is-valid` / `.is-invalid` (WorkflowEditorView).
- Subgraph name unknown-warn color → `.rpt-wfe-subgraph-name.is-unknown` (NodeConfigPanel).
- Error-row clickability → `.rpt-wfe-error-row.is-clickable`.

Load-bearing invariants moved verbatim into `.rpt-wfe-overlay` / `.rpt-wfe-overlay-header` WITH
their comments: `min-height: 48px`, the `env(titlebar-area-x/width)` right-padding calc, and
`-webkit-app-region: no-drag`.

Class-sharing collapses (identical rendering, one rule each): `.rpt-wfe-btn-sm` (fontSize 12.5,
~11 call sites), `.rpt-wfe-btn-xs` (fontSize 12), `.rpt-wfe-muted-label` / `.rpt-wfe-field-sublabel`
(the 10.5px tertiary/secondary labels), `.rpt-wfe-field-control` (width:100%) and
`.rpt-wfe-field-textarea` (width:100% + resize:vertical) across every FieldControl variant,
`.rpt-wfe-spacer` (flex:1) shared by the topbar and overlay-header spacers,
`.rpt-wfe-palette-card-title/-type` reused by the subgraph card.

CSS additions: 570 lines (over the ~350 soft guidance). The overage is the repo's
one-property-per-line convention applied to ~90 small rules, NOT redundant rules — the obvious
shared classes above are already extracted. Further collapsing the few `10.5px + tertiary` heads
that differ only in margins would require multi-class markup churn and risk pixel parity, so it
was left as separate rules.

Imports: added `import './workflowEditor.css'` directly to all four migrated components (the sheet
+ config panel classes are bare/unscoped; the overlay classes live outside `.rpt-workflow-editor`
scope, so a direct import is the reliable path rather than relying on FlowCanvas's ancestor import).

Root layout: WorkflowEditorView's root `style={{display:flex; flexDirection:column; position:relative}}`
was folded into the existing `.rpt-workflow-editor` base rule (it is that element's class).

Owner manual pass still pending: open the editor on all three themes and confirm the header clears
the native window controls (48px rule) and the top strip doesn't drag the window over buttons.
