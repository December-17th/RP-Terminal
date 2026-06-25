# Card Script Surfaces — Implementation Plan (2026-06-25)

**Design / spec:** [docs/card-script-wcv-surfaces-design.md](../../card-script-wcv-surfaces-design.md)

> **STATUS (2026-06-25): Phases 1–4 DONE & verified in-app. Phase 5 (OAuth) DEFERRED.**
> Phases 1–3 landed as planned (runtime surface → WCV transport → button bus + modal), with the script host
> refactored to a **session-level invisible engine** (App.tsx, off-screen) rather than a panel. **Phase 4
> changed from the plan:** instead of auto-lifting the status regex into `panel_ui`, ST-compat card UIs
> default to inline regex and the user **promotes** a loader regex to a docked WCV panel (`renderMode:'panel'`)
> — see design §0. Extra fixes shipped: worldbook TH↔native entry mapper (`worldbookEntry`),
> `create/deleteWorldbookEntries`, script-scope vars, WCV `YAML` global, lorebook-editor live refresh.
> **Phase 5 (OAuth cloud login) is deferred** — the public-project workshop works without it; revisit if
> private-project sync / publishing is needed.

**Goal:** Make `【命定之诗】创意工坊` (and any full-page card script) work — a button above the input opens a
modal that downloads/syncs lorebook entries + regex — by routing card scripts to a process-isolated WCV on
the **canonical `thRuntime` stack**, and let cards carry their own docked-panel layout (`状态栏`), with no
per-card hardcoding.

**Architecture:** Card scripts move from the legacy `CardScriptHost` iframe (`bridgeShim`/`dispatch`/
`shims/tavern.ts`) to a new `CardScriptWcvHost` that runs them in a `WebContentsView` via the existing
`wcvManager` + `wcvPreload` shim over `createThRuntime`. The runtime gains the missing TH surface
(regex write, button bus, script-scope vars, a few getters); the WCV host (`wcvIpc`/`wcvHost`) backs them by
the existing services (`regexService`, `lorebookService`, `pluginService`). The card's `panel_ui` becomes the
import-time source of truth for docked panels (`StaticWorkspace`), replacing the hardcoded `wcv-*` views.

**Tech Stack:** TypeScript (strict), Vitest, electron-vite (renderer + preload + main), Zustand, Electron
`WebContentsView`.

## Global constraints

- Prettier: **no semicolons, single quotes, 2-space indent, printWidth 100, no trailing commas**.
- `any` is intentional at the card boundary (repo disables `@typescript-eslint/no-explicit-any`).
- `src/shared/thRuntime/**` imports **nothing realm-specific** (no `electron`/`window`/Zustand/`fs`).
- Clean-room: never copy/vendor JSR source. Reuse the canonical stack; **do not extend** the legacy
  `scriptApiService`/`dispatch`/`shims/tavern.ts` path (design §4g reuse map).
- Run `npm run typecheck`, `npm test`, `npm run build` before each task's commit; no new lint errors.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Design review — refinements the plan encodes

Verified against the code while reviewing the design; these correct/sharpen the doc:

1. **The event bus already exists.** `thRuntime/index.ts:38-44` has `on`/`emit`/`off`; host→script events flow
   via `host.onHostEvent` (`index.ts:63`). So the button bus is *only* `getButtonEvent` (identity) +
   `replaceScriptButtons` + a `host.setButtons` push + delivering the click as a host event — **not** a new bus.
2. **The WCV `ctx` is empty.** `wcvPreload.ts:160` uses a placeholder ctx; main resolves the session from
   `e.sender`. So `SillyTavern.getCurrentChatId()` **cannot** read `host.ctx.chatId` in the WCV transport — add a
   sync host getter `currentChatId()` backed by a `wcv-host-get-chat-id-sync` IPC (`contextFor(e.sender)`).
3. **Script-scope vars are correctness-critical, not cosmetic.** The workshop caches `creative_workshop_cache`
   via `getVariables({type:'script'})` / `updateVariablesWith(.., {type:'script'})`. Today `thRuntime` ignores
   the scope and writes `stat_data` (`index.ts:198`/`:246`) — that would **corrupt the character's variables**.
   Route `type:'script'` to a KV store (`pluginService.pluginStorage`, owner `card:<id>`), like the inline
   `TAVERN_SHIM` already does (`shims/tavern.ts:39`).
