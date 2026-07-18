# Presets persist as lossless envelopes, edited in place without ceremony

- **Status:** Accepted 2026-07-17 (grill session over `.scratch/st-preset-compat/PLAN.md`).
- **Evidence:** `docs/research/sillytavern-prompt-compatibility.md` §1 — ST's permissive import keeps unknown fields and `extensions.*` namespaces alive; RPT's current `PresetSchema` projection destroys them (verified: 4 of 8 corpus presets import 8 of 41–78 prompts).

## Context
RPT's `PresetSchema` keeps only name + sampler parameters + a reduced prompt list; everything else an ST preset carries (all order lists, injection metadata, `extensions.SPreset`, `extensions.tavern_helper`, unknown fields) is destroyed at import. Byte-exact round-trip through ordinary JSON parsing is impossible (key order, duplicate keys, formatting). Candidate edit models: copy-on-edit forks (the ADR 0006 pattern), read-only imports, or plain in-place editing.

## Decision
- Every imported preset persists as a **Preset Envelope**: the original file bytes + SHA-256, the parsed nothing-dropped JSON, and the normalized view the runtime consumes.
- **Round trip is semantic:** normal export re-serializes equivalent JSON. A preset never edited in RPT can always be re-exported **byte-exact** from the stored original.
- **Edits are direct and unceremonied:** the user edits the imported preset in place — no warnings, no fork step, no read-only state, no dirty-flag UX. The envelope's original bytes remain silently as provenance.
- Presets imported before the envelope existed get **no migration** — their raw source is already gone; diagnostics flag them and re-import refreshes them.

## Consequences
- Nothing an ST preset carries is ever destroyed again; SPreset/TavernHelper data survives even while unexecuted (Tier-1 losslessness).
- After any edit, the stored SHA-256 and original bytes describe the *import*, not the current state — deliberate: provenance, not integrity enforcement.
- ADR 0006's copy-on-edit pattern is deliberately **not** extended to presets: forks earn their ceremony in workflow docs where sharing matters; presets are personal working objects.
- Storage grows by one original-file blob per import (0.1–2 MB observed) — negligible.
- **The byte-lossless guarantee is the stored ENVELOPE (original bytes + SHA), not the semantic export.** Semantic export is not guaranteed byte-equal for *pathological* presets: duplicate-id `prompt_order` entries collapse (first-seen wins, matching the parser), and parser-dropped order entries migrate to the tail. A never-edited preset can still be re-exported byte-exact via `exportPresetOriginal` from the original bytes.
