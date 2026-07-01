# RP Terminal

> **Status: early development / draft README.** RP Terminal is a work-in-progress standalone desktop app.
> Interfaces, storage, and compatibility are still evolving.

RP Terminal is a **standalone Electron app** that evolves the **SillyTavern + TavernHelper +
ST‑Prompt‑Template** roleplay experience from a chat tool into a **full local game platform** — customizable
UI, card‑authored panels / beautifications / mini‑games, native local combat, and prompt‑cache optimization —
while staying **format‑compatible** with the SillyTavern card ecosystem.

- **React 19 + Zustand** renderer, generation centralized in the **Electron main process**.
- **SQLite + file‑based** storage (chats, floors, presets, lorebooks, world assets).
- **Compatibility is tiered** (see below): the supported contract is the dominant declarative + framework
  stack — `chara_card_v3` data, lorebooks, regex, ST‑Prompt‑Template/EJS, native **MVU**, a documented subset
  of the TavernHelper JS API, and the standard card env libs. Arbitrary custom‑JS cards that reach past that
  surface are best‑effort / out‑of‑contract.
- **Localized** UI: English + 简体中文 (extensible), via a minimal `t()` layer.

> There is **no separate card spec.** The "standard" is `chara_card_v3` with everything RPT‑specific under
> `data.extensions.rp_terminal`. The intended distributable is a **PNG cartridge** embedding that JSON
> (+ an appended ZIP for binary assets). See `docs/world-card-design.md` and `docs/sdk/`.

---

## Highlights

- **World → Session → Play** launcher; a character card *is* a "world" (its PNG art is the avatar).
- **Native MVU status panels** — the AI emits `<UpdateVariable>` blocks (JSON‑Patch / `_.set` dialects) that
  drive live, card‑declared status UI (`data.extensions.rp_terminal.ui_layout`).
- **Card‑authored UI** rendered two ways at parity: inline (in‑message) and isolated (a crash‑resistant
  WebContentsView), over one shared card runtime.
- **Native local combat**, two modes: a **grid/turn d20** tactical system and a **Slay‑the‑Spire‑style card
  duel** — both pure, seeded, and card‑agnostic engines the AI narrates/referees.
- **Variables inspector/editor** — a debug view over the active chat's `stat_data` + session KV, built on
  `vanilla-jsoneditor`.
- **ST‑Prompt‑Template / EJS** engine (clean‑room) executed in a **QuickJS WASM sandbox**.
- **Prompt‑cache optimization** scaffolding (parked; locked to a baseline for now).

---

## Getting started

**Prerequisites:** a recent Node.js LTS — no `engines` field is pinned; the project is developed/tested on
**Node 22**.

```bash
npm install
npm run dev        # launch the app in development (electron-vite)
```

**Build a distributable:**

```bash
npm run build                       # typecheck + electron-vite build
npm run build:win  # or :mac / :linux  — package installers via electron-builder
```

### Verification gate

Before declaring any change done, run all three:

```bash
npm run typecheck      # tsc (main/preload/web projects)
npm run check:deps     # dependency-cruiser — enforces module boundaries
npm run test           # vitest (characterization + unit tests)
```

**Module boundaries** are enforced by `check:deps`: the card transports import only from the shared card
runtime; the combat engine is pure (no renderer/Electron/IPC); `shared/*` never imports `renderer`/`main`;
the renderer reaches `main` only through the typed IPC surface.

---

## Project layout

```
src/
  main/       Electron main: generation, services (chat/floor/combat/duel/lorebook/…), IPC, parsers (MVU, cards)
  preload/    the typed IPC bridge (window.api)
  renderer/   React 19 + Zustand UI, i18n (en/zh), card rendering, workspace views
  shared/     pure, cross-process code: the card runtime (thRuntime), combat engine, cardEnv, EJS, objectPath
resources/    vendored assets (e.g. cardlibs/tailwind.min.js)
docs/         design docs; docs/sdk/ is the card-compatibility contract
test/         vitest suites (incl. combat/ characterization)
```

---

## Compatibility (tiered)

Supported (the contract, kept solid): `chara_card_v3` data, lorebooks/world‑info, regex, ST‑Prompt‑Template /
EJS, native **MVU / MagVarUpdate**, a documented subset of the TavernHelper JS API, and the standard card
environment libraries (jQuery/‑UI, Vue, Pinia, Tailwind, Font Awesome). Best‑effort / out‑of‑contract:
arbitrary custom‑JS cards that reach past that surface. The card‑compatibility contract lives in
[`docs/sdk/`](docs/sdk/).

