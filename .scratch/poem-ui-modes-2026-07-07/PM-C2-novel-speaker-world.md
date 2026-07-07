# PM-C2 — 小说 speaker corridor + WORLD stack surface

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P0 (after PM-C1 — adopts its corridor/slicing conventions)
Dispatch: opus-4.8/medium
Scope: card v4 surface (new file `docs/sdk/examples/poem-novel-world-surface.html`)

## What

The right 25% column of 小说 mode as ONE WCV surface (slot `[9,0,3,12]`), per the v4 mock's
right side:

- Backdrop slice by geometry (as PM-C1).
- Speaker sprite: full-height, bottom-anchored, resolved by character name via
  `assetUrl(name,'立绘')`, glyph placeholder + diagnostic on failure. **Architecture constraint
  (v4 doc §6a): the WCV clips at its left edge — the mock's tuck-behind is achieved by the clip
  against the story glass; the mock's `right:-2vw; width:32vw` oversize still applies WITHIN the
  surface so the sprite bleeds to the slot's left edge.** Rear ensemble members (up to 2) stand
  BEHIND the front sprite inside this corridor, dimmed/desaturated (mock's `.actor.second`
  treatment adapted to in-corridor x-positions) — NOT at mid-viewport (that area belongs to the
  native chat and cannot be painted).
- Gilt nameplate + 正在交谈 pill ON the sprite (mock treatment; PM-B3 backing plate rule).
- WORLD card stack top-right: 世界 / 同行 (center-axis affection bars per PM-B4, 命定契约 mark,
  click a row to hand the front slot to that character — broadcast `stage:speaker` so PM-C1/D2
  can react) / 委托. Reuse `worldState` from `poem-world-surface.html`.
- Speaker priority: card-authored `stat_data.stage.speaking`, else highest-好感度 present
  (same rule as the v3 stage — see `poem-stage-surface.html`).
- Listens: `poem:theme`, `self:fold` (dim the corridor slightly), `mag_variable_updated`.

## Verification

Standalone at 340×820, mock data with 3 present members; handoff click; palettes; screenshots.

## Acceptance

Faithful to the mock's right column; handoff works standalone (mock fallback) and emits the
broadcast; all palettes; contrast/size rules hold. Gate green.
