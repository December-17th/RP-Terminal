# Scene language is stream-shaped; validated by a lenient incremental parse (YSS)

- **Status:** Accepted 2026-07-16 (grill session). **Revised 2026-07-16** after the scene wire-format A/B — the validation model changed from *atomic-JSON* to a *lenient line/incremental parse* of the Yuzu Scene Script (YSS). The concrete grammar is **ADR 0007**. The original atomic decision is retained at the bottom for the record.
- **Evidence:** `scene-format-ab-2026-07-16.md` (§5a authoritative — reproduced across two runs).

## Context
A scene could be one JSON document (strongest atomic validation, but a full-scene wait, and a single bad token fails the whole scene) or a progressively played line stream (low latency, graceful per-line degradation, natural streaming to the stage). The original decision (below) kept the schema stream-shaped but validated the whole scene atomically as one JSON object in v1. The scene wire-format A/B then compared atomic-JSON against an inline command-stream ("YSS v0") through **one identical validator** and the **same one-repair-then-fallback ladder**.

**A/B result (2026-07-16, two runs incl. a clean re-run):** **0 format-level failures in BOTH formats** on the daily-driver model (`gemini-3.1-pro-preview`); every non-valid outcome was a provider `429/524`, never a malformed scene. Reliability — the reason atomic validation was chosen defensively — is a **non-factor**: adopting the incremental format costs nothing in reliability, so the choice falls to streaming + architecture fit, which favor the line stream (it folds into the `stageCommands` stream naturally, and that matters at the model's ~110s p90 latency).

## Decision (revised)
The scene is authored and transmitted as a **line-oriented command stream — Yuzu Scene Script (YSS), grammar in ADR 0007** — not one JSON object. The pipeline validates it as a **ladder**:

1. **Lenient incremental parse** (`normalize`): fold the lines into the internal `Scene` model with **asymmetric leniency** — prose is never an error (it becomes narration); a malformed `<| … |>` line is recorded as an *observation* and **skipped**, the rest of the scene survives; a missing `<| end |>` is a truncation *observation*, not a failure.
2. **Scene-level validate**: the assembled `Scene` is checked for shape + manifest-vocabulary membership (asset ids) + effect allow-list + choice = `{text,intent}` only. This is the load-bearing correctness gate — **canon stays strict even though prose stays lenient.**
3. **One bounded repair** on scene-level failure, then **prose fallback** (raw text as a narration-only scene) as the floor. Unchanged from the original ladder.

The internal `Scene` model and all storage are **format-agnostic and unchanged** — only the wire format and the parse step differ. **Progressive prefix-playback** (render beats as tokens arrive) remains a deferred optimization requiring no schema/storage change — now a more natural fit, since YSS is already line-incremental.

## Consequences
- The **atomic all-or-nothing** failure mode is gone: a single bad token can no longer fail a whole scene; the scene-level repair/fallback becomes a rarely-hit safety net rather than the first line of defense.
- The **JSON wire format is retired for v1.** (The internal model stays; only the on-the-wire representation changes.)
- The validator must distinguish **per-line observations** (noted, non-fatal — `UNKNOWN_COMMAND`, `BAD_SPRITE_TOKEN`, `TRUNCATED`, `THINK_WRAPPED`) from **scene-level failures** (`SCHEMA_*`, `UNKNOWN_ASSET_ID`, `DISALLOWED_EFFECT`, `BAD_CHOICE_SHAPE`). WP-B's `sceneValidate.ts` implements this split.
- Whole-scene generate-then-play (with a generation-status indicator) is retained for v1; streaming playback is a later optimization.

## Original decision (2026-07-16, superseded by the revision above)
> The schema is designed for incremental parsing — scene header, ordered beat sequence, explicit end-of-scene marker — but the v1 pipeline generates and validates the entire scene (as one JSON object) before the first beat plays, showing generation status during the wait. Rationale: a scene replaces a whole turn, so one scene-wait ≈ one message-wait; v1 keeps whole-scene validation, one bounded repair, and prose fallback where reliability risk is highest, while progressive prefix-playback remains a later optimization requiring no schema or storage change.

_Superseded because the A/B showed the incremental (YSS) format matches atomic-JSON on reliability (0 format failures, two runs) while fitting streaming and the stage architecture better._
