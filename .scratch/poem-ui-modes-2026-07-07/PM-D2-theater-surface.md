# PM-D2 — 剧场 surface build (beat parser + ADV band + plates + composer)

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P1
Dispatch: opus-4.8/medium
Scope: card v4 surface (new file `docs/sdk/examples/poem-theater-surface.html`)

## What

剧场 mode as ONE full-viewport WCV variant (PM-A1 variant with a single slot `[0,0,12,12]`; no
native chat visible — the surface renders everything, so there are no seams and no z-order
constraints by construction).

- **Beat parser (card-side JS):** split the latest AI floor into beats — `「…」` quotes become
  dialogue beats attributed to the nearest preceding `关系列表` name in the paragraph; everything
  else is narration (v4 doc §4). Robust path (`stage.dialogue = [{who,text}]` written by a
  workflow extractor) is OPTIONAL: consume it when present, fall back to the parser.
- **Presentation:** per PM-D1's approved mock (fade-in beats, gilt plates, 26vh band, advance/
  auto/skip, choices overlay, "show full text" fallback). Streaming: reveal beats as the floor
  streams if the update events allow (ground how `message_updated` fires during streaming —
  read the actual event plumbing in `shared/thRuntime`; don't guess).
- **Reading floors + sending input:** ground the REAL runtime surface first —
  `src/shared/thRuntime/` and `docs/sdk/` for: reading chat messages/floors, `setInputText`/
  send-triggering (the repo has prior work: branches `fix/slash-setinput-send-trigger`,
  `fix/trigger-is-send-button`), and choice-click → send. If the documented subset can't send
  user input from a WCV, STOP and report the exact missing capability.
- HUD row + world chips per the mock; theme via `poem-themes.css`; listens `poem:theme`.

## Verification

Standalone with a canned multi-beat floor (mock fallback); then controller wires it into the
variant for an in-app owner pass.

## Acceptance

Beat segmentation correct on the canned floor (add a tiny inline test harness in the page or a
vitest for the parser if extracted to a shared example lib); never traps the reader (full-text
escape always reachable); palettes; contrast/size rules. Gate green.
