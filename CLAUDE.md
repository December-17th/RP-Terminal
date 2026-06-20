# CLAUDE.md — RP Terminal

System context for working in this repository. Read this first; it captures the
non-obvious conventions and architecture that aren't derivable from a quick scan.

---

## Project Overview

**RP Terminal** is an Electron desktop app for sophisticated AI roleplay — a
local "console" that runs SillyTavern-compatible content as interactive
sessions. Core functionality today:

- Import **character cards** (PNG with embedded JSON, or raw JSON; v1/v2/v3 specs)
  and their embedded **lorebooks** (`character_book`).
- Import and edit **SillyTavern presets** (prompt ordering + sampler params) and
  **regex** beautification scripts.
- Turn-based ("floor") chat against OpenAI-compatible and Anthropic APIs with
  **streaming**, regenerate, and per-message state.
- A keyword-triggered **lorebook/world-info** injection system.
- A data-driven **status panel** (HP bars, lists, text) per card, driven by
  `<rpt-event>` tags the model emits to mutate game state.

The long-term goal (see ROADMAP) is a CRPG/visual-novel-style engine: an agentic
mode with manual Explore/Dialogue/Combat modes, deterministic sandboxed combat
math, multi-lorebook RAG, prompt-cache optimization, and a "cartridge" card
format. **The current code is an MVP foundation, not the final architecture.**

---

## Tech Stack & Tools

- **Language:** TypeScript (strict), React 19, JSX runtime.
- **Shell:** Electron 39 (`electron-vite` for dev/build, `electron-builder` for
  packaging). Main process = Node 22.
- **UI:** React + **Zustand** stores; `react-markdown` (+ `remark-gfm`); plain CSS
  with `--rpt-*` CSS variables (no UI framework). `react-virtuoso` is a dependency
  but not yet wired.
- **Validation:** **Zod 4** owns the shape of cards, presets, and lorebooks.
- **Storage:** **better-sqlite3** (native; externalized + rebuilt for Electron)
  for relational/session data; **JSON files** for portable artifacts.
- **IDs:** `uuid` and Node `crypto.randomUUID`.
- **Tooling:** Prettier + ESLint (`@electron-toolkit/*` configs). No test runner
  yet.

Key commands:
- `npm run dev` — launch Electron with HMR.
- `npm run typecheck` — `typecheck:node` + `typecheck:web`; **must pass** (`build`
  runs it first). Always run before considering a change done.
- `npm run build` / `build:win` / `build:mac` / `build:linux`.
- `npm run lint` / `npm run format`.

---

## Architecture & Directory Structure

**Two-process split = backend/frontend.** The Electron **main process is the
engine** (all IO, DB, API calls, prompt assembly); the **renderer is a thin UI**.
They talk over **IPC via the preload bridge** (`src/preload/index.ts` exposes
`window.api.*`). There is no REST/WebSocket server — IPC is the bridge.

```
src/
  main/
    index.ts                 Electron entry: window + ALL ipcMain handlers (thin, delegate to services)
    services/
      db.ts                  SQLite open + schema (profiles, settings, characters, chats, floors,
                             rpg_entities, episodic_memory). WAL + FKs. Drops legacy preset/lorebook tables.
      storageService.ts      Filesystem helpers (getAppDir, ensureDir, read/writeJsonSyncAtomic, listers)
      profileService.ts      SQL
      settingsService.ts     SQL (Settings stored as a JSON blob)
      characterService.ts    SQL (card = JSON blob); avatars copied to userData/.../avatars/<id>.png
      chatService.ts         SQL; getChats/getChat/createChat/appendFloor/truncateFloors/deleteChat
      floorService.ts        SQL; one row per floor (PK chat_id+floor)
      presetService.ts       FILE-based, multi-preset (profiles/<id>/presets/<uuid>.json + _active.json)
      lorebookService.ts     FILE-based (profiles/<id>/lorebooks/<characterId>.json) + matchEntries (pure)
      promptBuilder.ts       Assembles the provider message[] from card+preset+lorebook+history
      generationService.ts   Orchestrates a turn: build -> stream -> regex -> rpt-event parse -> fold
                             state -> persist floor. generate() + regenerate().
      apiService.ts          streamProvider(): SSE for OpenAI-compatible + Anthropic
      logService.ts          In-memory ring buffer + IPC push ('log-event') + stdout mirror
      migrationService.ts    One-time, atomic, idempotent JSON->SQLite import on first run
    parsers/
      stPngParser.ts         Extract embedded JSON from PNG tEXt/iTXt 'chara' chunks
      stPresetParser.ts      Normalize an ST preset (prompts + prompt_order) into our marker model
      stRegexEngine.ts       Load/apply ST regex rules (placement-aware)
      contentParser.ts       Extract <rpt-event ... /> tags from model output -> events[]
    types/
      character.ts           Zod: RPTerminalCard, CardData, Lorebook(+Entry), RPTerminalExt, WidgetDef
      preset.ts              Zod: Preset, PromptBlock, PromptMarker; getDefaultPreset()
      chat.ts                FloorFile, ChatSession, FloorIndexEntry (interfaces)
      models.ts              Profile, Settings (interfaces)
  preload/index.ts           contextBridge: window.api.* (one method per IPC channel) + event subscriptions
  renderer/src/
    App.tsx                  The whole UI: top-nav tabs + 3-column layout
    stores/                  Zustand: profile/settings/character/chat/preset/lorebook/log
    components/              LayoutRenderer, WidgetRegistry, Modal, PresetManager, LorebookManager, LogsPanel
    assets/index.css         Real styles (--rpt-* tokens). NOTE: main.css/base.css are leftover boilerplate.
```

