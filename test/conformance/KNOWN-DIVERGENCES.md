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

## 5. System-message squashing (issue 15 — placeholder)

ST does selective system-message squashing (`squash_system_messages`); RPT currently merges all adjacent
same-role messages. This is closed by issue 15 (WP-2.5); recorded here so it's visible until then.

- **Grounding:** ST `public/scripts/openai.js` (`squash_system_messages` path); RPT
  `src/main/services/promptBuilder.ts` `mergeConsecutiveRoles`.
