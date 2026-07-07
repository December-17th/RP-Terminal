# RF-12 — Keyboard behavior for the TopStrip dropdowns (StripMenu)

Status: ready-for-human
Priority: P3

## Problem

`StripMenu` (`TopStrip.tsx:20-49`) has correct ARIA attributes (`aria-haspopup`, `aria-expanded`,
`role="menu"`, `menuitemradio/checkbox` on items) but no keyboard behavior: no arrow-key
traversal, Esc doesn't close (only the invisible backdrop click does), and focus isn't managed —
the ARIA promises a menu the keyboard can't operate.

## Grounding (verified 2026-07-06)

- All menu items are `<button class="tmenu-item ...">` children of the `div.tmenu` popover —
  querySelectorAll on the container is a reliable item enumeration (LorebookMenu / preset menu /
  openAction all conform).
- The Lorebook menu intentionally STAYS OPEN on item toggle (multi-select, TopStrip.tsx:51-54) —
  keyboard activation (Enter/Space on a focused item) must not force-close either; only the
  handlers that call `close()` close.
- The trigger button is the natural focus-return target.

## Changes — all inside `StripMenu` (TopStrip.tsx)

1. Refs: `triggerRef` (the `tmenu-btn`), `menuRef` (the `div.tmenu`).
2. On open: focus the first `.tmenu-item` in `menuRef` (effect on `open`, `requestAnimationFrame`
   for post-render focus).
3. `onKeyDown` on the `div.tmenu`:
   - `ArrowDown`/`ArrowUp`: move focus to next/previous `.tmenu-item` (wrap around);
     `preventDefault()`.
   - `Home`/`End`: first/last item.
   - `Escape`: `close()` + `triggerRef.current?.focus()`; `preventDefault()` + `stopPropagation()`
     (nothing above the strip listens for Esc in play mode, but don't leak).
   - `Tab`: `close()` (let focus move on naturally — no trap).
4. On the trigger button: `ArrowDown` when closed opens the menu (same as click).
5. When the menu closes for ANY reason while focus is inside it, return focus to the trigger
   (effect on `open` false edge, guard `menuRef.current?.contains(document.activeElement)`).
6. Enter/Space on a focused item: native button activation — no code needed; verify the
   lorebook checkbox items keep the menu open (they don't call `close()`).
7. No markup/CSS changes beyond the two refs; visible focus: `.tmenu-item:focus-visible` gets the
   same treatment as `:hover` in `index.css` (one selector addition if hover-only today — check).

## Tests

No component harness; manual journey below. (Do NOT extract a model for this — it's 40 lines of
focus plumbing, not logic.)

## User journey (PR description, for the owner pass)

Play mode → Tab to the Preset trigger → ArrowDown opens with the first item focused → arrows wrap
through items → Enter selects a preset and closes (its handler calls close) → reopen the Lorebook
menu → Enter toggles a book and the menu STAYS open → Esc closes and focus lands back on the
trigger.

## NON-GOALS

- No typeahead, no `aria-activedescendant` rework (roving focus on real buttons is fine).
- No changes to menu contents or the backdrop-click behavior.
- Not touching the Settings rail or ContextMenu (separate widgets).

## Size budget

≤ 80 lines diff, one file (+ ≤3 CSS lines).

## Comments

Implemented 2026-07-06 on branch `claude/nifty-mcclintock-6e6a1b`. All 7 points landed inside
`StripMenu` (TopStrip.tsx) plus one CSS selector:

- Refs `triggerRef` (tmenu-btn) + `menuRef` (div.tmenu).
- Open effect focuses first `.tmenu-item` via `requestAnimationFrame` (cleaned up with
  `cancelAnimationFrame`).
- `onMenuKeyDown` on `div.tmenu`: ArrowDown/ArrowUp with wrap (`preventDefault`), Home/End,
  Escape → `close()` + refocus trigger (`preventDefault` + `stopPropagation`), Tab → `close()`
  (no trap).
- Closed-trigger `onKeyDown`: ArrowDown opens (`preventDefault`).
- Close-edge effect: returns focus to trigger only when `menuRef.current.contains(activeElement)`.
- Enter/Space = native `<button>` activation; verified lorebook checkbox items only call
  `toggle` (no `close()`), so the menu stays open on toggle.
- CSS: added `.tmenu-item:focus-visible` sharing the `:hover` background (was hover-only).

Grounding matched the spec exactly (RF-10's Workflow button is a plain `tmenu-btn`, not a
StripMenu, so no interaction). Gate: typecheck ✓, check:deps ✓ (no violations), test ✓
(217 files / 2036 tests). No i18n keys needed. Diff well under the 80-line budget.
