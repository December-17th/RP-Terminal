# TavernHelper compatibility report - 2026-07-04

This is a point-in-time comparison between RP Terminal's clean-room TavernHelper-like runtime and the
local TavernHelper / JS-Slash-Runner installation at:

`E:\Projects\SillyTavern\data\default-user\extensions\JS-Slash-Runner`

The goal is not to copy TavernHelper. TavernHelper / JS-Slash-Runner is non-free for RP Terminal's
purposes, so this report describes observed behavior and compatibility gaps only. Implementation should
remain clean-room and routed through RP Terminal's shared card runtime.

## Summary

RP Terminal has a useful TavernHelper-compatible subset for the dominant card path: MVU/stat variables,
script/chat card variables, basic chat reads and writes, worldbook CRUD, regex reads/writes for common
display/prompt use, basic generation, event hooks, STScript subset, macros, and RP Terminal-only helpers.

It is not full TavernHelper API parity. TavernHelper's public `TavernHelper` type exposes a much wider
suite: audio playlists/settings, character CRUD, displayed-message helpers, extension/admin management,
model/proxy/stop generation APIs, raw imports, preset/persona CRUD, full variable scopes, and global/char/chat
worldbook rebind APIs. See the public type surface in
`E:\Projects\SillyTavern\data\default-user\extensions\JS-Slash-Runner\@types\function\index.d.ts:8`,
`:21`, `:45`, `:58`, `:68`, `:98`, `:107`, `:118`, `:162`, and `:170`.

The best framing for RP Terminal today is:

- Tier 1: strong support for card-authored panels that use MVU, lorebooks/worldbooks, common regex, basic
  generation, events, and STScript-style variables.
- Tier 2: partial support where names exist but signatures or semantics differ from TavernHelper.
- Out of contract for now: TavernHelper's administrative surface, SillyTavern extension lifecycle, most
  preset/persona/character mutation APIs, and audio playlist/settings APIs.

## Sources checked

RP Terminal:

- `src/shared/thRuntime/index.ts`
- `src/shared/thRuntime/types.ts`
- `src/shared/thRuntime/tavernRegex.ts`
- `src/shared/thRuntime/ops.ts`
- `src/shared/thRuntime/shapes.ts`
- `docs/rpt-api.md`
- `docs/sdk/component-inventory.md`

TavernHelper / JS-Slash-Runner:

- `@types/function/index.d.ts`
- `@types/function/variables.d.ts`
- `src/function/variables.ts`
- `src/function/event.ts`
- `@types/function/chat_message.d.ts`
- `src/function/chat_message.ts`
- `@types/function/tavern_regex.d.ts`
- `src/function/tavern_regex.ts`
- `@types/function/generate.d.ts`
- `src/function/generate/index.ts`
- `@types/function/audio.d.ts`
- `src/function/audio.ts`
- `@types/function/worldbook.d.ts`
- `src/function/worldbook.ts`

## 1. Runtime architecture

### RP Terminal behavior

RP Terminal intentionally centralizes card API behavior in one shared runtime:
`createThRuntime(host)` in `src/shared/thRuntime/index.ts`. The living API docs describe this as the
shared surface used by both inline `cardBridge` and isolated `wcvPreload` transports
(`docs/rpt-api.md:31`, `docs/rpt-api.md:228`). The project-level contract also says transports should
not drift; behavior belongs in `shared/thRuntime`.

The runtime exports both `window.TavernHelper`-style methods and many bare globals. It also exposes
RP Terminal-specific helpers such as `assetUrl` and `getDuelPreview` (`docs/rpt-api.md:171`,
`docs/rpt-api.md:175`).

### TavernHelper behavior

TavernHelper exposes its public suite through `TavernHelper` and mirrored globals. The local public type
surface includes method groups for audio, character, chat messages, extension/admin, generation, imports,
prompts, lorebook/worldbook, macros, presets, personas, regex, variables, and version/worldbook helpers
(`...\@types\function\index.d.ts:8`, `:21`, `:33`, `:45`, `:55`, `:68`, `:75`, `:79`, `:98`, `:101`,
`:118`, `:141`, `:144`, `:157`, `:167`, `:170`).

### Compatibility assessment

The runtime architecture is sound for clean-room parity because both RP Terminal transports inherit the
same implementation. The compatibility gap is API breadth and several behavior mismatches, not the
architecture.

## 2. Variables and MVU

### RP Terminal behavior

