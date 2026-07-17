# Known divergences from SillyTavern 1.18.0

**ADR 0016** freezes parity to SillyTavern 1.18.0's prompt **assembly**, verified against the oracle
fixtures in `fixtures/`. Parity can be "green" while these enumerated behaviors still differ from ST —
this file is the honest boundary. Each entry: what ST does, what RPT does, why, and where it's grounded.

Seeded by issue 13 (macros, new-engine profile). Add a row whenever a fixtured behavior deliberately
diverges; cite the ST `file:line` and the RPT code/test that pins RPT's side.

Legend: **Scope** — `macro` (issue 13), `assembly` (issues 11–12, 15), `out-of-effort` (tracked backlog,
not in this effort per ADR 0016 decision 2).

---

## 1. Legacy macro engine — not implemented (ADR 0016 decision 10)

RPT implements the **new** macro engine as its single profile (the ST 1.18.0 fresh-install default,
`power_user.experimental_macro_engine`). ST still ships a legacy engine (`substituteParamsLegacy`,
`public/scripts/macros.js`) whose quirks RPT does **not** emulate. These are divergences only for a user
who explicitly switched ST back to the legacy engine.

| # | Behavior | ST legacy | RPT (new-engine profile) | Grounding |
|---|----------|-----------|--------------------------|-----------|
| 1.1 | `{{pick}}` determinism seed | Legacy seeds on chat id + macro raw content + document offset (position-stable per chat). | RPT `{{pick}}` uses the injected RNG like `{{random}}` — **not** position/chat-stable. | ST `core-macros.js:374-406`; RPT `src/shared/macros.ts` (`pick` case shares the `random` branch). |
| 1.2 | Regex-based whole-string macro passes | Legacy runs an ordered list of global regex replacements over the whole string. | RPT runs a bounded multi-pass innermost-first `{{…}}` replace (new-engine-equivalent inside-out nesting). | ST `macros.js` `evaluateMacros`; RPT `src/shared/macros.ts` `expandMacros`. |
| 1.3 | Onboarding / feature sniffing (`{{if}}`, scoped, shorthand) | Legacy path shows onboarding when it detects new-engine-only syntax. | N/A — RPT is always the new profile; no onboarding, and new-only syntax below is simply out of profile. | ST `script.js:2790-2803`. |

## 2. New-engine features intentionally out of RPT's macro profile (issue 13)

These are new-engine behaviors RPT does not (yet) implement. They fall outside the corpus-required set
(`{{lastUserMessage}}`, `{{trim}}`, legacy-space dice, scoped var reads, unknown-passthrough,
case-insensitivity, comments, marker preprocessing, brace-unescape, `{{original}}`) and are recorded so
a preset relying on them is a known miss, not a silent bug.

| # | Feature | ST new engine | RPT | Grounding |
|---|---------|---------------|-----|-----------|
| 2.1 | Variable-shorthand operators (`{{.hp++}}`, `{{$g \|\|= x}}`, `{{.v == 3}}`) | Full operator grammar in the lexer/parser. | Not implemented — RPT supports only `{{setvar}}/{{addvar}}/{{getvar}}` + `{{get_X_variable}}`. Fixtured via the classic set (`wp-2.3-macro-vars`). | ST `MacroLexer.js:116-147`; RPT `src/shared/macros.ts`. |
| 2.2 | Scoped / block macros (`{{if}}…{{/if}}`, `{{else}}`, scoped `{{trim}}…{{/trim}}`, `#` preserve-whitespace flag) | Full CST-walked scoped blocks. | Not implemented — only **non-scoped** `{{trim}}` (post-processor removal) is supported. A stray `{{/if}}` scoped-close is left literal (unknown-passthrough). | ST `core-macros.js:130-233`, `MacroEngine.js:372-413`; RPT `src/shared/macros.ts` (`trim` case + post-processor). |
| 2.3 | Output filters / pipes (`{{>macro \| upper}}`) | `FilterFlag` + pipe grammar. | Not implemented — a `\|` inside a macro is left as literal arg text. | ST `MacroLexer.js:68,89-95`. |
| 2.4 | `{{time::UTC±N}}` offset | Preprocessor rewrites `{{time_UTC-10}}`→`{{time::UTC-10}}`, offset honored. | `{{time}}`/`{{date}}` return local time/date; the UTC offset arg is ignored (best-effort, unchanged from prior RPT). | ST `MacroEngine.js:278-281`; RPT `src/shared/macros.ts` (`time`/`date` cases). |
| 2.5 | `{{roll::0}}` (zero-sided) | `0`→`1d0`; droll rejects `d0` → warns, returns `''`. | Same result (`''`) — but note this diverges from RPT's *pre-issue-13* behavior, which returned `'0'`. Deliberate: matches ST. | ST `core-macros.js:322-331` + `droll.js:62`; RPT `src/shared/macros.ts` `roll`. |
| 2.6 | Full chat-introspection macros (`{{lastMessage}}`, `{{lastCharMessage}}`, `{{lastMessageId}}`, swipe/context ids) | Registered chat macros. | Only `{{lastUserMessage}}` is threaded (corpus-required). The rest are unknown-passthrough until a fixture needs them. | ST `chat-macros.js:9-100`; RPT `src/shared/macros.ts` + `promptBuilder.ts` `lastUserMessage`. |

