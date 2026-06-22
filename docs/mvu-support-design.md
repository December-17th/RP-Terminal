# MVU (MagVarUpdate) + Zod Schema Support — Design

Status: **Draft — design-doc-first, no code yet.** High priority: this is the backbone of
the **right-panel RPG UI**. It plans compatibility with **MagVarUpdate (MVU)** — the
SillyTavern variable-management framework — and the **Zod data-schemas** that MVU cards
ship, so the large ecosystem of MVU RPG cards drives RP Terminal's status panel.

Reference artifacts analyzed:

- MVU runtime — `MagicalAstrogy/MagVarUpdate/artifact/bundle.js`
- `mvu_zod` schema utility — `StageDog/tavern_resource/dist/util/mvu_zod.js`
- An example card schema — `The-poem-of-destiny/FrontEnd-for-destined-journey/dist/data_schema/index.js`

---

## 1. What MVU is (the protocol, distilled)

MVU keeps a structured RPG state object (`stat_data`) in sync with the story by having the
**model emit variable-update commands in its reply**, which MVU parses and applies. Flow:

1. **Schema** — a card/lorebook ships a **Zod schema** (the `data_schema` script) that calls
   `registerMvuSchema(schema)`. The schema defines the shape of `stat_data` (stats, inventory,
   quests, relationships, world/time, …) and its defaults.
2. **Init** — on first message, MVU seeds `stat_data` from `[initvar]`-tagged lorebook entries
   (YAML/JSON in code blocks) + the schema's defaults.
3. **Update** — the model wraps changes in an `<UpdateVariable>` block containing commands:
   ```
   <UpdateVariable>
   _.set('主角.生命值', 80, '受到攻击');     // replace
   _.add('命运点数', 1, '完成任务');          // numeric/date delta
   _.assign('关系列表.艾莉', {好感: 5});      // merge into object
   _.insert('任务列表', 0, {名: '寻找钥匙'}); // insert into array
   _.remove('世界.地点');                     // delete a path
   </UpdateVariable>
   ```
   (Parsed via `/_\.(set|insert|assign|remove|unset|delete|add|delta)\s*\([\s\S]*?\)\s*;/`.
   The 3rd arg is a human "reason" recorded in `delta_data`.)
4. **Apply + validate** — MVU folds the commands into `stat_data`, validates/coerces it against
   the registered Zod schema (`safeParse`), writes it to **message-scoped** variables, and emits
   events (`mag_variable_updated`, `mag_variable_update_ended`, …).
5. **Render** — a **front-end UI script** (also shipped with the card) reads `stat_data` and
   listens to those events to draw the RPG panel.

**Dependencies MVU expects from the host runtime:** Tavern-Helper / js-slash-runner functions
(`getVariables`/`replaceVariables`/`updateVariablesWith`/`insertOrAssignVariables` with
`{type:'message'|'chat'|'global'}`, `getChatMessages`, `getLastMessageId`, `eventOn`/`eventEmit`,
`registerMacro`, `registerFunctionTool`, `getLorebookEntries`), plus `_` (lodash), `$` (jQuery),
`toastr`, `YAML`/`JSON5`/`jsonrepair`, and `z` (Zod). The `data_schema` additionally does a **remote
`import`** of `mvu_zod.js` (which itself CDN-imports zod/json5/klona/compare-versions).

---

## 2. Codebase compatibility analysis

The good news: **RP Terminal already has the same concept** — AI-emitted state mutations folding
into a per-message variable object that drives status widgets. MVU is a richer, schema-validated
version of our `<rpt-event>` + `floor.variables` + widget pipeline.