4. **Transport selection is per-card-script-HOST, not per-script.** All of a card's `tavern_helper.scripts`
   share one host frame. v1 routes the whole card-scripts host to the WCV. The per-message inline widgets
   (`MessageContent` → `InlineCardFrame`/`WcvMessageFrame`) are a **separate** path and are unchanged.
5. **Modal teardown can't use content-height.** The workshop overlay is `position:fixed; inset:0`, which
   contributes 0 to `scrollHeight` (the same trap that breaks the inline iframe). The full-window modal WCV
   isn't content-sized; instead a `wcvPreload` `MutationObserver` reports `hasOverlay` (body has a visible
   fixed/absolute element child) → host shows on click, hides when `hasOverlay`→false.
6. **WCV inventory (per active card): up to two.** (a) a hidden **script-host WCV** that runs the card's
   scripts and becomes the full-window modal; (b) a **status-panel WCV** loading `status/index.html` in a
   `panel_ui` slot. Distinct views, distinct lifecycles.
7. **No new host method for the name.** `getCurrentCharacterName` derives from `host.charData()?.name`.
8. **Nit:** the design doc's §4f (Network+OAuth) sits after §4g/§4h — cosmetic ordering only.

**Open risk to check in Phase 2:** the card bundles `【命定之诗】MVU beta` (imports the real MagVarUpdate
bundle). RPT runs the MVU update pipeline **natively** (`mvuParser`); running the card's MVU script in the WCV
could double-run the update engine. Verify and, if needed, keep MVU-engine scripts off (RPT's native fold
already covers it) while still running the UI/workshop scripts.

---

## Phase 1 — Runtime surface + host bridge (foundation, no UI)

Unblocks both transports; fully unit-testable. **Touches the card-facing surface → update SDK docs in this
phase** (`docs/sdk/component-inventory.md` §2, `docs/rpt-api.md`).

- [ ] **T1.1 — `Host` interface additions** (`src/shared/thRuntime/types.ts`): `regexesFull(option): TavernRegex[]`
  (sync), `replaceRegexes(regexes, option): Promise<void>`, `isCharacterRegexesEnabled(): boolean`,
  `currentChatId(): string` (sync), `getScriptVars(): Record<string,any>` (sync) + `setScriptVars(obj): Promise<void>`,
  `setButtons(buttons: {name:string;visible:boolean}[]): void`.
- [ ] **T1.2 — Pure TH-regex shape module** `src/shared/thRuntime/tavernRegex.ts`: map our store rule
  (`RenderRegexRule`) ↔ TH `TavernRegex` (id/script_name/find_regex/replace_string/source/destination/…).
  Round-trippable. Pure (no realm imports). Unit-tested.
- [ ] **T1.3 — `thRuntime/index.ts` surface** : `getCurrentCharacterName` (from `charData().name`),
  `SillyTavern.getCurrentChatId = () => host.currentChatId()` (+ `getCurrentCharacterId` from `ctx`/charData),
  `isCharacterTavernRegexesEnabled`, `getTavernRegexes(option) → host.regexesFull(option)`,
  `updateTavernRegexesWith(updater, option)` + `replaceTavernRegexes(regexes, option) → host.replaceRegexes`,
  `getScriptId` (per-frame constant), `getButtonEvent(name) = String(name)`,
  `replaceScriptButtons`/`getScriptButtons`/`appendInexistentScriptButtons`/`updateScriptButtonsWith` →
  `host.setButtons`; and **script-scope** in `getVariables`/`setVariables`/`updateVariablesWith`: when
  `opt.type==='script'` use `host.getScriptVars()`/`setScriptVars()` instead of `stat`.
