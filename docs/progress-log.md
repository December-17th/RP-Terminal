# RP Terminal — Progress Log

Running status of the MVU / panel-workspace track. Newest first.

## 2026-06-21

### Done this session
- **MVU state pipeline (both dialects).** `<UpdateVariable>` parsing supports classic
  `_.set(path, old, new)` (reason from a trailing `//comment`) and `<JSONPatch>` (RFC-6902 +
  the non-standard `insert`/`set`→add and `delete`/`unset`→remove aliases the cards use).
  Applied to `floor.variables.stat_data` in `generationService`; `mvuParser` is pure + tested.
- **Lossless storage.** The FULL raw AI response (incl. `<thinking>`/`<UpdateVariable>`) and the
  FULL request prompt (`floors.request`) are stored; all transforms (reasoning strip, state-tag
  strip, beautification regex) happen at VIEW time (`src/shared/responseView.ts`,
  `ChatView`/`StreamingView`). Disabling the card's regex now shows the original; nothing is
  truncated in storage.
- **"Re-evaluate" button** (`reevaluateVariables`): replays every floor's stored `<UpdateVariable>`
  updates to rebuild `stat_data` without regeneration — e.g. to apply a parser fix retroactively.
- **Generic status panel:** `StatView` recursively renders arbitrary `stat_data` (bars for
  value/max incl. "current/max" strings, lists, collapsible groups) with no hand-authored layout.
- **Panel workspace — Phase 1 (commit `9999d57`).** Replaced the fixed 3-column shell with a
  resizable, reconfigurable split-pane workspace (custom, no docking lib). Layout is a pure,
  unit-tested split-tree (`src/shared/workspaceLayout.ts`); `workspaceStore` keeps one layout per
  FSM mode (explore/dialogue/combat), follows `chatStore.activeChatMode`, and debounce-persists
  into `Settings.workspace`. Views wrapped via a `ViewRegistry` (navigator/chat/status/
  card-scripts/logs); `RightPanel` decomposed into `StatusView` + a card-scripts view; `navStore`
  lifts the nav tab; `PluginHost` moved to a bounded app-root dock.
- **Design doc:** `docs/mvu-panel-workspace-design.md` (State/Logic/View split; native vs
  webview MVU UI; the 5-phase plan).

### Architecture state
- State source of truth = `floor.variables.stat_data` (MVU tree). Read by `StatView` /
  `LayoutRenderer`; written (today) only by the model via `<UpdateVariable>`.
- Generation is main-side; the renderer is a thin UI over IPC. Frontend-card execution is
  shelved behind a click-to-run gate (Electron iframes are same-process — true isolation needs
  `<webview>`).

### Next / open
- **Phase 2 — native MVU view kit:** grow `StatView`/`WidgetRegistry` into tabs/grids/inventory/
  relationship/map widgets, driven by `ui_layout` then the MVU `data_schema`.
- **Card custom UI embedding (investigating now):** let the left/right panels host a card's own
  MVU UI that can run scripts and WRITE message variables — two import modes (native-UI settings
  vs script-embedded UI). See `docs/card-custom-ui-design.md`.
- **Task #1:** process-isolate frontend-card frames via `<webview>` (the only reliable Electron
  OOP path) — prerequisite for safely running card-authored UI/scripts.
- **Task #2:** deep ST/MVU runtime shim (clean-room) — getVariables/replaceVariables(message
  scope), Mvu API, events, `<|ws_slot|>` injection.
