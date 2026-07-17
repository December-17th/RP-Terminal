# Oracle scenario manifest

**WP-0.4 / ADR 0016.** The written grid the one-time oracle capture drives. This
narrative is the human-facing spec; the machine-readable list the conformance
runner enumerates is [`scenarios.json`](./scenarios.json) — keep the two in sync
(one entry each).

## Invariants for every scenario

- **Target:** SillyTavern **1.18.0** (commit `51ad27f`), the pinned checkout at
  `E:\Projects\SillyTavern`. No other ST version is ever captured (PLAN decision 3).
- **Macro engine:** the **new** engine is ON (PLAN decision 10) — set it before
  capturing (Settings → enable the experimental/new macro engine; fresh-install
  default on 1.18.0).
- **Parity boundary:** assembly-only (PLAN decision 2). Fixtures supply
  preselected World Info entries and a fixed token budget; WI activation and
  tokenizer budgeting are out of scope here.
- **Prose:** RPT-authored + scrambled only (PLAN decision 8). **No** preset words
  are reused. ST's own default template strings are overridden with our text so no
  ST-authored prose can land in a committed fixture — see `overrideTemplates` in
  `scenarios.json` (`impersonation_prompt`, `wi_format`, `scenario_format`,
  `personality_format`, the new-chat / new-example / continue-nudge / group-nudge
  prompts). Set these in ST's Chat Completion presets → *Utility Prompts* before
  capturing. The conformance runner fails if any known ST default string leaks
  into a fixture.
- **Endpoint:** Chat Completion source = *Custom (OpenAI-compatible)*, Custom
  Endpoint = `http://127.0.0.1:8899/v1`. Any non-empty key.

## The grid

Derived from PLAN.md Phase-2 work packages WP-2.1 … WP-2.7 plus a generation-type
axis. `id` matches the fixture filename (`<id>.json`) and the `scenarios.json`
entry.

### WP-2.1 — markers / order / overrides

| id | what it pins |
|----|--------------|
| `wp-2.1-markers-basic` | all structural markers (`worldInfoBefore`/`After`, `charPersonality`, `scenario`) present, default order |
| `wp-2.1-marker-roles-positions` | per-marker role + injection-position overrides |
| `wp-2.1-injection-trigger` | `injection_trigger` includes/excludes a prompt by generation type |
| `wp-2.1-forbid-overrides` | `forbid_overrides=true` blocks a character-card override |
| `wp-2.1-char-card-overrides` | character card overrides `main`/`jailbreak` when allowed |
| `wp-2.1-empty-main` | ST's structural **empty** `main` slot is retained |
| `wp-2.1-duplicate-identifier` | duplicate identifier resolves **first-match** |

### WP-2.2 — in-chat injection

| id | what it pins |
|----|--------------|
| `wp-2.2-depth-injection-order` | same-depth grouping by `injection_order` **descending** |
| `wp-2.2-role-ordering` | same depth+order role grouping (`system`,`user`,`assistant`; final **reverse**) — openai.js:795-868 |
| `wp-2.2-depth-cap` | depth clamped at **10000** |

### WP-2.3 — macros (new engine profile)

| id | what it pins |
|----|--------------|
| `wp-2.3-macro-basic` | `{{user}}`, `{{char}}`, `{{lastUserMessage}}` |
| `wp-2.3-macro-trim` | `{{trim}}` whitespace collapse |
| `wp-2.3-macro-dice` | legacy-space dice `{{roll:1d6}}` (value frozen at capture) |
| `wp-2.3-macro-vars` | scoped variables + operators (`{{setvar}}`/`{{getvar}}`/`{{addvar}}`) |
| `wp-2.3-macro-unknown-literal` | unknown macro preserved **literally** |

### WP-2.4 — regex

| id | what it pins |
|----|--------------|
| `wp-2.4-regex-placements` | placements 3 / 5 / 6 hit the right targets |
| `wp-2.4-regex-phase-selection` | both-flags-false runs only in neither-display-nor-prompt calls (regexTypes.ts:51-58) |
| `wp-2.4-regex-runonedit-captures` | `runOnEdit`, named captures, macro-expanded trim strings |

### WP-2.5 — squashing

| id | what it pins |
|----|--------------|
| `wp-2.5-squash-on` | ST **selective** system-message squashing |
| `wp-2.5-squash-off` | discrete system messages preserved |

### WP-2.6 — SPreset *(needs SPreset loader active in ST; WP-0.5 spec first)*

| id | what it pins |
|----|--------------|
| `wp-2.6-spreset-regexbinding` | `RegexBinding` activation + ordering |
| `wp-2.6-spreset-chatsquash` | `ChatSquash` roles `follow`/`user` (+ disabled config) |
| `wp-2.6-spreset-macronest` | `MacroNest` gating nested macro passes |

### WP-2.7 — EJS profile (Tier 3)

| id | what it pins |
|----|--------------|
| `wp-2.7-ejs-basic` | pinned ST-Prompt-Template basic tags, identity escaper |
| `wp-2.7-ejs-tag-audit` | dense 107-tag QuickJS-subset entry test (scrambled structural corpus) |

### Generation-type axis

| id | what it pins |
|----|--------------|
| `gen-continue` | continue: overridden `continue_nudge_prompt` + prefill |
| `gen-impersonation` | impersonation: overridden `impersonation_prompt`, no ST default |
| `gen-group-nudge` | group: overridden `group_nudge_prompt` placement |

**28 scenarios.** Fixtures land as `test/conformance/fixtures/<id>.json`. Absent
fixtures are enumerated skips in the runner, not failures — capture them
incrementally.
