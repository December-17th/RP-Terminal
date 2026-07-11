# RP Terminal — Progress Log

> **Canonical changelog = git history.** This is a curated, non-exhaustive highlights log; use
> `git log` for the authoritative record and the design/plan docs under `docs/` for forward-looking work.

Running status of the MVU / panel-workspace track. Newest first.

## 2026-07-11

**Agentic plot-recall memory (branch `feat/plot-recall`, WP1–WP8).** An LLM-selected pre-turn recall
layer over the existing SQL-table memory + a per-chat prose notes corpus. Design +
as-built deviations: `docs/plot-recall-memory-design.md` (§As-built); plan
`.scratch/plot-recall/plan-2026-07-10.md`. Ships **inert** — opt-in is wiring the example workflow, no
settings flag, no pack. What landed, one line per WP:

- **WP1 — `notesGrep.ts` pure engine.** `src/shared/memory/notesGrep.ts`: section parse (`##`
  headings + optional `<!-- keywords -->`), CJK-safe grep (word-boundary for Latin, substring fallback
  for CJK; bad regex → literal, never throws), `formatHits`, `mergeNotes` (append/replace upsert).
- **WP2 — per-chat notes store + IPC.** `notesMemoryService.ts` (`profiles/<id>/chat-notes/<chatId>.md`,
  atomic write; cleaned up on `deleteChat`); IPC surfaced as `window.api.notesGet`/`notesSet`.
- **WP3 — pure recall helpers.** `renderCatalog` (纪要索引 catalogue, gated on `enabled &&
  extraIndexEnabled`), `filterEntriesByCodes` (exact-key, `MT001` ≠ `MT0012`, capped), and
  `codeColumnOf` in `src/shared/memory/codeColumn.ts` (its own structural type — shared imports no
  main/renderer types).
- **WP4 — `memory.recall` node.** `recallNodes.ts`: catalogue + notes TOC → one side LLM call → parse
  `<Recall>`/`<Query>`/`<QuestPlan>`/`<StoryEngine>` → deterministic code-fetch + notes grep → one
  tail `block`; plan persisted in node state (rewind-stale discard). No corpus → zero model calls.
  **Fail-open is return-based** (caught in `run()`, `NodeError` on `error`) so the pre-phase turn never
  aborts.
- **WP5 — prompts + chronicle template + example workflow.** `defaultRecallPrompts.ts` (zh, adapted
  from the reference stage-3 task, `AM`→`MT`, `<Recall_format>` bands scaled to `max_rows` 24);
  `docs/workflows/plot-recall-chronicle.chatsheets.json` (MT-coded 纪要 template);
  `docs/workflows/plot-recall.rptflow` + trace-equivalence test.
- **WP6 — `notes.maintain` node.** `notesNodes.ts`: post-turn maintainer parsing
  `<MemoryNote section= mode=append|replace>` (attribute-aware tag extractor beside `extractTagAll`)
  → `mergeNotes` → `writeNotes`; prose-only discipline; no-op when idle.
- **WP7 — UI.** Notes tab in the Memory Manager (textarea bound to `notesGet`/`notesSet`, explicit
  Save/Reset) + an MT-code badge on the Memory Manager row cards and the workspace Tables view (code
  column derived via `codeColumnOf`; also visible in the editor Data tab). i18n keys in `en.ts`+`zh.ts`.
- **WP8 — docs + closeout.** This entry; `plot-recall-memory-design.md` → Implemented (v1) + as-built
  deviations; `grep-notes-memory-design.md` marked partially superseded; the two new builtin nodes +
  the `plot-recall.rptflow` example inventoried in `docs/sdk/workflow-module-format.md`.

**Open (owner in-app pass):** the example doc's state trigger still watches the `summary` table
(chronicle-only setups repoint it); `<Recall_format>` band feel at `max_rows` 24; visual check of the
Notes tab + MT badges.

## 2026-07-02