| MVU concept                                              | RP Terminal today                                                                                                                                                                                            | Fit               | Gap                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `stat_data` (per-message nested state)                   | `floor.variables` (per-floor nested object), seeded from the previous floor                                                                                                                                  | ✅ near-identical | scope naming only                                                                                                                          |
| `_.set/add/assign/insert/remove/delta` commands          | `applyEvent` does `set`/`add`/`remove` on a path ([generationService.ts](../src/main/services/generationService.ts))                                                                                         | ✅ same idea      | missing `assign`(merge), `insert`(index), `delta`; different op set                                                                        |
| `<UpdateVariable>` + `_.x('path', val, 'reason')` syntax | `<rpt-event type=… path=… value=… />` parser ([contentParser.ts](../src/main/parsers/contentParser.ts))                                                                                                      | ⚠️ same role      | **new parser needed** for MVU syntax + JSON5 arg values                                                                                    |
| Registered **Zod schema** for shape/defaults/validation  | `RPTerminalExt.state_schema` is a `z.record(any)` **placeholder, unused** ([character.ts](../src/main/types/character.ts)); Zod 4 is the project's validator                                                 | ⚠️ slot exists    | **new**: real schema layer + defaults + validate/reconcile                                                                                 |
| `[initvar]` seeding of initial state                     | none — `floor.variables` starts `{}`                                                                                                                                                                         | ❌                | **new**: init from schema defaults + lorebook `[initvar]`                                                                                  |
| Variable scopes `message`/`chat`/`global`                | `local`(floor) + `global`(profile) ([pluginService.ts](../src/main/services/pluginService.ts))                                                                                                               | ⚠️                | `message`→floor ✅; `global`→global ✅; **no `chat` scope** (add one)                                                                      |
| Front-end UI reads `stat_data` + MVU events              | right panel = `LayoutRenderer` (declarative `ui_layout` widgets bound to `floor.variables`) + `CardScriptHost` (iframe scripts) ([App.tsx](../src/renderer/src/App.tsx))                                     | ⚠️ MVP            | widgets are 3 inline-styled types (StatBar/Text/List), flat-path, no nesting; **no MVU events emitted**                                    |
| Tavern-Helper API surface MVU calls                      | clean-room `TAVERN_SHIM` already maps `getVariables`/`setVariables`/`insertOrAssignVariables`/`getChatMessages`/`eventOn`/`toastr` onto `rpt.v1` ([bridgeShim.ts](../src/renderer/src/plugin/bridgeShim.ts)) | ✅ foundation     | extend with `{type}` scoping, `updateVariablesWith`, `replaceVariables`, message-id reads                                                  |
| Scripts shipped **in a lorebook**                        | scripts come from **cards** (`extensions.rp_terminal.scripts`) + plugins; lorebook entries have no script field                                                                                              | ❌                | **new**: a lorebook-script source                                                                                                          |
| Sandbox to run untrusted card schema/UI JS               | `allow-scripts` iframe (P1) + quickjs WASM (templates)                                                                                                                                                       | ✅ exists         | data_schema's **remote imports are CSP-blocked**; needs a local `mvu_zod` + import rewriting (and the T3.2 worker for headless validation) |

**Net:** the data model, the apply-events pattern, Zod, the sandboxes, the widget registry, and a
TH shim already exist. The genuinely new work is the **MVU command parser**, the **schema/init
layer**, the **right-panel widget upgrade**, **lorebook-borne scripts**, and a clean-room **`mvu_zod`**.

---

## 3. The core decision: clean-room native protocol vs. run-the-bundle

Two ways to support MVU cards:

- **A. Run the MVU `bundle.js` as-is** in the sandbox. Requires reproducing MVU's _entire_ host
  surface: message/chat/global scoped variables, the ST event bus (`MESSAGE_RECEIVED`,
  `worldinfo_entries_loaded`, …), `registerFunctionTool`/`registerMacro`, lodash + jQuery + YAML +
  JSON5 + jsonrepair + Zod **inside** the sandbox, `SillyTavern.POPUP`, and **un-blocking remote
  CDN imports** (the bundle and `mvu_zod` both `import` from jsdelivr — our iframe CSP is
  `connect-src 'none'`). Heavy, fragile, version-coupled, and security-awkward.
- **B. Clean-room reimplement the MVU _protocol_** (the `<UpdateVariable>` command grammar + the
  schema registry + init + the `mag_*` events) natively, folding into `floor.variables`. Small,
  testable, integrates with the existing pipeline, no giant untrusted bundle, no remote imports.

**Recommendation: B (clean-room native).** The MVU command grammar and the `registerMvuSchema`
contract are a _protocol_, not copyrightable code — we reimplement it the same way the
ST-Prompt-Template engine was built (clean-room from observed behavior). We still **run the card's
own `data_schema` and front-end UI scripts** (those are user content, sandboxed), but MVU's engine
itself is ours. This sidesteps the js-slash-runner constraint entirely and avoids vendoring AGPL
bundles. (See §11.)

---

## 4. Variable model mapping

- `stat_data` ⇒ a reserved namespace inside `floor.variables` (e.g. `floor.variables.stat_data`),
  so MVU state coexists with `<rpt-event>` state and template vars on the same object the widgets
  and next-turn seed already read.
