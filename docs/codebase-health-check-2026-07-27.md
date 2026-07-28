# RP Terminal Codebase Health Check — 2026-07-27

**Status:** Final point-in-time audit snapshot. Preserve this report and supersede it with a newer
dated review rather than silently rewriting historical findings.

**Reviewed revision:** `710088c6ef5d432a0f361a56283f84d5db826419` (`main`, equal to
`origin/main` when the review began).

**Review-owned changes:** This report and its entry in `docs/documentation-catalog.md` only. No
product code, dependency, configuration, or test behavior was changed.

## Executive verdict

RP Terminal is not release-ready. The repository has strong automated characterization coverage,
clear dependency boundaries, and several well-designed pure/shared cores, but the current Electron
trust boundary is not enforced consistently. Four independently actionable P0 defects allow a
remote page or card script to obtain privileges outside the documented card contract:

1. A normal Markdown link can navigate the privileged main renderer to a remote origin while its
   full preload API remains installed.
2. The model-list handler combines a stored provider key with a caller-controlled endpoint.
3. Raw preload IPC permits cross-profile enumeration and deletion despite the own-session contract.
4. An unvalidated plugin ID reaches recursive filesystem deletion outside the plugin root.

The review also found a destructive legacy migration composition bug, two generation-cancellation
ownership defects, a reachable crafted-ZIP process crash, WCV permission and cold-trust failures,
and several persistence/import races.

Finding inventory: **4 P0**, **9 P1**, and **7 P2**.

## Severity and confidence

| Level | Meaning |
| --- | --- |
| P0 | Release blocker: credible secret disclosure, cross-profile destruction, host reach, or equivalent compromise. |
| P1 | Major defect: reachable data loss, privacy breach, paid-work leak, persistent hang, or serious broken contract. |
| P2 | Material correctness, maintainability, architecture, localization, or verification deficiency. |

Every finding below has a concrete owner, trigger, reachable production path, and user impact. No
destructive proof-of-concept or intentionally memory-exhausting archive was executed.

## Scope and method

This was a whole-current-tree audit, not a diff review against one feature specification. The
previous dated reviews were historical input only; findings were carried forward only when they
were revalidated against the reviewed revision.

Reviewed domains:

- Electron window, navigation, preload, IPC sender, WCV, and card trust boundaries
- Profiles, chats, logs, settings, plugins, assets, and host filesystem operations
- SQLite/session storage, startup migrations, save transfer, and floor persistence
- Full-turn, raw-generation, Agent invocation, cancellation, and next-turn barriers
- Shared runtime/module boundaries, IPC typing, localization, documentation, lint, CI, and packages

Static/source conclusions were checked against production call paths and focused tests. The full
repository verification suite was run. Runtime keyboard, accessibility, visual layout, installer,
auto-update, and OS permission behavior were not manually exercised.

## What is working well

- `npm.cmd run verify` passes: node/web typechecks, dependency-cruiser, and the Vitest suite are
  green. The suite reported 324 passing test files, 4 skipped files, 3,635 passing tests, and
  12 skipped tests.
- Dependency-cruiser accepted 558 modules and 2,304 dependencies with no boundary violations.
- The shared TavernHelper runtime remains the single behavioral surface for inline and WCV
  transports.
- Combat/game logic and several Agent/runtime cores are isolated from renderer and Electron imports.
- Session storage, prompt assembly, MVU, EJS, combat, conversion, and transport parity have broad
  characterization coverage.
- The reviewed branch and worktree were clean and synchronized with `origin/main`.

## P0 — release blockers

### P0-1. Main-frame navigation turns an attacker page into the privileged app renderer

**Evidence**

- `src/renderer/src/components/MessageContent.tsx:147-149` renders model text with the default
  ReactMarkdown anchor behavior.
- `src/main/index.ts:153-156` handles only new-window creation; no `will-navigate` handler limits
  same-frame navigation.
- `src/preload/index.ts:855-858` exposes both `window.electron` and the complete `window.api` surface
  whenever the preload runs.
- `src/main/ipc/ipcGuards.ts:149-159` accepts the main `WebContents` main frame. A remote document
  loaded into that frame still satisfies this identity test.
- `src/main/index.ts:153-155` additionally forwards every new-window URL to `shell.openExternal`
  without a protocol allowlist.

**Trigger and impact**

An attacker-controlled or model-authored Markdown link is rendered in a normal message and the user
clicks it. The main frame navigates to the attacker origin, Electron runs the configured preload,
and the attacker page receives the app API. It can then use both ungated handlers and handlers whose
only authorization is the main-frame identity check. This bypasses the intended inline/WCV card
trust split.

