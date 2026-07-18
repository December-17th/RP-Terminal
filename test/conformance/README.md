# Conformance harness (oracle fixtures)

**WP-0.4 / ADR 0016.** Vitest suite that pins RPT prompt-assembly parity against
frozen SillyTavern 1.18.0 golden fixtures. Runs as part of `npm run test` (matched
by the repo's `test/**/*.test.ts` include).

## Pieces

- `fixtureSchema.ts` — the fixture contract (`Fixture` type), `validateFixture`,
  the ST-default-prose **leak guard** (`findStDefaultLeaks`), and
  `checkInvariants`. No dependency on `src/` — it is a stable contract.
- `rptAdapter.ts` — the seam where RPT assembly output gets compared to a fixture.
  **Wired** to the real assembly path (`parseStPreset` → `buildPromptDetailed` →
  `fitToBudget` → stage-A coalescing, mirroring `assemblePrompt`): a fixture's
  machine-readable `input` is re-driven through RPT and the result diffed against
  `expected.chat`. It returns null only for scenarios it can't reproduce
  deterministically (a nondeterministic macro, or an unparseable preset), which stay
  structural-only.
- `conformance.test.ts` — enumerates `tools/oracle/scenarios.json`; absent fixtures
  are counted skips, present fixtures are asserted (schema + leak guard + macro
  engine + invariants + adapter diff when wired).
- `fixtures/<scenario-id>.json` — the golden fixtures. `source: "captured"` come
  from the oracle rig (`tools/oracle/`, see its `RUNBOOK.md`); `source:
  "synthesized"` are hand-built structural placeholders with scrambled RPT-authored
  prose until a real capture replaces them.

## Fixture shape

```jsonc
{
  "schemaVersion": 1,
  "scenarioId": "wp-2.1-markers-basic",
  "source": "captured" | "synthesized",
  "st": { "version": "1.18.0", "commit": "51ad27f", "macroEngine": "new" },
  "generationType": "normal",
  "settings": { /* prose-free ST knobs that drove assembly */ },
  "input": {
    /* REQUIRED machine-readable feed that PRODUCED expected.chat, so rptAdapter can
       re-drive RPT assembly (Phase-2 issues 11-15). */
    "preset": { /* inline preset, or */ }, "presetName": "…",
    "character": { /* card fields ST reads */ },
    "chatMessages": [ { "role": "user", "content": "…" } ],
    "generationType": "normal", "macroEngine": "new",
    "settings": { /* override knobs */ },
    "worldInfo": [ { "position": "before_char", "content": "…" } ], // oracle SUPPLIES these
    "tokenBudget": 4096
  },
  "invariants": { /* optional: roleOrder, messageCount, mustContain, mustNotContain */ },
  "expected": { "chat": [ { "role": "system", "content": "…" }, … ] }
}
```

`expected.chat` is ST's **post-extension** mutable chat array (the golden prompt).
`input` is the machine-readable feed that produced it — under assembly-only parity
(ADR 0016) the pre-activated `worldInfo[]` and fixed `tokenBudget` are INPUTS the
oracle supplies, not values RPT recomputes.

## Adding a captured fixture

Follow `tools/oracle/RUNBOOK.md`. In short: run the capture server, drive ST
through the scenario, then `normalize-capture.mjs` the raw capture into
`fixtures/<id>.json`. Re-run `npm run test`; the scenario flips from *skipped* to
*asserted*.

## Clean-room note

Committed fixtures never contain ST default template prose — scenarios override
those strings with RPT-authored `ORP_` sentinels, and the leak guard fails the
suite if any known ST default fingerprint appears.
