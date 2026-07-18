# Project Yuzu — WP-P0 scene-generation probe

This env-gated harness measures how reliably real text-completion providers emit a scene accepted by
the draft schema in `src/shared/yuzu/p0/sceneDraftSchema.ts`. It records valid-first-try, repaired, and
fallback rates; failure shapes; and end-to-end run latency.

Each run packs the same premise, cast, asset vocabulary, and effect allow-list, calls a provider,
parses and validates the reply, makes at most one corrective re-ask, then degrades to a narration-only
scene if the repair also fails. Every completed run is appended immediately to a JSONL checkpoint.

## Running the readout

1. Copy the example and fill in real provider keys:

   ```sh
   cp test/yuzu/p0/providers.example.json test/yuzu/p0/providers.local.json
   ```

   `providers.local.json` is gitignored. Each entry is
   `{ name, provider, endpoint, api_key, model, rpm_limit?, max_concurrent? }`. Invalid entries are
   skipped with a warning, and `name` must be unique. `rpm_limit` and `max_concurrent` are
   non-negative integers; zero means unlimited.

2. Run either side of the A/B probe:

   ```sh
   RUN_YUZU_P0=1 YUZU_P0_RUNS=20 npx vitest run test/yuzu/p0/p0-real-run.harness.test.ts
   RUN_YUZU_P0=1 YUZU_P0_RUNS=20 npx vitest run test/yuzu/p0/p0-inline-run.harness.test.ts
   ```

   The first command tests atomic JSON. The second tests inline Yuzu Scene Script (YSS). Keep the
   provider file and environment knobs identical when comparing them.

   Environment knobs are `RUN_YUZU_P0` (required), `YUZU_P0_RUNS` (positive integer, default 20),
   `YUZU_P0_TEMP` (0–2 inclusive, default 0.8), and `YUZU_P0_MAX_TOKENS` (positive integer, default
   1500). Invalid numeric values produce a warning and use the documented default.

### Resume an interrupted run

Pass the existing JSONL file through `YUZU_P0_RESUME` and rerun the same format with the same target
run count:

```sh
RUN_YUZU_P0=1 YUZU_P0_RUNS=20 YUZU_P0_RESUME=test/yuzu/p0/results/<timestamp>.jsonl npx vitest run test/yuzu/p0/p0-real-run.harness.test.ts
```

The harness validates checkpoint lines, skips a malformed or partially written line with a warning,
and verifies a non-secret fingerprint of the format, context, providers, and generation parameters.
API keys are deliberately excluded from that fingerprint. A missing or configuration-mismatched
checkpoint is an error, preventing an accidental duplicate or mixed paid run. Matching records are
kept, provider calls cover only unfinished slots, and new records append to the same JSONL file. The
resume file must be a `.jsonl` file inside `test/yuzu/p0/results/`. The console prints
`[completed/total]` after every new record.

## Results

Files are written under the gitignored `test/yuzu/p0/results/` directory:

- `<timestamp>.jsonl` or `<timestamp>-inline.jsonl`: one validated `RunRecord` per line, including raw
  replies, per-attempt outcomes, latency, failure shapes, and any fallback scene.
- `<timestamp>.readout.txt` or `<timestamp>-inline.readout.txt`: the summary table also printed to the
  console.

Median and p90 latency are computed per complete run: first-attempt latency plus repair latency when a
repair occurred. Failure histograms still count observations across both attempts.

## Decisions

- YSS remains an intentional WP-P0 A/B requirement. JSON and YSS use the same provider settings,
  orchestration loop, one-repair limit, scene validator, metrics, and fallback. Only prompt, parser,
  and repair wording differ through the format strategy.
- Malformed YSS commands are not silently discarded. Unknown asset IDs, disallowed effects, unknown
  commands, invalid sprite tokens, and missing `<| end |>` markers reject the attempt and consume the
  single repair opportunity. Harmless `<think>` stripping remains an observation.
- Provider and Electron services are dynamically loaded only inside an enabled real-provider test.
  Normal test discovery imports only pure harness configuration and checkpoint helpers.
- Transport errors are stored separately from raw model output so an error message can never become
  player-facing fallback narration.

## Verification

Run from the repository root:

```sh
npm run typecheck
npx vitest run test/yuzu/p0 --configLoader runner
npm test -- --configLoader runner
npm run build
```

The real-provider suites remain skipped unless `RUN_YUZU_P0=1`; normal verification never spends
provider credits or reads local API keys. The latest verification completed with 57 P0 tests passing
and 2 real-provider tests skipped, 3,173 repository tests passing and 2 skipped, and a successful
production build.
