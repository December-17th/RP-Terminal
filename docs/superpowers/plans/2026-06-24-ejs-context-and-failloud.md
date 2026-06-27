# EJS Engine: missing `lastMessageId` + fail-loud on template errors — Plan

> Fixes the confirmed root cause of "the CoT entry isn't triggered" for the 命定之诗 preset: a preset
> conditional references `lastMessageId`, which RPT's EJS engine doesn't provide → `ReferenceError` → the
> engine's `stripTags` fallback leaks **all** branches of every `<% if %>…<% else %>…` entry into the prompt
> (verified against the real quickjs engine). Two real fixes + one deferred fidelity item.

## Background (verified, not assumed)

- RPT's EJS bridge already defines `getvar`/`setvar`/`getchar`/`getwi`/**`matchChatMessages`**/`getPreset`/…
  ([templateEngine.ts:130-227](../../../src/shared/templateEngine.ts#L130)). Context **constants** come from
  `ctx.constants` ([generationService.ts:205-213](../../../src/main/services/generationService.ts#L205)) =
  `{ userName, charName, lastUserMessage, lastCharMessage, chatId, characterId, runType }` — **no
  `lastMessageId`**. ST provides it as `chat.length - 1`
  ([ST-Prompt-Template ejs.ts:261](../../../../../SillyTavern/data/default-user/extensions/ST-Prompt-Template/src/function/ejs.ts)).
- On any eval error, `evalTemplateDetailed` returns `stripTags(template)`
  ([templateEngine.ts:325,333](../../../src/shared/templateEngine.ts#L325)) — which deletes the `<%…%>` tags
  but **keeps every branch body**. Proven: with `lastMessageId` undefined, a 3-branch toggle renders
  `"<|x|>OPENINGMAINELSE"` (all branches), error `'lastMessageId' is not defined`. With the var present the
  same conditional renders exactly one branch.
- ST **throws** on a template error ([ST ejs.ts:197](../../../../../SillyTavern/data/default-user/extensions/ST-Prompt-Template/src/function/ejs.ts)).

## Decisions

1. **Error fallback = fail the turn (owner-confirmed).** A build-time template error must **abort the
   generation** with a **detailed log** (which entry, the reason, the offending source) — never silently
   strip-and-leak. Render-time (displaying a message) stays graceful (empty, never crashes the UI).
2. **`lastMessageId` value** (derived from the preset's `lastMessageId === 1` opening-check + ST semantics):
   the index of the **last message in the assembled chat** = `chatIndexMap(floors).length - (userAction.trim()
? 0 : 1)`. Opening turn (floors = `[greeting]`, a pending user action) → `1 - 0 = 1` ✓; turn 2 → `3`;
   regenerate (no pending action) → last assistant index. `chatIndexMap` is the canonical map already used by
   get/set/delete ([shapes.ts:34](../../../src/shared/thRuntime/shapes.ts#L34)).
3. **`matchChatMessages` fidelity = DEFER.** It already exists and doesn't throw. For THIS preset
   (`matchChatMessages(['【角色信息】'], { start: -1 })` inside `lastMessageId === 1 && …`) the only message on
   the opening turn is the greeting, so RPT's "scan all messages" vs ST's "scan the last" is **functionally
   identical here**. Widening to ST's full `(patterns[], { start, end, role, and })` is a separate fidelity
   task (needs a flat message list + negative-index slicing) — out of scope, noted.

## Files

- `src/main/services/generationService.ts` — add `lastMessageId` (+ cheap siblings `lastUserMessageId`,
  `lastCharMessageId`, `assistantName`) to `ctx.constants`; ensure a thrown template error is logged + surfaced
  as a clean generation failure.
- `src/shared/thRuntime/shapes.ts` — (reuse) `chatIndexMap`; optionally add a tiny `lastMessageIndex(floors,
hasUserAction)` helper so build + any other caller compute it identically.
- `src/shared/templateEngine.ts` — on eval **error**, return `output: ''` (stop the branch-leak everywhere)
  while still returning the detailed `error`. (The `enabled === false` / `!QJS` non-error paths keep
  `stripTags`.)
- `src/main/services/promptBuilder.ts` — render preset blocks **strictly**: use `evalTemplateDetailed`, and on
  `.error` log `{entry name+identifier, reason, source snippet}` then **throw** (fail the turn). The
  graceful-output renders (persona/char-desc) can adopt the same labelled helper.
- `src/renderer/src/plugin/renderTemplate.ts` — render-time stays graceful (now empty-on-error via the engine
  change, no branch leak); optionally seed `lastMessageId` for display consistency (low priority).
- `test/templateEngine.test.ts` (+ `test/promptBuilder*.test.ts` if present) — regression tests below.

---

### Task 1: Provide `lastMessageId` (+ siblings) to the build-time context

- [ ] **Step 1:** in `shapes.ts`, export `lastMessageIndex(floors: FloorLike[], hasUserAction: boolean):
number` = `chatIndexMap(floors).length - (hasUserAction ? 0 : 1)` (clamped ≥ 0). Add `lastUserMessageIndex`
      / `lastCharMessageIndex` (last index in `chatIndexMap` whose slot `isUser` / `!isUser`, adjusted for the
      pending user action).
- [ ] **Step 2:** in `generationService.ts` `ctx.constants`, add `lastMessageId: lastMessageIndex(floors,
!!userAction.trim())`, `lastUserMessageId`, `lastCharMessageId`, and `assistantName: card.data.name || …`.
- [ ] **Step 3:** test (in `shapes`/a small unit): opening (`[greeting]`, hasUserAction) → `lastMessageId ===
1`; turn 2 → `3`; no user action → last assistant index.

**Verify:** `npm test` + typecheck.

### Task 2: Fail-loud on build-time template errors (no more branch-leak)

- [ ] **Step 1:** `templateEngine.ts` — in `evalTemplateDetailed`, change the two error-path returns from
      `stripTags(template)` to `''` (keep `error` populated). Leave the `enabled === false` / `!QJS` paths as
      `stripTags`. This alone stops the all-branches leak in every caller.
- [ ] **Step 2:** `promptBuilder.ts` — add `renderStrict(content, label)`: expand macros, then
      `evalTemplateDetailed`; if `.error`, `log('error', \`Template error in "${label}"\`, \`${error}\n— source:
      ${snippet}\`)` and `throw new Error(\`Template error in "${label}": ${error}\`)`. Use it in the
`preset.prompts`loop as`renderStrict(block.content, block.name || block.identifier)`(and for the major
card renders). Keep the existing`render` for non-fatal helper text if any.
- [ ] **Step 3:** `generationService.ts` — confirm a throw from `buildPrompt` is caught and surfaced as a
      clean turn failure (logged + error returned to the renderer), not an unhandled crash. Add a try/catch around
      the build if needed, mirroring the provider-call error path.
- [ ] **Step 4:** tests — (a) a 3-branch `<% if %>…<% else %>…` with the gate var **set** → exactly one
      branch; (b) with a **missing identifier** → `evalTemplateDetailed.error` is non-null and `output === ''`
      (no leaked branches); (c) `renderStrict` on a bad entry **throws** with the entry label in the message.

**Verify:** `npm test` + typecheck + build. **Manual (Electron):** generate a turn with the 命定之诗 preset →
the `request` log now contains the CoT `think_format` / `Step 0` body and a single `[START THINKING]` block
(no doubled `<thinking>`); a deliberately-broken preset entry fails the turn with a clear logged reason.

---

## Sequencing & acceptance

```
T1 lastMessageId (+siblings) constants  →  T2 fail-loud error handling (engine '' + renderStrict throw)
```

**Acceptance:** the toggle's conditional resolves to one branch (no leaked branches); `lastMessageId === 1`
holds on the opening turn; a template error aborts the turn with a detailed log naming the entry + reason;
render-time never leaks branches or crashes; gate (`typecheck` + `npm test` + `build`) green.

## Risks / notes

- **Fail-loud is a behavior change**: a preset entry that _used_ to silently strip will now abort the turn.
  That's the point (loud > corrupt), but worth a heads-up — the detailed log makes the offending entry
  obvious, and the deferred `matchChatMessages`/other-builtins audit reduces how often it triggers.
- **`lastMessageId` exactness**: the `chatIndexMap`-based value matches ST for the opening-detection this
  preset needs; edge cases (no greeting, group chats, swipes/continue with empty `userAction`) are handled by
  the `hasUserAction` adjustment but should be smoke-checked.
- **Other missing built-ins**: this preset only needs `lastMessageId`. A broader ST-PT context audit
  (`lastUserMessage*`, `getChatMessages`, `execute`, `SillyTavern`, …) is a good follow-up so future cards
  don't hit fail-loud — tracked separately, not in this plan.
- **`matchChatMessages` widening** is deferred (zero impact here); revisit if a preset relies on its
  `{ start/end/role }` scoping.

## Status

DONE (2026-06-24, branch `fix/thinking-reasoning-display`). T1 `acef7be` (`lastMessageId` + siblings in the
build-time constants, derived via `chatIndexMap`/`lastMessageIndex`; +8 shapes tests). T2 `1941f38` (engine
returns `''` on eval error; `promptBuilder.renderStrict` logs + throws on a broken preset block; chatIpc
already surfaces it; +3 promptBuilder tests). Gate green throughout (typecheck + 494 + build). Deferred:
`matchChatMessages` full signature; a broader ST-PT builtins audit. **Pending Electron smoke:** generate a
turn with the 命定之诗 preset — the `request` log should now carry the CoT `think_format` body + a single
`[START THINKING]`, and a deliberately-broken entry should fail the turn with a clear logged reason.

```

```
