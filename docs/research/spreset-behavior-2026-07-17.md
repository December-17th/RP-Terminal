# SPreset — behavioral spec (RegexBinding / ChatSquash / MacroNest)

Status: point-in-time research snapshot (2026-07-17). No product code. Blocks issue 16.
Author of investigation: research agent (issue `05-spreset-research.md`).

## What SPreset is

SPreset ("预设增强" / "PromptFlow — Advanced Prompt Editor") is a **third-party, closed-source
SillyTavern preset-enhancement extension** that is not installed as a normal ST extension. It is
loaded at runtime by a tiny (~701-char) TavernHelper card/preset script (attributed to
**"SoliUmbra"**) that injects a remote loader script into the ST page. That loader fetches and
`eval`/injects the implementation bundle from an anonymous host. Its configuration is carried
**inside presets** under `extensions.SPreset` (and mirrored to a disabled prompt block
`SPresetSettings`), which is why it shows up in the RPT preset corpus.

### Pinned artifacts (owner-approved one-time fetch; read-only, never executed, never copied)

| Artifact | URL | SHA-256 | Size |
|---|---|---|---|
| Core implementation | `https://jnai2d9kgnbs6xzx5c.com/regex_bind/inject.js` | `e130e91be14f50a4d18e8ed039a52a3dac3eea6cf65d8c90607e57ffc7509623` | 130342 B |
| Editor UI (iframe) | `https://jnai2d9kgnbs6xzx5c.com/regex_bind/bundled.html` | `dc05c1cc74fdd1bc37f5ed37ef807cb7d39915501d8b93b10354503876cd3aa6` | 147250 B |

Fetched 2026-07-17. `inject.js` is the behavioral source; `bundled.html` is only the editor
front-end (Tailwind/Roboto UI, loaded into a sandboxed iframe — `iframe.sandbox.add('allow-modals')`,
`inject.js:128`). All line citations below are to the pinned `inject.js` (hash above).

### License determination

**No license.** Neither artifact contains any license, copyright, `@author`, or SPDX string
(grep for `license|copyright|MIT|GPL|author` returns nothing in either file). Distribution is via
an **obfuscated remote injector on an anonymous throwaway domain** with no public repo. Absent an
explicit grant, this is **all-rights-reserved proprietary code**: it may **not** be vendored, copied,
or adapted. Issue 16 must be **clean-room from this behavioral doc only** — do not read `inject.js`
into the implementation context. (Same posture as the js-slash-runner fence in CLAUDE.md.)

---

## Activation & config precedence  (verified)

- On load, SPreset patches `SillyTavern.getContext()` (`ctx`) globals and installs event hooks; it
  also normalizes preset prompts with `role:'model'` → `'assistant'` up front (`inject.js:45-49`).
- **Config source of truth is the extensions namespace, not the prompt block.** `reloadSettings()`
  reads `ctx.chatCompletionSettings.extensions.SPreset` first; the disabled **`SPresetSettings`
  prompt block is only a fallback** — parsed via `JSON.parse(getPrompt('SPresetSettings'))` **only
  when** `extensions.SPreset` is absent or on legacy ST (`inject.js:636-654`). Global (cross-preset)
  regex order lives separately in `ctx.extensionSettings.SPreset` → `SGlobalSettings`
  (`inject.js:652,1528-1530`).
- **Writes update both** the extensions namespace and the prompt block in lockstep: every save does
  `ctx.chatCompletionSettings.extensions.SPreset = SPresetSettings` and then
  `setPrompt('SPresetSettings', …)` (or `addPrompt(...,'SPreset配置',…)` if the block does not yet
  exist) — e.g. `inject.js:488-492, 742-746, 974-978`. So the disabled prompt block is a
  **persistence/portability mirror of the JSON config**, disabled so it never enters the actual
  prompt; it does **not** gate feature activation. Each feature is gated only by its own boolean.