RP Terminal's default variable scope is the active message/floor MVU tree, returned as `{ stat_data }`.
This is documented in `docs/rpt-api.md:89` and `docs/rpt-api.md:93`, and implemented in
`src/shared/thRuntime/index.ts:267`.

Supported RP Terminal scopes:

- Default/no option: message stat data, exposed as `{ stat_data }`.
- `{ type: 'script' }`: per-card, cross-chat script KV (`src/shared/thRuntime/index.ts:267`;
  `src/shared/thRuntime/types.ts:72`; `docs/rpt-api.md:98`).
- `{ type: 'chat' }`: per-chat, per-card KV (`src/shared/thRuntime/index.ts:267`;
  `src/shared/thRuntime/types.ts:74`; `docs/rpt-api.md:99`).

Mutation helpers:

- `insertOrAssignVariables(vars)` deep-merges into `stat_data`
  (`src/shared/thRuntime/index.ts:348`, `src/shared/thRuntime/index.ts:353`).
- `insertVariables(vars)` inserts missing leaves only and does not overwrite existing values
  (`src/shared/thRuntime/index.ts:361`, `src/shared/thRuntime/index.ts:365`).
- `replaceVariables(vars, opt)` handles chat scope and default stat data
  (`src/shared/thRuntime/index.ts:373`).
- `updateVariablesWith(updater, opt)` handles script, chat, and default stat data
  (`src/shared/thRuntime/index.ts:383`).

The deep merge behavior was deliberately modeled after TavernHelper's merge semantics in
`src/shared/thRuntime/ops.ts:48`.

### TavernHelper behavior

TavernHelper's variable option type is broader. The local types define normal scopes `chat`, `preset`,
and `global`, plus `character`, `message`, `script`, and `extension` options
(`...\@types\function\variables.d.ts:1`, `:5`, `:13`, `:23`, `:29`, `:35`).

TavernHelper defaults `getVariables(option = { type: 'chat' })` to chat scope
(`...\src\function\variables.ts:96`). Its `insertOrAssignVariables(variables, option = { type: 'chat' })`
and `insertVariables(variables, option = { type: 'chat' })` accept the same option parameter
(`...\src\function\variables.ts:241`, `...\src\function\variables.ts:261`). TavernHelper also exposes
`deleteVariable(...)` (`...\src\function\variables.ts:281`).

### Compatibility assessment

This is a Tier 2 compatibility area.

RP Terminal's merge semantics for the default stat-data use case are close, but the scope model differs:

- RP Terminal default is message/stat data; TavernHelper default is chat.
- RP Terminal accepts options on `replaceVariables` and `updateVariablesWith`, but
  `insertOrAssignVariables` and `insertVariables` currently ignore a second option argument.
- RP Terminal has no equivalent for TavernHelper's preset/global/character/extension variable scopes via
  `getVariables`.
- `deleteVariable` is missing.

Expected TavernHelper-compatible amendments:

- Add `option` handling to `insertOrAssignVariables(vars, option)` and `insertVariables(vars, option)`.
- Add `deleteVariable`.
- Decide whether to preserve RP Terminal's default stat-data behavior as an intentional compatibility
  extension, or add a TavernHelper mode/alias where no-option defaults to chat.

## 3. Events

### RP Terminal behavior

RP Terminal exposes `eventOn`, `eventMakeFirst`, `eventOnce`, `eventEmit`, and `eventRemoveListener`
from the shared runtime (`src/shared/thRuntime/index.ts:324`). The current implementation maps
`eventOnce` to the same handler as normal `on` (`src/shared/thRuntime/index.ts:326`).

Docs describe lifecycle/mutation events, a subset of the ST enum, and MVU event behavior
(`docs/rpt-api.md:151`, `docs/rpt-api.md:152`, `docs/sdk/component-inventory.md:87`).

### TavernHelper behavior

TavernHelper wraps SillyTavern's event source. `_eventOn` uses `eventSource.on`
(`...\src\function\event.ts:77`, `:79`). `_eventOnce` wraps the listener with `{ once: true }` and calls
`eventSource.once` (`...\src\function\event.ts:108`, `:110`). TavernHelper also exposes make-last and
clear helpers (`...\src\function\event.ts:88`, `:145`, `:151`, `:157`), which are registered in its public
surface (`...\src\function\index.ts:223`, `:229`, `:230`, `:231`).

### Compatibility assessment

This includes a concrete behavior bug:

- RP Terminal `eventOnce` currently behaves like `eventOn`, so callbacks can fire repeatedly.
- RP Terminal has no `eventMakeLast`, `eventClearEvent`, `eventClearListener`, or `eventClearAll`.

