# RP Terminal — Card SDK Component Inventory

> **Living document, v0.1 (started 2026-06-24).** A catalog of the building blocks that make up
> RP Terminal's "card SDK" — what a card can *call*, the environment it *runs in*, the *format* it is
> stored as, and how an existing **SillyTavern / TavernHelper card is transformed** into that format.
> This is the seed of the `docs/sdk/` set; it is **not exhaustive** and is meant to grow. See
> [README.md](README.md) for the maintenance contract.

Status legend: ✅ built · 🟡 partial · 🔁 graceful stub (logs / safe default) · ⬜ planned

Every claim below cites the file it was verified against (per `CLAUDE.md` grounding). When you change one
of those files, update the matching row here in the same change.

---

## 0. The big picture — do we have a "card standard"?

**Effectively yes, and it is ST-compatible by construction.** RP Terminal does *not* invent a new card
spec string. A card is a SillyTavern **`chara_card_v3`** object whose RP-Terminal-specific payload rides
entirely under **`data.extensions.rp_terminal`** (verified [character.ts:130](../../src/main/types/character.ts)).
SillyTavern reads the prose / lorebook / regex and ignores our namespace; we read everything. So:

- **The "format" = `chara_card_v3` + the `rp_terminal` extension namespace.** Already implemented and
  versioned (`RPTerminalCardSchema`, normalized to `chara_card_v3`).
- **The "container" = a PNG cartridge.** The direction you're leaning toward — *store all scripts, regex,
  preset and per-card customizations in a PNG* — is already the documented **World Card** plan
  ([world-card-design.md](../world-card-design.md) §3, §8). The card's bundle (scripts/regex/presets/
  lorebooks/UI/theme/combat/agent) is plain text under `extensions.rp_terminal`, embeddable in the PNG's
  `chara`/`ccv3` text chunk; binary assets go in an appended ZIP. See §6 below.
- **The "transform" = lossless import + route + best-effort JS.** See §5.

The practical takeaway: you are not greenfield. The standard exists in code; what's unfinished is (a)
formally *blessing* `v3 + rp_terminal` as **the** standard, and (b) finishing the PNG cartridge
(compressed-`iTXt` read + appended-ZIP) and the lossless import routing.

---

## 1. SDK layers at a glance

| Layer | What it is | Canonical source |
| --- | --- | --- |
| **A. Card runtime API** | The TavernHelper / SillyTavern / MVU / EJS globals a card's scripts + frontend call | [`shared/thRuntime`](../../src/shared/thRuntime/index.ts) |
| **B. Rendering environment** | The `<head>` + libs + sizing a card is rendered inside (dual-mode) | [`shared/cardEnv.ts`](../../src/shared/cardEnv.ts) |
| **C. Authoring format** | The card schema + the `rp_terminal` bundle namespace | [`types/character.ts`](../../src/main/types/character.ts) |
| **D. Import / transform** | ST PNG/JSON → our card; route bundled artifacts to stores | [`stPngParser`](../../src/main/parsers/stPngParser.ts), `characterService` |
| **E. Host subsystems** | The stores/services a transformed card's pieces live in | lorebook / regex / preset / plugin / mvu / template services |
| **F. Game-platform targets** | The "make it a game" components (panels, native stat UI, combat, agent) | mostly design-stage |

---

## 2. Layer A — Card runtime API (`thRuntime`)

The **single canonical surface** is `createThRuntime(host)` ([thRuntime/index.ts](../../src/shared/thRuntime/index.ts)),
built over a realm-agnostic **`Host` seam** ([thRuntime/types.ts](../../src/shared/thRuntime/types.ts)). Two
transports implement the same surface, so a card behaves identically in either
(parity by construction — [th-parity-status.md](../superpowers/specs/2026-06-23-th-parity-status.md)):

- **Inline** (default) — `createThRuntime(createInlineHost(ctx))` at
  [createCardBridge.ts:9](../../src/renderer/src/cardBridge/createCardBridge.ts); Host backed by Zustand
  reads + `window.api` ([cardBridge/host.ts](../../src/renderer/src/cardBridge/host.ts)).
- **Isolated / WCV** — `createThRuntime(...)` at `wcvPreload.ts:161`; Host backed by `ipcRenderer.sendSync`
  (sync getters) + `invoke` (async) over the `wcv-host-*` IPC.

### Globals exposed to a card