- Scopes: `message` ⇒ the floor's variables (current behavior); `global` ⇒ profile globals
  (current behavior); **`chat`** ⇒ a new per-chat store (a `chats.chat_vars` column, mirroring
  `lorebook_ids`/`cached_world_info`) — distinct from per-floor and from per-profile.
- Keep the **value/description convention** (`ValueWithDescription`): MVU often stores
  `[value, "description"]` (or `{value, description}`) so the model keeps context and the UI shows
  labels/tooltips. The parser and widgets must treat that tuple as first-class (display the value,
  surface the description).
- Expect deeply nested, **named sub-trees and capped collections** — observed conventions include
  `Partner.<Name>`, `World_Calc.NPCs` / `World_Calc.Events`, and bounded arrays like
  `PositiveMemories` (≤5), `ImportantEvents` (≤10). The widgets (§8) must render arbitrary nesting
  and arrays, not a flat path list.

---

## 5. MVU command protocol (R1)

A new pure parser `parseMvuCommands(text)` (sibling to `parseContent`):

- Extract `<UpdateVariable>` / `<update>` / `<updatevariable>` blocks (strip from display text).
- Within each, match `_.op(args);` statements for `op ∈ {set, add, delta, assign, insert,
remove, unset, delete}`.
- **Argument parsing is JSON5, never `eval`** — split the `(...)` on top-level commas (respecting
  quotes/brackets), parse each arg with a JSON5-ish reader. Arg 1 = path, arg 2 = value, arg 3 =
  reason (optional).
- **Also accept MVU's JSON-Patch form** — some cards emit patch ops
  (`{op: 'replace'|'delta'|'add'|'insert'|'remove'|'move', path: '/a/0/b', value}`) instead of the
  `_.x(...)` sugar. Normalize both onto the same `MvuCommand[]`.
- Emit a normalized `MvuCommand[]`; an applier folds them into `stat_data`:
  `set`→replace, `add`/`delta`→numeric/date increment, `assign`→deep-merge, `insert`→array splice,
  `remove`/`unset`/`delete`→delete path. Reuse the existing `setPath`/`getPath`/`delPath` helpers.
- Record each change in `delta_data` (path, old, new, reason) for the UI + logs.
- Wire into `generationService.generate()` right beside the `parseContent`/`applyEvent` fold, so
  MVU and `<rpt-event>` both work. Pure + unit-tested (parser + applier + each op).

---

## 6. Schema layer + `mvu_zod` (R2 / R4)

- **Clean-room `mvu_zod` (recording shim)** — rather than bundle real Zod into the sandbox, inject a
  Zod-shaped _recording_ builder (`MVU_ZOD_SHIM`): `z.object/string/number/array/record/enum/...` with
  chainable `.prefault()/.default()/.describe()/.optional()/...` that capture the schema's _structure_
  as a plain tree, and `registerMvuSchema(schema)` stores it. Card ES-module imports are rewritten to
  the injected globals (`__mvuImports`); `$` (jQuery-ready), `_` (lodash), `YAML`, `toastr` are stubbed.
- **Running the card's `data_schema`:** execute it in the **T3.2 sandbox**; the recorded tree
  serializes out (functions drop on JSON round-trip). A Node-side interpreter (`schemaDefaults`,
  `validateStatData`) derives the default `stat_data` (seeded in `createChat`) and does light
  coercion. This avoids running real Zod or remote CDN imports inside the VM. Full Zod fidelity
  (transforms/refinements, per-turn reconcile wiring, schema-derived UI order) is a later hardening.
- Before R4 lands, R2 can drive the same plumbing from a **native JSON-described schema** authored
  in RP Terminal, so init/validation/auto-UI work without executing card JS.

---

## 7. Init (R2)

- Parse `[initvar]`-marked lorebook entries: pull YAML/JSON from fenced code blocks, merge into the
  starting `stat_data`. (Lorebook entries already carry a `comment` field; ST marks init entries in
  the comment/title — detect that.)
- Layer order: **schema defaults** (`.prefault()`) → `[initvar]` overrides → live updates. Seed at
  floor 0 (greeting) so the panel is populated before the first user turn.

---

## 8. Right-panel RPG UI (R3) — the headline deliverable

Today's [WidgetRegistry](../src/renderer/src/components/WidgetRegistry.tsx) is 3 inline-styled
widgets (StatBar/Text/List) bound to a flat `path`. MVU `stat_data` is deeply nested with
descriptions. Upgrade:

- **Nested rendering** — an `ObjectView`/`Section` widget that recursively renders sub-objects,
  arrays (quests, inventory, relationships), and `value/description` tuples; bars for numeric
  ranges; collapsible groups.
