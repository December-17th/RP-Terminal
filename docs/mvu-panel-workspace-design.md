# MVU + the Reconfigurable Panel Workspace — Design

Status: proposal. Supersedes the fixed 3-column layout's right column with a dockable workspace,
and defines how MVU compatibility, a native game engine, and the UI coexist.

## Goals

1. **Full MVU UI compatibility** — render a card's own MVU-driven UI faithfully.
2. **Native game logic** — deterministic combat/state math computed locally (no AI for numbers).
3. **An "MVU mod"** — AI-updated variables (MagVarUpdate) with minimal/no scripts, as a
   compatibility layer for the existing card ecosystem.
4. **A reconfigurable workspace** — resizable, movable, dockable panels that rearrange per the
   game's need (split-screen, per-mode layouts).

## Core principle: separate STATE / LOGIC / VIEW

The whole design hangs on keeping these three independent. It's what lets MVU and a native engine
coexist, and lets the same state drive multiple UIs.

- **State** — `stat_data` (the MVU variable tree) is the single source of truth, mode-agnostic.
  Already tracked: the `_.set` + `<JSONPatch>` engines (`mvuParser`), lossless storage, and the
  "re-evaluate" replay all operate on it.
- **Logic** — *how* state changes. Pluggable **systems** (combat, leveling, events, relationships).
  Each system is flagged AI-driven (MVU) or native (deterministic).
- **View** — panels that *render* state. Pluggable **views** arranged in the workspace.

`stat_data` is the universal currency: every view reads it, every system writes it.

## 1. The panel workspace (the UI shell)

Replace the fixed right column with a **dockable panel container**.

- The workspace is a tree of split containers (horizontal/vertical) holding **panels**; each panel
  hosts a **view** (registered component): Chat, Status (native), Card UI (MVU), Map, Inventory,
  Combat, Quest Log, Logs, Inspector, …
- **Resizable**: drag splitters. **Movable/dockable**: drag a panel tab to a dock zone → split,
  tab-group, or float. **Show/hide/add** via a panel chooser.
- **Layouts are data**: a layout = the split tree + which view in each panel + sizes. Stored
  per-profile, **per FSM mode** (explore/dialogue/combat), and optionally **declared by the card**
  (a card ships a default layout). Persisted in SQLite/settings; lives in a `workspaceStore`.
- **Per game need**: the FSM mode (or a card/script via an API) switches the active layout — e.g.
  entering Combat swaps to a combat-focused layout (Combat + Status + a narrow Chat); Explore shows
  Map + Status + Chat. Declarative and smooth.
- **Implementation**: a custom split-pane manager, or an MIT/permissive dock lib (react-resizable-
  panels for splits + a light drag-dock layer; evaluate dockview/rc-dock licenses first — keep it
  permissive, no AGPL). State in Zustand; views resolved via a `ViewRegistry` (mirrors the existing
  `WidgetRegistry`).

## 2. MVU rendering — two layers (the key decision)

"Full MVU UI compatibility" is delivered by **two complementary view types, both reading the same
`stat_data`**. The user (or the card/mode) chooses which to show; they can be shown side by side.

### (A) Native MVU views — the default, safe, no isolation
Data-driven renderers that interpret `stat_data` (+ an optional layout/schema). **No card code
runs.** `StatView` is the seed; grow it into a **view kit**: stat bars, key/value grids, lists,
tables, tabs, collapsible groups, a map widget, an inventory grid, a relationship list, a quest
tracker. Driven, in priority order, by:
1. the card's `rp_terminal.ui_layout` (our native layout spec), else
2. the MVU `data_schema` (auto-derive: bars for value/max, lists for arrays, …), else
3. pure auto-render (today's `StatView` fallback).

This **is** the "MVU mod" UI: AI updates variables → native views render them. Safe, fast,
themeable, always works, no webview.

### (B) Card's own MVU UI — the exact-fidelity compat view
Host the card's actual frontend (its Vue/HTML app) in a **process-isolated `<webview>`** (task #1)
with the **deep ST/MVU runtime shim** (task #2). Renders the card's bespoke UI exactly. It's just
another panel (the "Card UI" view), so it docks alongside native views. Cost: needs the isolation +
runtime work; opt-in per trusted card.

> Native views = always-on safe MVU UI (the mod). Webview card-UI = exact fidelity (full compat).
> Same `stat_data` feeds both, so they never disagree.

## 3. Logic — native engine ⇄ MVU, coexisting

State changes come from pluggable **systems**, each flagged AI-driven or native:

- **MVU (AI-driven)**: the model emits `<UpdateVariable>` → applied (done). Optional card automation
  scripts (leveling/achievements/events — e.g. `Automated-script-for-destined-journey`) run as
  sandboxed card scripts (CardScriptHost, isolated), or we replicate common ones natively.
- **Native (deterministic)**: RP Terminal computes the math locally — combat resolution, dice,
  damage, leveling — in a sandboxed deterministic engine (the roadmap's "deterministic sandboxed
  combat math"), writing results to `stat_data`. The AI narrates outcomes; the engine owns the
  numbers, so no hallucinated damage.
- **Hybrid (the target)**: a card/cartridge declares which systems are native vs AI. e.g. combat =
  native, relationships/events = AI. Both write the same `stat_data`; panels render it uniformly.

The "MVU mod" = the package providing the AI-driven path (the `<UpdateVariable>` parser, schema,
native status views, optional script runtime). The native engine = the core. MVU rides on top as a
compatibility/content layer.

## 4. Data flow (one turn)

user acts → engine assembles prompt (current `stat_data` injected) → AI responds (narrative +
`<UpdateVariable>` for AI-driven systems) → native systems compute their deltas (combat math) →
all deltas fold into `stat_data` → every panel re-renders (native views + the webview card-UI, both
reading `stat_data`). "Re-evaluate" can rebuild `stat_data` from stored responses at any time.

## 5. Build phases (incremental, each shippable)

1. **Workspace shell** — dockable/resizable/movable panels + layout persistence + `ViewRegistry`.
   Foundation; wraps the existing Chat / RightPanel as the first two views.
2. **Native MVU view kit** — grow `StatView` into the schema/layout-driven renderer (tabs, grids,
   map, inventory). Delivers the "MVU mod" UI.
3. **Per-mode / card-declared layouts** — FSM mode + cards switch layouts (combat vs explore).
4. **Webview card-UI panel** — exact-fidelity compat view (needs task #1 isolation + task #2
   runtime). Delivers full MVU UI compatibility.
5. **Native deterministic engine** — local combat math + per-system native/AI flags. The CRPG core.

## Open decisions

- Dock implementation: custom vs a permissive lib (license-gated — no AGPL).
- Layout-spec schema (the native `ui_layout`): how rich, and how it auto-derives from `data_schema`.
- How a cartridge declares native-vs-AI systems and its default per-mode layouts (card extension
  fields).
- Whether the webview card-UI and native status should two-way sync edits, or webview is read-only.