- **WS-3 variable write-back loop — architectural fix LANDED (origin tag).** The self-feedback loop
  (`docs/structural-cleanup-log-2026-06-26.md` Stage 13/15) is now closed at the source, faithfully to real
  MVU, retiring the heuristic to a mere backstop. Root cause: `shared/thRuntime` `onVarsChanged` fired
  `mag_variable_update_*` + `MESSAGE_UPDATED` on **every** `stat_data` change — including a card's own write
  echoed back — so a card writing a constantly-changing value on its own `mag_variable_update_ended`
  (命定之诗's remote automation writing a world-clock/`date`) self-looped: write → echo → event → write → …
  until the `LOOP_MAX=40` guard tripped, **persisting corrupted intermediate values** first (owner saw the
  panel value churning + `variable write-back — floor N: date` spam).
  - **Fix:** tag every `stat_data` change with an **origin** (`model-fold` | `card-write` | `external`)
    end-to-end and fire MVU/`MESSAGE_UPDATED` **only for non-`card-write`** origins; a card-write still
    refreshes the runtime cache (so `getvar`/EJS see it) but fires no events. Matches MIT MagVarUpdate
    (events only on the AI fold, never on programmatic writes). Since 命定之诗 loads the **real** MVU/FrontEnd
    remotely, faithful semantics help it — defusing the prior-revert risk that kept this deferred.
  - **Threaded through:** `shared/thRuntime/types.ts` (`VarsOrigin` + `onVarsChanged(sd, { origin })`),
    `shared/thRuntime/index.ts` (branch), `chatStore.lastVarsOrigin` (set at every floors mutation; only
    `applyVariableOps` + `setLatestFloorVariables` are `card-write`), inline `cardBridge/host.ts`
    subscription, and the WCV path (`App.tsx` → `preload` → `wcvManager.notifyVarsChanged(origin)` →
    `wcvIpc` `wcv-broadcast-vars` / `wcv-host-apply-vars` / `-set-vars` → `wcvHost.ts`). The **indirect**
    echo (host `pushHostVars` → `setLatestFloorVariables` → `wcv-broadcast-vars`) was the actual loop path
    and is now tagged `card-write`. `LOOP_MAX` + no-op guard retained as backstops (`generation/varsWrite.ts`).
  - **Tests:** `test/thRuntime.test.ts` adds a card-write-origin case (cache refreshes, no events) + a
    fold-origin case. **In-app verified (owner, 2026-07-02):** one round on 命定之诗 → `runaway loop` count 0,
    `date` write-back settled at 2 (distinct fold events) then quiet — vs the old ~40-line spam. Residual to
    watch: a *sibling* WCV panel now refreshes its cache but won't get `mag_*` for another slot's programmatic
    write until the next fold (faithful MVU; native host panels still update via `pushHostVars`).

## 2026-06-26

- **Structural & maintainability review + plan (branch `refactor/structural-cleanup-2026-06-26`).** Whole-
  codebase review: [codebase-structural-review-2026-06-26.md](codebase-structural-review-2026-06-26.md)
  (diagnosis, 9 ranked findings WS-1..WS-9 + per-file notes) and
  [maintainability-plan-2026-06-26.md](maintainability-plan-2026-06-26.md) (sequenced treatment).
  Headline: the `Host`-seam two-transport design **resolved** the old dual-card-host risk, but the EJS
  _engine_ is now shared while its _context_ is hand-built 3 divergent ways (WS-1, HIGH) — the keystone fix.
  Other HIGH: the write-back-loop heuristic should be replaced by origin-tagging (WS-3). MED: decompose
  `buildPrompt` (WS-5), de-escalate L1 cache (WS-2), lodash-out-of-string (WS-4), one broadcast helper
  (WS-7). LOW: delete dead schema (WS-6), document path dialects (WS-8) + error policy (WS-9). Supersedes
  [maintainability-plan.md](maintainability-plan.md) (2026-06-22).

- **⚠️ GAP — prompt-build EJS can't run async / `TavernHelper`-using lorebook entries.** The 命定之诗 card
  has constant lorebook entries written as ST-Prompt-Template scriptlets that call the **TavernHelper API**
  and use **`await`**, e.g. `命定系统-艾莉亚核心`:
  `const userName = await TavernHelper.triggerSlash('/pass {{user}}')` (an async initializer that seeds
  `stat_data.关系列表`). RP Terminal's main-process prompt-build engine (`shared/templateEngine`) is
  **synchronous** (compiles each template into a sync IIFE, so `await` → `SyntaxError: expecting ';'`) and
  its bridge exposes getvar/setvar/`_`/faker but **not `TavernHelper`**. Git confirms neither was ever
  present (engine extracted 2026-06-22 `81e5f92`; no `evalCodeAsync`, no `TavernHelper` ever) — so these
  entries NEVER rendered in the prompt; the failure was just **silent** until the 2026-06-26 naming
  diagnostic (`5927369`/`fd3b29a`) surfaced it. The card UI (WCV) renders them fine because there it has
  **real lodash + TavernHelper + async**. ST-Prompt-Template itself runs in the browser with TavernHelper
  and supports async, so a faithful reimplementation eventually should too — but that needs (a) async EJS
  eval (`evalCodeAsync` + pending-job pump) and (b) a TavernHelper surface reachable from the main-process
  builder (architecturally heavy: TavernHelper is renderer-side, and `triggerSlash`/`generate` during
  prompt assembly invite re-entrancy/side-effects). **For now: out-of-contract.** Such async/side-effecting
  init belongs in a card SCRIPT (WCV runtime), not a prompt-injected lorebook entry. Pure-lodash display
  entries (e.g. `status_current_variables`) DO work now that the `_` subset gained `cloneDeep` + the common
  methods (`9ce2ebe`/`b28157b`). See [rpt-api.md](rpt-api.md) EJS surface + [compat-comparison.md](compat-comparison.md).

- **⚠️ TECH DEBT — WCV variable write-back loop is contained by a heuristic, not properly fixed.** A card
  (命定之诗) that writes a constantly-CHANGING value (a `date` clock) on its own `mag_variable_update_ended`
  self-loops: write → broadcast → echo → event → write → … forever. The saga + final state:
  - Tried, insufficient: WCV exclude-sender on the direct echo (`notifyVarsChanged(…, e.sender.id)`);
    a value-diff guard in the shared runtime `onVarsChanged`; a source-side **no-op** guard in
    `applyVariableOps`. None stop a _changing_ value, and the echo also returns via the INDIRECT path
    (host floor update → `wcv-broadcast-vars`), so byte-diffs don't survive the round-trip.
  - Tried, REVERTED: suppressing MVU events for the card's own writes (compare echo vs live `stat`).
    It broke cards that **chain initialization through their own update events** — and the prompt-side
    EJS injection reads those vars, so injection went empty. MVU semantics here are unverified (does a
    programmatic `insertOrAssignVariables` fire `mag_variable_update_*` in real MVU? we assumed yes).
  - **Current band-aid (`b01f836`):** self-write events fire again; `applyVariableOps` drops a write once
    the SAME changed-path **signature** repeats `LOOP_MAX=25` times within `LOOP_WINDOW_MS=400ms`.
  - **Why it needs a real fix:** the thresholds are guesses — a loop slower than 400 ms isn't caught, and a
    legitimate rapid same-path animation (≤25 writes is fine, more would be falsely dropped) is at risk.
    The root cause is architectural: a card-initiated write is echoed back to its author as an MVU event
    via two paths. A proper fix would **tag the change source** (model-fold vs card-write) end-to-end and
    fire `mag_variable_update_*` only on model/external folds, removing the need to guess — but that
    requires confirming real-MVU event semantics first. See the loop-guard note in
    [rpt-api.md](rpt-api.md) (Host↔card section).
  - **RESOLVED (spike, 2026-06-26, WS-3):** confirmed against the MIT MagVarUpdate source — real MVU fires
    `mag_variable_update_*` **only on the AI-message fold** (`updateVariables` ← `handleVariablesInMessage`),
    **NOT** on programmatic card writes (`setMvuVariable`/`insertOrAssignVariables` are pure helpers). We had
    "assumed yes"; the answer is **no**. So the origin-tag fix above IS faithful to real MVU. Implementation
    still **deferred** (live-pipeline behavior change + the prior revert risk → needs in-app verify against
    命定之诗). Full spike writeup: [structural-cleanup-log-2026-06-26.md](structural-cleanup-log-2026-06-26.md)
    Stage 13.

- **命定之诗 combat extension — card-side complete (branch `feat/poem-combat-extension`).** A card-side
  mod that imports the party from MVU `stat_data` and resolves combat with the card's own `<战斗协议>`
  (层级-d20), co-developed with the app combat SDK. Design:
  [combat-poem-of-destiny-expansion.md](combat-poem-of-destiny-expansion.md); plan:
  [plans/2026-06-25-poem-combat-extension.md](superpowers/plans/2026-06-25-poem-combat-extension.md);
  manual tests: [combat-poem-manual-tests.md](combat-poem-manual-tests.md).
  - **Engine/SDK:** `stat_map`/`derive` bundle fields + an `ext` bag on combatants/abilities;
    `parseCardItem` (incl. `scanEffectProse` for the card's flavor-keyed effect prose) +
    `buildEncounterFromMvu`; the `<战斗协议>` resolver on the `resolveAction` seam
    (`getSystem`/`runHookFor`); 百分比 伤害增幅, 护盾, healing (治疗 / 治疗增幅).
  - **Owner decisions:** enemies via **channel A1** — a JSON roster in the `<rpt-combat-start>` body
    (static bundle `enemies` fallback); item-format compat = **scan prose + lorebook tighten**
    (`<战斗数据规范>`); combat sheet = **standalone regex** (option A, parchment `<战斗状态栏/>`); the
    **binary mode choice** (AI-decided vs combat-system) is **lorebook-driven** (`<战斗启动协议>` + a
    `<战斗协议>` gate); combat mode **does not reshape the workspace layout** (removed the combat seed).
  - **Lorebook applied to the card** via [patch-poem-card.cjs](sdk/examples/patch-poem-card.cjs) →
    `v4.2.1+combat.png` (combat bundle + 战斗启动协议 + 战斗协议 gate + 战斗数据规范).
  - **Lifecycle/UX:** re-roll/swipe clears the encounter; always-available **Quit combat** → back to chat
    (AI-narrated); no-viable-party guard; empty-body lorebook fix; the **variable write-back loop** fixed
    app-side (value-diff guard in the shared runtime + WCV exclude-sender).
  - **Remaining:** per-encounter narration cadence chooser (app UI); end-of-combat fold-back verify
    (in-app); deferred depth (typed-damage / 集群 / 意图·部位 / 战意 / revive) + the creative-input box.

## 2026-06-25

- **Local grid combat system — built end-to-end (branch `feat/combat-system`, P1–P7 + P8-partial; 71
  combat unit tests, 640 total).** A player-played, turn-based, square-grid d20 engine; the engine owns
  every number (seeded, deterministic, resumable), the AI only narrates + referees. Design:
  [combat-system-design.md](combat-system-design.md); plan + per-phase status:
  [plans/2026-06-25-combat-system.md](superpowers/plans/2026-06-25-combat-system.md).
  - **Pure engine** (`src/shared/combat/`): `types`, `dice` (seeded mulberry32 + d20 adv/dis/crit +
    `rollExpr`/`averageExpr`), `grid` (Chebyshev distance, Dijkstra movement, burst/line/cone/aura AoE,
    `lineOfSight`), `resolver` (native d20: attack-vs-AC, saves, typed damage + resist/vuln, conditions,
    death), `engine` (d20 initiative, turn advance, victory, `applyAction` + the card-override seam),
    `policy` (weighted enemy AI), `hooks` (`RunHook` seam), `serialize` (AI prompts/result parsing),
    `bundle` (`buildEncounter`: card bundle + cue → encounter).
  - **Main**: `combatService` (orchestration + `combat_encounters` persistence + sandbox-backed hooks +
    `adjudicate`/`narrate`/`startFromCard`), `combatIpc`, `window.api.combat*`.
  - **Renderer**: native `CombatView` + `combatStore`; Combat FSM mode seeds a combat layout; ChatView
    shows an **Enter Combat** banner when a turn carries a `combat_cue`.
  - **AI touchpoints**: `<rpt-combat-start>` cue (detected in `generate()`, tag hidden at view time),
    `<rpt-combat-result>` adjudication of out-of-system actions, end-of-combat narration, and an `ai`
    enemy controller (weighted fallback) — all over `generateRaw`, so `generate()` is untouched.
  - **Card surface**: `extensions.rp_terminal.combat` tightened into a permissive `CombatBundleSchema`;
    SDK docs updated ([sdk/component-inventory.md](sdk/component-inventory.md) §8/§8a, [rpt-api.md](rpt-api.md) §4).
  - **As-built deltas**: coarse `resolveAction` hook (not the granular §5 names — reserved); encounter in
    a new `combat_encounters` table (not `rpg_entities`); per-action RNG from `(seed, rngCursor)`.
  - **Not verified in-app**: the renderer UI + live AI calls pass typecheck/build but need the running
    app + a provider to exercise. 命定之诗's actual combat content is owner-authored against the schema.
  - **Deferred (P8)**: cover, opportunity attacks/reactions, flanking, hex grid, smarter policy; the
    granular resolver hooks; narration-as-a-chat-floor (currently returned prose / available via prompt).

## 2026-06-22

- **WCV card-UI productionization (#1–#5).** Card write-back (optimistic mirror + `replaceMvuData` via a
  `wcv-host-set-vars` IPC); shim cleanup (DEBUG-gated logs, real `getChatMessages`); hardening (CSP
  locking `connect-src` to jsDelivr, per-card click-to-consent, trust-model docs; full
  `contextIsolation:true` deferred — needs a host-page refactor); the static card-determined workspace
  (`RPTerminalExtSchema.panel_ui` grid + `StaticWorkspace`); and the card's OTHER frontends integrated —
  the shim grew `window.Vue`/`VueRouter`/`Pinia` + `getTavernHelperVersion`/`extensionSettings`/
  `waitGlobalInitialized`.
- **Full onboarding loop works end-to-end (verified).** `home` launcher renders; `custom_start` (character
  creation) runs; its finish INJECTS a starting prompt into RP Terminal's input box (new composer-injection
  bridge: `rptHost.setInput` → `wcv-host-input` → `composerStore` → the Composer) → the player sends → the
  AI fills the MVU vars → the status UI shows them.
- **MVU `op:delta`** (increment) so EXP/MP-style updates apply; live model→card broadcast on floor change.
- **API settings: fetch + select models** — a provider-aware `GET /models` (a "Fetch models" button + a
  model dropdown), `apiService.listModels` + `list-models` IPC.
- **Worldbook + ST-chat compat (Track C0).** Sync worldbook NAME getters (`getCharWorldbookNames` via
  `sendSync` — cards call them WITHOUT await) + `getWorldbook`/`updateWorldbookWith` over the file-based
  `lorebookService` (card book at `id==characterId`, resolved from the chat row); `SillyTavern.chat[]`
  - `swipes`/`saveChat`/`reloadCurrentChat` so the home's "start game" picks a greeting swipe (floor-0
    swipes = `first_mes` + `alternate_greetings`); `saveChat` re-folds the scenario's `<UpdateVariable>`.
    `getTavernHelperVersion` ≥ the card's minimum (4.3.17).
