# RF-05 — Localize panel view titles + add a locale-parity test

Status: ready-for-human
Priority: P2 (CLAUDE.md i18n rule violation; land early if parallelizing — its test guards later issues)

## Problem

1. `src/renderer/src/components/workspace/viewRegistry.tsx:90-98` hardcodes English titles
   (`'Chat'`, `'RPG Status'`, `'Combat'`, `'Duel'`, `'Variables'`, `'Tables'`, `'Usage'`, `'Logs'`),
   and `Panel.tsx:10-15` maps only 4 of the 8 built-in views to i18n keys — Combat / Duel /
   Variables / Tables display English in the 简体中文 locale, in every panel's view picker.
2. Locale parity is currently perfect (991 keys in each file, verified by diff on 2026-07-06) but
   nothing enforces it — one forgotten key silently ships an untranslated string.

## Grounding (verified 2026-07-06)

- `VIEW_LABEL_KEY` (Panel.tsx:10-15) currently maps: chat→`view.chat`, status→`status.heading`,
  usage→`view.usage`, logs→`logs.heading`. So `view.chat` / `view.usage` keys already exist.
- Locale files are plain `Record<string, string>` TS objects
  (`src/renderer/src/i18n/locales/en.ts`, `zh.ts`) — directly importable in a node-env vitest.
- Interpolation uses `{{var}}` (en.ts:1 header comment).
- Card-promoted panels (`p.scriptName`) keep their author-given names — NOT localized.

## Changes

### 1. Keys — BOTH locale files

| key | en | zh |
|---|---|---|
| `view.combat` | `Combat` | `战斗` |
| `view.duel` | `Duel` | `决斗` |
| `view.variables` | `Variables` | `变量` |
| `view.tables` | `Tables` | `表格` |

### 2. `Panel.tsx`

Extend `VIEW_LABEL_KEY` with the four new mappings (`combat`, `duel`, `variables`, `tables`).
Keep `status.heading` / `logs.heading` reuse as-is. The fallback branch
(`o.title` for unknown/card views) stays.

### 3. Do NOT touch `viewRegistry.tsx`

Its `title` field remains the English fallback for unknown/spike views — the localization layer is
`VIEW_LABEL_KEY`, matching the existing pattern. (Changing the registry to hooks would break its
"no-props component registry" design.)

### 4. Parity test — NEW `test/i18nParity.test.ts`

```ts
import en from '../src/renderer/src/i18n/locales/en'
import zh from '../src/renderer/src/i18n/locales/zh'
```

(Check the actual export style first — default vs named — and match it.)

1. Key sets are identical in both directions (report the exact missing keys in the assertion
   message, not just a count).
2. No empty-string values in either locale.
3. Per key, the SET of `{{var}}` interpolation names is identical between en and zh.

### 5. `VIEW_LABEL_KEY` coverage guard (same test file)

Assert every id in `ViewRegistry` has a `VIEW_LABEL_KEY` entry — imports from
`viewRegistry.tsx`/`Panel.tsx` pull React; if that breaks node-env vitest, move `VIEW_LABEL_KEY`
into a tiny non-React module (e.g. `workspace/viewLabels.ts`) imported by both Panel.tsx and the
test. Stop and report if neither works cleanly.

## User journey (PR description, for the owner pass)

Switch Settings → Preferences → language to 简体中文 → open any panel's view picker → all eight
built-in entries show Chinese; a card-promoted panel keeps its card-given name.

## NON-GOALS

- No localization of card-supplied panel names.
- No key renames or sweeping i18n refactors — four keys + one map + one test.

## Size budget

≤ 120 lines diff (incl. the test).

## Comments

**Done 2026-07-06** (branch `claude/nifty-mcclintock-6e6a1b`).

Changes:
- Added `view.combat` / `view.duel` / `view.variables` / `view.tables` to BOTH `en.ts` and `zh.ts`
  (Combat/Duel/Variables/Tables ↔ 战斗/决斗/变量/表格).
- New `test/i18nParity.test.ts` with the three parity assertions (bidirectional key-set equality with
  named-key failure messages, no empty values, per-key `{{var}}` set equality) plus the `VIEW_LABEL_KEY`
  coverage guard.

Deviation from the "extend VIEW_LABEL_KEY in Panel.tsx" wording — took the spec's **fallback** import path:
importing `viewRegistry.tsx`/`Panel.tsx` into a node-env test pulls the full React view tree, so I
extracted `VIEW_LABEL_KEY` into a new non-React module `src/renderer/src/components/workspace/viewLabels.ts`
(which also exports `BUILTIN_VIEW_IDS`). `Panel.tsx` now imports `VIEW_LABEL_KEY` from there; `viewRegistry.tsx`
pins `ViewRegistry` to `Record<BuiltinViewId, ViewEntry>` so the id list and registry can't drift.
`viewRegistry.tsx` itself was otherwise untouched (its English `title` fallbacks stay, per §3).

Gate (all green): `npm run typecheck` ✓, `npm run check:deps` ✓ (no violations, 388 modules),
`npm run test` ✓ (215 files / 2023 tests).
