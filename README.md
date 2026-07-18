# RP Terminal

> **Status: early development.** RP Terminal is a work-in-progress standalone desktop application.
> Interfaces, storage schemas, and the extension surface are still evolving.

RP Terminal is a **standalone Electron desktop app** for AI-driven interactive fiction and roleplay
games. It pairs a streaming LLM generation pipeline with a sandboxed scripting/template runtime,
author-authored UI panels, native local game systems (turn-based combat and a deckbuilder duel), and a
visual node-graph workflow engine — all running locally against your own model provider and API key.

The renderer is **React 19 + Zustand**; all model generation is centralized in the **Electron main
process**; state is persisted with **SQLite + a file-based store**. The app UI is localized (\*\*English

- 简体中文\*\*, extensible).

---

## Architecture at a glance

RP Terminal is a four-layer Electron application. Process and module boundaries are **enforced in CI**
by `dependency-cruiser` (`npm run check:deps`), not left to convention.

```
┌── renderer ──────────────────────────────────────────────┐   React 19 + Zustand UI, i18n,
│   workspace views · launcher · authored-UI hosts         │   panel rendering, editors
└───────────────┬──────────────────────────────────────────┘
                │  typed IPC only (window.api, via preload)
┌── main ───────▼──────────────────────────────────────────┐   generation, services, IPC,
│   generation pipeline · services · parsers · workers     │   custom protocols, SQLite
└───────────────┬──────────────────────────────────────────┘
                │  imports
┌── shared ─────▼──────────────────────────────────────────┐   pure, cross-process code:
│   sandbox runtime · combat/duel engines · template eng.  │   no Electron / IPC / renderer deps
└──────────────────────────────────────────────────────────┘
```

- **`renderer` never touches main internals** — it reaches the main process only through the typed IPC
  surface exposed on `window.api` by the preload bridge.
- **`shared/*` is pure** — it must not import from `renderer` or `main`, and the game engines carry no
  Electron/IPC/DOM dependencies, which keeps them unit-testable in isolation.
- **The sandbox runtime is one surface with two transports at parity** (see below); behavior lives in
  the shared runtime so both transports inherit it and never drift.

Crossing a boundary means changing the dependency-cruiser rule deliberately in the same change — bypass
via `eslint-disable` is not permitted.

---

## Generation pipeline

All LLM calls run in the **main process**; the renderer only dispatches an action and streams deltas
back. One turn flows through a testable, staged pipeline (`src/main/services/generation/`):

1. **Assemble context** (`buildGenContext`) — gather the session, settings, active preset, working
   variables, and scan/recursion parameters into a single `GenContext` up front, so the rest of the
   turn reads from it rather than re-deriving state.
2. **Compose the prompt** (`assemble.ts`, `promptBuilder.ts`) — build the ordered message array from
   the preset's prompt sections, injected context, and templated content.
3. **Call the model** (`callModel.ts`, `apiService.ts`) — stream a completion from the configured
   provider. **OpenAI-, Anthropic-, and Google/Gemini-compatible** endpoints are supported behind a
   provider-shape abstraction, with configurable base endpoint and key.
4. **Parse the response** (`parseResponse.ts`) — split the streamed text into displayable body,
   reasoning, and any structured state directives.
5. **Fold state** (`foldState.ts`, `varsWrite.ts`) — apply state updates emitted by the turn to the
   session's variable store, journaled so they can be replayed/rewound.
6. **Persist** (`persistFloor.ts`) — write the completed turn to storage.

Supporting infrastructure:

- **Rate & concurrency control** (`rpmLimiter.ts`) — a per-endpoint **RPM budget** (requests are
  delayed, never dropped) plus an independent **max-concurrency** cap, so a multi-call graph can't open
  unbounded parallel requests inside one window. Presets sharing an endpoint share one budget.