Electron recommends denying unexpected navigation, validating every IPC sender, and never exposing
Electron APIs to untrusted web content in its
[security guidance](https://www.electronjs.org/docs/latest/tutorial/security#13-disable-or-limit-navigation).

**Required correction**

Install a default-deny `will-navigate` policy for the main window, allow only the packaged/dev app
origin, and open validated `https:`/`mailto:` links externally. Treat sender validation as origin
plus frame identity, and do not expose a generic Electron API to documents outside the app origin.

### P0-2. `list-models` can send a stored provider key to a caller-controlled endpoint

**Evidence**

- `src/renderer/src/components/InlineCardFrame.tsx:214-226` deliberately permits trusted scripts in a
  same-origin, parent-reachable iframe.
- `src/preload/index.ts:23-30` exposes profile enumeration and `listModels`.
- `src/main/ipc/profileIpc.ts:34-42` accepts an API object and profile ID from the caller, resolves the
  real stored key when the supplied key is blank or masked, and spreads that key back into the
  caller's object.
- `src/main/services/apiService.ts:163-188` sends the key to the supplied Anthropic, Gemini, or
  OpenAI-compatible endpoint.
- The handler is not protected by `gate`, despite `src/main/ipc/ipcGuards.ts:7-11` explicitly stating
  that card trust never includes provider keys.

**Trigger and impact**

A trusted inline card, or a remote page reached through P0-1, supplies an attacker endpoint and a
blank/masked key. Main sends the stored credential to that endpoint in an authorization header.

**Required correction**

Gate model discovery to the app UI and resolve a complete saved provider/preset configuration
atomically in main. Never combine a stored secret with a renderer-selected endpoint or provider.

### P0-3. Card operations are not bound to their documented profile/session

**Evidence**

- `docs/rpt-api.md:54-63` promises that cards cannot read or modify another session or world.
- `src/preload/index.ts:23-25,49-53,174-175` exposes profile listing, arbitrary-profile chat listing,
  floor reads, and chat deletion.
- `src/main/ipc/profileIpc.ts:10` and `src/main/ipc/chatIpc.ts:11-15,32` trust caller-supplied profile
  and chat IDs.
- `src/main/services/profileService.ts:13-19` returns all profile IDs.
- `src/main/services/chatService.ts:86-92` lists chats for the supplied profile.
- `src/main/services/chatDeleteService.ts:29-42` deletes the central chat row by `chatId` without
  verifying that it belongs to the supplied profile.

**Trigger and impact**

A trusted inline card enumerates profile IDs, lists another profile's chats, and invokes deletion
with a victim chat ID. The central chat disappears and its session directory may be orphaned under
the victim profile. The same default-open pattern affects many read/write APIs.

**Required correction**

Create an explicit card capability surface whose profile/chat/character context is bound by main or
the host transport. Do not accept scope identifiers from card arguments. Add ownership checks at
service boundaries so an IPC mistake cannot become cross-profile access.

### P0-4. Plugin IDs escape the plugin root and reach recursive deletion

**Evidence**

- `src/preload/index.ts:545-554` exposes plugin management.
- `src/main/ipc/pluginIpc.ts:111-148` gates install, enable, and grant mutations but leaves
  `plugins-uninstall` ungated.
- `src/main/services/pluginHostService.ts:24-27` builds plugin and profile-state paths with raw IDs.
- `src/main/services/pluginHostService.ts:98-106` uses an unvalidated manifest ID as an installation
  destination.
- `src/main/services/pluginHostService.ts:135-140` recursively removes the path produced by
  `pluginDir(id)`.

**Trigger and impact**

A card calls uninstall with a traversal ID such as `..\profiles\victim`, or a selected plugin
package contains a traversal manifest ID. `path.join` resolves outside `plugins/`; recursive removal
or replacement can delete or overwrite application data.

**Required correction**

Define a strict plugin-ID grammar, reject separators and dot segments, resolve the target, and prove
containment under the canonical plugin root before every read/write/delete. Keep main-frame
authorization as defense in depth.

## P1 — major findings

### P1-1. A persistently denied card executes during cold trust resolution

`src/renderer/src/components/MessageContent.tsx:70-87` loads persisted grants asynchronously.
`src/renderer/src/components/messageCardRouting.ts:31-51` routes the unresolved state to isolated
WCV execution. `src/renderer/src/components/WcvMessageFrame.tsx:53-77` loads the raw scripted HTML,
and `src/preload/wcvPreload.ts:398-411` installs the full TavernHelper runtime.

The WCV channel catalog includes worldbook and chat mutations plus generation
(`src/shared/thRuntime/wcvChannelSpec.ts:79-101,134-137`), and
`src/main/ipc/wcvIpc.ts:162-177` registers the catalog without a trust decision. On a cold open, a
previously denied card can delete content or start paid generation before the asynchronous grant
read tears the WCV down.

Hold executable rendering behind an unresolved placeholder and independently verify the card's
current trust/grant state in main before executing mutation or generation handlers.

### P1-2. Legacy JSON migration deletes migrated floors and cannot reliably resume

`src/main/services/migrationService.ts:84-124` inserts chats and writes their legacy floor files
through the current `saveFloor` path. That path writes to the per-chat session DB
(`src/main/services/floorService.ts:262-313`). Because the insert omits `session_migrated`, the chat
receives the default zero marker defined at `src/main/services/db.ts:568-571`.

Startup immediately invokes session migration (`src/main/index.ts:196-206`).
`src/main/services/sessionMigrationService.ts:89-98` removes the newly populated session directory,
creates a clean store, and copies only legacy central-table rows. The JSON-migrated floors never
entered those central tables, so the chat opens empty and is marked migrated.

There is a second resumability defect: `src/main/services/migrationService.ts:18-36` returns whenever
any profile row exists but catches individual profile failures. If one profile succeeds and a later
profile fails, every subsequent startup skips the failed profile.

Repair the pipeline as one idempotent migration with per-profile/per-chat completion markers and add
an integration fixture covering multiple profiles, floor files, partial failure, restart, and exact
post-migration content.

### P1-3. Stop targets the wrong provider call when raw and full generation overlap

`src/main/services/generationService.ts:60-65` intentionally permits raw generation during a main
turn while sharing `activeControllers`. Full generation writes and later deletes the chat key at
`src/main/services/generationService.ts:131-133,186-189`; raw generation does the same at
`src/main/services/generation/rawGenerate.ts:84-95`.

The later call overwrites the earlier controller. Stop aborts only the current map value, and either
call's `finally` can remove the other call's controller. A request can continue spending tokens
after Stop and become unabortable.

Track controllers by invocation, maintain an explicit per-chat set, and make Stop abort all relevant
provider work. Each completion must delete only its own entry.

### P1-4. Floor deletion can strand a `blocksNextTurn` waiter forever

`src/main/services/agentRuntime/invocation/InvocationRuntime.ts:1183-1187` snapshots barrier objects
and awaits their `settled` promises. `cancelFloors` deletes the barrier from the map without invoking
its resolver at lines 1133-1143. Eventual lane completion looks the barrier up again at lines
915-916, receives `undefined`, and therefore cannot settle the already-observed promise.

If a turn begins waiting and transcript truncation removes the originating floor, generation hangs
until a separate Stop. Settle the barrier before removal and add a regression test that combines an
active waiter with floor deletion.

### P1-5. Crafted ZIP input can crash the main process through `adm-zip`

`package-lock.json:3746-3749` installs `adm-zip` 0.5.17. Its entry reader allocates the declared
uncompressed size before validation (`node_modules/adm-zip/zipEntry.js:103`).

The application reaches affected materialization methods on selected/imported community content:

- `src/main/services/cardCodeService.ts:83-104` reads a card-code manifest before applying entry caps.
- `src/main/services/worldAssetService.ts:291-340` calls `entry.getData()` without archive/entry caps.
- `src/main/services/pluginHostService.ts:121-129` calls `extractAllTo`.

The published [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) advisory
describes a tiny crafted archive that forces a multi-gigabyte allocation. Upgrade to a patched
release and enforce declared, compressed, uncompressed, per-entry, and aggregate limits before
materialization.

### P1-6. WCV sessions have no deny-by-default web permission policy

`src/main/services/wcvManager.ts:47-96` creates the persistent WCV session but installs no permission
request/check handlers. `src/main/services/wcvManager.ts:282-307` accepts remote pages and disables
process sandboxing for the view.

Electron automatically approves permission requests when no custom handler exists, as documented in
its [security guide](https://www.electronjs.org/docs/latest/tutorial/security#5-handle-session-permission-requests-from-remote-content).
A card page can request camera, microphone, notifications, or clipboard access subject only to
OS-level controls. Install a default-deny request and check handler on every session that loads
card/remote content, with narrow origin-and-permission exceptions where a product requirement exists.

### P1-7. Rapid chat selection can commit one chat's state under another chat ID

`src/renderer/src/stores/chatStore.ts:206-216` sets the active ID, awaits floors and mode, then
unconditionally commits the result. If selection A resolves after a later selection B, the store
retains B's `activeChatId` while displaying A's floors/mode. Editing, deleting, variable mutation,
or generation can then target B using stale A state.

Use a monotonically increasing request token or re-check the active profile/chat after the await
before committing. Apply the same post-await ownership check to refresh paths.

### P1-8. Global logs disclose prompts and responses across profiles

`src/preload/index.ts:609-611` exposes get/clear logs. `src/main/ipc/logIpc.ts:4-6` provides ungated,
profile-agnostic handlers, and `src/main/services/logService.ts:56-94` returns the global ring.
Generation logs complete outbound messages at `src/main/services/generation/assemble.ts:571-575`
and raw responses at `src/main/services/generation/callModel.ts:54-63`.

A trusted card in one profile can read recent private content from other profiles and erase the
audit buffer. Restrict full logs to the trusted debug/app surface, redact sensitive payloads by
default, and scope any card-visible diagnostics to the originating card/session.

### P1-9. World-asset manager IPC can copy host files into card-readable storage

`src/main/ipc/worldAssetIpc.ts:163-182` exposes import, delete, and rename manager operations without
sender gating. The preload accepts arbitrary source paths at `src/preload/index.ts:816-830`, and
`src/main/services/worldAssetService.ts:383-432` copies a supported-media source path into the
world-asset root.

A card that knows a host image/audio/video path can copy it into served storage and read it back.
Gate manager operations and replace caller-provided paths with unforgeable, short-lived tokens
returned by the native picker.

## P2 — material findings

### P2-1. Save import does not remap newer chat-scoped tables

The remap lists at `src/main/services/saveTransferService.ts:28-38,254-277` omit
`execution_records`, `agent_runs`, and `memory_retrieval_embeddings`, although all contain `chat_id`
(`src/main/services/sessionDbService.ts:124-162`). After import, consumers query with the new chat
ID, so forensic generation records, Agent history, and embedding cache disappear while stale
old-ID rows remain. Include every chat-scoped table and remap embedded chat IDs in Agent JSON where
required.

### P2-2. `saveFloor` converts synchronous persistence failures into detached rejections

`src/main/services/asyncLock.ts:59-65` catches a synchronous write error and returns a rejected
promise. `src/main/services/floorService.ts:327-340` deliberately discards that promise to preserve
a synchronous public contract, and `src/main/services/chatService.ts:377-388` proceeds to touch the
chat as if persistence succeeded.

A corrupt/read-only session DB or summary-write failure can report a successful turn that was not
saved and can surface as an unhandled rejection. Preserve synchronous error propagation for the
fast path or make the persistence contract honestly asynchronous and await it end to end.

### P2-3. Host fetch validates only the initial URL and limits too late

`src/main/services/scriptApiService.ts:118-134` validates that the input begins with HTTPS, follows
redirects, and calls `res.text()` before applying its character cap. It never validates the final
URL. Module-graph fetch at lines 156-190 repeats the redirect behavior and has no response or
aggregate-byte limit.

A remoteScripts-granted endpoint can redirect main's CORS-free fetch to localhost/private services,
and large responses are buffered before rejection. Validate every redirect/final address, apply a
network policy for private/link-local destinations, and enforce streaming byte limits plus an
aggregate module-graph budget.

### P2-4. The primary verification gate omits currently failing lint and documentation

`package.json:8-18` defines lint and documentation checks but `verify` runs only typecheck,
dependency-cruiser, and tests. `.github/workflows/release.yml:34-37` likewise omits the missing gates.

Current targeted ESLint over `src`, `test`, and `scripts` reports 25 errors and 1,461 warnings; seven
errors are in production source. `npm.cmd run check:docs` reports 73 broken local links, including
living contract documents such as `docs/rpt-api.md`, `docs/compat-comparison.md`, and
`docs/sdk/component-inventory.md`.

Repair the baselines, scope lint so it completes predictably, add lint/docs to `verify`, and run that
gate in general pull-request CI rather than only release/path-limited workflows.

### P2-5. The renderer IPC contract is effectively `any`

`src/preload/index.d.ts:3-6` declares `window.api` as `any & { ... }`, which collapses the entire
intersection to `any`. The runtime preload has hundreds of methods while the declaration lists only
a subset, and renderer call sites compensate with local casts.

Export a shared `RendererApi` derived from or checked against the preload implementation. Remove the
`any` escape hatch so signature drift is caught at the renderer/main boundary.

### P2-6. Retired workflow data is still created and migrated

`CONTEXT.md:462-464` promises that legacy workflow definitions, bindings, and run records remain
inert on disk and are never loaded, executed, migrated, or automatically deleted. Fresh schema and
startup migration logic in `src/main/services/db.ts:117-127,200-215,232-261,493-503,549-620`
continues to create, alter, and backfill workflow/pack structures.

Stop creating or migrating retired structures while leaving existing historical tables untouched.
Document any narrow table that remains load-bearing under a non-workflow domain name.

### P2-7. The pure combat engine transports localized presentation prose

`src/shared/combat/engine.ts:90-100,145-192`,
`src/shared/combat/resolver.ts:69-171`, and
`src/shared/combat/deckbuilder/deckResolve.ts:40-101` build user-facing English or mixed-language
strings. `src/renderer/src/components/workspace/CombatView.tsx:448-460` and
`DuelView.tsx:380-390` display those strings verbatim.

This bypasses the repository's `t()` rule and couples the pure engine to presentation language.
Return semantic event codes plus structured arguments; localize them in the renderer. Retain a
separate narration field only where model context genuinely requires prose.

## Architecture assessment

The principal weakness is not the existence of cards or WCV; it is the authorization interface
around them. The preload exposes a large application-management surface, and IPC registration is
default-open unless each handler remembers to call `gate`. Scope-bearing handlers commonly accept
raw profile, chat, endpoint, plugin, path, or card identifiers. This creates repeated authorization
misses across otherwise unrelated modules.

The durable correction is:

1. Separate app-management IPC from a narrow card capability interface.
2. Make IPC policy declaration mandatory and default-deny unknown channels.
3. Bind card identity and scope at host/view creation, then derive it main-side.
4. Enforce path containment and entity ownership again in the service that owns the invariant.
5. Treat provider secrets as opaque main-owned references, never renderer-round-tripped settings.

The main runtime-integrity weakness is ownership keyed too coarsely or cleared by the wrong
lifecycle: one controller per chat for multiple calls, barriers deleted before settlement, and
async selection results committed without an ownership token. Per-invocation/request identity
would simplify all three.

## Prioritized remediation plan

### Before any release or external test build

1. Deny unexpected main-frame navigation and validate external-open schemes.
2. Close P0-2 through P0-4: main-owned provider configuration, card-bound scope, and canonical
   plugin path containment.
3. Repair legacy JSON/session migration and prove it with an end-to-end fixture.
4. Upgrade `adm-zip` and add pre-materialization archive budgets.

### Before wider internal testing

5. Hold card execution until trust is resolved; enforce trust again in WCV main handlers.
6. Install default-deny WCV permission handlers.
7. Replace the shared generation-controller slot and settle barriers before deletion.
8. Close global log and world-asset manager exposure.
9. Add the rapid-chat-selection ownership guard.

### Before a release candidate

10. Repair save remapping and floor persistence error propagation.
11. Harden remote fetch redirects and streaming/aggregate limits.
12. Restore lint/docs as enforced CI gates and replace the `any` IPC declaration.
13. Remove retired workflow migrations and move combat presentation into localized renderer events.

## Verification ledger

| Command | Result |
| --- | --- |
| `npm.cmd run verify` | Pass: typecheck, dependency boundaries, 324 passing test files, 3,635 passing tests |
| `npm.cmd run check:docs` | Fail: 73 pre-existing broken local links |
| `eslint src test scripts --cache` | Fail: 25 errors, 1,461 warnings |
| `npm.cmd run lint` | Did not complete within four minutes in two attempts |
| `npm.cmd audit --omit=dev --json` | 2 high, 1 low; only the `adm-zip` path was proven reachable in production |
| `git diff --check` | Pass after the report and catalog edits |

The first `verify` attempt inside the restricted sandbox failed four tests that write to the
repository's configured `E:\tmp` test location. The same command passed when run with the required
filesystem permission; those initial failures were environmental, not product failures.

Post-report validation reran `git diff --check` successfully. `npm.cmd run check:docs` remained at
the existing 73-link failure baseline, and no new failure references this report or its catalog
entry.

## Residual limits

- No destructive deletion, credential exfiltration, camera/microphone request, private-network fetch,
  or memory-exhaustion proof was executed.
- No packaged installer, updater, or signed artifact was built.
- No live Electron accessibility, keyboard, resizing, or visual QA pass was performed.
- Dependency findings were promoted only when the vulnerable condition was reachable from a
  production import/extraction path.