## 3. Assembly ordering — depth-0 trailing user action (issue 12)

At **depth 0**, ST's `populationInjectionPrompts` splices the injected role messages at reversed-array
index 0 and, after the final whole-array reverse, they land **after** the newest chat message — i.e. an
injection can appear *below* the trailing user turn.

- **ST:** depth-0 injections may sit after the last user message.
- **RPT:** keeps a trailing **user action last** (the L4-last invariant, so the live input is always the
  final message the model sees). A depth-0 injection lands just *before* that trailing user action instead.
- **When they agree:** with no pending user turn (e.g. a `continue` on an assistant tail), both append the
  depth-0 injection at the very bottom — see fixture `fixtures/wp-2.2-depth-zero.json`.
- **Grounding:** ST `public/scripts/openai.js:858-864` (splice + final reverse); RPT
  `src/main/services/promptBuilder.ts` (history builder appends `userAction` last); ADR 0016.

## 4. Assembly-only parity boundary — out of this effort (ADR 0016 decision 2, PLAN §Non-goals)

Oracle fixtures **supply** these as inputs; RPT keeps its own engines, and their divergences from ST are
tracked backlog, not chased here.

| # | Area | ST | RPT | Status |
|---|------|-----|-----|--------|
| 4.1 | World Info activation (recursion, probability, sticky/cooldown, inclusion groups, scan depth) | ST's WI engine selects entries. | RPT's own lorebook activation selects entries; the oracle **feeds pre-activated** entries so assembly can be compared in isolation. | out-of-effort — separate future effort (PLAN decision 2). |
| 4.2 | Tokenizer-aware budgeting | ST trims by exact model tokenizer under a token budget. | RPT uses a char-estimate budget (`estimateTokens`); the oracle supplies a **fixed** `tokenBudget`. | out-of-effort — separate future effort (PLAN decision 2). |

## 5. System-message squashing — squash OFF keeps RPT merge-all (issue 15 / WP-2.5)

ST's `squashSystemMessages` (openai.js:3827-3866) runs ONLY when `oai_settings.squash_system_messages`
is true (openai.js:1599-1601). RPT implements that squash faithfully (`squashSystemMessages` in
`src/main/services/promptBuilder.ts`) and applies it for an imported ST preset whose flag is `true`
(`providerShape`, opt-in via `preset.squash_system_messages`). One deliberate divergence remains for the
squash-**off** case:

- **ST (squash off):** no squashing at all — adjacent unnamed system messages stay discrete.
- **RPT (squash off, AND native presets):** keeps its merge-all `mergeConsecutiveRoles`, so adjacent
  same-role messages coalesce. Retained on purpose — it fixes the split-block (`<X_setting>` open / body /
  close as separate system entries) coalescing symptom the merge-all was added for, and reverting it for
  imported-squash-off presets would resurrect that. ST's default is squash **off** (openai.js:488), so
  most imports hit this path; making them ST-off-faithful (no merge) would broadly regress existing imports.
- **When they agree:** with `squash_system_messages: true`, RPT applies ST's SELECTIVE squash exactly —
  consecutive unnamed system messages merged with `\n`, empties dropped, protected control identifiers and
  named system messages preserved, user/assistant untouched (fixture `fixtures/wp-2.5-squash-on.json`, and
  the `providerShape` / `squashSystemMessages` unit tests).