---

## Dependencies & open‑source software

RP Terminal is built on open‑source software. The tables below list **everything bundled or used**; the
authoritative license text ships with each package under `node_modules/<pkg>/LICENSE` and, for notable
runtime libraries, in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Licenses noted here are the
commonly published SPDX identifiers — **verify before redistribution.**

### Runtime dependencies (npm)

| Package | Role | License |
| --- | --- | --- |
| `electron` (+ `@electron-toolkit/preload`, `@electron-toolkit/utils`) | Desktop app shell | MIT |
| `react`, `react-dom` | Renderer UI | MIT |
| `zustand` | Renderer state stores | MIT |
| `better-sqlite3` | SQLite storage (chats/floors/…) | MIT |
| `vanilla-jsoneditor` | JSON editor in the Variables view | **ISC** |
| `@formkit/auto-animate` | Duel UI hand/board animation | MIT |
| `quickjs-emscripten`, `@jitl/quickjs-singlefile-browser-release-sync` | QuickJS WASM sandbox (EJS / card scripts) | MIT |
| `dompurify` | Sanitize inline card HTML | Apache‑2.0 (dual: MPL‑2.0) |
| `react-markdown`, `remark-gfm`, `rehype-raw` | Chat/message markdown rendering | MIT |
| `zod` | Schema validation (card/preset/settings) | MIT |
| `lodash` | Utilities (shared with card runtime) | MIT |
| `uuid` | ID generation | MIT |
| `adm-zip` | PNG‑cartridge / asset‑zip handling | MIT |
| `postcss` | CSS processing (card Tailwind pipeline) | MIT |
| `jquery` | Card env lib (also served to cards) | MIT |
| `vue`, `pinia`, `vue-router` | Card env libs (also served to cards) | MIT |

### Card‑runtime environment libraries (served to cards)

These are provided to card‑authored UIs for ST/TavernHelper parity — vendored (`resources/cardlibs/`) or
loaded from jsDelivr (see `src/shared/cardEnv.ts`):

| Library | Delivery | License (verify) |
| --- | --- | --- |
| jQuery + jQuery‑UI (+ touch‑punch) | jsDelivr | MIT |
| Vue 3 + Pinia | npm/served | MIT |
| Tailwind CSS (3.4.x) | vendored + CDN | MIT |
| Font Awesome **Free** | jsDelivr (CSS) | Icons **CC BY 4.0**, fonts **SIL OFL 1.1**, code MIT |
| Motion (`motion.dev`) — opt‑in, app does not use it | jsDelivr | MIT |

### Dev / build tooling (npm devDependencies)

`electron-vite`, `vite`, `@vitejs/plugin-react`, `electron-builder`, `typescript` (Apache‑2.0), `vitest`,
`eslint` (+ `eslint-plugin-react`, `-react-hooks`, `-react-refresh`), `prettier`,
`dependency-cruiser`, `@electron-toolkit/*` configs, and the `@types/*` type packages — all MIT unless noted.

### Clean‑room reimplementations & compatibility targets (no code vendored)

RP Terminal reimplements several SillyTavern‑ecosystem behaviors from public docs / observed behavior rather
than vendoring their code:

- **ST‑Prompt‑Template / EJS engine** — clean‑room reimplementation.
- **TavernHelper JS API (documented subset)** — clean‑room. **js‑slash‑runner / TavernHelper is AFPL
  (non‑free) and is NOT copied or vendored.**
- **MVU / MagVarUpdate** — **MIT**; reused/adapted with attribution.

> **Licensing note:** the one bundled component whose license differs from the MIT norm and is documented in
> `THIRD-PARTY-NOTICES.md` is `vanilla-jsoneditor` (**ISC**, © Jos de Jong) — an independent library, distinct
> from the AFPL js‑slash‑runner code this project deliberately does not use.

---

## License

_TODO: choose and add the project's own license (e.g. `LICENSE` file)._ Third‑party components retain their
own licenses as listed above and in `THIRD-PARTY-NOTICES.md`.

---

## Documentation

- `docs/sdk/` — the card‑compatibility contract (the source of truth for what cards can rely on).
- `docs/world-card-design.md` — the PNG‑cartridge / world‑card design.
- `docs/` — design specs and point‑in‑time health checks.
- `CLAUDE.md` — contributor notes: project direction, grounding rules, and the module‑boundary/verification
  discipline.
