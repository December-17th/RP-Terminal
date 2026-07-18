# Preset compatibility targets frozen SillyTavern 1.18.0, assembly-only

- **Status:** Accepted 2026-07-17 (grill session over `.scratch/st-preset-compat/PLAN.md`).
- **Evidence:** `docs/research/sillytavern-prompt-compatibility.md` + `preset-corpus-verification-2026-07-17.md` (codex worktree, branch `docs/st-preset-research`, `b80124f`) — all claims verified against the ST 1.18.0 tag (`51ad27f`) and the 8-preset corpus.

## Context
RPT imports heavily customized ST Chat Completion presets. Three candidate bars: corpus-driven ("the 8 presets work"), general parity against a moving ST, or general parity against a pinned release. And two boundary questions: whether parity covers the systems that *produce* assembly's inputs — World Info activation (recursion, probability, sticky/cooldown, groups) and tokenizer-aware budgeting — where RPT has its own lorebook engine and char-estimate budgeting.

## Decision
Parity means: **RPT reproduces SillyTavern 1.18.0's prompt-assembly semantics, given assembly's inputs, verified against a one-time Oracle capture — and never chases later ST versions.**

- The Oracle is captured once from the pinned local 1.18.0 checkout (fake-OpenAI capture server for transport bodies + a local capture extension on `CHAT_COMPLETION_PROMPT_READY`), scenarios driven manually per a written manifest, with the **new macro engine enabled** (the 1.18.0 fresh-install default — the legacy engine is not implemented; its quirks are recorded divergences). The committed fixtures are thereafter the frozen spec.
- Fixtures supply preselected World Info entries and a fixed token budget. RPT's own WI activation and budgeting stay; their divergences from ST are **enumerated as tracked backlog issues**, not silently absorbed and not in this effort's scope.
- The 8-preset corpus is the reality check, not the bar: behaviors no corpus preset uses are still implemented and fixtured.

## Consequences
- No oracle-regeneration or ST-version-migration machinery is ever built; an ST 1.19 behavior change is by definition out of scope.
- The conformance grid from the research report is real work (Phase 0/5), including behaviors the corpus never exercises.
- A preset that depends on WI-activation subtleties or exact token-pressure trimming can still diverge in RPT with parity "green" — the tracked-divergence list is the honest boundary.
- Fixture capture is a one-shot manual session: the scenario manifest must be reviewed against every planned parity feature *before* capture day.
