# Project Yuzu — WP-P0 scene-generation probe

A throwaway harness that measures how reliably real text-completion providers can emit a **structured
scene** (the draft schema in `src/shared/yuzu/p0/sceneDraftSchema.ts`) for a native visual-novel
engine. The code is throwaway; the **data** it produces — valid-first-try %, repaired %, fallback %,
and a failure-shape histogram per provider — is the keeper.

The pipeline per run: pack a context (premise + cast + asset-id vocabulary + effect allow-list) →
render a schema-in-prompt → call the provider → extract JSON (strip `<think>`, unwrap fences, slice
the outermost `{…}`) → validate against the schema + vocabulary → on failure, **one** bounded repair
re-ask → on second failure, degrade to a prose fallback scene. Every run is recorded.

## Running the readout

1. Copy the example and fill in your real provider keys:

   ```
   cp test/yuzu/p0/providers.example.json test/yuzu/p0/providers.local.json
   ```

   `providers.local.json` is **gitignored** — your keys never leave this machine. Each entry is
   `ApiPreset`-shaped: `{ name, provider, endpoint, api_key, model, rpm_limit?, max_concurrent? }`.
   `provider` is one of `openai` / `anthropic` / `gemini` (or any OpenAI-compatible value). Set
   `rpm_limit` / `max_concurrent` to pace calls (0 = unlimited); presets sharing an endpoint share a
   budget.

2. Run the env-gated harness (skipped by the normal suite):

   ```
   RUN_YUZU_P0=1 YUZU_P0_RUNS=20 npx vitest run test/yuzu/p0/p0-real-run.harness.test.ts
   ```

   Env knobs: `RUN_YUZU_P0` (required, enables the suite), `YUZU_P0_RUNS` (runs per provider,
   default 20), `YUZU_P0_TEMP` (default 0.8), `YUZU_P0_MAX_TOKENS` (default 1500).

## Where results land

Both files are written to `test/yuzu/p0/results/` (gitignored), timestamped:

- `<timestamp>.jsonl` — one `RunRecord` per line (raw reply, latency, `applied[]` transforms,
  per-attempt `ok` + failure shapes, outcome, and the prose-fallback scene when it degraded). This is
  the raw data to mine for extraction/schema lessons.
- `<timestamp>.readout.txt` — the formatted summary table (also printed to the console).

## Reading the readout

Each provider row shows `runs`, `valid` (valid on the first try), `repaired` (valid only after the one
repair), `fallback` (degraded to prose), and median / p90 latency. Below each row, the **failure
shapes** histogram counts every problem seen across all attempts — e.g. `THINK_WRAPPED`, `FENCED`,
`EXTRA_PROSE` (how the model wrapped its JSON), `UNKNOWN_ASSET_ID` / `DISALLOWED_EFFECT` (vocabulary
drift), `SCHEMA_MISSING_FIELD` / `SCHEMA_WRONG_TYPE`, `TRUNCATED`, etc. High `FENCED`/`THINK_WRAPPED`
means the extractor is earning its keep; high `UNKNOWN_ASSET_ID` means the vocabulary needs to be
stated more forcefully in the prompt.

## Notes

- Keys live only in the gitignored `providers.local.json`; nothing is written to git.
- The pure pipeline (`src/shared/yuzu/p0/**`) never imports Electron or the network. Only this harness
  injects the real `streamProvider`. The normal-suite tests (`p0-loop.smoke.test.ts`,
  `p0-units.test.ts`) drive the same pipeline with a fake provider.