- **MVU `add /-` fix** — RFC-6902 array-append now creates an ARRAY (not `{ "-": … }`) so `主角.身份`/`职业`
  pass the card's Zod schema (+test).
- **Inline frontend cards = the WCV compat layer.** `MessageContent` routes a card's regex-injected
  SCRIPTED block to `WcvMessageFrame` (wrap → `data:` URL → out-of-process WCV + shim), card-agnostic;
  the overlay is clamped to its scroll container so it can't paint over the composer.
- **API-key masking (the retained security measure).** The renderer never sees a full key after first
  entry — `maskedSettings` + retain-on-save in `settingsService`, masked `get-settings`, `ApiSettingsPanel`
  masked-field + Replace, `list-models` resolves the real key in main. Broad security hardening DEFERRED
  (owner decision).
- **Codebase review + doc-drift fixes.** Flagged the TWO parallel frontend-card compat layers (iframe
  sandbox vs WCV) + the WCV threat model as the fork to resolve; fixed ROADMAP drift (Phase E tests,
  `<%%>`/C1, the lorebook script-API status, the frontend-card path). 273 tests.
- **Assessment — script lorebook mutation:** ✅ on the iframe rpt/TH path (`rpt.lore.get/set` + TH
  `replaceWorldbookEntries` → `scriptApiService.setWorldbookEntries` → `saveLorebookById`, gated by
  `worldbook:read/write`) — add/remove/edit/toggle via read-modify-write. The Track C0 WCV trusted-card
  bridge is read + **toggle only** (write-back applies `enabled`); extend `wcv-host-replace-worldbook`
  for parity.
