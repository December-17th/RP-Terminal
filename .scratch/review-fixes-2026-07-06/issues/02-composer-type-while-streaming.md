# RF-02 — Allow typing in the composer while a response streams

Status: ready-for-human
Priority: P0 (daily-felt UX)

## Problem

`src/renderer/src/components/Composer.tsx:93` sets `disabled={isGenerating}` on the textarea, so
the player cannot compose their next action while a long response streams. SillyTavern allows
typing during generation; the lock makes the app feel frozen on slow turns.

## Grounding (verified 2026-07-06)

- Submission is ALREADY gated independently of the disabled attribute:
  - Enter-to-send checks `if (!isGenerating) submit()` (Composer.tsx:87-90).
  - The send button flips to a stop button while generating (Composer.tsx:95-108).
  - Script-driven submit (`/trigger` → `requestSubmit`) is refused mid-turn at the App level
    (App.tsx:77-82 checks `!st.isGenerating`) — unchanged.
- The composer text is store-owned (`composerStore.text`, see `hooks/useComposer.ts:29-32`), so
  keeping the field enabled has no interaction with streaming state.

## Change

In `Composer.tsx`:

1. Remove `disabled={isGenerating}` from the `<textarea>`.
2. Keep every submit gate exactly as is (Enter gate, stop-button behavior).
3. Slash-command lines: `submit()` runs slash commands instead of generating
   (useComposer.ts:62-74). Mid-generation slash execution is NOT part of this issue — the Enter
   gate above already blocks it; leave it blocked.
4. The send/stop button logic is untouched: while generating it shows ■ (stop) and stays clickable;
   `disabled={!isGenerating && !actionInput.trim()}` already handles the empty-box case.

## Tests

No renderer component test harness exists in this repo (all tests are `test/**/*.test.ts`,
node-env). No new test; note in the PR that this is covered by the manual journey below.

## User journey (PR description, for the owner pass)

Start a generation with a long response → while it streams, click the textarea and type the next
action → text appears normally; Enter does nothing while streaming → when the stream ends, Enter /
send submits the typed action. Also verify the stop button still aborts mid-stream.

## NON-GOALS

- No send-queue ("auto-send when the turn ends") — typing is preserved, submission stays manual.
- No changes to slash-command mid-turn semantics.
- No changes to `StreamingView` or `pendingUserMsg` handling in ChatView.

## Size budget

≤ 10 lines diff, one file.

## Comments

Removed the single `disabled={isGenerating}` line from the `<textarea>` in `Composer.tsx` (1-line
diff, one file). All submit gates left untouched — the Enter gate (`if (!isGenerating) submit()`) and
send/stop button logic still hold. Gates all green: typecheck OK, check:deps (0 violations),
test (214 files / 2019 tests passed). No deviations from spec.