- **Grounding:** ST `public/scripts/openai.js:3827-3866` + `:1599-1601`; RPT
  `src/main/services/promptBuilder.ts` (`squashSystemMessages`, `mergeConsecutiveRoles`),
  `src/main/services/generation/providerShape.ts` (stage-A selector); fixtures `wp-2.5-squash-off.json`,
  `wp-2.5-squash-on.json`.

## 6. SPreset (RegexBinding / ChatSquash / MacroNest) — clean-room, partial (issue 16 / WP-2.6)

SPreset is closed-source, remote-loaded, unlicensed; RPT reimplements it **clean-room from the pinned
behavioral spec** (`docs/research/spreset-behavior-2026-07-17.md`) — no SPreset source is read into the
implementation. Config source of truth is `extensions.SPreset` (the disabled `SPresetSettings` prompt
block is a mirror fallback, parsed only when the namespace is absent). Each feature gates on its own
boolean. Implemented in `src/shared/spreset.ts` + assembly hooks; kept a DISTINCT namespace from core
regex everywhere (storage `origin:'spreset'`, inventory `spresetRegex`, execution-record kind
`spreset-regex`).

Implemented (spec-VERIFIED): **RegexBinding** — bound regexes installed as preset-scoped regex +
`preset-first` tier order (spec default `[2,0,1]`, an ordering-MODE selection, not the upstream
`Object.values` monkeypatch). **ChatSquash** — role-based adjacent merge (`role`/`follow`, per-role
affixes, separators, `user_role_system`, conditional-tag gating) + stop-strings. **MacroNest** —
`false` ⇒ single non-nesting macro pass, `true`/absent ⇒ RPT's default nesting cap (issue 13).

| # | SPreset feature | Upstream | RPT | Grounding |
|---|-----------------|----------|-----|-----------|
| 6.1 | `ChatSquash.squashed_post_script` | Runs arbitrary JS via `eval(script)(prompt)` in the ST page context. | **NEVER run.** RPT has no raw-eval path; when a preset enables it, it surfaces as an import diagnostic (toast `preset.inv.spresetUnsupported`), inventory `unsupportedSpreset`. | spec §ChatSquash (`inject.js:1419-1427`); ADR 0017; RPT `spresetUnsupportedCapabilities`. |
| 6.2 | `ChatSquash.parse_clewd` / inline `<regex>` / control tokens | "clewd" transform over merged content. | Not implemented — diagnostic + black-box-fixture TODO (corpus-unused / newer-than-corpus per spec). | spec §ChatSquash (`inject.js:1358-1413`); RPT `spresetUnsupportedCapabilities`. |
| 6.3 | `ChatSquash.re_split` | Re-splits merged content back into role messages by scanning affixes. | Not implemented — diagnostic + TODO. | spec §ChatSquash (`inject.js:1199-1266`). |
| 6.4 | `ChatSquash.separate_chat_history` | Squashes ONLY the chatHistory block, leaving other injected prompts intact. | RPT applies **whole-array** squash; the history-region distinction is not modeled (RPT has no `promptManager` collection at the shaping seam). Diagnostic + TODO. | spec §ChatSquash (`inject.js:1044-1085`); ADR 0016 (port ordering intent, not mechanism). |
| 6.5 | ChatSquash stop-strings | Appended to `data.stop` on `CHAT_COMPLETION_SETTINGS_READY`. | Parsed (JSON, single-element fallback) and forwarded as `params.stop` — on the **OpenAI-compatible** path only (`cleanParams` spread); Anthropic/Gemini map params explicitly and ignore it. | spec §ChatSquash (`inject.js:1150-1166`); RPT `resolveStopStrings`, `apiService`. |
| 6.6 | RegexBinding pre-1.13.5 injection path + regex "locking" | Older-ST branch owns injection; `loadLockedRegexes` survives preset switches. | Not modeled — spec marks these **unverified** (needs black-box fixture). RPT installs bound regex at import + selects the tier order; lock-on-switch is out of scope. | spec §RegexBinding "Unverified"; issue 16 acceptance (unverified ⇒ TODO, not guessed). |
| 6.7 | MacroNest recursion cap | `substituteParamsRecursive` loops to `MAX_STEPS = 1_000_000`. | Mapped onto RPT's pass-count engine: `true`/absent ⇒ default nesting cap (5 passes, issue 13); `false` ⇒ 1 pass. A macro nested deeper than RPT's cap under-resolves vs SPreset's near-unbounded loop. | spec §MacroNest (`inject.js:523-566`); RPT `src/shared/macros.ts` (`maxPasses`). |

