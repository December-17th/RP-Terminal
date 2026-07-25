# Regenerate resamples the stored prompt behind an Assembly Epoch

Regenerate and swipe replay the floor's stored `request` byte-for-byte and draw only a new model
response (a **Resample**), instead of re-running recall, lore selection, EJS, and assembly. This
makes re-rolls the cheapest operation in the app, a guaranteed provider-cache prefix hit, and —
decisively — it removes the only consumer of deterministic lore probability and per-floor lore
state, which the V7 lore-runtime design would otherwise have needed (seeded RNG, activation
ledgers, revision hashes). Staleness is handled by a coarse persisted per-chat **Assembly
Epoch**: any assembly-relevant edit (variables or transcript below the latest floor, referenced
lorebook saved *or deleted*, card/preset/settings, a prompt-phase **regex** rule, chat lorebook
selection or mode) bumps it, and a floor whose stored epoch no longer matches falls back to
today's full reassembly — false positives merely cost a normal rebuild, never correctness.

The asymmetry is load-bearing and runs one way only: over-bumping is free, under-bumping replays
a stale prompt. So a floor is stamped with the epoch read when its **context was built**
(`GenContext.assemblyEpoch`), never with a fresh read at persist time — a persist-time read sits
on the far side of the model call, and an edit landing mid-stream would be folded into the stamp,
marking a prompt assembled under the *old* epoch as current. The Resample path likewise stamps the
epoch validated at capture, since `generate()` awaits the turn barriers between the two.
The old floor's `'template'`-source journal ops must be captured
before the cut and re-journaled on the replacement floor, or Forward Replay silently loses
build-time setvar writes.

## Consequences

- ST preset blocks gated on `injection_trigger: ['regenerate'|'swipe']` never fire under a
  Resample (the stored prompt predates the trigger); they fire only when the epoch forces a
  reassembly. Owner-accepted deviation, recorded in `docs/compat-comparison.md`.
- Fine-grained dirty-tracking (per-store versioning) was rejected as exactly the machinery this
  design exists to avoid; unconditional reuse was rejected because player edits would silently
  never affect a re-roll.

Design: `docs/lore-runtime-v8-minimal-2026-07-23.md`. Decided with the owner, 2026-07-23.
