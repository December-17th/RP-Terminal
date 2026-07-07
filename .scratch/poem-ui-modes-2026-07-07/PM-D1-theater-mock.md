# PM-D1 — 剧场 (Mode B) mock

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P1 (design gate for PM-D2)
Dispatch: opus-4.8/medium
Scope: design (new file `docs/design/poem-play-area-mock-v4b.html`)

## What

An interactive mock of 剧场 mode over the SAME scene/tokens as `poem-play-area-mock-v4.html`
(copy its `:root` palette blocks verbatim), per v4 doc §4 with the CLOSED design calls (§6.3/6.4):

- Full-bleed scene; full cast spread across the width (this mode owns the whole viewport — no
  native chat, no corridor clipping constraint).
- ADV letterbox band, 26vh, bottom: narration text (serif, fade-in per beat ~240ms, no
  typewriter; `prefers-reduced-motion` ⇒ instant), ▸ advance affordance, auto/skip toggles,
  minimal composer row.
- Dialogue beats: **gilt plate** anchored near the speaking sprite (nameplate visual language:
  serif, 「」 quote glyph, thin gold rule, night-glass fill with faint parchment warm-mix);
  speaker brightens, others dim.
- Choices as overlay buttons when the beat sequence ends; a "show full text" control that
  presents the whole reply as a scroll (the escape hatch — sequential must never trap).
- SELF HUD collapsed to one row bottom-left; WORLD collapsed to chips that expand on hover.
- Interactions to mock: click/Space advance, hold-Space skip, beat sequence over a canned
  3-beat reply (narration → dialogue → narration → choices), palette swatches.
- Obey PM-B3 contrast + PM-B5 size rules.

## Verification

Serve + screenshot each beat state and 2 palettes at 1360×820 (backdrop-filter off for capture).

## Acceptance

Interactive mock faithful to §4 + §6.3/6.4; a `## Comments` note here listing any spec deviation
you had to make (controller + owner review the mock before PM-D2 dispatches). Gate green (docs
only — still run it).