- ST-version gating: reads `/version`, computes `versionNumber = major*10000+minor*100+patch`
  (`inject.js:375-403`); `>= 11305` (ST **1.13.5**) takes the "ST has built-in preset regex binding"
  path (see RegexBinding). It also special-cases display versions `1.13.0`–`1.13.1`
  (`inject.js:401-402`).

---

## RegexBinding  (verified)

Purpose: store ST regex scripts **inside the preset** (`extensions.SPreset.RegexBinding.regexes[]`,
records shaped exactly like core ST regex scripts) and control the **execution order of the three
regex tiers** (global / character / preset).

- **Ordering hook:** at load it monkeypatches `Object.values` (`inject.js:57-73`). When the call
  stack shows ST's `getRegexScripts` (`regex/*.js`) and the value is the 3-element tier array
  `[0,1,2]`, it substitutes `window.__regexScriptOrder`, default **`[2,0,1]` = preset → global →
  character** (`inject.js:61`). So by default **preset-bound regex runs before global and character
  regex.** The order is user-sortable via a "执行顺序 / activation order" panel and persisted to
  `SGlobalSettings.RegexBinding.activationOrder` (`inject.js:1528-1530,1602-1679`). Tier codes:
  `0=全局(global) 1=角色卡(character) 2=预设(preset)` (`inject.js:1603-1607`).
- **Sync model depends on ST version:**
  - ST **≥ 1.13.5** (`versionNumber>=11305`): ST's native `extensions.regex_scripts` is
    authoritative. If ST has scripts, SPreset syncs **from** ST into the preset store and re-saves;
    if ST has none but the preset store does, it migrates **to** ST (`inject.js:1532-1558`). Legacy
    `prompt_order[1].xiaobai_ext.regexBindings.scripts` are migrated in and then nulled
    (`inject.js:1538-1548`). It also strips legacy global-regex entries whose `id` starts with
    `preset_`, whose `scriptName` starts with `[s]`, or that carry a `preset-regex` flag, then
    `reloadCurrentChat()` (`inject.js:1560-1567`).
  - Older ST: SPreset itself owns injection of the preset regexes (the `<11305` branch around
    `inject.js:1905+`, not fully read — mark **partially verified**).
- On preset switch (`oai_preset_changed_after`) it reloads settings and re-syncs regex + tool
  registrations (`inject.js:1585-1600`). It also offers **"regex locking"** (`loadLockedRegexes`,
  `inject.js:1525`) so locked scripts survive preset changes — behavior of the lock set is
  **unverified — needs black-box fixture**.

Implication for RPT: the record shape matches core ST regex exactly, so RPT already understands the
payload; what is SPreset-specific is (a) reading them out of `extensions.SPreset.RegexBinding.regexes`
and (b) the **tier execution order** (default preset-first), which differs from RPT's current
fixed order.

---

## ChatSquash  (verified)

Purpose: post-process the final Chat-Completion message array right before send — **merge adjacent
messages** into one role, re-tag roles, inject/strip separators, add stop strings, and optionally
run a user post-script. This is the heaviest and most security-relevant feature.

- **Hook point:** `ctx.eventSource.makeLast(ctx.eventTypes.GENERATE_AFTER_DATA,
  handleChatCompletionPromptReady)` — registered as the **last** GENERATE_AFTER_DATA listener so it
  mutates `data.prompt` (the outgoing message array) after everything else (`inject.js:1127,1147`).
  Re-armed on `SETTINGS_UPDATED` (`inject.js:1145-1148`). Gated by `ChatSquash.enabled`; when
  disabled it early-returns (only calling an optional `SToolBookPromptCompat` shim)
  (`inject.js:1018-1024`).
- **Conditional activation:** if `conditional_enabled`, squash only runs when `conditional_tag`
  (e.g. `<merge>`) is present in the prompt; the tag is stripped wherever found and, if absent,
  squash is bypassed (`consumeConditionalTag`, `inject.js:1088-1110, 1030-1036`). *(`conditional_enabled`
  / `conditional_tag` keys were not in the original corpus key list — newer than the corpus.)*
