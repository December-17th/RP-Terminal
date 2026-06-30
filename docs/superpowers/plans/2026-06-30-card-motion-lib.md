# Expose `motion` to card authors (Plan B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the **`motion`** animation library to the card runtime environment as a new assumed env lib (a card-page global), so *card authors* can opt into it — alongside jQuery/-UI, Vue, Pinia, Tailwind, FontAwesome. The native app (incl. DuelView) does NOT use it ("let the card creator decide").

**Architecture:** Add a `MOTION_JS_URL` constant to `src/shared/cardEnv.ts`, then inject it as a classic `<script src>` in **both** transports' lib-tag builders (`buildInlineLibTags` + `buildWcvLibTags` in `src/renderer/src/cardBridge/cardLibs.ts`) **at parity**. Then document the new assumed lib in the SDK docs.

**Tech Stack:** TypeScript; the existing card-env composition; `motion` (motion.dev, MIT) via jsDelivr UMD/global build.

This is **Plan B** of [2026-06-30-duelview-juice-design.md](../specs/2026-06-30-duelview-juice-design.md) §7. Independent of Plan A.

## Global Constraints

- **Both transports at parity.** The inline (`cardBridge`) and WCV (`wcvPreload`) cards must assume the *same* env — add the tag to **both** `buildInlineLibTags` and `buildWcvLibTags`. Never let them drift (the SP2 anti-drift discipline; the existing libs are added to both).
- **CDN, unversioned** (matching the other CDN libs — FontAwesome/jQuery-UI/touch-punch are unversioned jsDelivr, so cards get a consistent build).
- **SDK docs are the contract.** A new assumed env lib is a card-facing surface → document it (per `CLAUDE.md`'s "touch the card-facing surface → update `docs/sdk/`").
- **Verification gate:** `npm run typecheck && npm run check:deps && npm run test`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/cardEnv.ts` (modify) | add `MOTION_JS_URL` constant (CDN) |
| `src/renderer/src/cardBridge/cardLibs.ts` (modify) | inject `MOTION_JS_URL` `<script>` in both `buildInlineLibTags` + `buildWcvLibTags` |
| `docs/sdk/*` + `docs/compat-comparison.md` (modify) | document `motion` as a new assumed env lib |

---

## Task 1: Add `motion` to the card env (both transports)

**Files:**
- Modify: `src/shared/cardEnv.ts`, `src/renderer/src/cardBridge/cardLibs.ts`

- [ ] **Step 1: Confirm the build URL + global name**

`motion` (motion.dev) ships a UMD/iife global build that a classic `<script src>` exposes as `window.Motion`. Open the jsDelivr listing to confirm the exact dist file, then use the standalone global build. Expected: `https://cdn.jsdelivr.net/npm/motion/dist/motion.js` exposing `window.Motion` (`Motion.animate`, `Motion.scroll`, …). Verify the path resolves and the global name before wiring (a quick `curl -sI` on the URL); if the dist filename differs, use the real one.

- [ ] **Step 2: Add the constant** to `src/shared/cardEnv.ts` (beside the other CDN URLs, ~line 44):

```ts
// Motion (motion.dev) — assumed env lib for card-authored animations (the app does NOT use it; cards opt in).
// UMD/global build → window.Motion (Motion.animate/scroll/inView/…). Unversioned, like the other CDN libs.
export const MOTION_JS_URL = 'https://cdn.jsdelivr.net/npm/motion/dist/motion.js'
```

- [ ] **Step 3: Inject it in both lib-tag builders** in `src/renderer/src/cardBridge/cardLibs.ts`:

Add `MOTION_JS_URL` to the import from `'../../../shared/cardEnv'`, then append `jsTag(MOTION_JS_URL)` to **both** arrays (after the existing libs — it has no intra-family ordering dependency):

```ts
// buildInlineLibTags(): … add to the returned array:
    jsTag(piniaUrl),
    jsTag(MOTION_JS_URL)
// buildWcvLibTags(): … add to the returned array:
    jsTag(JQUERY_UI_TOUCH_PUNCH_URL),
    jsTag(MOTION_JS_URL)
```

- [ ] **Step 4: Gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS (a string constant + two tag appends; the characterization tests that pin the env head — if any assert the exact lib-tag string — must be updated in this commit to include the new tag, deliberately, since the env head legitimately changed).

```bash
git add src/shared/cardEnv.ts src/renderer/src/cardBridge/cardLibs.ts
git commit -m "feat(card-env): expose motion (motion.dev) as an assumed card lib (both transports)"
```

> If a characterization test pins `buildInlineLibTags()`/`buildWcvLibTags()` output (search `test/` for `cardLibs`/`buildInlineLibTags`/`libTags`), update its expected string to include the motion tag in the SAME commit — this is a deliberate, correct change to the env surface, not a regression to delete.

---

## Task 2: SDK docs

**Files:**
- Modify: the env-lib inventory under `docs/sdk/` + `docs/compat-comparison.md`

- [ ] **Step 1: Document the new assumed lib**

Find where the assumed env libs are listed (search `docs/sdk/` + `docs/compat-comparison.md` for `Tailwind` / `FontAwesome` / `jQuery` — that's the env/lib inventory). Add **`motion`** there: the global is `window.Motion` (motion.dev), CDN-loaded, available to both inline + WCV cards, **app-provided for card use** (the native app does not depend on it). Mirror the style of the existing Tailwind/FontAwesome entries; note it's an RPT/JSR-env addition.

- [ ] **Step 2: Commit**

```bash
git add docs/sdk docs/compat-comparison.md
git commit -m "docs(sdk): document motion as an assumed card env lib"
```

---

## Self-Review

**Spec coverage:** expose `motion` to cards, not used natively, both transports at parity, SDK-docs obligation (spec §7) → Tasks 1-2. ✓
**Placeholder scan:** one verification point — confirm the jsDelivr dist filename + `window.Motion` global name (Task 1 Step 1) — a concrete read-then-use check, not missing logic. The char-test note (Task 1 Step 4) is conditional with the exact search term. ✓
**Type consistency:** `MOTION_JS_URL` (Task 1 step 2) imported + used in both builders (step 3). ✓

---

## Execution

Two small tasks; independent of Plan A. Gate `npm run typecheck && npm run check:deps && npm run test`. Execute via subagent-driven development or executing-plans.
