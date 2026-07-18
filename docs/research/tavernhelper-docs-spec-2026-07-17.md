# TavernHelper behaviors re-established from first-party docs

Date: 2026-07-17
Author: research agent (docs-only, clean-room)
Issue: `.scratch/st-preset-compat/issues/06-jsr-reestablish.md` (blocks issue 19)

## Method / licensing constraint

TavernHelper / JS-Slash-Runner source is AFPL (non-free); **no `src/` files were read.**
All citations below are from the first-party documentation site
`https://n0vi028.github.io/JS-Slash-Runner-Doc/` (Chinese). Where the docs themselves
merely *link out* to a repo `.d.ts` in the source tree instead of republishing the
content as reference, that is treated as **docs-silent** (the source tree is off-limits),
not as a citation.

Base for all URLs below: `https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/功能详情/`

Each claim group is marked **docs-confirmed**, **partial** (some sub-claims confirmed,
others silent), or **docs-silent** (needs a black-box fixture on the ST+TH oracle rig).

---

## 1. Preset script record shape + folder semantics — **docs-confirmed**

Source: `酒馆助手脚本/获取脚本.html`

The docs republish the `Script` type as public reference:

```ts
type Script = {
  type: 'script';
  enabled: boolean;
  name: string;
  id: string;
  content: string;
  info: string;
  button: { enabled: boolean; buttons: Array<ScriptButton> };
  data: Record<string, any>;
  export_with: { data: boolean; button: boolean };
};
```

Every field the prior report claimed (`enabled`, `name`, `id`, `content`, `info`,
`button`, `data`, `export_with`) is confirmed. Note the extra discriminant
`type: 'script'` and that `button` is an object `{ enabled, buttons[] }`, and
`export_with` is `{ data, button }` (booleans), not a flat flag.

Folder semantics confirmed: `getScriptTrees(option)` returns `ScriptTree[]` where each
node is `Script | ScriptFolder`, with

```ts
type ScriptFolder = {
  type: 'folder'; enabled: boolean; name: string; id: string;
  icon: string; color: string; scripts: Script[];
};
```

Scope selector `option` covers global / preset / character scripts.

---

## 2. Runtime ordering of enabled scripts (ID-sorted vs array order) — **docs-silent**

Source: `酒馆助手脚本/获取脚本.html`, `酒馆助手脚本/创建和修改脚本.html`

The docs describe the tree structure (`ScriptTree[]`, folders contain `scripts: Script[]`)
but **do not state the runtime execution order** of enabled scripts — neither ID-sorted
nor tree/array order is documented. The prior report's "ID-sorted, not array order" claim
is an unverified source-derived hypothesis.

→ **Needs black-box fixture (F1).**

---

## 3. Event surface: names, payload mutability, listener semantics — **partial**

Source: `监听和发送事件.html`

**Confirmed — listener API and semantics:**

- `eventOn(event_type, fn)` — register; auto-runs on emit.
- `eventOnce(event_type, fn)` — fires once then auto-unregisters.
- `eventMakeFirst(event_type, fn)` — adjust listener to run **first**.
- `eventMakeLast(event_type, fn)` — adjust listener to run **last**.
- `eventRemoveListener(event_type, fn)` — unregister.
- `eventEmit(event_type, ...data)` — dispatch.
- `eventEmitAndWait(event_type, ...data)` — dispatch and **await** all handlers.
- Event sources: `iframe_events` and `tavern_events` ("近百种" — nearly 100 tavern
  events); arbitrary custom string events are also supported.

**Docs-silent:**

- The docs do **not** enumerate `CHAT_COMPLETION_PROMPT_READY`,
  `GENERATE_AFTER_COMBINE_PROMPTS`, etc. by name — they link to
  `@types/iframe/event.d.ts` **in the source tree**, which is off-limits under the
  clean-room constraint. Only `MESSAGE_RECEIVED` / `MESSAGE_UPDATED` are named in prose.