- **Grounding:** RPT `src/shared/spreset.ts`, `src/main/parsers/stPresetParser.ts` (projection),
  `src/main/services/presetService.ts` (install + inventory), `src/main/services/regexService.ts`
  (tier-order mode), `src/main/services/generation/{assemble,providerShape}.ts`; fixtures
  `wp-2.6-spreset-regexbinding.json`, `wp-2.6-spreset-chatsquash.json`, `wp-2.6-spreset-macronest.json`;
  unit tests `test/spreset.test.ts`, `test/regexOrder.test.ts`, `test/presetInventory.test.ts`.

## 7. World Info before/after — distinct messages vs one combined blob (issue 11 / WP-2.1)

RPT now applies ST's per-marker FORMAT strings for imported presets — a BARE `charDescription`
(openai.js:1369), `stringFormat(wi_format, …)` on the World Info marker (`formatWorldInfo`,
openai.js:780-792), and `substituteParams(personality_format|scenario_format)` on the personality/scenario
markers (openai.js:1359-1360). Those match ST. What does NOT match is how the two World Info markers are
POPULATED.

- **ST:** `worldInfoBefore` (↑Char) and `worldInfoAfter` (↓Char) are DISTINCT default markers
  (openai.js:1367-1368); ST activation places each entry into one slice, and both slices render as their
  own messages at their own ordered positions/roles.
- **RPT:** `LorebookEntry` has no ST `position`, so assembly computes ONE combined `worldInfo` blob (from
  `partitionLore`/`topEntries`) rendered at the first before-slot (`world_info` or `world_info_before`).
  `world_info_after` renders the blob ONLY as a fallback when there is no before-slot at all. RPT therefore
  cannot split matched lore into distinct before/after messages.
- **When they agree:** a single before-slot slice (or an after-only slice with no before-marker). The
  marker fixtures `wp-2.1-markers-basic` (single `before_char`) and `wp-2.1-marker-roles-positions`
  (single `after_char`, no before-marker → after-fallback) are authored to that convergent case so their
  `expected.chat` stays a true ST oracle; the split itself is not exercised.
- **Grounding:** ST `public/scripts/openai.js:1367-1368` (distinct markers) + `:780-792` (`formatWorldInfo`);
  RPT `src/main/services/promptBuilder.ts` (`world_info_before`/`world_info_after` cases, `renderWorldInfo`,
  the single `worldInfo` blob), `docs/adr/0016`. Scope — `assembly`.

## 8. In-chat injection depth beyond MAX — RPT clamps, ST drops (issue 12 / WP-2.2)

- **ST:** `populationInjectionPrompts` loops `i = 0..getExtensionPromptMaxDepth()` (MAX_INJECTION_DEPTH =
  10000, `script.js:499`; `getExtensionPromptMaxDepth` returns MAX with NO clamp, `script.js:3222-3223`)
  and keeps only `prompt.injection_depth === i` (openai.js:813). A block at a depth that matches no `i`
  — i.e. depth > MAX — is DROPPED entirely (never injected).
- **RPT:** clamps the injection index into the conversation region
  (`idx = max(start, min(base − depth, maxIdx))`, `promptBuilder.ts`), so a depth > MAX is injected at the
  TOP of the chat region instead of being dropped.
- **When they agree:** any depth ≤ MAX. At depth == MAX (10000) both inject at the top after ST's final
  whole-array reverse — the convergent value fixture `wp-2.2-depth-cap` pins.
- **Grounding:** ST `public/scripts/openai.js:801-864` (loop + splice + final reverse), `:813` (`=== i`
  filter), `script.js:499` + `:3222-3223`; RPT `src/main/services/promptBuilder.ts` (depth splice-plan
  clamp). Scope — `assembly`.