| Global | Contents | Status |
| --- | --- | --- |
| `TavernHelper` (+ bare helpers) | variables (+ script scope), chat r/w, worldbook CRUD, char/preset read, regex read/format/write, generate, events, `triggerSlash`, macros, audio | ✅ (gaps below) |
| `Mvu` | `getMvuData`/`getMvuVariable`/`setMvuVariable`/`replaceMvuData`/`parseMessage`/`events` | ✅ |
| `SillyTavern` | `getContext()`, `chat[]` (+swipes), `substituteParams`, `saveChat`, `reloadCurrentChat`, `eventSource` | ✅ |
| `EjsTemplate` | `evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`/… | ✅ |
| `toastr`, `tavern_events` | toast bus; the events enum | ✅ |
| injected libs | see Layer B | ✅ |

### API domains

| Domain | Methods | Status | Notes |
| --- | --- | --- | --- |
| **Variables / MVU** | `getVariables`, `insertOrAssignVariables`, `replaceVariables`, `updateVariablesWith`; `Mvu.*` | ✅ | State of truth = `floor.variables.stat_data`. Writes → RFC-6902 JSON-Patch (`applyVariableOps`). `type:'script'` → a card KV (`plugin-storage`), separate from `stat_data`. |
| **Chat read** | `getChatMessages`, `getCurrentMessageId` | ✅ | `message_id` = compact chat-array index. |
| **Chat write** | `setChatMessages`, `deleteChatMessages`, `saveChat`, `reloadCurrentChat`, `setInput`, `createChatMessages` | ✅ / 🟡 | `createChatMessages` → composer-inject (onboarding); general mid-history insert ⬜ (floor-model decision). |
| **Worldbook** | get / `createWorldbook` / `deleteWorldbook` / `replaceWorldbook` / `updateWorldbookWith` / `create`+`deleteWorldbookEntries` / `bindWorldbook` / names | ✅ | **Full library CRUD + bind** (trusted-card stance). Entries map TH `WorldbookEntry` (strategy/keys/extra) ↔ native via [`thRuntime/worldbookEntry`](../../src/shared/thRuntime/worldbookEntry.ts). |
| **Character / preset** | `getCharData`, `getCharAvatarPath`, `getPreset`, `getPresetNames`, `getCurrentCharacterName`, `SillyTavern.getCurrentChatId`, `getScriptId` | ✅ | Read-only (sync). |
| **Generation** | `generate`, `generateRaw` (+ `STREAM_TOKEN_RECEIVED`) | ✅ | Host-side; **the AI key never reaches the card**. `stopGenerationById` ⬜. |
| **Regex** | `getTavernRegexes(option)`, `isCharacterTavernRegexesEnabled`, `formatAsTavernRegexedString`, `replaceTavernRegexes`, `updateTavernRegexesWith` | ✅ | Read + **write** (full replace of a scope's bucket via `regexService`; debounced reload). Shapes map in [`thRuntime/tavernRegex`](../../src/shared/thRuntime/tavernRegex.ts). |
| **Events** | `eventOn/Once/Emit/MakeFirst/RemoveListener`; `tavern_events`; MVU `mag_variable_*` | ✅ / 🟡 | ~10 lifecycle/mutation/stream events wired; the full ST enum is a subset. `MESSAGE_SENT` ⬜. |
| **STScript** | `triggerSlash` | 🟡 | Subset via [`shared/stscript`](../../src/shared/stscript.ts): pipes/closures/macros, chat+global vars, `/gen`·`/genraw`·`/trigger`·`/send`. `while`/loops + long-tail commands ⬜. |
| **EJS** | `EjsTemplate.*` | ✅ | Backed by the quickjs engine (Layer C of ST-PT). |
| **Macros** | `substituteParams`, `substitudeMacros`, `{{get_X_variable}}`/`{{format_X_variable}}` | ✅ | `registerMacroLike` ⬜ (cross-process). |
| **Audio** | `audioPlay/Pause/Import/Mode/Enable` | 🔁 | Cards play audio natively (`<audio>`/WebAudio) under the card CSP — the real path. |

---

## 3. Layer B — Rendering environment (`cardEnv` + transports)

A card is rendered inside a `<head>` built **once** in [`cardEnv.ts`](../../src/shared/cardEnv.ts) so both
transports inject the same thing (clean-room mirror of JSR's `createSrcContent`/`adjust_viewport.js`):

- **Base CSS reset** (`BASE_RESET_CSS`): `box-sizing:border-box` + `html,body{margin:0;overflow:hidden;…}`
  (≈ Tailwind preflight) — without it `width:100%`+padding cards overflow.
- **`--TH-viewport-height`** bootstrap + `replaceVhInContent` (rewrites a card's `min-height:NNvh` onto the
  variable) for **fill** mode; **fit** mode (default) auto-sizes to content.
- **Assumed libs** the card env provides (cards are authored expecting these to be global):
  - From `cardEnv` (CDN, both transports): **FontAwesome**, **jQuery-UI (+touch-punch)**, **Tailwind** (v3).
  - From the transport: **jQuery**, **Vue**, **Pinia**, **VueRouter** (iframe-realm classic builds —
    [`cardBridge/cardLibs.ts`](../../src/renderer/src/cardBridge/cardLibs.ts) inline / `wcvPreload` WCV),
    plus **lodash** (`_`) and **Zod** (`z`) from the bridge.

**Dual-mode routing** ([MessageContent.tsx](../../src/renderer/src/components/MessageContent.tsx)):

| Card shape | Renders as | Why |
| --- | --- | --- |
| Bare top-level HTML (`<div>`/`<table>`/`<details>`…), no `<script>` | **Inline in the message DOM** (`InlineHtml`: DOMPurify-sanitized + per-card CSS scope) | Blends with prose; no frame. |
| Scripted `<body>`/```html``` card, mode `inline` (default) | **Same-origin `srcdoc` iframe** (`InlineCardFrame`) | Scrolls with chat, auto-sizes. |
| Scripted card, mode `isolated`, or full-page / `window.top` apps | **Out-of-process `WebContentsView`** (`WcvMessageFrame`/`wcvManager`) | Crash isolation; full-page cards get a real `window.top`. |
| Passive full doc / non-scripted | Sandboxed `HtmlFrame` (`sandbox="allow-same-origin"`, no scripts) | Static, safe. |

Per-card override: a regex `_meta.renderMode` → a `<!--rpt:mode=inline|isolated-->` marker parsed by
`splitHtml`. Global default: `settings.cards.renderMode` (`inline`). A third mode **`panel`** PROMOTES a
loader regex (one whose replacement does `$('body').load('https://…')`) out of the message into a docked WCV
**panel**: the inline marker is stripped, the page URL is exposed via `regexService.listPanelRegexes`, and it
becomes a selectable workspace view (`regex-panel:<file>`, rendered by `WcvPanel`). Card scripts themselves
run app-wide in the invisible session-level **engine** (`CardScriptWcvHost`), not in a panel.

---

## 4. Layer C — Authoring format (the de-facto standard)

Verified against [`character.ts`](../../src/main/types/character.ts). A card = `chara_card_v3`:

**Standard ST fields** (`data.*`): `name, description, personality, scenario, first_mes, mes_example,
creator_notes, system_prompt, post_history_instructions, alternate_greetings, tags, creator,
character_version, character_book` (embedded lorebook). Unknown ST `extensions.*` keys are **preserved**
(catchall) — so a round-trip through us is lossless for ST tooling.

**`data.extensions.rp_terminal`** — the bundle namespace (`RPTerminalExtSchema`):

| Field | Purpose | Status |
| --- | --- | --- |
| `ui_layout` (`WidgetDef[]`) | native status-panel widgets (`{id,type,path,config}`) | ✅ schema; renderer 🟡 |
| `css`, `theme`, `assets` | per-card styling + asset map | ✅ |
| `reasoning_template` | card-customizable `<think>` UI (`{{reasoning}}`/`{{title}}`/`{{tp}}`/`{{state}}`…) | ✅ |
| `state_schema` | native `stat_data` defaults | ✅ |
| `data_schema` | MVU Zod schema **source (JS)**, run sandboxed | ✅ |
| `scripts` (`[{name,code,enabled?}]`) | card scripts | ✅ |
| `game_rules` | freeform rules bag | ✅ |
| `panel_ui` | static card-determined grid (slots → native view or `wcv` entry) | ✅ schema |
| **World Card bundle slots** | `world_card` (version marker), `meta`, `regex[]`, `presets[]`, `lorebooks[]`, `plugins[]`, `agent`, `combat`, `recommended_settings` | ✅ schema; routing 🟡 (see §5) |

`world_card` present ⇒ the card is a **World Card** (a complete, one-click-installable world). The schema
has a `catchall` so future slots round-trip.

---

## 5. Layer D — Transforming a SillyTavern card → RP Terminal

The mapping from an ST/TH card's pieces to ours. **Tier 1** transforms mechanically; **Tier 2** is
best-effort (arbitrary author JS reaching past the supported surface).

| ST / TH card element | Lives in (ST) | RPT destination | Status |
| --- | --- | --- | --- |
| Core character fields | `data.*` | `CardDataSchema` (`data.*`) | ✅ direct |
| Embedded lorebook | `data.character_book` | lorebook library at `id == characterId` ([`LorebookSchema`](../../src/main/types/character.ts)) | ✅ |
| Standalone world info | separate JSON | lorebook library (uuid id) | ✅ |
| World-info **EJS** (`<% %>`, `getvar`) | entry `content` | `templateService` (build) + `renderTemplate` (display) | ✅ A–E ([plan](../st-prompt-template-plan.md)) |
| Injection **markers/decorators** (`[GENERATE]`, `@INJECT`, `@@…`) | entry `comment`/decorator | [`injectMarkers.ts`](../../src/main/parsers/injectMarkers.ts) + `promptBuilder` | ✅ build-time; `[RENDER:*]` partial |
| `[InitialVariables]` | entry | `mvuSchema.parseInitVars` → floor-0 `stat_data` | ✅ |
| **Regex scripts** (beautification + state) | `extensions.regex_scripts` | regex store + `rp_terminal.regex`; per-card render mode | ✅ engine ([`stRegexEngine`](../../src/main/parsers/stRegexEngine.ts), `regexTransform`); 🟡 bundled import routing (World Card S1) |
| **MVU** `<UpdateVariable>` / `stat_data` | model output + MVU bundle | **native** [`mvuParser`](../../src/main/parsers/mvuParser.ts) (`_.set` + JSON-Patch + `delta`/array-append); thin `Mvu` shim | ✅ (no bundle loaded) |
| MVU `data_schema` (Zod) | bundle | `rp_terminal.data_schema`, sandboxed | ✅ |
| **TavernHelper scripts** (JS) | script lib / regex-injected | `rp_terminal.scripts` + the `thRuntime` surface at render | 🟡 Tier-1 for the supported API; **Tier 2** for arbitrary DOM / ST internals |
| **Frontend cards** (HTML/Vue/React UI) | regex `$('body').load(...)` / `<body>` block | dual-mode frame (inline / WCV) + `cardEnv` libs | ✅ for the supported env; full-page/`window.top` → Isolated |
| Chat-completion **preset** | preset JSON | [`stPresetParser`](../../src/main/parsers/stPresetParser.ts) → preset files + `rp_terminal.presets` | ✅ parser; 🟡 bundle import |
| Quick replies / STScript | QR sets | `triggerSlash` subset (`shared/stscript`) | 🟡 |
| Avatar / assets | PNG image / embedded | `avatars/<id>.png` + `rp_terminal.assets` | ✅ avatar; 🟡 binary asset bundle (PNG cartridge ZIP, §6) |
| Audio | TH audio API | native `<audio>`/WebAudio | 🔁 (API stubbed) |

**What does NOT transform cleanly (Tier 2 — set expectations honestly):** cards whose JS reaches past the
documented surface — full-page apps that read undocumented `window.top` internals, exotic/uncommon
`tavern_events`, timing/DOM-structure assumptions, or a second variable engine. These run *best-effort*;
the importer should **report** them, not silently drop or pretend-support them. (This is the tiered-
compatibility stance: support the dominant MVU+EJS+TH+Vue/Tailwind stack solidly; the long tail is
explicitly out-of-contract.)

**The importer today** ([`characterService.ts`](../../src/main/services/characterService.ts)): preserves
the full `extensions` object (lossless), detects `world_card`, collects bundled regex from
`extensions.regex_scripts`, and `buildWorldCardExport` writes the inverse. Remaining routing (presets/
plugins/scope) is tracked in [world-card-design.md](../world-card-design.md) §5/§9.

---

## 6. The PNG cartridge (your "store everything in a PNG" direction)

This is already specced as **World Card §8**. Concretely:

- **Read** — [`stPngParser.ts`](../../src/main/parsers/stPngParser.ts) parses PNG `tEXt`/`iTXt` chunks for
  the `chara`/`ccv3` keyword and base64-decodes the JSON. Because *scripts, regex, preset and per-card
  customizations are all text under `extensions.rp_terminal`*, a PNG whose embedded JSON is a World Card
  **already carries all of them**. ⚠️ Limitation: **compressed `iTXt` is unsupported** (the parser bails) —
  fix this to read more real-world cards.
- **Write/export** — `buildWorldCardExport` produces the `chara_card_v3` JSON (own lorebook →
  `character_book`, world regex → `extensions.regex_scripts`, `world_card` stamped). ⬜ A **PNG writer**
  (embed that JSON into a `tEXt`/`ccv3` chunk over an avatar image) is not yet built — this is the missing
  piece to make "export a PNG cartridge" real.
- **Binary / large assets** — text outgrows a base64 chunk, so the plan is an **appended ZIP after `IEND`**
  (`adm-zip` is already a dependency): manifest + `assets/` + bundled lorebooks/plugins/scripts. ⬜ planned
  (World Card S5).

**Recommendation:** formally adopt **`chara_card_v3` + `extensions.rp_terminal`** as the standard (no new
spec string → ST stays compatible), and treat the **PNG as the cartridge**: inline JSON for text
(scripts/regex/preset/customizations — exactly your list), appended ZIP for binary. The two build items
are the **PNG writer** and **compressed-`iTXt` read**; everything else (the schema, the bundle slots, the
reader) exists.

---

## 7. Heavy-card playbook (worked example: 命定之诗)

How a heavy card's pieces map, from [card-custom-ui-design.md](../card-custom-ui-design.md) §"boot chain":

- **Status UI** (React ESM, jsDelivr imports) → runs in a frame (WCV isolated / inline); reads `stat_data`
  via the runtime, refreshes live on a model turn. ✅ working.
- **home / custom_start** (Vue apps, env-check at boot) → **onboarding** (one-time): home → creation →
  inject starting prompt → first turn fills MVU vars. Full-page → Isolated/WCV. 🟡 (works in isolated).
- **MVU framework** (`MagVarUpdate`, MIT) → **not loaded**; we run the update pipeline natively
  (`mvuParser`) and serve the UIs' reads via the thin `Mvu` shim. Optionally vendor MVU's
  schema-defaults/`initvar` logic (MIT, reusable with attribution — see the clean-room constraint in
  [CLAUDE.md](../../CLAUDE.md)).
- **data_schema** (Zod) → `rp_terminal.data_schema`, sandboxed, fills `getMvuData().schema`.
- **Lorebook** (469 entries, 34 with build-time EJS) → lorebook library + `templateService`. ✅.

The lesson: a heavy card is *mostly* declarative data + a known framework stack + a few frontends. That
part is Tier 1. The bespoke JS frontends are the work — supported through the dual-mode frame + the
runtime surface, full-page ones via WCV.

---

## 8. Layer F — Game-platform component targets (the "make it a game" SDK)

Mostly design-stage; these are the components that turn the chat tool into a game platform. Tracked, not
yet an SDK you'd hand a card author:

| Component | What | Status / source |
| --- | --- | --- |
| Static panel workspace | card-declared `panel_ui` grid → native views + WCV slots | 🟡 `StaticWorkspace` ([card-custom-ui-design.md](../card-custom-ui-design.md)) |
| Native MVU view kit | render StatusMenuBuilder-style declarative widgets (`StatBar/StatRow/Image/Checkbox/RichText/QuestList`) natively (no frame) | ⬜ Option 1 (recommended) |
| Variable write-back bridge | panel/script UI mutates `stat_data` (JSON-Patch → persisted) | ✅ `applyVariableOps` |
| Reasoning UI | card `reasoning_template` slots fold `<think>` | ✅ (`reasoning_template`; `ReasoningPanel`) |
| Combat engine | native deterministic d20 grid engine (`shared/combat`); seeded, card-overridable | ✅ (Track Combat P1–P4) |
| Combat view | native `CombatView` (grid · initiative · action bar · log); Combat-mode layout | ✅ (P5) |
| Combat AI touchpoints | `<rpt-combat-start>` cue, `<rpt-combat-result>` adjudication, narration, `ai` enemy ctrl | ✅ (P6) |
| Combat bundle | card-shipped `rp_terminal.combat` (abilities/bestiary/party/maps/scripts/skin; + `stat_map`/`derive` for MVU import) → `buildEncounter` / `buildEncounterFromMvu` | ✅ schema + builders (P7 + BP1–4); see [combat-system-design.md](../combat-system-design.md) §10 + §8a |
| Agent / FSM modes | card-defined explore/dialogue/combat tuning + prompts | 🟡 modes exist; card-defined `agent` slot ⬜ |
| Plugin packages | bundled `plugins[]` install via the permission/sandbox model | ⬜ (World Card S3) |

---

## 8a. Combat SDK components (Track Combat)

The combat authoring surface a world targets, all under `extensions.rp_terminal.combat` (the
`CombatBundleSchema`, [character.ts](../../src/main/types/character.ts)) unless noted. The engine
(`src/shared/combat/*`) is native and deterministic; a card supplies **content + skin + optional
script overrides**, never the renderer. Design: [combat-system-design.md](../combat-system-design.md);
methods/tags: [rpt-api.md](../rpt-api.md) §4 (Combat).

### Authorable now (✅ built)

| Component | Where / shape | Notes |
| --- | --- | --- |
| Ability catalog | `combat.abilities[]` (`AbilityDef`) | `range`, `shape` (AoE), `toHit`, `save`, `damage`, `damageType`, `effects`, `cost`, `requiresLoS` |
| Action economy | `AbilityDef.cost` `'attack'` \| `'action'` (default: attack-roll → attack, else action) | one move + one attack + one action per turn (`CombatState.turnUsed`) |
| Line of sight | `AbilityDef.requiresLoS` + terrain `blocksLoS` | true = blocked by walls (ranged); false = lobbed AoE arcs over them |
| AoE shapes | `shape.kind` ∈ `self` / `burst{r}` / `aura{r}` / `line{len,width}` / `cone{len}` | engine computes covered cells + auto-targets ([grid.ts](../../src/shared/combat/grid.ts) `templateCells`) |
| Bestiary | `combat.bestiary[]` (`id`,`name`,`tier`,`block`,`abilities`,`controller`) | enemies the cue resolves against |
| Party templates | `combat.party[]` | the player-side combatants instantiated at setup |
| Maps | `combat.maps[]` (`w`,`h`,`cell_ft`,`party_spawns`,`enemy_spawns`) | else a default open grid |
| Stat block | `block` (`hp`,`maxHp`,`ac`,`speed`,`mods`,`abilities`,`resist`,`vulnerable`) | fresh + ephemeral; only consequences fold back to `stat_data` |
| Enemy controller | `combat.enemy_controller` `weighted` \| `ai`; per-enemy `controller` | native weighted policy (free) or model-driven |
| Resolver override (coarse) | `combat.scripts.resolveAction` (sandboxed JS) | `(input{state,action}, rng, emit, log) → {state?, events?}`; replaces native resolution for an action |
| Combat-start cue | model emits `<rpt-combat-start enemies="…" map="…">` | → Enter-Combat button → `buildEncounter` |
| Adjudication / mid-fight exit | model replies `<rpt-combat-result>{narration, ops[], end}</rpt-combat-result>` | ops: `damage`/`heal`/`move`/`condition`; `end:true` concludes/escapes the fight → prose to chat + exit |
| Combat prompts | card `combat.narration_prompt` / `narration_mode` / `improvise_prompt`; user `settings.combat.*` | steer end-of-combat narration (+ append/new-floor placement) and the freeform-action box; card overrides user |
| Conditions (mechanical) | `stunned`/`restrained` (immobilize), `prone` (attackers get advantage) | other ids are labels only — extended mechanics are script-authored (below) |
| Ruleset id | `combat.ruleset` (`rpt-d20-v1`) | selects the native core |

### MVU-driven import + card combat systems (built — the 命定之诗 path)

A world whose stats already live in MVU `stat_data` (e.g. 命定之诗) can build the encounter **party
from those variables** instead of `combat.party` templates, and resolve the fight with its **own**
rules via a **combat system** plugged into the `resolveAction` seam. The card authors combat numbers
into the MVU fields its schema already preserves (`标签`/`效果`/`消耗`) — **no new field** — and the app
parses them. See [combat-poem-of-destiny-expansion.md](../combat-poem-of-destiny-expansion.md). Reference
bundle config: [examples/poem-combat-bundle.json](examples/poem-combat-bundle.json).

| Component | Where / shape | Notes |
| --- | --- | --- |
| Stat map | `combat.stat_map` (`StatMap`, [bundle.ts](../../src/shared/combat/bundle.ts)) | `player` key, `party{from,filter}` (e.g. `关系列表` where `在场:true`), `paths` (logical→character path). Structural keys are SDK English; values are the card's (`主角`/`属性`/`生命值`…). |
| Derive tables | `combat.derive` (`DeriveConfig`) | pure DATA: `attributes`, `tier_coefficient`, `hp_multiplier`, `mp_sp_multiplier`, `rating_tiers`, `attr_mitigation`, `defense_constant`. No formulas/eval. |
| Encounter import | `buildEncounterFromMvu(statData, stat_map, system, {derive})` | walks `stat_map` → player + present companions → `system.buildCombatant` each → grid. Enemies are AI-generated at entry (deferred). |
| Combat system | `CombatSystem` = `parseItem` + `buildCombatant` + optional `resolveAction`; selected by id via `getSystem()` ([systems/index.ts](../../src/shared/combat/systems/index.ts)) | the card-side adapter. v1 built-in: **`poemD20`**. |
| ext bag | `Combatant.ext` / `AbilityDef.ext` (opaque `Record<string,unknown>`) | carries the system's parsed stats (五维, `CardCombat`); the native engine ignores it, the system resolver reads it. |
| Resolver context | `ResolverContext` = `{state, action, abilities, rng, derive}` | the documented inputs a card resolver receives; `resolveAction` returns `{state?,events?}` or **`null`** (→ native for move/end/improvise/out-of-range). The service injects it as the engine's RunHook (built-in runs first, then sandboxed scripts, then native). |
| 命定之诗 system | [systems/poemD20.ts](../../src/shared/combat/systems/poemD20.ts) | parses `标签`/`效果`/`消耗`; resolves the card's `<战斗协议>` — 生命层级 d20 pool, `命中−闪避→评级`, `构成→装备减免/属性减免→×评级→DR`, `附加效果`. Intent/集群/战意/typed-damage **deferred**. |

A card-SHIPPED (untrusted, sandboxed) resolver via `combat.scripts` is the **same `ResolverContext`
contract** — deferred hardening; v1 systems are trusted built-ins. Mode selection (Classic / Combat-
system Narrate / Deterministic) at combat entry and AI enemy `char_info`→combatant generation are the
remaining wiring (need the running app).

### Tactical depth = script-authored (deferred, by design)

Cover, opportunity attacks / reactions, flanking, and an extended **conditions library** are **not**
baked into the native engine. They're delivered by **combat scripts that ship with a world or are
installed by the player**, via the card-override hook seam (`combat.scripts`). Today that's the coarse
`resolveAction` hook; the granular hooks (`resolveAttack` / `applyDamage` / `onTurnStart` / `onTurnEnd`
/ `enemyPolicy` / `checkVictory` / `seedCombatant`) are reserved in `HookName` and not yet wired. The
native engine stays lean (grid · d20 · move/attack/action · LoS · base conditions). Deferred.

### Potential / planned (⬜ not built)

| Component | What it would add |
| --- | --- |
| Granular resolver hooks | wire the reserved `HookName`s so scripts can override single steps, not just whole actions |
| `ai` enemy controller | **deferred** — dormant scaffold (`aiChooser`/`buildEnemyPrompt`); needs its **own player/world prompt** (the third combat prompt) + per-round batching before production |
| Hex grid | `grid.type:"hex"` distance + neighbors (engine is square-only today) |
| Keyboard controls | arrow-key cursor / number-key abilities — **deferred**, mouse-only for now |
| Combat skin (renderer) | `combat.skin` slot exists (token/tile art, ability icons, `--rpt-*` CSS) but `CombatView` doesn't consume it yet |
| Encounter / bundle authoring UI | a visual editor for abilities/bestiary/maps (pairs with the state-schema/widget editor, agentic D2) |

---

## 9. How to extend this inventory

When you add or change a card-facing capability:

1. **Runtime API** → update [`thRuntime`](../../src/shared/thRuntime/index.ts) (both transports inherit it)
   and §2 here.
2. **Rendering env** → `cardEnv.ts` + §3.
3. **Format / bundle slot** → `RPTerminalExtSchema` ([character.ts](../../src/main/types/character.ts)) + §4,
   and the transform row in §5.
4. **Import/transform** → the parsers + `characterService` + §5/§6.

Keep the status markers honest (✅/🟡/🔁/⬜) and cite the file each row was verified against. This doc and
[rpt-api.md](../rpt-api.md) (the method-level reference) must move together with the code — see
[README.md](README.md).
