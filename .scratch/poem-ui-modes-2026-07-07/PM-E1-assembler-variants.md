# PM-E1 — bundle assembler: three layout variants in one card fragment

Status: needs-triage (DEFERRED — owner 2026-07-07 rev 3: novel/theater delayed until ensemble ships)
Priority: P0-final
Dispatch: opus-4.8/medium
Scope: build script (`docs/sdk/examples/build-poem-play-area.cjs`)

## What

Extend the assembler to emit the PM-A1 `variants` shape in the `rp_terminal.panel_ui` fragment:

- `群像` (ensemble): the CURRENT v3 layout — self `[0,0,3,12]` / stage `[3,0,9,4]` /
  story(chat) `[3,4,6,8]` / world `[9,4,3,8]`, seamless, existing v3 surfaces.
- `小说` (novel, **default**): novel-self `[0,0,3,12]` / story(chat) `[3,0,6,12]` /
  novel-world `[9,0,3,12]`, seamless, + the PM-A2 `backdrop` declaration + the PM-A3 glass
  tokens in `theme`.
- `剧场` (theater): theater `[0,0,12,12]`, single slot.

Keep: CSS inlining per surface (each slot serves ONE self-contained html), `data:text/html`
entries, `--apply` PNG surgery preserving existing `rp_terminal` (combat/left_panel), output to
git-ignored `dist/`, default src card `…/命定之诗/v4.2.1+combat+party+duel.png`. Variant labels
are card content (Chinese) — no i18n plumbing.

**Do NOT run `--apply`** — build to `dist/` only and verify the fragment JSON; the controller
applies.

## Grounding

The script itself + `patch-poem-card.cjs`; PM-A1's landed schema (match it exactly — add a
schema-validation step to the script if cheap).

## Acceptance

`node build-poem-play-area.cjs` emits a fragment that parses against `RPTerminalExtSchema`;
three variants present, 小说 default; existing single-`panel_ui` output path removed or kept
per what PM-A1's backward-compat decided (state which in Comments). Gate green.
