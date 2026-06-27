# JSR Faithful-Host — End-State Architecture & Roadmap

> Umbrella design for making RP Terminal a **faithful clean-room host** for SillyTavern + Tavern-Helper
> (JS-Slash-Runner / JSR) cards and scripts. This is the north-star; each sub-project (SP1…) gets its own
> spec → plan → build cycle. Clean-room only — no JSR (AFPL) source is copied; behavior is reimplemented
> from public docs/observed behavior. See the licensing note in CLAUDE.md and
> [[rp-terminal-no-jsr-code-reuse]].

Date: 2026-06-23. Target branch: `feat/dual-mode-card-rendering`.

## Goal

Any ST/JSR card + script runs **unmodified** in RP Terminal — rendered and scripted faithfully — while
RPT keeps its own engine advantages (out-of-process isolation option, native MVU, host-side generation
with the AI key never reaching the card, SQLite, multi-provider).

## Audit summary (how RPT compares to ST + JSR today)

Full comparison: [docs/compat-comparison.md](../../compat-comparison.md) (needs a refresh — it predates
dual-mode rendering). Rendering/scripting pipeline findings:

- **Architecture already matches.** Both ST/JSR and RPT-inline render cards in a **same-origin iframe**
  and hand it the API by reaching into `window.parent` (JSR `predefine.js` merges
  `window.parent.TavernHelper/SillyTavern/Mvu/EjsTemplate` and binds each fn to the iframe;
  RPT does `window.parent.__rptCardBridge(ctx)`). No postMessage/IPC at that seam. The gaps are
  **coverage**, not architecture.
- **One true divergence:** JSR runs **in-process** (TH functions _are_ the ST app, mutating ST state
  directly); RPT is **two-process** (TH functions are a _shim_ translating to main via IPC / Zustand).
  RPT must therefore reimplement each TH function against its own engine — the clean-room work.
- **Rendering env gaps** vs JSR's `createSrcContent`: base reset (✅ landed, `899cd98`), the assumed
  libraries (**jQuery-UI(+touch-punch), FontAwesome, Tailwind** — we inject only Vue/jQuery/Pinia/
  Vue-Router), `--TH-viewport-height` + the `100vh`→var rewrite, and avatar CSS.
- **Scripting coverage:** the full TH surface is ~25 domains (`function/*`). RPT covers a substantial
  subset with stubs — see the roadmap.

## Decisions (this brainstorm)

1. **Target:** faithful card host (north star); design the end-state arch, sequence subsystems.
2. **Card sizing:** configurable, **default content-fit**. Provide `--TH-viewport-height` (set to the
   frame's effective height) so cards that read it compute correctly, but default the frame to
   content-fit (compact inline). A per-card/global **fill-vs-fit** toggle reuses the render-mode setting.
3. **Runtime architecture:** **unified clean-room TH core + transport adapters** (parity by construction).

## End-state architecture

```
ST/JSR card (HTML+JS, unmodified)
   │  calls TavernHelper.* (bare + namespaced), SillyTavern.getContext(), Mvu.*, EjsTemplate.*
   ▼
shared/thRuntime  ──  ONE clean-room implementation of the full TH surface
   │   • builds the TavernHelper / SillyTavern / Mvu / EjsTemplate objects
   │   • owns: event bus, snake→camel normalize, the sync/async split, MVU surface
   │   • realm-agnostic: reaches the outside world ONLY through ↓
   ▼
Host interface  (the seam — where RPT's two-process reality lives)
   • sync getters:  getStatData() · chatSnapshot() · currentMessageId() · charData()
                    worldbookNames() · regexes() · getVar(scope, path)
   • async ops:     generate() · generateRaw() · stopGeneration() · getWorldbook()
                    saveWorldbook() · setChatMessage() · applyVariableOps() · saveChat()
   • events/util:   onEvent/emitEvent · toast() · audio() · substituteMacros() · evalTemplate()
   ├── Inline adapter (renderer):  sync → Zustand reads · async → window.api (IPC)
   └── WCV adapter (preload):      sync → ipcRenderer.sendSync · async → ipcRenderer.invoke
          ▼
RPT engine (main):  chatService · lorebookService · generationService · regexService ·
                    templateService · mvuParser · settingsService   (ctx-scoped; AI key never leaves main)
```

Load-bearing properties:

- **Sync/async is explicit in `Host`.** TH getters are called without `await` (a known bug class — see
  [[rp-terminal-wcv-compat-invariants]]). The core calls `host.chatSnapshot()` (sync) vs
  `await host.generate()` (async); each adapter satisfies sync its own way (store read vs `sendSync`).
- **`shared/thRuntime` is pure-ish:** it imports neither renderer-only (`window`, Zustand) nor main-only
  (`electron`, `fs`) modules — only the `Host` interface. So both the renderer (inline) and the preload
  (WCV) builds can import it.
- **Rendering-env is shared too:** base reset, assumed libs, `--TH-viewport-height` (configurable
  sizing), avatar CSS all live in `buildCardDoc`, so both transports wrap cards identically.
- **Security/scoping unchanged:** cards get global API access scoped to their own session/world via the
  `ctx` (`profileId`/`chatId`/`characterId`) the IPC handlers resolve against; never the AI key.

## Roadmap (subsystems A–D mapped onto the architecture)

| #                                  | Sub-project                                                                                                                   | Builds                | Status |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ |
| **SP1 — Foundation**               | Extract `shared/thRuntime` + `Host` + the two adapters from today's `cardBridge`/`wcvPreload` (no new domains) + parity tests | the seam; kills drift | next   |
| **SP2 — (A) Rendering-env parity** | assumed libs, `--TH-viewport-height` + fill/fit toggle, avatar CSS                                                            | visual fidelity       |        |
| **SP3…n — (B) TH domains**         | lorebook CRUD, chat write, regex, generateRaw/stop, full `tavern_events`, audio, macros — one slice per spec                  | compatibility         |        |
| **later — (C) Scripts / STScript** | author script library (global/char) + clean-room STScript interpreter                                                         | scripts beyond cards  |        |
| **later — (D) EJS / MVU depth**    | ST-PT long tail (render-time eval, markers/decorators, scopes)                                                                | templating parity     |        |

Each sub-project is its own spec → plan → build cycle so the work stays reviewable.

## Constraints / invariants carried in

- **Clean-room only** — never copy/vendor/load JSR source (AFPL/non-free). MVU (MIT) logic is adaptable
  with attribution; ST-Prompt-Template is a clean-room engine already.
- Keep **dual transports** (inline default + WCV isolated); the unified core is what keeps them in parity.
- Generation stays **host-side**; the card never sees the AI key.
- Out-of-scope here: the broader agentic FSM, RAG, the Forge — separate ROADMAP tracks.