- **Schema-derived auto-layout** — when an MVU schema is present, derive a sensible default panel
  from it (field types → widgets, descriptions → labels/tooltips) so a card needs **no hand-authored
  `ui_layout`**. A card can still override with `ui_layout` or a custom `CardScriptHost` UI.
- **Live updates** — already supported: `setLatestFloorVariables` syncs widgets immediately after a
  fold; extend it to push the `mag_*` events (§9) so custom front-end scripts update too.
- **Two-sided layout** — the RPG UI can render on the **left panel** (a dedicated tab) as well as
  the right sidebar, so game UI flanks **both** sides of the center chat (a "cockpit"). Panels and
  `ui_layout` declare a `side: 'left' | 'right'` target; `rpt.ui.registerPanel` gains the same. The
  right sidebar stays the default when no side is specified.
- Styling moves to `--rpt-*` tokens / `index.css` (the current inline styles are MVP).

**Precedent:** the MVU ecosystem ships a visual **"Zod Status Menu Builder"** (click-and-drag, no
coding) that authors the status panel from the schema. R3's schema-derived auto-layout — and an
eventual widget editor — is the same idea, and converges with Track 3's **D2** (state-schema +
widget editor): build **one** authoring surface that serves both MVU and native cards.

---

## 9. Events + front-end scripts (R5)

- After a fold, **emit MVU-named events** into card-script iframes via the existing event channel:
  `mag_variable_initialized`, `mag_variable_update_started`, `mag_command_parsed`,
  `mag_variable_updated` (per change), `mag_variable_update_ended`. This is what MVU front-end UIs
  subscribe to.
- **Extend `TAVERN_SHIM`** with the scoped surface MVU front-ends call: `getVariables({type})`,
  `replaceVariables`, `updateVariablesWith`, `insertOrAssignVariables({type})`, `getLastMessageId`,
  message-scoped reads. (`eventOn`/`toastr`/`getChatMessages`/`setVariables` already exist.)
- Provide `_` (a small lodash subset: `get/set/merge/clamp/pick/uniq/size`) and `YAML.parse` in the
  card-script sandbox, since front-ends use them. Clean-room or a permissively-licensed dep.

---

## 10. Lorebook-embedded scripts (R5)

MVU's schema + front-end ship **in a lorebook**, not a card. Add a lorebook-script source:

- Extend `LorebookEntry` with an optional `script`/`type` (or detect fenced JS / a flagged entry,
  per ST convention) so a book can carry `data_schema` + UI scripts.
- Route those scripts through the same sandbox as card scripts (schema → worker; UI → `CardScriptHost`
  iframe). Respect the per-card/per-plugin permission + enable model.

---

## 11. Licensing / clean-room

- **Hard constraint (unchanged): no code from `n0vi028/js-slash-runner` (AGPL).** MVU calls its
  Tavern-Helper API; we satisfy that with our **existing clean-room shim**, never its source.
- **MagVarUpdate**, **`mvu_zod`** (`StageDog/tavern_resource`), and **`KritBlade/MVU_Game_Maker`**
  are separate ST-ecosystem repos — **AGPL-3.0** (confirmed on MVU_Game_Maker; assume the same
  across the ecosystem). We **reimplement their protocol/contract clean-room** (command grammar,
  `registerMvuSchema`), copying nothing — same posture as the ST-Prompt-Template engine.
- MVU's runtime stack is Tavern Helper + **ST-Prompt-Template** + a compatible preset. We already
  ship a clean-room **ST-Prompt-Template engine (C1)** and a clean-room **Tavern-Helper shim**, so
  two of the three host dependencies are already satisfied without any third-party code.
- The example card (`FrontEnd-for-destined-journey`) and any card's `data_schema`/UI are **user
  content**, run sandboxed; not vendored into this repo.
- Net: nothing here binds the project's (undecided) license; record provenance in `CLAUDE.md`.

---

## 12. Phased plan