- The docs make **no statement about payload mutability**: whether a listener that
  mutates the payload at `CHAT_COMPLETION_PROMPT_READY` (or the combine-prompts event)
  actually changes the outgoing generation data is undocumented. Examples show read-only
  handlers (`message_id => alert(...)`) and neither demonstrate nor forbid mutation.

→ **Needs black-box fixtures (F2, F3).**

---

## 4. Prompt injection API — **partial** (fields confirmed; `once` cleanup timing silent)

Source: `注入提示词.html`

**Confirmed:**

```ts
function injectPrompts(prompts: InjectionPrompt[], options?: injectPromptsOptions): { uninject: () => void };
function uninjectPrompts(ids: string[]): void;
type injectPromptsOptions = { once?: boolean };
```

`InjectionPrompt` fields (all confirmed):

- `id: string`
- `position: 'in_chat' | 'none'` — `'in_chat'` sends to AI; `'none'` suppresses sending
  but **still activates world-book entries**.
- `depth: number` — ordering/priority.
- `role: 'system' | 'assistant' | 'user'`.
- `content: string`.
- `filter?` — sync or async boolean predicate for conditional enablement.
- `should_scan?: boolean` — whether the content participates in world-book scanning
  (this is the report's "scan").

Injections are scoped to the current chat file (*"仅在当前聊天文件中有效"*). Cleanup:
`injectPrompts` returns `{ uninject() }`, plus `uninjectPrompts(ids)`.

**Docs-silent:** the `once` flag is documented as *"是否只在下一次请求生成中有效"* (valid
only for the next generation request), but the **exact cleanup timing is not specified**
— e.g. whether the once-injection is removed after an aborted/failed generation, or only
after a successful completion, is undocumented.

→ **Needs black-box fixture (F4).**

---

## 5. Variable-macro transformation of final generation data — **partial**

Source: `酒馆助手宏.html` (plus `变量/替换或修改变量.html` confirms the manipulation API
does not touch serialization)

**Confirmed:**

- `get_*` family (`{{get_global_variable::x}}`, `get_preset_variable`,
  `get_character_variable`, `get_chat_variable`, `get_message_variable`) render the value
  **as a one-line JSON string**.
- `format_*` family (`format_global_message`, `format_preset_message`,
  `format_character_message`, `format_chat_message`, `format_message_variable`) render
  **as a formatted YAML block**.
- **`$`-prefixed key omission confirmed:** the docs state the macro *"will ignore all keys
  starting with `$`"* so data can be stored in variables *"that should not be seen by AI."*

**Docs-silent:** the docs do not specify (a) string-value pass-through vs JSON-quoting
nuances, (b) object-vs-string handling differences, or (c) the "text-part-only in
multimodal" behavior (that macro substitution applies only to text parts of a multimodal
message). Also, whether the same JSON/YAML/$-omission rules apply to the **final
generation payload** produced by `generate()` (vs only these display macros) is not stated
on the generate page.

→ **Needs black-box fixture (F5).**

---

## 6. `generate({preset_name})` vs active preset + `generateRaw` ordering — **docs-confirmed**

Source: `请求生成.html`

**Confirmed — `preset_name`:**

- `generate()` has `preset_name?: 'in_use' | string`, defaulting to the current active
  preset.
- Explicit quote: *"若设置, 则会用所选预设的提示词及参数, 但**不会**使用所选预设的正则、
  酒馆助手脚本"* — when a preset is selected, its **prompts and parameters** are used but
  its **regex and scripts are NOT activated**. This directly confirms the report's claim.

**Confirmed — `generateRaw` ordering:**

- `generateRaw()` takes `ordered_prompts?: (PlaceholderPrompt | RolePrompt)[]`; no preset
  is applied. Elements are *"按顺序发给 AI"* (sent to AI in array order). Placeholder
  prompts are built-in slots (e.g. `'char_description'`, `'chat_history'`, `'user_input'`);
  if `user_input` is not present in `ordered_prompts` it is auto-appended at the end.