- [ ] **T1.4 — WCV host adapter** (`src/preload/wcvHost.ts`) + IPC (`src/main/ipc/wcvIpc.ts`):
  `wcv-host-get-regexes-full(option)` (sync, via `regexService.getAllRules` + shape map),
  `wcv-host-replace-regexes(regexes, option)` (→ `regexService` `updateRule`/`saveRegexScript`/`deleteScript`/
  `setScriptDisabled`; **debounced reload**), `wcv-host-is-char-regex-enabled` (sync),
  `wcv-host-get-chat-id-sync` (sync, `contextFor(e.sender).chatId`),
  `wcv-host-script-vars` get/set (→ `pluginService.pluginStorage`, owner `card:<characterId>`).
- [ ] **T1.5 — Inline host adapter parity** (`src/renderer/src/cardBridge/host.ts`): implement the same new
  methods over `window.api` (regex via `scriptRegex*`/a new write IPC, script vars via `pluginStorage`) so both
  transports stay at parity (CLAUDE.md). `setButtons` no-ops inline (cards run in WCV) or feeds `toolbarStore`.
- [ ] **T1.6 — Tests**: `tavernRegex` round-trip; `getTavernRegexes(option)` filtering; script-scope routing
  (writes land in the KV store, **not** `stat_data`); `updateTavernRegexesWith` applies via the shape map.
- [ ] **T1.7 — SDK docs**: add the new surface to `component-inventory.md` §2 + `rpt-api.md`.

**Exit:** a unit-tested runtime where `getTavernRegexes`/`updateTavernRegexesWith`/`isCharacterTavernRegexesEnabled`/
`getCurrentChatId`/`getCurrentCharacterName`/`getScriptId`/script-scope vars/`replaceScriptButtons` all resolve.

## Phase 2 — Script-host WCV transport

- [ ] **T2.1 — `CardScriptWcvHost.tsx`** (new): build a card doc (`buildCardDoc` + `buildWcvLibTags`, like
  `WcvMessageFrame`) embedding the merged `get-runtime-scripts` as `<script type="module">`; ensure a **hidden**
  WCV via `wcvManager` (served from `rpt-card://`), passing `{profileId, chatId, characterId}`. Remote imports
  load natively (real Chromium page — no `data:` inlining). Grant-gated by the existing `trusted`/`remoteScripts`
  consent.
- [ ] **T2.2 — Route the card-scripts panel** (`viewRegistry.tsx` `CardScriptsPanel`) to `CardScriptWcvHost`
  when the card has scripts; reuse the `ConsentCardView`-style gate. Keep `CardScriptHost` for the plugin path /
  fallback; do not port its event forwarding (App.tsx already broadcasts to WCVs — design §4g).
- [ ] **T2.3 — MVU interaction check** (the open risk): confirm RPT's native `mvuParser` still owns the fold;
  ensure the card's MVU-engine script doesn't double-run (keep it off if so; UI/workshop scripts still run).
- [ ] **T2.4 — Verify** scripts receive `tavern_events` (generation/message/mvu) via the existing
  `wcvBroadcastEvent` path.

**Exit:** the card's scripts run out-of-process; background logic + `eventOn(tavern_events.*)` work. (Button
visible after Phase 3.)

## Phase 3 — Button bus + modal (创意工坊 end-to-end, minus OAuth)

- [ ] **T3.1 — `wcvPreload` button bridge**: `host.setButtons` → `ipcRenderer.send('wcv-register-button', …)`;
  `ipcRenderer.on('wcv-button-click', (name) => onHostEvent(name))` so the runtime `emit(getButtonEvent(name))`
  reaches the script's `eventOn`.
- [ ] **T3.2 — main/renderer toolbar feed** (`wcvIpc.ts` + `wcvManager.ts` + `toolbarStore`): `wcv-register-button`
  → `mainWindow.webContents.send('wcv-buttons', {slotId, buttons})` → renderer pushes to `toolbarStore`
  (deduped `card:<id>::<name>`, cleared on WCV destroy). The toolbar button's `onClick` →
  `window.api.wcvButtonClick(slotId, name)` → `wcvManager.notifyEvent(chatId, name)`.
