# RP Terminal — Product, Technical, and Strategy Review

- **Review date:** 2026-07-09
- **Reviewed revision:** `e641334127a1a7659810e7d433dfd1d02c2af17c` (`main`)
- **Review type:** Point-in-time senior product, technical, UX, and strategy assessment
- **Final verdict:** **Not ready yet**

---

## 1. Executive summary

RP Terminal is an ambitious, technically substantial local desktop platform for AI-driven roleplay and
interactive fiction. Its clearest differentiator is the combination of:

- SillyTavern-compatible content import and runtime behavior;
- local, bring-your-own-provider generation;
- author-defined interactive UI and state;
- deterministic native game systems;
- visual workflows and background agents;
- portable world, memory, and asset formats.

The project demonstrates unusually strong implementation depth for an early-stage product. TypeScript
typechecking passes; 2,317 automated tests pass across 239 test files; dependency boundaries pass under a
supported Node runtime; core systems are modular and heavily characterized; and the documentation contains
substantial design rationale.

Those strengths do not make the project release-ready. Three categories currently block a public release:

1. **The authored-content security boundary is unsafe.** The default interactive-card path executes
   scripted content in a same-origin iframe with `allow-scripts allow-same-origin`. That document can reach
   its parent renderer, while the parent exposes the complete Electron preload API as `window.api`. The
   message rendering path does not consult the stored per-card trust decision before mounting this runtime.
   This creates a path from card or message HTML to destructive application capabilities outside the intended
   card API.
2. **The product is too broad for its demonstrated validation.** RP Terminal currently combines a player,
   content compatibility layer, creator studio, workflow IDE, plugin runtime, memory engine, combat engine,
   deckbuilder, asset system, and distribution format. The repository contains extensive implementation
   evidence but no clear primary-user decision, research record, activation data, retention evidence, or
   willingness-to-switch evidence.
3. **Release and data-safety infrastructure is incomplete.** There is no project license, CI workflow,
   supported-runtime pin, production update endpoint, macOS notarization, packaged-app test suite, complete
   backup/restore flow, or versioned migration framework. The packaged default data location is beside the
   executable, which can be unwritable on common macOS and sandboxed Linux installations.

The recommended course is to pause feature expansion and execute a release-readiness program centered on:

1. securing every authored-code path;
2. selecting one launch persona and one primary journey;
3. establishing compatibility and usability evidence;
4. implementing data recovery and release automation;
5. running a limited private alpha before any broad distribution.

---

## 2. Review scope and methodology

### 2.1 Materials reviewed

The review covered:

- the product overview and declared architecture in [`README.md`](../README.md);
- application entry points, Electron configuration, preloads, IPC, storage, database, generation, workflow,
  runtime, and game-engine code under `src/`;
- launcher, settings, message rendering, workspace, workflow, and authored-UI renderer code;
- the compatibility, World Card, SDK, runtime, UI, memory, combat, plugin, and manual-test documentation;
- project scripts, package configuration, builder configuration, TypeScript configuration, Vitest setup,
  dependency boundaries, Git history, and repository state;
- automated verification results listed below.

This was a source and documentation review. It was **not** a formal penetration test, dependency-vulnerability
audit, live-provider certification, packaged-binary certification, or observed end-user usability study.

### 2.2 Verification executed

| Check                                         | Result                                          | Interpretation                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | **Pass**                                        | Node/preload and renderer TypeScript projects compile without type errors.                                                                                       |
| `npm run test`                                | **Pass** — 239 files, 2,317 tests               | Strong unit and characterization coverage for pure/core behavior.                                                                                                |
| `npm run check:deps` under Node 24.14         | **Pass** — 413 modules, 1,674 dependencies      | Declared module boundaries hold.                                                                                                                                 |
| `npm run check:deps` under the host Node 25.9 | **Could not run**                               | `dependency-cruiser` rejects Node 25; the project does not pin a supported engine.                                                                               |
| ESLint without cache                          | **Fail** — 9 errors, 1,312 warnings             | The current repository does not satisfy its lint configuration. Most warnings are formatting; errors include React purity/memoization issues and unused imports. |
| Git state                                     | `main` matched `origin/main` before this report | Review was based on the current remote revision, excluding pre-existing uncommitted local changes.                                                               |

### 2.3 Test-coverage qualification