- **Two modes:** `separate_chat_history:true` rebuilds `data.prompt` from the promptManager
  collection, squashing **only the `chatHistory` block** and leaving other injected prompts intact
  (`getChat`, `inject.js:1044-1085`); otherwise `squashPrompts(data.prompt)` squashes the whole array
  (`inject.js:1049-1051`).
- **`squashPrompts` merge algorithm** (`inject.js:1172-1331+`):
  - Target role = `role` setting. `role:'follow'` means "adopt the first/segment message's role"
    (`inject.js:1174-1177,1314-1316`); other observed values `assistant`/`system`/`user`.
  - `user_role_system:true` rewrites `system` messages to `user` before merging (`inject.js:1284-1286`).
  - Per-role **affixes** `user_prefix/suffix`, `char_prefix/suffix`, `prefix_system/suffix_system`
    are `substituteParams`-expanded and wrapped around each role segment; consecutive same-role
    messages are joined with `\n` (`inject.js:1185-1194,1321-1330`).
  - **Separators / non-mergeable boundaries:** `enable_squashed_separator` +
    `squashed_separator_string` (literal, or regex when `squashed_separator_regex:true`) marks a
    message as "separate" and strips the marker; `parse_clewd` treats a `<|no-trans|>` marker the
    same way; any message with `tool_calls` or `role:'tool'` is always kept separate
    (`inject.js:1288-1319`). "Separate" messages flush the current merge buffer and pass through
    un-merged.
  - `re_split:true` re-splits merged content back into role messages by scanning for the affix
    prefixes (`reSplitContent`, `inject.js:1199-1266`) — inverse of the merge.
  - Non-text content parts (images/attachments) are swapped out for `<｜attachment｜N｜>`
    placeholders and restored after post-processing (`inject.js:1272-1282,1204,1210`).
- **`postProcess` / `parse_clewd`** (`inject.js:1358-1428`): when `parse_clewd`, runs a "clewd"-style
  transform (`HyperPmtProcess`) that (a) applies inline `<regex order=N>"pat":"rep"</regex>`
  directives found *in the content*, ordered 1→2→3 (`hyperRegex`, `inject.js:1359-1394`), and (b)
  interprets control tokens `<|curtail|>`→newline, `<|join|>`→"", `<|space|>`→space, `<|\..|>`→
  JSON-unescape, plus whitespace normalization (`inject.js:1395-1413`).
- **`squashed_post_script` runs arbitrary JS via `eval`** — `prompt = eval(squashed_post_script)(prompt)`
  with try/catch restoring the original on error (`inject.js:1419-1427`). **Security-relevant:** a
  preset can carry attacker-controlled JS that executes over the outgoing prompt in the ST page
  context. Issue 16 / RPT trust-boundary must decide whether to support, sandbox, or hard-drop this
  key.
- **Stop strings:** on `CHAT_COMPLETION_SETTINGS_READY`, if `enable_stop_string` + `stop_string`,
  it parses `stop_string` as JSON (falling back to a single-element array) and appends to `data.stop`
  (`inject.js:1150-1166`).

---

## MacroNest  (verified)