- Remaining: the AUTO-onboarding overlay (`home`→`custom_start` on a new chat, then dismiss into play); the
  auto-start finish alternative (wire `createChat`/`triggerSlash` to the session system); the status UI's
  outer (edit/settings) layer.

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
- **Variable write-back bridge** (`applyVariableOps`, commit `c4f334a`): panel UI / scripts can now
  MODIFY message variables (JSONPatch ops → the same `applyJsonPatch` engine the model uses →
  persisted), not just display them.
- **Card-custom-UI investigation + decisions** (`docs/card-custom-ui-design.md`): two import modes
  (native config vs script-embedded UI); the StatusMenuBuilder format (AGPL, declarative); the
  iframe/webview/WebContentsView comparison. Decisions: frame model = **WebContentsView, static
  card-determined layout**; manual/panel edits **transient** (Re-evaluate resets to model state);
  inline-message beautification UI is an **iframe** (not WCV) and **read-only in history**; the
  center stays native chat.
- **WebContentsView spike (verified on hardware).** `wcvManager` overlays an out-of-process
  WebContentsView on a panel (commit `6b488f4`); a locked-down `wcvPreload` (`window.rptHost`) +
  per-slot session context give the card page a host bridge that READS the latest floor's
  `stat_data` and WRITES it back through `applyVariableOps`, pushing the result so native panels stay
  in sync (commit `856394c`). Round-trip confirmed live: a button in the WCV page increments a
  counter shown in the native RPG Status panel, persisted across restart.
