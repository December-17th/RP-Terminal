# Card Custom UI in the Panel Workspace — Investigation & Design

Status: investigation + proposal. Builds on `docs/mvu-panel-workspace-design.md` (the two
MVU-rendering layers) now that Phase 1 gives us movable left/right panels.

## Goal

Let a card supply its OWN status/menu UI that renders in the left or right panel, runs scripts,
and — new — **WRITES message variables** (not just displays them). Two author-facing import modes:

1. **Native** — the card imports a config/settings for RP Terminal's native UI.
2. **Script** — the card imports scripts that render UI onto a panel.

Reference target: [KritBlade/MVU_Zod_StatusMenuBuilder](https://github.com/KritBlade/MVU_Zod_StatusMenuBuilder),
a drag-and-drop builder that generates these status menus for ST/MVU cards.

## What the StatusMenuBuilder actually produces (from `dist/layout-rpg.json`)

Its output is a **declarative JSON config (~72 KB), not runnable code**:

- Top level: `layout` (tabs → cards), `mvuData` (the variable values), `globalCss`,
  `globalLogic` (a JS recompute function), `customTemplates`, `selectedPaths`/`lockedPaths`,
  `staticLocale` (i18n).
- `mvuData` stats are `[value, label]` tuples — the MVU `stat_data` convention (value +
  description) that `StatView`/`statViewHelpers.asValueDesc` already understands.
- Each card: `{ id, type, title, mappedKey, maxMappedKey, barColor, sourceType, customLogic }`.
  `type` ∈ a **finite set**: `StatBar, StatRow, Image, Checkbox, RichText, QuestList`. `mappedKey`
  is a variable path; `customLogic` is a field-level JS string using `getV(root, path, default)`.
- Interactivity = checkbox toggle, `QuestList` delete, equipment equip/unequip → mutate `mvuData`
  and run `globalLogic` (`setVal(obj, key, value)`) to recompute derived stats.
- Target runtime: SillyTavern + TavernHelper (JS-Slash-Runner) + ST-Prompt-Template. **License:
  AGPL-3.0.**

**Implication:** this is a declarative UI tree with a finite widget vocabulary + small sandboxed
JS — almost perfectly suited to a NATIVE renderer. We'd consume the author's CONFIG (data), i.e.
format-compatibility (like reading ST cards), so its AGPL-3.0 doesn't bind us; and being AGPL
(OSI/free, compatible with our AGPL-3.0 lean) we *could* adapt its logic if ever needed — unlike
the AFPL JS-Slash-Runner (do-not-vendor).

## Shared prerequisite — a variable WRITE-BACK bridge

Today `stat_data` is written only by the model's `<UpdateVariable>`. Both options need panel UI to
MODIFY message variables. New capability (the heart of this feature):

- IPC `apply-variable-ops(profileId, chatId, floorId, ops)` → main applies ops to the floor's
  `stat_data` (reuse `mvuParser.applyJsonPatch` / `applyMvuCommands`), persists with
  `floorService.saveFloor`, returns the updated floor → `chatStore` swaps it in → every panel
  re-renders. (Mirrors the existing `setLatestFloorVariables` store path, but persisted + main-side.)
- "Message variables" (TavernHelper message scope) == our `floor.variables`. Default target = the
  latest floor (the current message).
- Optionally re-run the card's `globalLogic` / MVU recompute after a write so derived stats update.
- Guardrails: validate ops against `data_schema`/`state_schema` where present; user/script writes
  persist losslessly alongside the model's, so "re-evaluate" still works.

## Option 1 — Native UI from a card-imported config (recommended first)

The card ships a declarative status-menu config (the StatusMenuBuilder JSON and/or our own
`ui_layout`); RP Terminal renders it natively in a panel.

- **Storage:** under `data.extensions.rp_terminal` — e.g. `status_menu` = the builder JSON, or
  extend `ui_layout`. On import, optionally seed `state_schema.defaults` from `mvuData`.
- **Renderer:** the Phase-2 native view kit, extended to the builder's widget vocabulary
  (`StatBar/StatRow/Image/Checkbox/RichText/QuestList`) + tabs + scoped/sanitized `globalCss`.
  Bind `mappedKey` → `stat_data`. Registered as a `status-menu` view, mountable in any panel.
- **Field logic** (`customLogic`, `globalLogic`) runs in our quickjs sandbox
  (`templateService`/`sandboxRunner`) with a bound `getV(root,path,def)` / `setVal(obj,key,val)`
  API over a COPY of `stat_data`; results drive display, and `setVal`/interactions route through
  the write-back bridge.
- **Interactivity:** Checkbox / Delete / Equip emit variable ops → bridge → re-render.
- Pros: safe (only sandboxed expressions, no arbitrary DOM/JS), themeable, fast, no webview, works
  in any panel, and directly consumes the most popular builder's output. Cons: we implement each
  widget `type` + a faithful `getV/setVal` surface; exotic author HTML isn't pixel-identical.

This is the design doc's "native MVU views (A)" made concrete + interactive.

## Option 2 — Script-embedded UI in a panel (needs isolation)

The card ships JS/HTML (a frontend card / TavernHelper script) that renders its OWN UI into a panel
and uses the TavernHelper/Mvu shim to read/write message variables.

- A new `panel-ui` view type hosts a card-provided bundle in a process-isolated `<webview>`
  (**task #1**) with the clean-room ST/MVU runtime shim (**task #2**): `getVariables` /
  `replaceVariables` / `insertOrAssignVariables` (message scope), `Mvu.setMvuVariable`, events,
  `getV`. Writes route through the same bridge.
- The card declares `panel_ui` + a target slot under `rp_terminal`; different panels can host
  different bundles.
- Pros: pixel-exact author UI, arbitrary interactivity, runs the real ecosystem code. Cons: needs
  the webview isolation + the deep shim (both deferred); larger trust/security surface; per-card
  opt-in (matches today's click-to-run gate).

This is the design doc's "webview card-UI (B)", generalized to any panel + write-back.

## How a card picks an option

Under `data.extensions.rp_terminal`:

- Option 1: `status_menu` (builder JSON) and/or `ui_layout` (our spec) + `data_schema`/`state_schema`.
- Option 2: `panel_ui: [{ slot: 'left' | 'right', name, code | html, enabled }]` (+ existing `scripts`).
- A card may ship both (native by default, webview as an opt-in fidelity view). A panel's
  view-picker lists whichever the card provides.

## Security

- Option 1 field logic: quickjs only (no DOM, no network); `globalCss` sanitized + scoped to the
  panel; ops validated against the schema.
- Option 2: webview with no node / no `allow-same-origin`; all host access via the shim's narrow
  IPC; writes validated; per-card consent.
- Never node `vm`; never run untrusted author JS on the main thread.

## Recommendation / sequence

1. **Variable write-back bridge** — small, unlocks interactivity for everything (and useful on its
   own, e.g. manual stat edits).
2. **Option 1** on the Phase-2 native view kit — implement the builder's widget vocabulary +
   sandboxed `getV/setVal` + config import. Highest value, safe, no new infrastructure.
3. **Option 2** after task #1 (webview) + task #2 (shim) — the `panel-ui` webview view for
   pixel-exact author UIs.