**Storage philosophy (important):** relational/session state lives in **SQLite**;
**portable, user-shareable artifacts stay as JSON files in their native format** —
**presets, lorebooks, and regex are files, never SQL rows.** Cards/settings are
JSON blobs inside SQL because a Zod schema owns their shape. Data root:
`app.getPath('userData')/rp-terminal-data/` (`rpterminal.db` + `profiles/<id>/{presets,lorebooks,regex}/` + `avatars/`).

**Design patterns / invariants:**
- Services are **function modules** (named exports), imported as namespaces
  (`import * as fooService`). No classes, no DI.
- **All generation happens in main.** The renderer calls one `generate` IPC and
  receives a persisted floor; it never assembles prompts.
- **Prompt assembly is preset-driven** (`promptBuilder`): preset prompt blocks are
  emitted in order; `marker` blocks (`char_description`, `mes_example`,
  `world_info`, `chat_history`, `post_history`) expand to live content. There are
  safety nets (e.g. history is appended if no `chat_history` marker exists).
- **Streaming:** `apiService.streamProvider` emits deltas via an `onDelta`
  callback → main forwards them on the `generation-delta` IPC channel → the
  renderer shows live text, then swaps in the final post-processed floor.
- **State events:** `<rpt-event type="state" path="stats.hp" action="set|add|remove" value=.. />`
  are parsed out of responses and folded into `floor.variables`, which drive the
  right-panel widgets (`LayoutRenderer` + `WidgetRegistry`).
- **Provider quirk:** strict Claude/Bedrock proxies require the conversation to
  END with a user message; `apiService` moves the last user message to the end on
  the OpenAI-compatible path.

---

## Coding Standards

Prettier is the source of truth (`.prettierrc.yaml`): **2-space indent, single
quotes, NO semicolons, printWidth 100, no trailing commas.** (Some early renderer
files still carry semicolons from the scaffold — match Prettier, not them.)

- **Naming:** services `xxxService.ts` with named function exports; functions
  `camelCase`; React components & types `PascalCase`; Zod schemas suffixed
  `Schema` with the inferred type sharing the base name (`PresetSchema` →
  `type Preset`); Zustand hooks `useXxxStore`; IPC channels kebab-case
  (`get-floors`, `set-active-preset`).
- **React:** function components + hooks only; local state via `useState`; cross-
  cutting state via Zustand. Keep `window.api` typed loosely (`api: any` in
  `preload/index.d.ts`) — don't over-type the bridge.
- **Validation/IO:** parse untrusted input with Zod `safeParse` and skip/getDefault
  on failure; wrap file/JSON/DB reads in try/catch; writes are atomic
  (`writeJsonSyncAtomic`). Never trust imported card/preset/lorebook shape.
- **Comments** explain *why* (especially provider/format quirks and safety nets),
  not *what*. Match the surrounding density.
- **IPC handlers stay thin** — validate/route only; logic lives in services.
- **Errors** thrown in main propagate to the renderer (shown as an error block)
  and should be logged via `logService.log('error', …)` so they appear in the
  Logs panel and stdout.

**Dev-loop caveat (read this):** `electron-vite dev` **HMRs the renderer but does
NOT auto-restart the main process.** After editing anything under `src/main` or
`src/preload`, you must restart Electron for it to take effect. better-sqlite3 is
a native module — it's externalized in `electron.vite.config.ts` and rebuilt for
Electron via `electron-builder install-app-deps`; packaging will need asar-unpack.

---

## Roadmap & Current Focus

Full plan with status markers lives in [ROADMAP.md](ROADMAP.md). Synthesis:

**Done:** unified Zod card schema; centralized generation; floor persistence;
marker-based preset model + ST importer; keyword lorebook; tabbed UI shell;
streaming (A1); regenerate + delete + persona (A2/A4/A5); provider message fix
(A6); logs console; **SQLite migration (Phase F)**; **multiple file-based presets**.

**Immediate next steps:**
1. **Phase G — Four-layer prompt-cache assembly:** rebuild `promptBuilder` into
   immutable layers (L1 static core → L2 semi-static lore/memory → L3 rolling
   history → L4 volatile state at the bottom) mapped onto Anthropic `cache_control`
   / OpenAI prefix caching. Highest-value foundation piece.
2. **Phase A leftovers:** A3 token-budget/truncation (long sessions overflow
   context today); swipe/edit-message.
3. **Phase B — the visual thesis:** safe HTML render pipeline (DOMPurify +
   `rehype-raw`/sandbox) so card/regex HTML actually renders; regex engine
   fidelity + management UI.
4. **Phase C — ST-Prompt-Template (EJS):** currently `<% %>` blocks are *stripped*,
   not evaluated.

**Locked architectural decisions for vNext (do not relitigate):** Node-only, **no
local ML**; the agentic FSM uses **manual mode switching** now (auto-routing is
opt-in via a user-configured API later); **embeddings/RAG are optional** and
user-API-based — **keyword lorebooks remain primary**; keep React + virtualization
(no framework swap); keep the IPC bridge (no separate backend process) and offload
heavy work to `worker_threads`/`utilityProcess` when needed.

**Known gaps / security:** `sandbox: false` + future untrusted-HTML rendering is an
XSS surface — land DOMPurify *with* Phase B. Untrusted author scripts (combat/Forge)
will need a real JS sandbox (`isolated-vm`/`quickjs`), never node `vm`. An empty
preset injects no lorebook today (no `world_info` marker) — `promptBuilder` should
gain a world-info safety net.