- **命定之诗's REAL frontend runs in a WCV (verified end-to-end).** Loaded its React ESM status UI from
  jsDelivr into the card panel and grew `wcvPreload` into a starter ST/TavernHelper/Mvu shim: the libs it
  externalizes as globals (lodash `_`, Zod `z`, jQuery `$` lazy-required, `toastr`), the ST/Mvu surface
  (`SillyTavern.getContext`/`substituteParams`, a thin `window.Mvu`, `getVariables` returning the
  `{stat_data}` wrapper, `getCurrentMessageId`), a SYNCHRONOUS stat_data mirror (sendSync init + push on
  change, since MVU getters are sync), and a missing-API logger. Key fixes: force `text/html` on jsDelivr
  `.html` (it serves text/plain, so the page rendered as raw text); lazy-require jQuery (it probes the DOM
  at import → crashed the preload). The card's own UI renders real `stat_data` and refreshes LIVE on a
  model turn (it re-reads `getVariables` on its own trigger; the host broadcasts new state on every floor
  change → `notifyVarsChanged`). Also added the MVU `op:delta` increment so EXP/MP-style updates apply.

### Architecture state

- State source of truth = `floor.variables.stat_data` (MVU tree). Read by `StatView`/`LayoutRenderer`;
  written by the model (`<UpdateVariable>`) AND now by panel UI / scripts / WebContentsView card pages
  via the `apply-variable-ops` bridge (the `pluginVars` path also persists message-scope writes).