Expected TavernHelper-compatible amendments:

- Fix `eventOnce` to unregister after the first emission.
- Add the clear/make-last helpers if cards in the supported corpus use them.

## 4. Chat message helpers

### RP Terminal behavior

RP Terminal's `getChatMessages()` returns all mapped floors with no range/options
(`src/shared/thRuntime/index.ts:298`). The docs state that `message_id` is the compact chat-array index
(`docs/rpt-api.md:107`), backed by the canonical floor/message mapping in
`src/shared/thRuntime/shapes.ts:55`.

RP Terminal supports:

- `getChatMessages()` read.
- `getCurrentMessageId()` / `getLastMessageId()`.
- `setChatMessages([{ message_id, message }])`.
- `deleteChatMessages(ids)`, with truncation from the earliest targeted floor rather than arbitrary
  single-message removal (`docs/rpt-api.md:108`).
- `createChatMessages`, currently routed through composer/injection behavior
  (`src/shared/thRuntime/index.ts:458`; `docs/rpt-api.md:272`).

### TavernHelper behavior

TavernHelper's `getChatMessages` accepts message ranges and options:

- `role`
- `hide_state`
- `include_swipes`

These are declared in `...\@types\function\chat_message.d.ts:22`, with overloads at `:56`, `:85`, and
`:101`. The implementation accepts the same options at `...\src\function\chat_message.ts:70` and branches
for `include_swipes` at `:132`.

TavernHelper also supports broader mutation helpers:

- `setChatMessages` (`...\src\function\chat_message.ts:187`)
- `createChatMessages` with insertion options (`...\src\function\chat_message.ts:314`)
- `deleteChatMessages` (`...\src\function\chat_message.ts:385`)
- `rotateChatMessages` (`...\src\function\chat_message.ts:427`; public type at
  `...\@types\function\chat_message.d.ts:229`)

### Compatibility assessment

This is a Tier 2/partial area.

RP Terminal is enough for cards that read the visible transcript and edit recent content by compact id.
It is not equivalent for cards that rely on:

- range expressions such as `-1`, `0-{{lastMessageId}}`, or numeric windows,
- role/hide filtering,
- `include_swipes`,
- true arbitrary insertion,
- true arbitrary deletion,
- `rotateChatMessages`.

Expected TavernHelper-compatible amendments:

- Implement `getChatMessages(range?, options?)` with at least range parsing and `include_swipes`.
- Add `rotateChatMessages` only after deciding how it maps to RP Terminal's floor model.
- Document floor-model limitations where RP Terminal intentionally cannot do exact ST message mutation.

## 5. Regex

### RP Terminal behavior

RP Terminal has a TavernHelper-shaped regex bridge in `src/shared/thRuntime/tavernRegex.ts`. The type
includes source/destination/depth-ish fields (`src/shared/thRuntime/tavernRegex.ts:18`). The bridge notes
that unmodeled fields take defaults (`src/shared/thRuntime/tavernRegex.ts:41`) and currently maps several
fields to defaults such as `slash_command: false`, `world_info: false`, `run_on_edit: false`, and null
depths (`src/shared/thRuntime/tavernRegex.ts:55`).

The runtime exposes:

- `getTavernRegexes`
- `isCharacterTavernRegexesEnabled`
- `formatAsTavernRegexedString`
- `replaceTavernRegexes`
- `updateTavernRegexesWith`

The formatting helper currently takes only the text argument and applies host formatting
(`src/shared/thRuntime/index.ts:320`, `src/shared/thRuntime/index.ts:322`; `docs/rpt-api.md:139`).

### TavernHelper behavior

TavernHelper's `formatAsTavernRegexedString` accepts:

- text
- source: `user_input`, `ai_output`, `slash_command`, `world_info`, or `reasoning`
- destination: display/prompt-style destination
- options such as depth

See `...\@types\function\tavern_regex.d.ts:23`, `:25`, and the implementation at
`...\src\function\tavern_regex.ts:27`.

TavernHelper's regex shape includes and round-trips `run_on_edit`, `min_depth`, and `max_depth`
(`...\@types\function\tavern_regex.d.ts:52`, `:54`, `:55`; implementation mapping at
`...\src\function\tavern_regex.ts:156`, `:158`, `:159`, `:168`, `:184`, `:186`).

### Compatibility assessment

RP Terminal supports the common display/prompt regex path, including scoped read/write. It does not yet
match the full TavernHelper regex API:

- `formatAsTavernRegexedString` ignores source/destination/options.
- slash command, world info, and reasoning source behavior is not modeled.
- `run_on_edit`, `min_depth`, and `max_depth` are not fully round-tripped as TavernHelper behavior.

Expected TavernHelper-compatible amendments:

- Expand `formatAsTavernRegexedString(text, source, destination, options)`.
- Round-trip all fields already represented in RP Terminal's bridge type.
- Add tests for both-destination, display-only, prompt-only, source filtering, and depth filtering.

## 6. Generation

### RP Terminal behavior

RP Terminal supports `generate(text)` and `generateRaw(config)`. The Host contract returns
`Promise<string>` for `generateRaw` (`src/shared/thRuntime/types.ts:83`). The runtime normalizes simple
snake_case/camelCase config and returns text (`src/shared/thRuntime/index.ts:405`,
`src/shared/thRuntime/index.ts:410`). Docs describe `generate` as a visible turn and `generateRaw` as a
one-off completion (`docs/rpt-api.md:127`, `docs/rpt-api.md:128`).

Docs also state that `stopGenerationById` is missing (`docs/sdk/component-inventory.md:85`;
`docs/rpt-api.md:276`).

### TavernHelper behavior

TavernHelper's generation suite includes:

- `generate(config): Promise<string | GenerateToolCallResult>`
- `generateRaw(config): Promise<string | GenerateToolCallResult>`
- `getModelList(custom_api)`
- `getProxyPresetNames`
- `stopGenerationById`
- `stopAllGeneration`
- generation IDs for stop/listen behavior
- tool-call return objects

See `...\@types\function\generate.d.ts:146`, `:199`, `:208`, `:216`, `:223`, `:232`, `:287`, and
`:467`. The implementation registers stop/model functions at `...\src\function\generate\index.ts:43`,
`:71`, `:92`, `:392`, and `:401`.

### Compatibility assessment

RP Terminal supports the normal text-generation path that many cards need. It is not equivalent for cards
that rely on:

- custom API/model enumeration,
- proxy preset enumeration,
- stop/cancel APIs,
- generation IDs,
- tool call results,
- full ordered prompt composition knobs.

Expected TavernHelper-compatible amendments:

- Add stop APIs only if the host generation pipeline can cancel by id safely.
- Consider returning a discriminated string/tool result only after RP Terminal supports tool calls.
- Keep API keys host-side; do not expose custom API secrets to cards.

## 7. Worldbook / lorebook

### RP Terminal behavior

RP Terminal has strong core worldbook support:

- `getWorldbookNames`
- `getCharWorldbookNames`
- `getWorldbook`
- `replaceWorldbook`
- `updateWorldbookWith`
- `createWorldbookEntries`
- `deleteWorldbookEntries`
- `createWorldbook`
- `deleteWorldbook`
- `bindWorldbook`

See `src/shared/thRuntime/index.ts:312`, `:411`, `:413`, `:427`, `:434`, `:449`, and docs at
`docs/rpt-api.md:113`, `:114`, `:115`, `:116`. Entry shape conversion is documented in
`docs/rpt-api.md:117`.

The Host contract returns a new id from `createWorldbook(name)`
(`src/shared/thRuntime/types.ts:95`).

### TavernHelper behavior

TavernHelper exposes additional worldbook binding helpers:

- `getGlobalWorldbookNames`
- `rebindGlobalWorldbooks`
- `getCharWorldbookNames`
- `rebindCharWorldbooks`
- `getChatWorldbookName`
- `rebindChatWorldbook`
- `getOrCreateChatWorldbook`
- `createOrReplaceWorldbook`

See public types at `...\@types\function\worldbook.d.ts:6`, `:13`, `:19`, `:32`, `:48`, `:62`, `:177`,
`:285`, and `:307`. Implementation begins at `...\src\function\worldbook.ts:23`, with chat/global helpers
at `:27`, `:30`, `:50`, `:65`, and `:77`.

TavernHelper also has specific return/error semantics. For example, `getWorldbook` throws if the named
worldbook does not exist (`...\src\function\worldbook.ts:357`), while `createWorldbook` returns false if
the book already exists before delegating to create-or-replace (`...\src\function\worldbook.ts:368`,
`:371`).

### Compatibility assessment

This is one of RP Terminal's stronger areas, but not exact TavernHelper parity.

Gaps:

