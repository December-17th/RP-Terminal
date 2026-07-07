# PM-A3 — chat-column glass: token coverage for panel bg/blur

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P1 (小说 mode polish; PM-C* can proceed without it)
Dispatch: opus-4.8/medium
Scope: app

## What

小说 mode needs the NATIVE story column to read as translucent night-glass over the PM-A2
backdrop. Today card themes reach colors + `chat-font`/`prose-font` (see `cardTheme.ts` ALIAS +
guard). Audit what the chat panel's backdrop surface is (ChatView/MessageContent containers in
`index.css`) and add the minimal token(s) — e.g. `--rpt-chat-panel-bg` (accepts rgba) and
`--rpt-chat-panel-blur` — settable from the card `theme` map, with the same guard/sanitization
discipline as the existing tokens (this is the §6a trust model: tokens, not arbitrary CSS).

## Grounding

`src/renderer/src/cardTheme.ts` (+ its test), `src/renderer/src/assets/index.css`, the chat panel
component tree (ground the actual class names — do not guess), `docs/ui-rehaul-design.md` §6a.

## Acceptance

- A card theme token turns the chat column translucent + blurred over the backdrop; absent the
  token, today's opaque look is unchanged in all 3 app themes.
- `cardTheme` test extended. SDK/theme docs updated same commit. Gate green.
- Contrast: prose over the glass at the card's declared values stays ≥4.5:1 (add the check to the
  test with the poem values: glass rgba(18,15,26,.82), text #e9e3d4).