- **Resilient calls** (`resilientCall.ts`) — retry/abort handling around the streaming provider.
- **Usage & cost accounting** (`usageMetricsService.ts`, `usageCost.ts`) — captures each provider's raw
  usage payload and surfaces token/cost overlays.
- **Prompt-cache metrics** (`promptCacheMetrics.ts`, `cacheLayers.ts`) — scaffolding for reasoning
  about prompt-cache hit rates across turns.

---

## Sandboxed runtime & authored UI

Authored content can ship both **logic** (templates/scripts) and **UI**, executed under isolation:

- **Template / expression engine** (`shared/templateEngine.ts`) — a clean-room reimplementation of an
  EJS-style prompt-templating dialect, executed inside a **QuickJS WASM sandbox**
  (`quickjs-emscripten`) via a worker (`src/main/workers/sandboxWorker.ts`), so authored code never runs
  with host privileges.
- **Unified UI runtime with two transports at parity** (`shared/thRuntime`):
  - **Inline** — authored UI rendered in-message through a bridged iframe (`cardBridge`,
    `InlineCardFrame.tsx`).
  - **Isolated** — the same UI rendered in a crash-resistant Electron **WebContentsView**
    (`wcvManager.ts`, `CardScriptWcvHost.tsx`), served over a dedicated privileged scheme so it gets a
    stable, storage-enabled origin.

  Both transports drive the **same shared runtime**, so a behavior change in one surface applies to both.

- **HTML sanitization** — inline authored HTML is sanitized with **DOMPurify** before rendering.
- **A curated set of environment libraries** (jQuery/-UI, Vue 3, Pinia, Tailwind, Font Awesome) is
  vendored (`resources/cardlibs/`) or served on demand (`shared/cardEnv.ts`) so authored UIs have a
  predictable runtime.

---

## Native game systems

The combat and duel engines live in `shared/combat` and are **pure, seeded, and deterministic** — no
renderer, Electron, or IPC dependencies — so the same code runs headless in tests and interactively in
the app. The AI narrates and referees; the engines own the rules.

- **Grid / turn-based tactical combat** (`shared/combat/engine.ts`, `grid.ts`, `resolver.ts`,
  `dice.ts`) — a d20-style turn system with a seeded RNG and a serializable state snapshot; driven from
  the main process via `combatService.ts` and surfaced in a native workspace view.
- **Deckbuilder duel** (`shared/combat/deckbuilder`) — a Slay-the-Spire-style card-battle mode with its
  own engine, an interactive native view (`duelService.ts`, `DuelPopup.tsx`), and a headless
  preview API.

Both are **content-agnostic**: the app supplies the engine; rulesets and skins come from authored
content.

---

## Agents & the workflow node-graph engine

Generation and agentic behavior are authored as a **visual, ComfyUI-style node graph** (`shared/workflow`,
`src/main/services/workflowEngine.ts`, editor built on `@xyflow/react`). A graph is a **validated,
versioned document** (`docSchema.ts`, `validate.ts`); the engine topologically orders it (`graph.ts`) and
executes it with per-node tracing (`trace.ts`), run history, and per-node output panels.

### Typed ports and the node catalog

Nodes connect through **typed ports** — `Signal` (control flow), `Context`, `Messages`, `Text`, `Vars`,
and `Lore` — so the editor can validate wiring before a run. Node **config panels auto-render from the
same Zod schema the engine validates with** (`catalog.ts` converts each node's `configSchema` to JSON
Schema), so the UI and the executor never disagree about a node's shape.

Around **forty built-in node types** ship across a dozen families (`src/main/services/nodes/builtin/`):

- **Triggers** — `trigger.state` (fires when a comparison over committed state holds), `trigger.cadence`
  (every N turns), `trigger.manual`.
- **Context assembly** — pull recent history, action, persona, params, and knowledge-base selections into
  a prompt context; refresh it mid-graph.
- **Generation** — sample a model, assemble/compose prompts, choose an API preset per call, merge/trim
  message arrays.