The passing test count is meaningful, but it must not be interpreted as full application verification.
Vitest runs in a Node environment and aliases both Electron and `better-sqlite3` to mocks
([`vitest.config.ts:5-25`](../vitest.config.ts#L5-L25)). The repository does not contain an automated
renderer-component harness, native SQLite integration suite, Electron end-to-end suite, or packaged-app
smoke suite. Documentation explicitly acknowledges that renderer components and DB-touching wiring rely on
typechecking and manual validation
([`docs/token-cache-meter-plan.md:14-18`](token-cache-meter-plan.md#L14-L18)).

---

## 3. Overall assessment scorecard

The scores below reflect readiness for an external product release, not the ingenuity or volume of the
implementation.

| Area                           | Score | Priority | Summary                                                                                        |
| ------------------------------ | ----: | -------- | ---------------------------------------------------------------------------------------------- |
| Overall concept and purpose    |  7/10 | High     | Differentiated and coherent at the vision level, but overloaded at the product level.          |
| Target users and audience      |  5/10 | High     | Strong ecosystem knowledge; unclear primary customer and launch persona.                       |
| Problem-solution fit           |  5/10 | High     | Real problems addressed, but insufficient user and compatibility evidence.                     |
| Technical feasibility          |  6/10 | High     | Core architecture is feasible and tested; security, integration, and release gaps remain.      |
| User experience                |  5/10 | High     | Thoughtful interaction work, but first-run complexity and system breadth remain high.          |
| Business/practical viability   |  3/10 | High     | Potential low-infrastructure model; licensing, distribution, support, and GTM are unresolved.  |
| Risk and failure handling      |  3/10 | Critical | Several good guardrails, but the authored-content boundary is a release blocker.               |
| Requirements completeness      |  4/10 | High     | Rich implementation specs; weak release, recovery, privacy, performance, and success criteria. |
| Simplicity and maintainability |  4/10 | High     | Good internal primitives are offset by subsystem count, legacy paths, and high churn.          |
| Execution readiness            |  4/10 | High     | Strong engineering cadence; current sequencing favors features over validation and hardening.  |

---

## 4. Detailed review by area

### 4.1 Overall concept and purpose

**Priority: High**

#### What is strong

- The project has a recognizable and differentiated thesis: evolve a SillyTavern-style chat experience into
  a complete local game platform. The README clearly connects generation, authored UI, native game systems,
  and workflows ([`README.md:3-13`](../README.md#L3-L13)).
- Local execution with user-selected providers avoids the largest recurring infrastructure cost and gives
  privacy-conscious users more control.
- Compatibility provides a plausible adoption wedge: users do not have to abandon existing cards,
  lorebooks, presets, regex, or MVU content to try the product.
- Deterministic game engines and stateful authored interfaces offer a concrete advantage over a plain chat
  frontend.

#### What is weak or unclear

- The product simultaneously presents itself as a player, game platform, compatibility layer, workflow IDE,
  creator environment, plugin system, memory system, combat system, deckbuilder, and portable content format.
- These are not merely adjacent features. Each brings separate onboarding, reliability, security,
  compatibility, documentation, and support obligations.
- The repository labels the product “early development” while `package.json` reports version `1.0.0`
  ([`README.md:3-4`](../README.md#L3-L4), [`package.json:1-5`](../package.json#L1-L5)). That creates an
  avoidable expectation mismatch.
- The product purpose is clearer to someone already immersed in the SillyTavern ecosystem than to a new
  player. The outcome is described largely through capabilities rather than one dominant user benefit.

#### Specific recommendations

1. Adopt a one-sentence launch promise, for example: **“Import an advanced SillyTavern world and play it as
   a polished desktop game with minimal setup.”**
2. Define an MVP capability boundary. A defensible first release could include:
   - connection setup and model generation;
   - character/World Card import;
   - chat, lorebook, regex, MVU state, and one safe authored-UI mode;
   - session persistence, export, backup, and recovery;
   - one showcase native game mode.
3. Move workflows, plugins, advanced memory authoring, and the second game engine behind an experimental or
   creator-preview flag until the primary player journey is validated.
4. Reset versioning to a prerelease line such as `0.x` until public compatibility and migration guarantees
   exist, or explicitly define what `1.0` guarantees.

---

### 4.2 Target users and audience

**Priority: High**

#### What is strong

- The implementation demonstrates detailed knowledge of advanced card authors, TavernHelper users, MVU
  users, prompt-template users, and Chinese-language ecosystem conventions.
- The launcher’s World → Session model uses player-facing language rather than exposing database entities
  ([`src/renderer/src/components/Launcher.tsx:8-12`](../src/renderer/src/components/Launcher.tsx#L8-L12)).
- The creator surface has substantial depth: card APIs, runtime themes, custom panels, assets, table memory,
  workflows, modules, triggers, and trace visibility.
- English and Simplified Chinese localization materially expands the plausible audience.

#### What is weak or unclear

The product appears to serve at least three distinct audiences:

1. **Players** who want to import content and start playing quickly.
2. **World/card authors** who want programmable UI, state, assets, and game mechanics.
3. **Technical automation authors** who want workflows, modules, agents, SQL memory, traces, and plugins.

These users have different tolerance for complexity and risk. The normal play header exposes Persona, Preset,
Lorebook, Assets, Connection, and Workflow actions
([`src/renderer/src/components/TopStrip.tsx:7-15`](../src/renderer/src/components/TopStrip.tsx#L7-L15)),
which makes the default experience feel like a creator tool even when the user’s job is simply to play.

No repository artifact establishes:

- the primary launch persona;
- the audience size or acquisition channel;
- their present workflow and pain severity;
- their willingness to switch from SillyTavern;
- the acceptable setup and learning time;
- whether players or authors are expected to pay.

#### Specific recommendations

1. Choose one primary launch persona and one secondary persona.
2. Write a concise job-to-be-done profile for each:
   - triggering situation;
   - current workaround;
   - most painful failure;
   - desired outcome;
   - switching barrier;
   - success measure.
3. Run 8–12 recorded, observed sessions with target users. Do not substitute feature requests or code review
   for workflow observation.
4. Separate **Play** and **Create/Debug** modes. Keep the default player surface focused on world, session,
   chat, status, and the current game interaction.

---

### 4.3 Problem-solution fit

**Priority: High**

#### What is strong

RP Terminal addresses recognizable ecosystem problems:

- advanced cards require multiple manually installed artifacts;
- frontend-card scripts can be fragile or tightly coupled to SillyTavern behavior;
- long-running roleplay needs durable state and memory;
- model narration should not own deterministic game mechanics;
- creators need inspectable prompt/workflow behavior;
- content portability is weakened when state, assets, scripts, regex, and presets are separate.

The lossless import direction and World Card concept are strong solutions. The design explicitly aims to make
one card the distribution unit for a complete experience
([`docs/world-card-design.md:12-30`](world-card-design.md#L12-L30)).

#### What is weak or unclear

- The compatibility contract is partial. The comparison document records missing async templates, missing
  TavernHelper-in-template behavior, partial events, partial slash commands, incomplete regex writes, and
  audio stubs ([`docs/compat-comparison.md:28-53`](compat-comparison.md#L28-L53),
  [`docs/compat-comparison.md:63-81`](compat-comparison.md#L63-L81)).
- The World Card promise remains partially implemented. Plugin bundles, some scope bindings, complete export,
  compressed `iTXt`, and appended-ZIP cartridges are incomplete
  ([`docs/world-card-design.md:184-197`](world-card-design.md#L184-L197)).
- The product does not maintain a measured compatibility corpus with pass rates.
- There is no evidence that the full platform solves a more important user problem than a narrower,
  safer compatibility-focused player would.
- A large amount of effort is devoted to sophisticated authoring systems before the repository demonstrates
  repeatable first-session success for ordinary target users.

#### Specific recommendations

1. Build a compatibility corpus of 20–50 representative cards across:
   - plain v2/v3 cards;
   - lorebook-heavy cards;
   - regex beautification cards;
   - MVU cards;
   - TavernHelper script cards;
   - remote frontend-card loaders;
   - cards with large assets and alternate greetings.
2. Record objective outcomes for every card:
   - imports without loss;
   - reaches first playable turn;
   - expected UI renders;
   - expected variables initialize and persist;
   - save/reload/regenerate works;
   - export/re-import preserves behavior;
   - unsupported APIs are reported clearly.
3. Publish a compatibility tier and percentage instead of relying on the broad phrase
   “SillyTavern-compatible.”
4. Measure time-to-first-successful-turn and the number of manual interventions required.

---

### 4.4 Technical feasibility

**Priority: High**

#### What is strong

- The four-layer architecture is sensible for the product: renderer, preload/IPC, main services, and pure
  shared modules.
- Dependency boundaries pass under a supported runtime.
- Generation is centralized in main, preventing normal renderer code from directly handling provider keys.
- The generation pipeline is decomposed into context assembly, provider shaping, calls, parsing, folding,
  and persistence.
- The combat and duel engines are pure, serializable, seeded, and well tested.
- The workflow model is schema-validated and uses typed ports, execution tracing, and bounded control flow.
- Settings use Electron `safeStorage` when available, and renderer-facing settings mask stored keys
  ([`src/main/services/settingsService.ts:5-30`](../src/main/services/settingsService.ts#L5-L30),
  [`src/main/services/settingsService.ts:40-59`](../src/main/services/settingsService.ts#L40-L59)).
- Rate limiting, concurrency caps, abort handling, journal replay, and write-loop defenses show thoughtful
  attention to real failure modes.

#### What is weak or unclear

1. **Security architecture:** authored UI is treated as a compatibility feature, but it is also an application
   security boundary. The current inline boundary is insufficient; see §5.1.
2. **Integration coverage:** the test environment mocks Electron and SQLite. The high-risk interactions among
   preload, IPC, native DB, WCVs, renderer state, migrations, and filesystem behavior are not continuously
   verified.
3. **Lint health:** ESLint reports 9 errors and 1,312 warnings. Current errors include render-time `Date.now()`
   calls and memoization/declaration-order issues in workflow UI code, plus unused test imports.
4. **Runtime reproducibility:** no `engines`, `packageManager`, `.nvmrc`, or equivalent runtime pin exists.
   The dependency check fails under Node 25 even though it passes under Node 24.
5. **Release gate mismatch:** `npm run build` runs typechecking and the Electron-Vite build, but not lint,
   dependency checks, tests, packaging smoke tests, or security tests
   ([`package.json:6-22`](../package.json#L6-L22)).
6. **No CI:** the README states module boundaries are enforced in CI, but no CI workflow is present.
7. **Migration strategy:** schema changes are handled through `CREATE IF NOT EXISTS`, conditional `ALTER`,
   table rebuilds, and unconditional legacy drops at startup
   ([`src/main/services/db.ts:283-315`](../src/main/services/db.ts#L283-L315),
   [`src/main/services/db.ts:366-421`](../src/main/services/db.ts#L366-L421)). There is no schema-version
   ledger, automatic pre-migration backup, or rollback strategy.
8. **High churn:** the reviewed repository contains roughly 68,000 TypeScript/TSX source lines and recorded
   284 commits since 2026-07-01. High velocity is not inherently bad, but it increases the value of integration
   gates, release branches, and stabilization periods.

#### Specific recommendations

1. Resolve the authored-content boundary before adding features.
2. Pin Node and the package manager; make unsupported versions fail immediately with a clear message.
3. Add CI jobs for format check, lint, typecheck, dependency boundaries, tests, build, package, and artifact
   smoke tests.
4. Add native SQLite tests using temporary databases rather than a global mock.
5. Add Electron end-to-end tests for profile creation, connection setup, import, session start, generation
   abort, restart/reload, and card trust.
6. Add migration fixtures for every supported prior schema and verify backup, migration, integrity, and
   recovery.
7. Establish a stabilization branch or release-freeze window before alpha builds.

---

### 4.5 User experience

**Priority: High**

#### What is strong

- The launcher uses a straightforward World → Session funnel and includes useful session previews
  ([`src/renderer/src/components/Launcher.tsx:92-160`](../src/renderer/src/components/Launcher.tsx#L92-L160)).
- World and session deletion use in-app confirmation instead of immediate destructive action.
- The settings hub groups application, world, and automation configuration in one predictable surface
  ([`src/renderer/src/components/SettingsModal.tsx:16-22`](../src/renderer/src/components/SettingsModal.tsx#L16-L22)).
- The project has invested in keyboard navigation, theme contrast, internationalization, failure banners,
  usage visibility, prompt previews, run traces, and editable memory tables.
- Card-defined themes are contrast-checked rather than blindly trusted.

#### What is weak or unclear

- First-run success requires understanding profiles, providers, endpoints, keys, models, World Cards, presets,
  lorebooks, regex, scripts, and possibly workflows.
- There is no guided connection verification. “Fetch models” is helpful, but it is not a complete readiness
  check, and the default configuration can reach a session before a usable provider is configured
  ([`src/renderer/src/components/ApiSettingsPanel.tsx:40-57`](../src/renderer/src/components/ApiSettingsPanel.tsx#L40-L57)).
- A user with no worlds sees an import-oriented empty state rather than a safe, bundled sample journey.
- Advanced configuration appears close to normal play, increasing cognitive load and the chance of accidental
  modification.
- WebContentsView integration requires custom native-overlay positioning, clipping, wheel forwarding,
  focus recovery, freeze frames, and modal suppression. This is a large UX reliability surface even when the
  content itself works.
- Manual-pass notes recorded important journeys and fixes that still needed live re-verification
  ([`docs/handoff-2026-07-04-manual-pass.md:34-57`](handoff-2026-07-04-manual-pass.md#L34-L57)).
- There is no automated renderer accessibility or interaction harness.

#### Specific recommendations

1. Add a first-run checklist:
   - create or select profile;
   - choose provider;
   - enter key;
   - verify endpoint and model;
   - load a safe built-in sample or import a card;
   - create a session;
   - send the first successful turn.
2. Show a persistent readiness indicator before generation: provider configured, model selected, world loaded,
   and required card capabilities granted.
3. Introduce **Play** and **Creator/Debug** modes.
4. Include a declarative, script-free sample world that exercises the core journey without remote content.
5. Conduct task-based usability studies and record completion rate, time, errors, help requests, and
   comprehension of trust prompts.
6. Make failure recovery actionable: explain what failed, what data is safe, and what the user should do next.

---

### 4.6 Business and practical viability

**Priority: High**

#### What is strong

- BYO provider credentials reduce central inference cost and allow the project to operate without a hosted
  generation backend.
- Local-first storage is attractive for private, long-running roleplay data.
- Format compatibility can reduce the cold-start problem by importing an existing content ecosystem.
- A successful World Card format and creator SDK could create ecosystem defensibility.
- The product could support several viable models: open-source player, paid desktop application, paid creator
  tooling, curated marketplace, or a hybrid.

#### What is weak or unclear

- No business model or distribution model is selected.
- No project license exists. The README explicitly says the license is still to be chosen
  ([`README.md:312-315`](../README.md#L312-L315)). This blocks responsible redistribution and creates
  uncertainty for contributors and downstream users.
- No acquisition, conversion, activation, retention, or support plan is documented.
- The builder configuration is not production-ready:
  - generic `com.electron.app` identifier;
  - lowercase product name;
  - macOS notarization disabled;
  - generic Linux maintainer;
  - update endpoint set to `https://example.com/auto-updates`
    ([`electron-builder.yml:1-43`](../electron-builder.yml#L1-L43)).
- There is no auto-update implementation dependency or release-channel policy.
- Community-authored executable content creates a significant trust, moderation, compatibility, and support
  burden.
- The lack of a hosted marketplace is a reasonable non-goal for the current phase, but it also means content
  discovery and update distribution remain unresolved.

#### Specific recommendations

1. Decide the economic model before public launch:
   - free/open-source player;
   - paid signed desktop distribution;
   - paid creator features;
   - marketplace revenue;
   - sponsorship/donation model.
2. Choose and publish a project license after legal review of compatibility and clean-room obligations.
3. Start with one supported operating system to reduce signing, packaging, native-module, filesystem, and UI
   variation.
4. Define a support policy: supported cards, supported providers, response expectations, diagnostic collection,
   and what is explicitly best effort.
5. Establish release identity, signing, notarization, update hosting, changelogs, rollback, and security-contact
   processes.

---

### 4.7 Risks, edge cases, and failure points

**Priority: Critical**

#### What is strong

- API keys are normally retained in main, encrypted with OS facilities when available, and masked on later
  renderer reads.
- Card scripts have a visible trust prompt and persisted grant state.
- Model calls have rate and concurrency limits, abort behavior, and retry handling.
- Headless agent failures are surfaced instead of silently disappearing.
- Variable and table writes are journaled for replay and rewind.
- Game engines are deterministic and serializable.

#### What is weak or unclear

The highest-risk issue is the authored-content execution boundary.

##### A. Default inline scripted content can reach the parent application

`MessageContent` detects scripted HTML and routes it to either `WcvMessageFrame` or `InlineCardFrame`. The
default global mode is inline, and this branch has no per-card trust check
([`src/renderer/src/components/MessageContent.tsx:37-73`](../src/renderer/src/components/MessageContent.tsx#L37-L73)).

`InlineCardFrame` intentionally creates a same-origin `srcdoc` iframe, uses both `allow-scripts` and
`allow-same-origin`, and reaches `window.parent.__rptCardBridge`
([`src/renderer/src/components/InlineCardFrame.tsx:19-28`](../src/renderer/src/components/InlineCardFrame.tsx#L19-L28),
[`src/renderer/src/components/InlineCardFrame.tsx:47-60`](../src/renderer/src/components/InlineCardFrame.tsx#L47-L60),
[`src/renderer/src/components/InlineCardFrame.tsx:183-203`](../src/renderer/src/components/InlineCardFrame.tsx#L183-L203)).

The parent renderer exposes the complete preload API as `window.api`
([`src/preload/index.ts:729-743`](../src/preload/index.ts#L729-L743)). That API includes destructive and
host-level operations such as profile wipe, character/chat deletion, asset mutation, file dialogs, storage
location changes, and application restart.

Because the iframe is same-origin with the parent, the intended card bridge is not the only reachable
surface. A malicious scripted document can attempt to access `window.parent.api` or mutate the parent DOM.
This can originate from an imported card’s regex/frontend HTML, and the renderer also recognizes full
`<html>`/`<body>` or fenced HTML in message content. A model or prompt-injected output that meets the scripted
HTML pattern therefore deserves the same threat treatment as imported executable content.

This is a **release-blocking security design issue**, not a low-priority hardening task.

##### B. WCV isolation is incomplete

The WCV path provides process separation, but its preferences disable both context isolation and Chromium
sandboxing while loading a preload into the page world
([`src/main/services/wcvManager.ts:142-173`](../src/main/services/wcvManager.ts#L142-L173)). Its CSP permits
HTTPS resources, inline code, eval, arbitrary images/media, and network connections
([`src/main/services/wcvManager.ts:24-27`](../src/main/services/wcvManager.ts#L24-L27)).

All card WCVs share one persistent session partition and one `rpt-card://card` origin
([`src/main/services/wcvManager.ts:11-23`](../src/main/services/wcvManager.ts#L11-L23)). This permits storage
collision and cross-card data observation through same-origin browser storage.

The manager does not install an explicit navigation-denial policy for card views. A navigated page retains the
preload and sender-bound application context unless the host destroys or restricts it.

##### C. Consent wording understates capability scope

The trust prompt says a world’s scripts run with access to “this session”
([`src/renderer/src/components/CardTrustPrompt.tsx:58-70`](../src/renderer/src/components/CardTrustPrompt.tsx#L58-L70)).
WCV IPC handlers can enumerate, create, read, save, bind, and delete profile-wide worldbooks
([`src/main/ipc/wcvIpc.ts:377-426`](../src/main/ipc/wcvIpc.ts#L377-L426)), write profile-global variables,
mutate chat history, start generations, and import assets. Consent is not sufficiently specific or granular.

##### D. Main renderer hardening is incomplete

The main BrowserWindow explicitly sets `sandbox:false`
([`src/main/index.ts:31-58`](../src/main/index.ts#L31-L58)). External window requests are passed directly to
`shell.openExternal` without a visible scheme allowlist
([`src/main/index.ts:69-77`](../src/main/index.ts#L69-L77)). Under a renderer compromise, these choices widen
the impact.

##### E. Data-location and recovery risks

Packaged builds default the data root to the executable directory plus `rp-terminal-data`
([`src/main/services/storageService.ts:24-38`](../src/main/services/storageService.ts#L24-L38)). This may be
unwritable or unsuitable for applications installed in `/Applications`, protected Windows locations, Snap,
or read-only mounts. The platform-standard default should be `app.getPath('userData')`, with a deliberate
portable mode as an option.

Startup migration failures are logged and the app continues
([`src/main/index.ts:102-119`](../src/main/index.ts#L102-L119)). There is no user-facing safe mode, automatic
backup, integrity check, or recovery wizard.

#### Specific recommendations

1. Make all untrusted or semi-trusted authored documents cross-origin from the renderer and unable to access
   parent DOM or `window.api`.
2. Prefer one production runtime:
   - sandboxed process;
   - `contextIsolation:true`;
   - `sandbox:true`;
   - `nodeIntegration:false`;
   - narrow `contextBridge` facade;
   - no raw `ipcRenderer` exposure;
   - strict navigation and popup denial;
   - per-card/per-profile storage partition;
   - CSP derived from approved capabilities.
3. Treat **all** scripted HTML as executable content. Carry provenance and trust state through regex
   transformation and message rendering.
4. Replace blanket “trust” with explicit capabilities: session variables, chat writes, generation, worldbook
   reads/writes, global storage, network domains, assets, and UI overlays.
5. Validate sender identity, origin, profile, chat, card, and granted capability in main for every card IPC
   call. Renderer-only checks are not sufficient.
6. Add adversarial tests for parent access, preload API access, navigation, cross-card storage, permission
   bypass, malformed IPC, oversized payloads, infinite loops, and prompt-produced HTML.
7. Move default data to `userData`; add portable mode separately.

---

### 4.8 Missing requirements and unanswered questions

**Priority: High**

#### What is strong

- Feature and subsystem designs are unusually detailed.
- The SDK attempts to maintain an explicit compatibility contract.
- Several ADRs preserve the reasoning behind workflow and agent decisions.
- Point-in-time handoffs are candid about unresolved work and manual verification.

#### What is weak or unclear

The repository lacks a single release PRD defining what “ready” means. Important missing requirements include:

| Requirement area    | Missing decision or acceptance criterion                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Primary user        | Who the first release is for and whose complexity is optimized.                                 |
| Core journey        | Exact steps and success criteria from install to first successful session.                      |
| Supported platforms | OS versions, architectures, packaging formats, and support order.                               |
| Compatibility       | Guaranteed formats/APIs, best-effort tiers, test corpus, and pass threshold.                    |
| Security            | Threat actors, trust boundaries, capabilities, network policy, disclosure process.              |
| Privacy             | Stored sensitive data, logs, retention, exports, deletion, and diagnostic sharing.              |
| Data safety         | Backup, restore, corruption recovery, migrations, rollback, and downgrade policy.               |
| Performance         | Maximum chat size, floor count, card size, asset count, workflow size, and WCV count.           |
| Reliability         | Crash recovery, interrupted writes, provider timeouts, partial imports, and disk-full behavior. |
| Accessibility       | Keyboard, focus, screen reader, contrast, reduced motion, and localization criteria.            |
| Updates             | Channels, signatures, migration compatibility, rollback, and security patches.                  |
| Business            | License, pricing, support, contribution, distribution, and moderation policies.                 |
| Success metrics     | Activation, first-turn completion, retained sessions, compatibility rate, and crash-free rate.  |

There are also implementation/documentation mismatches:

- README says profiles may be password protected
  ([`README.md:178-192`](../README.md#L178-L192)), but the renderer activates a profile directly and profile
  creation accepts only a name
  ([`src/renderer/src/components/ProfilePicker.tsx:5-39`](../src/renderer/src/components/ProfilePicker.tsx#L5-L39)).
  The service stores an optional `password_hash`, but no authentication path uses it
  ([`src/main/services/profileService.ts:9-35`](../src/main/services/profileService.ts#L9-L35)).
- README describes CI enforcement, but no CI workflow exists.
- World Card design promises one-click installation of everything, while plugin bundling and complete packing
  remain deferred.
- Package version `1.0.0` conflicts with the explicit early-development status.

#### Specific recommendations

1. Create one release PRD with:
   - primary persona and job;
   - supported journey;
   - non-goals;
   - compatibility contract;
   - security and data requirements;
   - platform scope;
   - measurable launch gates.
2. Maintain one truthful feature matrix: implemented, experimental, partial, unsupported.
3. Remove or relabel unimplemented claims immediately.
4. Define quantitative budgets for content size, process count, latency, and storage growth.

---

### 4.9 Opportunities to simplify or improve

**Priority: High**

#### What is strong

- `shared/thRuntime` is intended as one behavioral surface over multiple transports.
- Pure engines, schema-driven workflow nodes, typed ports, and reusable table/memory cores are strong
  simplification primitives.
- The one-canvas workflow model attempts to collapse previously fragmented agent concepts.
- The launcher and settings-hub changes show willingness to simplify user-facing navigation.

#### What is weak or unclear

- Two card transports double compatibility and security reasoning.
- Both native and card-authored game surfaces coexist with two native game systems.
- Retired pack/recipe terminology has been removed from product language, but substantial pack-era stores,
  services, IPC, migrations, and transfer formats remain in the implementation.
- Disabled or dormant settings remain represented in models and UI, including cache optimization and agentic
  mode.
- Several systems expose expert configuration before a validated default path exists.
- The preload and IPC surface is very broad, increasing audit cost and the impact of any renderer compromise.

#### Specific recommendations

1. **Choose one secure card runtime.** Preserve transport compatibility only if measured card evidence proves it
   necessary.
2. **Choose one showcase native game system.** Keep the other experimental until the first is validated.
3. **Collapse creator complexity into templates.** Most users should select a tested workflow rather than
   author a graph.
4. **Quarantine legacy internals.** Remove, migrate, or isolate pack/recipe-era code behind compatibility
   adapters with a retirement date.
5. **Hide dormant features.** Do not display disabled selectors or “coming soon” product modes in the normal
   settings experience.
6. **Reduce preload authority.** Split the renderer API by domain and ensure authored documents never share a
   realm with it.
7. **Establish deletion as a roadmap item.** Every feature milestone should identify code, UI, or concepts it
   makes removable.

---

### 4.10 Recommended next steps

**Priority: High**

#### What is strong

- The project has an established habit of writing specs, tests, ADRs, and manual checklists.
- Core boundaries and characterization tests make controlled refactoring possible.
- The current architecture can support a safer runtime and narrower product without a full rewrite.

#### What is weak or unclear

- Recent sequencing emphasizes feature expansion and UI breadth over security, packaging, recovery, and user
  validation.
- Passing local unit tests is used as the dominant completion signal even where the critical behavior is
  native, visual, cross-process, filesystem-dependent, or provider-dependent.
- There is no externally meaningful definition of alpha, beta, or 1.0 readiness.

#### Specific recommendations

Follow the phased plan in §9. Do not begin another major subsystem until the Phase 0 and Phase 1 gates pass.

---

## 5. Priority risk register

| ID  | Risk                                                                          | Severity | Likelihood             | Evidence                                                           | Required response                                          |
| --- | ----------------------------------------------------------------------------- | -------- | ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| R1  | Same-origin inline card reaches parent `window.api` and DOM                   | Critical | High                   | `MessageContent`, `InlineCardFrame`, preload exposure              | Redesign boundary before release.                          |
| R2  | Scripted message/model output enters executable path without trust provenance | Critical | Medium–High            | Script detection is content-based; no trust input in render branch | Carry provenance and deny execution by default.            |
| R3  | WCV page has context isolation and sandbox disabled                           | Critical | High                   | `wcvManager` web preferences                                       | Enable isolation/sandbox; use narrow bridge.               |
| R4  | Card consent understates profile-wide and destructive capabilities            | High     | High                   | Trust copy vs WCV worldbook/global/chat handlers                   | Capability-based consent and main enforcement.             |
| R5  | Shared WCV origin/storage leaks state across cards                            | High     | Medium                 | One persistent partition and origin                                | Partition per profile/card and clear on revoke/delete.     |
| R6  | Packaged default data path is unwritable or unsuitable                        | High     | High on some platforms | `storageService` uses executable directory                         | Use `app.getPath('userData')`; add portable mode.          |
| R7  | Startup migration causes unrecoverable or silent data loss                    | High     | Medium                 | Ad hoc DDL/drops, log-and-continue startup                         | Backup, versioned migrations, integrity checks, safe mode. |
| R8  | Public release cannot be legally distributed consistently                     | High     | High                   | No project license                                                 | Choose license before distribution.                        |
| R9  | Packages are unsigned/unnotarized or cannot update securely                   | High     | High                   | Builder placeholders and notarize false                            | Production release pipeline and signing.                   |
| R10 | Compatibility promise exceeds measured reality                                | High     | High                   | Partial feature matrix; no corpus                                  | Representative corpus and published tiers.                 |
| R11 | Users abandon before first successful turn                                    | High     | Medium–High            | No guided setup or sample journey                                  | Onboarding checklist and usability studies.                |
| R12 | Native/renderer regressions escape unit suite                                 | High     | High                   | Electron and DB mocked; no UI E2E                                  | Native integration and packaged smoke tests.               |
| R13 | High feature count prevents stabilization and support                         | High     | High                   | Multiple platforms/subsystems and rapid churn                      | MVP freeze and removal roadmap.                            |
| R14 | Unsupported Node/package-manager combination breaks contributor/release gate  | Medium   | High                   | Node 25 check failure; no engine pin                               | Pin runtime and enforce it.                                |
| R15 | Lint/React issues accumulate in high-churn UI                                 | Medium   | High                   | 9 lint errors, 1,312 warnings                                      | Format cleanup; lint as mandatory CI gate.                 |

---

## 6. Top five biggest concerns

1. **The default authored-HTML runtime can access the parent renderer and its full Electron API.**
2. **No primary launch user or narrowly defined MVP has been validated.**
3. **Release infrastructure—license, CI, signing, notarization, update delivery, and packaging validation—is
   incomplete.**
4. **Data migration and recovery are not robust enough for valuable long-running user histories.**
5. **Compatibility and one-click-world claims are not backed by a representative measured corpus.**

---

## 7. Top five highest-impact improvements

1. **Replace the current card execution boundary with one capability-limited, isolated runtime.**
2. **Choose a primary player journey and freeze features outside the launch MVP.**
3. **Create a compatibility corpus and make its pass rate a release gate.**
4. **Implement versioned migrations, automatic backups, restore, integrity checks, and safe recovery.**
5. **Build a real release pipeline with pinned tooling, CI, native/Electron tests, signing, and updates.**

---

## 8. Questions that must be answered before moving forward

### Product and users

1. Who is the primary customer for the first release: player, card author, or workflow/plugin developer?
2. What single outcome makes that customer switch from their current setup?
3. Which five capabilities are required for launch, and which are explicitly postponed?
4. Is a user expected to understand presets, lorebooks, regex, scripts, workflows, and memory tables before
   their first successful session?
5. What activation and retention metrics will demonstrate real value?

### Compatibility and content

6. What exact ST/TavernHelper/ST-Prompt-Template surface is guaranteed?
7. How many representative cards must pass before a release may claim compatibility?
8. What happens when a card is partially supported: refuse, degrade, transform, or run best effort?
9. Is executable third-party card code essential to the launch, or can v1 support a declarative-only tier?
10. How are card updates, conflicts, dependencies, revocation, and provenance handled without a marketplace?

### Security and privacy

11. Which capabilities may a trusted card read or mutate?
12. Can one card access profile-global data or other worlds, and if so, why?
13. Which network origins may authored content contact, and how does the user review them?
14. What is the threat model for model-produced HTML and prompt injection?
15. What sensitive data appears in logs, prompts, exported worlds, screenshots, and crash reports?

### Distribution and business

16. Is RP Terminal open source, paid desktop software, creator tooling, a marketplace, or a hybrid?
17. Which license applies to the project and contributions?
18. Which OS ships first, and what support commitment is made?
19. Who pays for support and compatibility maintenance if users bring arbitrary community cards?
20. What release, update, rollback, and security-disclosure process will users rely on?

### Data safety

21. How does a user recover from a corrupt database, failed migration, disk-full event, or interrupted write?
22. What is the backup and restore format?
23. Are downgrades supported after a schema migration?
24. What happens to encrypted keys when data is moved to another device or OS account?
25. What objective evidence qualifies the product as alpha, beta, and ready?

---

## 9. Recommended phased action plan

### Phase 0 — Immediate containment and decisions (0–7 days)

**Goal:** prevent new work from deepening the highest-risk problems.

1. Freeze major feature development.
2. Disable scripted inline cards in production builds or force them into a temporary isolated path.
3. Write a threat model covering renderer, preload, WCV, iframe, QuickJS, card, plugin, model-output, network,
   filesystem, and IPC boundaries.
4. Choose the primary launch persona and write the MVP/non-goal list.
5. Decide the supported launch OS.
6. Select a prerelease versioning policy.
7. Fix the 9 ESLint errors and establish a warning-reduction baseline.

**Exit gates:**

- no scripted authored content can access parent `window.api`;
- MVP and non-goals are approved;
- threat model identifies every privileged card capability;
- lint has zero errors.

### Phase 1 — Security and data foundation (1–4 weeks)

**Goal:** create defensible application boundaries and protect user histories.

1. Implement the isolated card runtime with context isolation, Chromium sandboxing, narrow bridge, navigation
   restrictions, capability grants, and per-card storage.
2. Add main-side sender/origin/grant validation to every authored-content IPC handler.
3. Move default data storage to platform `userData`.
4. Add automatic backup before migration and before destructive maintenance.
5. Introduce numbered, transactional schema migrations and integrity checks.
6. Add recovery UI and restore/export flows.
7. Add adversarial security tests.

**Exit gates:**

- security test suite proves parent/preload isolation;
- capability revocation takes effect without restart;
- migration fixtures preserve data across all supported versions;
- backup/restore is verified on the target OS;
- the app enters safe mode instead of continuing after a migration failure.

### Phase 2 — Product validation and compatibility (2–6 weeks)

**Goal:** verify that the narrowed product solves a valuable problem.

1. Assemble the representative card corpus.
2. Add an automated compatibility harness where feasible and a structured manual protocol for the rest.
3. Build the guided first-run setup and safe sample world.
4. Conduct 8–12 observed target-user sessions.
5. Measure setup completion, first successful turn, import success, failure recovery, and session return.
6. Revise the MVP based on observed failures, not feature requests alone.

**Exit gates:**

- target compatibility pass rate is met;
- at least 80% of target test users complete first setup and first turn without developer intervention;
- trust prompts are correctly understood by the majority of participants;
- the primary user can explain the product’s value in their own words.

### Phase 3 — Release engineering (3–8 weeks)

**Goal:** make builds reproducible, distributable, and supportable.

1. Pin Node and package-manager versions.
2. Add CI for format, lint, typecheck, dependency boundaries, unit tests, native DB tests, Electron E2E, build,
   and packaging smoke tests.
3. Choose and add the project license.
4. Set production app identity, icons, metadata, permissions, and protocol registration.
5. Add signing, notarization, update hosting, channel policy, changelog, and rollback.
6. Test install/update/uninstall/data preservation on clean target machines.

**Exit gates:**

- clean-machine build is reproducible;
- signed package installs without security warnings on the target OS;
- update and rollback paths are verified;
- user data survives update and uninstall according to documented policy;
- release artifacts are generated only from a green protected branch.

### Phase 4 — Private alpha

**Goal:** validate real use over time before a public promise.

1. Recruit a small group of players and authors with representative cards.
2. Provide an explicit supported/unsupported matrix.
3. Track crash-free sessions, generation failures, compatibility failures, backup/restore, and repeat use.
4. Triage only issues inside the MVP unless a security or data-loss issue requires expansion.
5. Reassess whether combat, duel, workflows, plugins, and advanced memory should be public, experimental, or
   deferred.

**Suggested alpha exit gates:**

- zero known critical security issues;
- zero known reproducible data-loss issues;
- > 99% crash-free sessions on the target OS;
- target compatibility pass rate sustained;
- reliable backup/restore used successfully by external testers;
- evidence of repeat weekly use for the core journey.

---

## 10. Proposed release gates

RP Terminal should not be called “Ready” until all gates below pass.

### Security

- [ ] Authored content cannot access renderer DOM, `window.api`, raw IPC, Node, or filesystem primitives.
- [ ] All card/plugin capabilities are main-enforced and revocable.
- [ ] Model-produced HTML cannot silently become trusted executable code.
- [ ] Navigation, popups, downloads, external schemes, and network origins are restricted.
- [ ] Security disclosure and patch process exists.

### Data

- [ ] Platform-standard default data location.
- [ ] Automatic pre-migration backup.
- [ ] Versioned migrations with integrity verification.
- [ ] User-visible recovery and restore.
- [ ] Clean update and rollback tests.

### Product

- [ ] Primary persona and MVP approved.
- [ ] Guided first-run journey complete.
- [ ] Safe bundled sample available.
- [ ] Compatibility corpus meets target pass rate.
- [ ] Observed usability target met.

### Engineering

- [ ] Zero lint errors.
- [ ] Pinned runtime and package manager.
- [ ] CI required on protected `main`.
- [ ] Native DB, Electron E2E, and packaged-app tests pass.
- [ ] Reproducible signed build from clean environment.

### Distribution and business

- [ ] Project license selected.
- [ ] Production app identity and metadata configured.
- [ ] Signing/notarization configured for supported OS.
- [ ] Secure update endpoint and rollback policy configured.
- [ ] Support and compatibility policies published.

---

## 11. Final verdict

**Not ready yet.**

RP Terminal is not being rejected as a concept or as an engineering effort. It has a stronger technical
foundation than many projects at this stage: core boundaries are coherent, pure systems are well tested, the
team has documented difficult decisions, and the compatibility work reflects real ecosystem knowledge.

The verdict is driven by readiness, not potential. A public release today would expose users to:

- an unsafe authored-content boundary;
- unclear trust and capability scope;
- incomplete data recovery and migration safeguards;
- unfinished distribution and licensing infrastructure;
- a product surface too broad to support confidently;
- compatibility claims that lack a measured release corpus.

If the project pauses expansion and completes the security, focus, validation, and release work in this report,
the likely next verdict is **Promising but needs work**, followed by **Ready** only after a successful private
alpha demonstrates secure execution, recoverable data, repeatable first-run success, and sustained use.

The most important strategic decision is simple: **make RP Terminal a trustworthy, excellent player before
making it an unlimited platform.**