- Missing global rebind helpers by TavernHelper name.
- Missing char/chat rebind helpers by TavernHelper name.
- Missing `getChatWorldbookName` and `getOrCreateChatWorldbook`.
- Missing `createOrReplaceWorldbook`.
- Return values and missing-worldbook error semantics may differ.

Expected TavernHelper-compatible amendments:

- Add aliases where RP Terminal already has equivalent host behavior.
- Match TavernHelper's return values for create/existing/missing cases where possible.
- Preserve RP Terminal's trusted-card stance and context scoping.

## 8. Audio

### RP Terminal behavior

RP Terminal exposes legacy/stub-style audio helpers:

- `audioImport`
- `audioPlay`
- `audioPause`
- `audioMode`
- `audioEnable`

They are implemented as no-op stubs in the runtime (`src/shared/thRuntime/index.ts:334`) and documented as
stubs with native `<audio>` / WebAudio as the preferred path (`docs/rpt-api.md:180`,
`docs/sdk/component-inventory.md:91`).

### TavernHelper behavior

TavernHelper exposes playlist/settings APIs:

- `playAudio`
- `pauseAudio`
- `getAudioList`
- `replaceAudioList`
- `appendAudioList`
- `getAudioSettings`
- `setAudioSettings`
- `getCurrentAudio`

See public type lines `...\@types\function\index.d.ts:8` through `:15`, and audio-specific declarations at
`...\@types\function\audio.d.ts:29`, `:44`, and `:85`. The implementation starts at
`...\src\function\audio.ts:29`, `:51`, and `:75`.

### Compatibility assessment

RP Terminal is not TavernHelper-compatible for the audio suite. Cards that call TavernHelper audio methods
by name will not work unless they use RP Terminal's stub names or native browser audio.

Expected TavernHelper-compatible amendments:

- If audio compatibility matters, add the TavernHelper method names and implement a scoped playlist layer.
- If not, document audio as intentionally out of contract and keep encouraging native `<audio>` / WebAudio.

## 9. Character, preset, persona, import, and extension/admin APIs

### RP Terminal behavior

RP Terminal docs claim char/preset reads as part of the supported helper surface
(`docs/sdk/component-inventory.md:68`; `docs/rpt-api.md:270`). The runtime has current character/preset
read helpers via host data, but broad CRUD is not part of the current shared helper implementation.

### TavernHelper behavior

TavernHelper public types include:

- Character names/ids/current id and create/delete/replace/update:
  `...\@types\function\index.d.ts:21` through `:30`.
- Displayed-message helpers:
  `...\@types\function\index.d.ts:40` through `:42`.
- Extension/admin helpers:
  `...\@types\function\index.d.ts:45` through `:52`.
- Raw imports:
  `...\@types\function\index.d.ts:68` through `:72`.
- Preset CRUD:
  `...\@types\function\index.d.ts:107` through `:115`.
- Persona CRUD:
  `...\@types\function\index.d.ts:118` through `:128`.

### Compatibility assessment

These APIs are mostly outside RP Terminal's current TavernHelper-compatible contract. That is reasonable
for a standalone app with stricter card scoping, but it should be described as out of contract rather than
"substantially complete" full TavernHelper parity.

Expected TavernHelper-compatible amendments:

- Keep admin/extension install/update APIs out of contract unless there is a deliberate trusted-card
  permission model.
- Add read-only aliases only where RP Terminal already has safe host data.
- Treat import and destructive CRUD APIs as explicit product decisions, not incidental compatibility work.

## 10. STScript, macros, and prompt injection

### RP Terminal behavior

RP Terminal supports a subset of STScript through `triggerSlash` (`src/shared/thRuntime/index.ts:148`,
`src/shared/thRuntime/index.ts:471`). Docs describe support for pipes, closures, macros, chat/global vars,
and commands such as `/gen`, `/genraw`, `/trigger`, and `/send`, while loops and long-tail commands are
missing (`docs/rpt-api.md:132`; `docs/sdk/component-inventory.md:88`).

Macros such as `substituteParams`, `substitudeMacros`, and variable macro forms are documented as supported,
while `registerMacroLike` is not (`docs/rpt-api.md:157`; `docs/sdk/component-inventory.md:90`).

### TavernHelper behavior

TavernHelper exposes prompt injection helpers and `registerMacroLike` in the public type surface
(`...\@types\function\index.d.ts:75`, `:76`, `:98`).

### Compatibility assessment

RP Terminal's subset is probably enough for many declarative cards, but not for cards that assume the full
SillyTavern slash-command ecosystem or runtime macro registration.

Expected TavernHelper-compatible amendments:

- Prioritize commands found in real supported cards.
- Keep `registerMacroLike` blocked until there is a cross-process macro registration model that works in
  both transports.

## 11. Version and initialization helpers

### RP Terminal behavior

RP Terminal documents `getTavernHelperVersion`, `waitGlobalInitialized`, and `errorCatched` as supported
(`docs/rpt-api.md:179`). The runtime exports version/init/toast/error helpers alongside the main helper
surface in `src/shared/thRuntime/index.ts`.

### TavernHelper behavior

TavernHelper exposes version helpers including `getTavernVersion` in its public type surface
(`...\@types\function\index.d.ts:167`) in addition to TavernHelper-specific version/init helpers.

### Compatibility assessment

Mostly adequate for cards that only check "is TavernHelper present/new enough." RP Terminal likely needs
`getTavernVersion` as a harmless alias if cards use it for feature gating.

## 12. Priority recommendations

### P0 - behavior bugs / low-risk compatibility

1. Fix `eventOnce` to behave as a one-shot listener.
2. Add `deleteVariable`.
3. Add `option` support to `insertOrAssignVariables` and `insertVariables`.
4. Add harmless aliases where RP Terminal already has behavior, such as `getTavernVersion`.

### P1 - high-impact supported-card compatibility

1. Implement `getChatMessages(range?, options?)` with ranges and `include_swipes`.
2. Expand `formatAsTavernRegexedString(text, source, destination, options)`.
3. Round-trip regex source/depth/run-on-edit fields where RP Terminal's regex store can represent them.
4. Add worldbook helper aliases: `getChatWorldbookName`, `getOrCreateChatWorldbook`,
   `createOrReplaceWorldbook`, and rebind helpers where safe.

### P2 - larger behavior decisions

1. Decide whether RP Terminal should emulate TavernHelper's variable default of `{ type: 'chat' }` or keep
   RP Terminal's no-option stat-data default as a documented compatibility divergence.
2. Add generation stop APIs only if host generation cancellation can be done safely.
3. Add audio playlist/settings APIs only if the product wants TavernHelper audio compatibility rather than
   native browser audio.

### P3 - likely out of contract

1. Extension install/update/admin APIs.
2. Broad character/preset/persona destructive CRUD.
3. Raw imports that mutate RP Terminal libraries without an explicit trusted-card permission model.

## Suggested compatibility labels

Use these labels in docs and issues:

- `compatible`: same public name and close enough behavior for supported cards.
- `partial`: same public name but reduced signature, reduced scope, or different return/error semantics.
- `aliasable`: missing TavernHelper name, but RP Terminal already has safe equivalent behavior.
- `stub`: exported but no meaningful behavior.
- `out-of-contract`: deliberately unsupported for product/security/licensing reasons.

## Current category status

| Area | RP Terminal status | Main reason |
| --- | --- | --- |
| Shared runtime architecture | compatible | One `createThRuntime(host)` surface backs both transports. |
| MVU/stat-data variables | compatible | Deep merge and insert-if-absent behavior exists for default stat data. |
| General TavernHelper variable scopes | partial | Missing preset/global/character/extension scopes; insert helpers ignore options. |
| Events | partial | `eventOnce` is currently persistent; clear/make-last helpers missing. |
| Chat read/write | partial | Basic read/write exists; ranges, swipes, rotate, arbitrary insert/delete differ. |
| Regex | partial | Common display/prompt path exists; full source/destination/options/depth behavior missing. |
| Generation | partial | Text generation exists; model/proxy/stop/tool-call behavior missing. |
| Worldbook/lorebook | partial-to-strong | Core CRUD is strong; TH rebind aliases and exact semantics missing. |
| Audio | stub/out-of-contract | RP Terminal exposes no-op legacy names, not TH playlist/settings names. |
| Character/preset/persona CRUD | out-of-contract | Mostly absent; likely requires permission/product decisions. |
| Extension/admin APIs | out-of-contract | Unsafe for card-level compatibility by default. |
| Imports | out-of-contract | Library mutation needs explicit product policy. |
| STScript/macros | partial | Useful subset; long-tail commands and `registerMacroLike` missing. |

## Bottom line

RP Terminal is already viable for the main "card-authored UI plus MVU/worldbook/regex/generation" workflow.
It should not be described as full TavernHelper parity. The next best work is to fix the few same-name
semantic mismatches first, then add aliasable safe APIs, and only then decide whether high-risk/destructive
TavernHelper suites belong in RP Terminal's supported contract.