- **Parsing & state** — extract tagged blocks or fields from a reply, apply state-variable updates, run
  structured-memory (SQL-table) reads/queries/writes with gating.
- **Control flow** — `control.if` / `control.switch` / `control.when`.
- **Sub-graphs** — `subgraph.call` / `input` / `output` / `loop` for composition and bounded iteration.
- **Consolidated agent nodes** — `history.recent` + `agent.llm` fold the common
  _read history → prompt a model → get its reply_ pattern into two nodes, so a typical memory agent is a
  five-node chain: **trigger → `history.recent` → `agent.llm` → `parse.extract` → `table.apply`**. The
  fine-grained legacy nodes stay registered so older graphs keep running.

### One graph, two execution paths

The same document does double duty via a **Signal-gate / dead-edge** mechanism:

- **Turn run (on the hot path)** — when the player takes an action, the graph runs to produce the reply.
  Only the **main output streams live** back to the renderer. This is the _pre-phase_: a failure on an
  unwired node here is fatal to the turn.
- **Headless run (off the hot path)** — when a trigger fires, only its **downstream closure** executes
  asynchronously (`headlessRunService.ts`). This is the _post-phase_: side branches and agent fragments
  **fail open**, so a background summarizer or memory pass can error without breaking the player's turn.

Because a trigger-rooted chain is gated on the trigger's `Signal`, that chain's edges go **dead** on a
normal turn run (the trigger is excluded), the gated nodes are pruned, and the same graph cleanly serves
both paths without branching logic.

### Guardrails

Multi-model graphs are bounded by the same **per-endpoint RPM budget and max-concurrency cap** as the main
pipeline, so a graph that fans out to several LLM calls can't open unbounded parallel requests. Triggers
and reusable agent chains are persisted (`workflowTriggerStore.ts`, `agentPack*` services) and can be
transferred between sessions.

---

## Storage

State is split deliberately between a relational store and portable files (`src/main/services/db.ts`,
`storageService.ts`):

- **SQLite** (`better-sqlite3`) is split between a central index (`rpterminal.db`: profiles, settings,
  worlds, chat metadata, and shared-library references) and one database per session
  (`profiles/<profileId>/chats/<chatId>/session.sqlite`: floors, operation logs, combat, workflow state,
  and progress). Existing central session rows migrate at startup only after a checkpointed backup is
  created; startup stops and retries later if the backup or any chat migration fails.
- **File-based JSON** holds **portable, user-shareable artifacts** in their native format (presets,
  world/knowledge data, regex, structured-memory tables), so they can be exchanged without a database
  export.
- **Structured-memory tables** (`tableDbService.ts`, `tableSql.ts` and siblings) provide a
  spreadsheet/SQL-table memory layer driven by workflow nodes, with sandboxed writes, an operation log
  for rewind, backfill, and an editable table view. Each session's sandbox lives beside its session DB
  as `table.sqlite`.
- **Portable saves** (`.rpsave`) are validated zip archives containing one session store plus a world
  reference and central sidecar. Import requires the referenced world to be installed, stages and
  integrity-checks the session database before publishing it, rejects unsupported or unexpected
  archive contents, and never restores derived world-info caches.
- **Custom protocols** — a privileged scheme serves isolated authored-UI HTML, and an asset scheme
  (`worldAssetProtocol.ts`) serves per-world binary assets to the renderer.
- **Migrations** (`migrationService.ts`) evolve the schema across versions; multiple **profiles** are
  supported, each optionally password-protected.

---

## Renderer

- **React 19 + Zustand** — feature state is split across focused stores (`src/renderer/src/stores/`),
  one per subsystem (session, settings, workflow editor, combat, duel, plugins, …).
- **Launcher → workspace flow** — a launcher selects a world/session; the workspace hosts pluggable
  views (chat, combat, duel, variables, tables, workflow editor, logs, usage) behind a panel router.
- **Variables inspector/editor** — a debug view over the active session's variable state, built on
  `vanilla-jsoneditor`.