- Generation is main-side; the renderer is a thin UI over IPC. **WebContentsView gives true process
  isolation** — the iframe-same-process freeze that shelved frontend cards does not apply to it — so
  it's the chosen path for embedding a card's own (e.g. Vue) UI in a static panel.

### Next / open

- **WCV card UI — productionize** (the spike runs the real card UI live). Remaining: test the card's
  WRITE path (its interactive controls → `apply-variable-ops`); harden — it's TRUSTED-CARD only now
  (`contextIsolation:false`, remote jsDelivr load, the page gets `rptHost`), so production needs vendored
  assets + CSP + per-card consent; fill the shim stubs (lorebook / generate / getChatMessages) as cards
  need them; the static card-determined workspace; and the card's OTHER frontends (character-creation +
  the external MVU framework).
- **Inline frames read-only in history** (decided, deferred): thread the floor id through
  `ChatView → MessageContent → MessageScriptFrame`, deny writes + snapshot reads on non-latest floors.
- **Phase 2 native MVU view kit** (Option 1) — deprioritized vs the custom-frontend/WCV path, but
  still the safe default renderer for declarative StatusMenuBuilder-style cards.
- **Static card-UI workspace** (`StaticWorkspace` + card-declared grid) — the production home for WCV
  panels once the shim proves out.