- [ ] **T3.3 — Modal presentation** (`wcvManager.ts` + `wcvPreload.ts`): the script-host WCV starts hidden
  (`setVisible(false)`, offscreen/zero-bounds). On button-click → `setBounds(window content rect)` +
  `setVisible(true)`. A `wcvPreload` `MutationObserver` reports `hasOverlay` (body has a visible fixed/absolute
  child); `hasOverlay`→false → host `setVisible(false)`. Window-resize re-bounds while visible.
- [ ] **T3.4 — Tests**: button dedupe/clear-on-teardown; `hasOverlay` show/hide transitions (pure logic).

**Exit:** the `命定创意工坊` button opens the modal; browse → download/sync writes worldbook (existing bridge)
+ regex (Phase 1) into the card's book.

## Phase 4 — Card-carried static layout + import transform

- [ ] **T4.1 — Import transform** (`characterService.ts`, pure helper + test): detect the status-loader regex
  (`placement:[2]`, replacement `.load('…/status/index.html')`) → synthesize a `panel_ui` `wcv` slot
  (`view:'wcv'`, `entry`, `rect`, `title:'状态栏'`) and **skip** it as a display regex. `首页`/`自定义开局`
  loaders (different URLs) are untouched → stay inline.
- [ ] **T4.2 — Import summary**: `summarizeCardBundle` (`:157`) reports panel count/layout → "Layout: N panels"
  in the import confirm.
- [ ] **T4.3 — Workspace switch**: when the active card has `panel_ui`, render `StaticWorkspace` (static-locked);
  a `wcv` slot mounts `WcvPanel` with the slot's `entry`. Cards without `panel_ui` keep the resizable workspace.
- [ ] **T4.4 — Retire hardcodes**: drop `wcv-card`/`wcv-home`/`wcv-start` from `viewRegistry.tsx` and the
  `命定之诗` URLs/wrappers in `WcvPanel.tsx` (keep the `WcvPanel` component + `DEFAULT_STATIC_LAYOUT` as a generic).
- [ ] **T4.5 — Tests**: regex→`panel_ui` synthesis (status matched; home/custom_start not); workspace selection.

**Exit:** `状态栏` renders as a docked WCV panel declared by the card; onboarding stays inline; no hardcoded
card URLs remain.

## Phase 5 — OAuth window-open (deferred, highest risk)

- [ ] **T5.1 — `setWindowOpenHandler` on the card WCV** (`wcvManager.ts`): allow the workshop's OAuth popup as a
  child window with `opener`, relay its `postMessage` back to the workshop. Gate behind the trusted-card consent.
- [ ] **T5.2 — Verify** the login round-trip (popup → callback → `addEventListener('message')`).

**Exit:** cloud login completes; authenticated sync works.

---

## Sequencing & milestones

- **M1 = Phases 1–3:** `创意工坊` works for download/sync (public projects), the headline fix.
- **M2 = Phase 4:** the generalized card-carried panel layout; `状态栏` becomes a card-declared panel; hardcodes gone.
- **M3 = Phase 5:** OAuth/cloud login.

Phases 1→4 are strictly ordered (3 needs 1+2; 4 is independent of 3 and may land in parallel). 5 is last.

## Out of scope / deferred

- `registerScriptPanel` (dynamic, script-registered panels) — design §4b, dynamic only.
- User-resizable card layouts (static-locked in v1; resize + "reset to card layout" later).
- A general per-card surface registry beyond `panel_ui` + `replaceScriptButtons`.
- Vendoring/caching remote card assets (still loaded from jsDelivr behind consent).
- Retiring the legacy `CardScriptHost`/`dispatch`/`shims/tavern.ts` for plugins (out of this scope).

## Risks

- **OAuth postMessage relay** (Phase 5) — child-window `opener` + cross-window `postMessage` in a WCV is the
  least-certain piece; M1/M2 ship without it.
- **MVU double-run** (Phase 2 T2.3) — native fold vs the card's MVU-engine script.
- **Modal teardown heuristic** (Phase 3 T3.3) — the `hasOverlay` MutationObserver must not flap; add a small
  debounce and a `closeSurface()` escape hatch.
- **Regex-write chat reload** — `replaceTavernRegexes` reloads chat; debounce + guard against thrash (design §6).