- **Internationalization** — all user-facing strings route through a minimal `t()` layer
  (`src/renderer/src/i18n/`) with string maps per locale (`en` + `zh`); locale is persisted in settings.
- **Custom title bar** — on Windows the native bar is hidden and window controls render as an overlay
  re-synced to the active theme; the renderer's top bar is the draggable region. Colors are driven by
  `--rpt-*` design tokens (`theme.ts`) for theme-able, contrast-safe UI.

---

## Getting started

### Download the Windows portable build

Open the [latest GitHub Release](https://github.com/December-17th/RP-Terminal/releases/latest), download
`rp-terminal-<version>-windows-x64-portable.zip`, extract the whole archive to a writable folder, then
run `RP Terminal.exe`. It does not install anything and does not require Git, Node.js, or npm. Code
signing is not configured yet, so Windows SmartScreen may show an unrecognized-app warning.

App data is stored in `rp-terminal-data` beside `RP Terminal.exe`, including Electron preferences,
browser storage, and caches, so moving or backing up the extracted folder keeps the app and its data
together. The active location is shown in Settings. On first launch, an existing default data folder
from the earlier AppData-based portable build is copied beside the app; the AppData copy is left intact
as a backup. Explicit custom locations remain unchanged.

Packaged builds check GitHub's latest published stable release in the background and show a notice above
the world chooser when a newer strict `vMAJOR.MINOR.PATCH` release exists. The notice only opens the
official release page; RP Terminal never downloads or installs an update. Updates remain manual: stop RP
Terminal, extract the newer ZIP, and copy the existing `rp-terminal-data` folder into the new extracted
folder before launching. Keep that folder private; it is not included in GitHub release archives.

### Download the macOS build

The latest GitHub Release provides ZIP builds for Apple Silicon (`arm64`) and Intel (`x64`) Macs.
Download `rp-terminal-<version>-macos-<arch>-unsigned.zip`, extract it, and move `RP Terminal.app`
wherever you prefer. It does not require Node.js or a source checkout.

These builds are intentionally unsigned and not notarized because the project does not yet have an
Apple Developer Program membership. macOS will block the first launch. After trying to open the app,
open **System Settings → Privacy & Security**, scroll to Security, click **Open Anyway**, and confirm.
Only bypass this warning when the ZIP came from this repository's GitHub Release. See
[Apple's instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

On macOS, app data is stored at `~/Library/Application Support/RP Terminal`, following the platform
convention. Updates do not remove the Application Support data directory.

### Development launch

**Prerequisite:** Node.js 22.

```bash
git clone https://github.com/December-17th/RP-Terminal.git rp-terminal
cd rp-terminal
npm ci
npm run dev
```

The downloadable builds include a release notification but no automatic download or installation
channel. Developers can inspect an isolated card panel with `RPT_OPEN_WCV_DEVTOOLS=1`; this is
intentionally off by default. Maintainers should use the process in [`RELEASE.md`](RELEASE.md) to publish
builds.

### Verification gate

Before declaring any change done, run all three:

```bash
npm run typecheck      # tsc (main/preload + web projects)
npm run check:deps     # dependency-cruiser — enforces module boundaries
npm run test           # vitest (characterization + unit tests)
```

Characterization tests pin current behavior on the cores (runtime/transport parity, template engine,
combat/duel engines, generation pipeline). They assert "same as before," not "correct" — if a change
_should_ alter behavior, update the characterization test in the same commit, deliberately.

---

## Project layout

```
src/
  main/       Electron main: generation pipeline, services (session/combat/duel/workflow/…),
              IPC, parsers, custom protocols, SQLite, sandbox worker
  preload/    the typed IPC bridge (window.api)
  renderer/   React 19 + Zustand UI, i18n (en/zh), authored-UI hosts, workspace views
  shared/     pure cross-process code: sandbox runtime (thRuntime), combat/duel engines,
              template engine, object-path & regex helpers, workflow schema
resources/    vendored assets (e.g. cardlibs/)
docs/         design docs and the extension/compatibility contract
test/         vitest suites (incl. combat/ characterization)
```

---

## Tech stack & dependencies

RP Terminal is built entirely on open-source software. The authoritative license text ships with each
package under `node_modules/<pkg>/LICENSE`, and notable runtime libraries are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Licenses below are the commonly published SPDX
identifiers — **verify before redistribution.**

### Runtime dependencies (npm)

| Package                                                               | Role                                           | License                    |
| --------------------------------------------------------------------- | ---------------------------------------------- | -------------------------- |
| `electron` (+ `@electron-toolkit/preload`, `@electron-toolkit/utils`) | Desktop app shell                              | MIT                        |
| `react`, `react-dom`                                                  | Renderer UI                                    | MIT                        |
| `zustand`                                                             | Renderer state stores                          | MIT                        |
| `@xyflow/react`                                                       | Workflow node-graph editor                     | MIT                        |
| `better-sqlite3`                                                      | SQLite storage                                 | MIT                        |
| `vanilla-jsoneditor`                                                  | JSON editor in the Variables view              | **ISC**                    |
| `@formkit/auto-animate`                                               | Duel UI animation                              | MIT                        |
| `quickjs-emscripten`, `@jitl/quickjs-singlefile-browser-release-sync` | QuickJS WASM sandbox                           | MIT                        |
| `dompurify`                                                           | Sanitize inline authored HTML                  | Apache-2.0 (dual: MPL-2.0) |
| `react-markdown`, `remark-gfm`, `rehype-raw`                          | Message markdown rendering                     | MIT                        |
| `zod`                                                                 | Schema validation (settings/presets/state)     | MIT                        |
| `lodash`                                                              | Utilities (shared with the sandbox runtime)    | MIT                        |
| `uuid`                                                                | ID generation                                  | MIT                        |
| `adm-zip`                                                             | Archive / asset-bundle handling                | MIT                        |
| `postcss`                                                             | CSS processing (Tailwind pipeline)             | MIT                        |
| `jquery`                                                              | Environment lib (also served to authored UIs)  | MIT                        |
| `vue`, `pinia`, `vue-router`                                          | Environment libs (also served to authored UIs) | MIT                        |

### Authored-UI environment libraries (served to sandboxed content)

Provided to authored UIs for a predictable runtime — vendored (`resources/cardlibs/`) or loaded from a
CDN (see `src/shared/cardEnv.ts`):

| Library                                             | Delivery       | License (verify)                                     |
| --------------------------------------------------- | -------------- | ---------------------------------------------------- |
| jQuery + jQuery-UI (+ touch-punch)                  | jsDelivr       | MIT                                                  |
| Vue 3 + Pinia                                       | npm / served   | MIT                                                  |
| Tailwind CSS (3.4.x)                                | vendored + CDN | MIT                                                  |
| Font Awesome **Free**                               | jsDelivr (CSS) | Icons **CC BY 4.0**, fonts **SIL OFL 1.1**, code MIT |
| Motion (`motion.dev`) — opt-in, app does not use it | jsDelivr       | MIT                                                  |

### Dev / build tooling (npm devDependencies)

`electron-vite`, `vite`, `@vitejs/plugin-react`, `electron-builder`, `typescript` (Apache-2.0),
`vitest`, `eslint` (+ React plugins), `prettier`, `dependency-cruiser`, `@electron-toolkit/*` configs,
and the `@types/*` packages — all MIT unless noted.

---

## License

_TODO: choose and add the project's own license (a `LICENSE` file)._ Third-party components retain their
own licenses as listed above and in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

---

## Documentation

- `docs/` — design specs, architecture notes, and point-in-time health checks.
- `docs/sdk/` — the extension/compatibility contract for authored content.
- `CLAUDE.md` — contributor notes: project direction, grounding rules, and the
  module-boundary / verification discipline.