| Phase                                   | Deliverable                                                                                                                                                                                                                                                                                                                                                                                              | Reuses                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **R0** (this doc)                       | MVU protocol analysis + compatibility map + clean-room decision.                                                                                                                                                                                                                                                                                                                                         | —                                                  |
| **R1 — Command protocol**               | `parseMvuCommands` + applier (`<UpdateVariable>` + `_.set/add/delta/assign/insert/remove`, JSON5 args, `delta_data`), folded in `generate()` beside `<rpt-event>`. Pure + tested. **Live MVU state tracking.**                                                                                                                                                                                           | `applyEvent`, `setPath`/`getPath`, `contentParser` |
| **R2 — Schema + init**                  | ✅ init/defaults seeding — native `state_schema.defaults` ⊕ `[initvar]` JSON code blocks (deep-merged) → floor-0 `stat_data`, so the panel is populated before turn 1 (`mvuSchema`, wired in `createChat`). ⬜ deferred: YAML init blocks, the `chat` var scope (→ R5), and reconcile/validation (→ R4 Zod).                                                                                             | Zod 4, `chats` migration pattern                   |
| **R3 — RPG UI upgrade**                 | ✅ recursive `StatView` auto-renders `stat_data` (collapsible object groups, arrays, value/description tuples, value/max bars) with tokenized styles; shown in the right panel for cards without a `ui_layout`; live via the latest-floor variables. ⬜ deferred: schema-derived ordering/labels (pairs with R4), `mag_*` event push (R5), two-sided layout (separate todo).                             | `LayoutRenderer`, latest-floor variables           |
| **R4 — Card Zod schema in the sandbox** | ✅ clean-room recording `mvu_zod` shim + import rewriting runs a card's `data_schema` in the **T3.2 sandbox** and captures a serializable schema tree → `schemaDefaults` seeds `stat_data` in `createChat` (card field `extensions.rp_terminal.data_schema`); light `validateStatData`. ⬜ deferred: transforms/refinements, per-turn reconcile wiring, schema-derived UI order.                         | **T3.2 worker harness**                            |
| **R5 — Events + front-end shim**        | ✅ `mag_*` events (`buildMvuEvents`) emitted to card iframes on each fold; `TAVERN_SHIM` gains `updateVariablesWith` / `replaceVariables` / `getLastMessageId` / `getCurrentMessageId`; clean-room `_` (lodash subset) + `YAML` injected into the sandbox (`LIB_SHIM`). ⬜ deferred: lorebook-borne scripts (a script source on lorebook entries) — MVU front-ends can live in card `scripts` meanwhile. | `bridgeShim`/`CardScriptHost`                      |

**Dependency notes:** R1 is standalone and the highest-value first slice (MVU cards start tracking
state immediately). R3 builds on R1 and is the visible "RPG UI" win — **R1 + R3 is the recommended
first milestone.** R4 depends on the **T3.2 worker harness**, so MVU support and Track 3's sandbox
work are synergistic (build the harness once, used by combat _and_ MVU schema validation). R5 layers
full front-end-card compatibility on top.

---

## 13. Open questions

1. **Schema source order** — ship R2 with a native JSON-described schema (no card JS) to unblock
   init/validation/auto-UI fast, then add R4 (run card Zod) for full compat? (Lean yes.)
2. **`chat` scope storage** — a `chats.chat_vars` column vs. reuse the floor store. (Lean column,
   for parity with `lorebook_ids`/`cached_world_info`.)
3. **lodash in-sandbox** — bundle a permissive `lodash-es` subset vs. a tiny clean-room `_`?
   (Front-ends lean on `_.get/set/merge/clamp/...`.)
4. **Detecting MVU cards** — a card/lorebook flag, or sniff for a registered schema / `<UpdateVariable>`
   in history? (Lean explicit: presence of an MVU schema or an `[initvar]` entry enables the engine.)
5. **`<UpdateVariable>` vs `<rpt-event>`** — keep both, or make `<rpt-event>` a thin alias once MVU
   lands? (Lean keep both; MVU is opt-in per card.)

---

## 14. What we already have (so this is incremental)

- **`floor.variables`** + `applyEvent` set/add/remove + `setPath`/`getPath`/`delPath` — the state
  model + the apply pattern MVU needs.
- **`<rpt-event>` parser** — the precedent for parsing state mutations out of model output.
- **Zod 4** — the validator MVU schemas are written in.
- **Two sandboxes** — the `allow-scripts` iframe (UI scripts) and quickjs WASM (headless schema/
  validation, via the T3.2 worker).
- **Clean-room `TAVERN_SHIM`** — the Tavern-Helper surface MVU front-ends call (extend, don't rebuild).
- **Right panel** — `LayoutRenderer` + `WidgetRegistry` + `CardScriptHost` + live `setLatestFloorVariables`.
- **Per-card permission/enable model** — for gating untrusted lorebook scripts.

The genuinely new work: the **MVU command parser**, the **schema/init layer**, the **nested
schema-driven widgets**, the **clean-room `mvu_zod`**, and **lorebook-borne scripts**.
