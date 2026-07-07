# Review fixes 2026-07-06 — UI/UX + workflow-editor findings

**Source:** comprehensive project review 2026-07-06 (UI/UX + agent/workflow system), grounded against
the code on branch `claude/nifty-mcclintock-6e6a1b` (= main + poem design docs). Every file:line in
the issues was verified on that revision.

**Intent:** each issue below is a self-contained work package for one implementing agent
(**Opus 4.8, medium effort** — name model+effort in the dispatch description, e.g.
"RF-01 manual-trigger run-now [opus-4.8/medium]"). Agents execute the spec; they do not redesign.
If reality contradicts an issue's grounding (file moved, signature differs, a referenced helper
doesn't exist), **stop and report** — do not improvise around it.

## Ground rules (apply to every issue)

1. **Gate before done:** `npm run typecheck && npm run check:deps && npm run test` — all green.
2. **One issue per branch/PR.** No opportunistic refactors outside the issue's file list.
3. **i18n:** every new user-facing string goes through `t('key')` with the key added to BOTH
   `src/renderer/src/i18n/locales/en.ts` and `zh.ts` (exact strings are given per issue; use
   ST-ecosystem terms: 世界书 = lorebook, 预设 = preset, 正则 = regex, 工作流 = workflow).
4. **No new runtime dependencies.** The undo history in RF-03 is hand-rolled by design.
5. **Renderer ↔ main only via the preload surface:** a new IPC channel = handler in
   `src/main/ipc/*.ts` + binding in `src/preload/index.ts` + type in `src/preload/index.d.ts`,
   all in the same change.
6. **None of these issues touch the card-facing surface** (`shared/thRuntime`, `cardBridge`,
   `wcvPreload`, `shared/cardEnv.ts`, `RPTerminalExtSchema`, import pipeline) — so no `docs/sdk/`
   updates are required. If your change somehow does touch one of those, stop and report.
7. **Acceptance includes the user journey:** each issue names the journey to walk end-to-end from
   where the user actually starts (owner directive). Manual steps go in the issue's PR description
   for the owner pass; agents cannot drive the dev Electron app.
8. **The 48px rule:** any full-window overlay header must span 48px and reserve the right corner
   via `env(titlebar-area-x/width)` (see `WorkflowEditorOverlay.tsx:64-76` for the reference
   implementation). Relevant to RF-03/RF-09 which touch that header.

## Findings → issues map

| # | Issue | Priority | Finding |
|---|-------|----------|---------|
| 01 | manual-trigger-run-now | P0 | `runManualDoc` (headlessRunService.ts:882) has no IPC/preload/UI wiring — `trigger.manual` nodes cannot be fired at all |
| 02 | composer-type-while-streaming | P0 | Composer textarea `disabled={isGenerating}` blocks typing during generation |
| 03 | editor-undo-save-esc | P1 | Workflow editor: no undo/redo (Delete key IS wired), no Ctrl+S, Esc-anywhere closes the overlay |
| 04 | palette-search-minimap-center | P1 | Flat ~45-entry node palette, no search/categories/minimap; module import lands at fixed x/y (parked item) |
| 05 | view-title-i18n-parity-test | P2 | viewRegistry titles hardcoded English; Panel.tsx maps only 4/8 views; no locale-parity test |
| 06 | confirm-dialog-launcher | P2 | Native `confirm()` for world/session deletion in the styled launcher |
| 07 | accent-soft-token | P2 | `--rpt-accent-soft` used (ChatView.tsx:332) but defined in no theme |
| 08 | delete-dead-workflowview | P2 | `workspace/WorkflowView.tsx` (462 lines) is imported by nothing |
| 09 | editor-css-migration | P2 | ~125 inline `style={{}}` objects across the editor surfaces vs. the token-driven CSS elsewhere |
| 10 | topstrip-workflow-entry | P3 | Editor entry buried at Settings → Automation → Workflow → button |
| 11 | floor-pager-keyboard-jump | P3 | Floor pager is mouse-only corner buttons; no jump-to-floor |
| 12 | stripmenu-keyboard-a11y | P3 | TopStrip dropdowns have ARIA but no keyboard behavior (no arrows, Esc doesn't close) |

## Sequencing & conflict notes

- **RF-01 .. RF-08 and RF-10 .. RF-12 are independent** of each other; land in any order.
- **RF-03 before RF-04** (both edit `WorkflowEditorView.tsx` / `FlowCanvas.tsx`; 03's keyboard
  wiring is the smaller diff — rebase pain is lower this way).
- **RF-09 (CSS migration) lands LAST** among the editor issues — it rewrites the same JSX that
  03/04 touch; doing it first would force both to re-ground.
- RF-05's parity test will fail any later issue that adds a key to only one locale — that is the
  point; land RF-05 early if running issues in parallel.

## Out of scope (recorded, deliberately not in this batch)

- Converting the other nine native `confirm()` call sites (ApiSettingsPanel, LorebookManager,
  PluginsPanel, PresetManager, RegexPanel, CardScriptHost, …) — mechanical follow-up after RF-06
  proves the ConfirmDialog shape.
- MemoryPane inline-style migration (16 objects) — it is pack-era KEEP-ALIVE UI
  (handoff 2026-07-04 gotchas); don't churn it until its future is decided.
- Tier-2 pack-machinery retirement, `.rptrecipe` rethink, sub-graph promoted-param form UI,
  play-area redesign (has its own spec: `docs/design/poem-play-area-redesign.md`).
- The `editorToDoc` base-spread refactor (existing task chip).