Other confirmed shared config fields: `user_input`, `image`, `should_stream`,
`should_silence`, `generation_id`, `overrides`, `injects: Omit<InjectionPrompt,'id'>[]`,
`max_chat_history: 'all' | number`, `custom_api`, `tools`, `tool_choice`, `json_schema`.

---

## 7. `getPreset('in_use')` shape + persistence durability — **partial**

Source: `预设/获取预设.html`

**Confirmed — shape:**

`getPreset('in_use')` returns the currently-active in-chat preset as a `Preset`:

- `settings` — numeric/boolean params (temperature, token limits, penalties, …)
- `prompts` — active prompt list (ids, roles, positions, enabled states)
- `prompts_unused` — prompts not currently in the list
- `extensions` — extra binding data

Related getters confirmed: `getPresetNames(): string[]`,
`getLoadedPresetName()` (name `'in_use'` was loaded from), `getPreset(name)`. The docs
note `'in_use'` can diverge from the loaded/saved preset because in-chat edits take effect
immediately but are not written back unless explicitly persisted, and are lost on switch.

**Docs-silent:** the get-preset page makes **no mention** of `saveSettingsDebounced`,
`extensionSettings`, or the concrete durability mechanism. (The modify/create/import
preset pages under `预设/` were not needed for the getter shape but should be consulted if
issue 19 needs write-path durability; the getter page alone does not establish it.)

→ **Needs black-box fixture (F6).**

---

## Black-box fixtures required before implementing docs-silent behaviors

These must run against a live **SillyTavern + TavernHelper** install (the oracle rig) —
issue 19 depends on this list. 6 fixtures:

- **F1 (claim 2) — Enabled-script runtime order.** Install 3+ enabled scripts across a
  folder and top level with non-monotonic ids; instrument each to append to a shared log;
  trigger a run and record execution order. Determine: ID-sorted, tree/array order, or
  folder-then-order. Include a disabled script to confirm it is skipped.

- **F2 (claim 3) — Event payload mutability.** Register a listener on the
  prompt-ready / combine-prompts event that mutates the payload (e.g. append a marker to a
  prompt entry). Confirm whether the marker appears in the outgoing generation data.
  Repeat for `eventEmitAndWait` vs `eventEmit`. Establishes whether the payload is a live
  mutable object.

- **F3 (claim 3) — Event enumeration + ordering.** Log every event that fires during one
  full generation, in order, capturing each event's name and payload keys. (Docs point
  only to an off-limits source `.d.ts`; the fired-name set and their firing order must be
  observed, not read.) Also verify `eventMakeFirst` / `eventMakeLast` reorder handlers.

- **F4 (claim 4) — Injection `once` cleanup timing.** Inject with `once: true`; run one
  generation, then a second; confirm removal after the first. Then repeat aborting the
  first generation mid-stream to determine whether an aborted/failed run still consumes the
  once-injection.

- **F5 (claim 5) — Macro serialization edge cases.** With variables holding: a plain
  string, a nested object, an array, and both `$`-prefixed top-level and nested keys —
  capture the exact substituted text for `get_*` (JSON line) and `format_*` (YAML block).
  Confirm: string quoting behavior, nested `$`-key omission depth, and whether substitution
  applies only to text parts when the message is multimodal (image + text).

- **F6 (claim 7) — Preset durability.** After a preset write (setPreset/replacePreset or
  equivalent), reload ST and check whether the change survives (i.e. whether writes are
  debounce-persisted to settings) and confirm the documented `in_use` vs
  `getLoadedPresetName()` divergence when in-chat edits are made without a save.

---

## Summary table

| # | Claim group | Verdict | Fixture |
|---|-------------|---------|---------|
| 1 | Script record shape + folders | docs-confirmed | — |
| 2 | Enabled-script runtime order | docs-silent | F1 |
| 3 | Event surface (names/mutability/listeners) | partial | F2, F3 |
| 4 | Prompt injection API | partial (once-timing silent) | F4 |
| 5 | Variable-macro transformation | partial | F5 |
| 6 | generate preset_name + generateRaw order | docs-confirmed | — |
| 7 | getPreset('in_use') + durability | partial | F6 |
