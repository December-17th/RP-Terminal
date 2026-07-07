# RF-11 — Floor pager: keyboard paging + jump-to-floor

Status: ready-for-human
Priority: P3

## Problem

The paginated floor stage (one floor per page) is navigable only by the two corner buttons
(`ChatView.tsx:296-318`, `↩`/`↪`). No keyboard paging; the `[3/12]` page indicator is inert; the
only jump affordance is the heavyweight FloorManagerModal.

## Grounding (verified 2026-07-06)

- Page state is local to ChatView: `viewIndex` + derived `page`/`pageCount`
  (ChatView.tsx:64-103). Setter: `setViewIndex`.
- Conflicting UI states that must suppress paging keys: inline edit (`editing !== null`),
  context menu (`menu !== null`), floors modal (`floorsOpen`), and focus inside ANY
  input/textarea/select/contentEditable (the composer is a textarea — typing must never page).
- While `isGenerating`, an effect pins the view to the streaming page (ChatView.tsx:193-195);
  paging BACK during streaming is allowed today via the buttons — keep that equivalence.
- i18n keys `chat.prevFloor` / `chat.nextFloor` exist for the buttons.

## Changes

### 1. Keyboard paging — `ChatView.tsx`

Window keydown effect (deps: page/pageCount/editing/menu/floorsOpen):

- Guard: return if `editing || menu || floorsOpen`, or `e.target` is
  input/textarea/select/contentEditable (use the same `inEditable` helper shape as RF-03 — local
  copy; do NOT import from the workflow components), or any of Ctrl/Alt/Meta is held.
- `ArrowLeft` → `setViewIndex(Math.max(0, page - 1))`; `ArrowRight` →
  `setViewIndex(Math.min(pageCount - 1, page + 1))`. `preventDefault()` only when handled.
- No-op when `pageCount === 0`.

### 2. Jump-to-floor — `ChatView.tsx`

Turn the `floor-pageinfo` span into a button (`title={t('chat.jumpToFloor')}`). Clicking swaps it
for a small `<input type="number" min={1} max={pageCount}>` (local state `jumpOpen`,
autoFocus, width ~56px, className `floor-pagejump`):

- Enter → clamp to `1..pageCount` → `setViewIndex(n - 1)`, close.
- Esc or blur → close without jumping.
- While open, the RF-11 paging keys are naturally suppressed (focus is in an input).

CSS (`index.css`, next to the existing `.floor-pageinfo` rules): style `.floor-pagejump` +
make the pageinfo button keep its current look (it must not gain default button chrome — reuse
the `pager-btn` reset pattern).

### 3. i18n — BOTH locale files

| key | en | zh |
|---|---|---|
| `chat.jumpToFloor` | `Go to floor…` | `跳转至楼层…` |

## Tests

No component harness; logic is trivially thin over `setViewIndex`. Manual journey below.

## User journey (PR description, for the owner pass)

Open a session with several floors → click the stage background → ArrowLeft/ArrowRight page
through floors → click into the composer and press arrows: caret moves, page does NOT → click
`[3/12]` → type 1, Enter → first floor shows → while a response streams, ArrowLeft still lets you
peek back (matches the buttons).

## NON-GOALS

- No swipe-gesture / wheel paging.
- No FloorManagerModal changes.
- No PgUp/PgDn bindings (arrows only, to keep scroll semantics untouched).

## Size budget

≤ 90 lines diff.

## Comments

Implemented 2026-07-06 (RF-11). Diff: 86 insertions across ChatView.tsx (64), index.css (23),
en.ts (1), zh.ts (1) — within the 90-line budget.

- Grounding held: pager JSX now at ChatView.tsx:296-318, state at :60-65, streaming pin at
  :189-195. Only line numbers had shifted (RF-02 landed).
- Section 1: window keydown effect (deps page/pageCount/editing/menu/floorsOpen), all guards in
  place — early return on pageCount===0, inEditable local copy (module-level, matches the workflow
  editors' shape, NOT imported), skips when any of Ctrl/Alt/Meta held, preventDefault only when an
  arrow was handled. Paging back during streaming still works (page/pageCount include the streaming
  page, same as the buttons).
- Section 2: `.floor-pageinfo` span → button (title chat.jumpToFloor); click opens a
  `.floor-pagejump` number input (autoFocus, min 1 / max pageCount, ~56px). Enter clamps to
  1..pageCount and jumps; Esc/blur close without jumping. CSS resets the button's default chrome so
  the indicator keeps its plain-text look; hover brightens it.
- Section 3: chat.jumpToFloor added to both locales (en "Go to floor…", zh "跳转至楼层…").

Gate: `npm run typecheck` OK, `npm run check:deps` OK (389 modules, 0 violations),
`npm run test` OK (2036 passed / 217 files). No component test added — logic is thin over
setViewIndex (per spec); manual journey pending owner pass.