Purpose: **recursive / nested macro substitution** so macros that expand into other macros get fully
resolved (ST's default `substituteParams` is a single shallow pass).

- **Hook point:** wraps `promptManager.preparePrompt` (`inject.js:407-451`). When
  `SPresetSettings.MacroNest` is false or the prompt has no content, it calls the original
  unchanged; otherwise it builds the prompt and replaces `content` with
  `substituteParamsRecursive(...)` (`inject.js:410-450`).
- **`substituteParamsRecursive`** (`inject.js:523-...`) repeatedly scans left-to-right, resolves the
  **innermost** `{{...}}` first via `ctx.substituteParams("{{inner}}")`, and protects already-resolved
  braces by swapping `{`/`}` for `<|lb|>`/`<|rb|>` sentinels so expansion output is not re-parsed as a
  macro; loops until no `{{...}}` remain, with a `MAX_STEPS = 1_000_000` runaway guard that throws on
  unbalanced/exploding braces (`inject.js:533-566`). Net effect: full nested-macro resolution with
  documented evaluation order (innermost-first, left-to-right).

---

## Also present in the extension (context for issue 16, not in scope title)

- **ToolBindings** (`extensions.SPreset.ToolBindings`): preset-bound LLM tool/function definitions
  registered into ST on `CHAT_COMPLETION_SETTINGS_READY` (`inject.js:469-514, 1168-1170`,
  `syncSPresetToolRegistrations`). Registration/validation detail **unverified** (not fully read).
- **`SToolBookPromptCompat`**: an optional external shim SPreset calls for "seamless prompt
  injection" when squash is off/bypassed (`inject.js:1021,1031-1039`). Provenance **unverified**.

---

## What issue 16 must implement (clean-room, from this doc only)

1. **Config read:** parse `extensions.SPreset` = `{ RegexBinding, ChatSquash, MacroNest,
   ToolBindings }`; treat the disabled `SPresetSettings` prompt block as a **fallback/mirror only**
   (parse it iff `extensions.SPreset` missing). Do not let the block enter the prompt.
2. **RegexBinding:** surface `RegexBinding.regexes[]` (already core-ST-shaped) as preset-scoped regex,
   and honor a **configurable tier order** (default preset→global→character). Decide RPT's stance on
   `activationOrder` and regex-locking.
3. **ChatSquash:** a final-stage (post-everything) message-merge pass over the outgoing array with the
   per-key semantics above. **Explicitly decide the `squashed_post_script` `eval` policy** (RPT
   trust boundary) and the `parse_clewd`/inline-`<regex>`/control-token transform scope.
4. **MacroNest:** an opt-in recursive macro-expansion mode (innermost-first, brace-sentinel guarded,
   step-capped) layered on RPT's existing macro engine.
5. **License posture:** clean-room only; no code from `inject.js` may be read into implementation.

## Verified / unverified split

**Verified against pinned `inject.js`** (hash above, cited by line): config precedence &
prompt-block mirror; RegexBinding tier-order hook + default `[2,0,1]` + ≥1.13.5 sync-from-ST path;
ChatSquash hook (`GENERATE_AFTER_DATA` makeLast), conditional-tag gating, both squash modes, the full
merge/affix/separator/re-split algorithm, `parse_clewd`/postProcess transforms, `squashed_post_script`
`eval`, stop-string injection; MacroNest recursive-substitution hook + algorithm; absence of any
license.

**Unverified — needs black-box fixture / deeper read:**
- Pre-1.13.5 RegexBinding injection path (`<11305` branch ~`inject.js:1905+`) — not read in full.
- Regex "locking" set semantics (`loadLockedRegexes`).
- ToolBindings registration/validation and `SToolBookPromptCompat` provenance.
- The loader script + host (`jnai2d9kgnbs6xzx5c.com`) identity, and whether corpus presets in the
  wild actually carry newer keys (`conditional_enabled`, `re_split`, `user_role_system`) vs. the
  original corpus key list — confirm against real preset fixtures.
- Exact interaction/ordering when RPT's own regex + macro engines run alongside these hooks (RPT has
  no `Object.values`/`GENERATE_AFTER_DATA` equivalent — port the *ordering intent*, not the mechanism).

## Web corroboration (non-authoritative)

Chinese community pages describe SPreset/RegexBinding as "preset-bound regex saved in the preset (not
global), character-independent, lock-on-preset-switch, batch enable/disable/export," and describe the
SoliUmbra loader as an MVU-variable helper — consistent with the source but lower-trust. Sources:
`https://pastebin.com/LneqXPcQ` (raw SPreset config sample), `https://sillytavern.wiki/extensions/regex/`.
