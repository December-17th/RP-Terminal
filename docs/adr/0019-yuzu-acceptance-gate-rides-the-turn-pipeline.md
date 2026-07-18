# The Yuzu acceptance gate rides the turn pipeline; trace is a floor field; effects fold at generation

**Decided 2026-07-18 (owner, WP-S2 design review).** Implements ADR 0008 §7's second seam (the acceptance gate) and §3/§4 (canonical fold of scene effects). Depends on and does not revisit ADR 0008. Grounding: a scout of the RPT main-branch response path the same day — the node-graph turn pipeline (`llm.sample → parse.response → apply.state → output.writeFloor`), `persistFloor`'s optional `plot_block` field, `callModelResilient`'s existing corrective-retry loop, `mvuParser`/`foldState`, and the `generateParity` harness.

## Context

WP-S1 landed the first mode-gated seam (the prompt overlay). WP-S2 adds the second: the WP-B validation ladder must run on the model's response **before the floor commits**, so a VN floor stores a validated Yuzu Scene Script (or a prose fallback), never a malformed one. Two scout findings reshaped the naive plan:

- **Display regex is already view-time, not write-time.** `parseResponse` stores the full raw response losslessly; reasoning strips and display regex are applied at *render* time. So "gate display regex for VN floors" is a renderer concern (the stage, WP-D2), **not** a floor-commit concern. It leaves S2's core scope.
- **The current fold cannot see YSS effects.** `mvuParser` only extracts commands from `<UpdateVariable>` blocks. The post-Y1 YSS beat-effect form `<| effect _.set('path',old,new) //reason |>` is invisible to `apply.state`/`foldState`. A VN floor generated today would commit with its scene effects **unfolded**, contradicting ADR 0008 §3 (the floor's stored `stat_data` keeps classic fold-at-generation semantics). The WP slicing did not clearly assign who bridges the inline form into the fold.

## Decisions

1. **The acceptance gate is a mode-gated seam in the classic turn pipeline, running the WP-B ladder before the floor commits.** When the turn is in VN mode, the response is run through `parseScene → validateScene → (one bounded repair re-ask on structural failure) → toProseFallbackScene`, and the *validated* scene text (or the fallback) is what `parse.response`/`apply.state`/`output.writeFloor` see. Classic turns are byte-identical: the gate is skipped when `vn_mode` is off, argued in the PR and pinned by the `generateParity` harness (existing classic snapshots are **never** modified to go green; VN cases are added).

2. **The repair re-ask is a discrete, triggered "repair this YSS" call behind a stable seam — agent-ready.** Repair fires **only** on structural validation failure (schema shape / empty output / bad choice shape per ADR 0008 §5); soft observations (unknown asset id, `UNKNOWN_PATH`) never trigger it. The seam's contract is `(rawModelOutput, sceneContext) → repairedSceneOutcome`, so the mechanism is swappable: **v1 makes a direct `streamProvider` re-ask** (salvaging WP-C's abort/trace patterns) with the classic `resilientCall.ts` **left untouched** (transport-level resilience and scene-structural repair stay separate layers — ADR 0008's "parallel, not woven in"); a **future agentic workflow** can own YSS weaving/repair by implementing the same seam. Rejected: extending `callModelResilient` with a `yuzu_scene` validator (would split the ladder across a classic-shared file); rejected: a graph loop-back through `llm.sample` (the node graph is single-shot per turn).

3. **The gate trace is an optional `FloorFile` field, written only for VN floors.** The trace (raw in/out, repair attempts, timings, observations) lands as an optional field on the floor, persisted losslessly **only when present** — mirroring the `plot_block` precedent, so classic floors are byte-identical and WP-I reads the trace back per-floor for free. Rejected: return-only (trace lost after the turn, no post-hoc inspection until WP-I); rejected: a separate store (new machinery WP-I could own).

4. **S2 folds YSS `<| effect |>` effects into the canonical `stat_data` at generation.** The gate bridges the scene's beat-effect strings into the existing MVU command grammar and folds them through `foldState`, so a VN floor commits with correct canon (upholds ADR 0008 §3). Classic `<UpdateVariable>` blocks in the same response still fold as before (they remain legal, attributing to scene end). **WP-P** then layers only the per-beat *displayed* view on top of already-correct canon.

## Consequences

- **Classic-step gating narrows to workflow triggers.** Display regex drops out (view-time). The remaining question — which async post-floor workflow triggers (memory/table/notes maintenance) should or should not run on YSS floors — is enumerated at brief time and gated on `vn_mode`; a trigger that makes sense on scene text (e.g. memory extraction) may stay on.
- **The `Scene` shape and the ladder API are the S2 contract surface**; the fold bridge depends on `mvuParser`'s command representation. Shared `src/shared/yuzu/*` stays main-free — the bridge (parse + apply) is main-side at the seam.
- **New floor field.** `FloorFile` gains an optional `yuzu_trace`; the floor schema/readers tolerate its absence (classic floors never carry it).
- WP-P's prerequisite (correct canonical fold) is satisfied by decision 4. WP-I's data source (the persisted trace) is satisfied by decision 3.
- When this governs merged code, copy it into the RPT repo ADR system (next repo number after 0018; `docs/**` is gitignored → `git add -f`).
