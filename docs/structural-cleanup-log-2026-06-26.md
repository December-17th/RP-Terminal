# Structural Cleanup — Execution Log (2026-06-26)

_Traceability log for executing [maintainability-plan-2026-06-26.md](maintainability-plan-2026-06-26.md)
(diagnosis: [codebase-structural-review-2026-06-26.md](codebase-structural-review-2026-06-26.md)) on branch
`refactor/structural-cleanup-2026-06-26`._

> **How to read this.** Newest stage at the bottom of "Stages". Each stage records: what changed (files),
> why, the verification run, and the commit. Verification gate this session =
> `npm run typecheck && npm run lint && npm run test` (+ `npm run check:deps` once it exists — see Phase 0).

## Work schedule (status)

| # | Phase | ID | Pr | Status | Commit |
| --- | --- | --- | --- | --- | --- |
| 0 | Make module-boundary gate real | WS-10 | (pre) | ✅ done | (pending) |
| 0a | Error-handling policy doc | WS-9 | LOW | ⬜ todo | — |
| 0b | Delete dead DB schema | WS-6 | LOW | ⬜ todo | — |
| 0c | Document path dialects + test | WS-8 | LOW | ⬜ todo | — |
| 0d | One broadcast helper | WS-7 | MED | ⬜ todo | — |
| 1 | Unify EJS context (keystone) | WS-1 | HIGH | ⬜ todo | — |
| 2 | lodash/faker → tested module | WS-4 | MED | ⬜ todo | — |
| 3 | Decompose buildPrompt | WS-5 | MED | ⬜ todo | — |
| 4 | De-escalate L1 cache | WS-2 | MED | ⬜ todo | — |
| 5 | Write-back loop origin-tag | WS-3 | HIGH | ⬜ todo | — |

Status key: ⬜ todo · 🔄 in progress · ✅ done · ⏸ deferred (with reason).

## Baseline (start of session)

- Branch `refactor/structural-cleanup-2026-06-26` off `feat/poem-combat-extension` @ `9409bfe` (the
  planning-docs commit).
- `npm run typecheck` → ✅ passes (node + web).
- `npm run check:deps` → ❌ **script does not exist** (see Phase 0 / WS-10 — newly discovered drift:
  CLAUDE.md presents it as the enforced module-boundary gate, but there is no script, no
  `dependency-cruiser` dependency, and no config). Added as a Phase 0 prerequisite.
- `npm run test` → (run at Phase 0 baseline).

---

## Stages

<!-- append one entry per completed stage -->

### Stage 1 — Phase 0: module-boundary gate made real (WS-10) ✅

**Why (discovered drift).** CLAUDE.md presents `npm run check:deps` (dependency-cruiser) as the enforced
module-boundary gate, and the verification gate is documented as
`typecheck && check:deps && test`. In fact **none of it existed**: no `check:deps` script, no
`dependency-cruiser` dependency, no config. The architecture's load-bearing boundaries were unenforced.
Making this real first gives the later refactors (WS-1/WS-4/WS-7 move modules) automated cover.

**Changes.**
- `package.json` — added `dependency-cruiser` (devDep) + `"check:deps": "depcruise src --config
  .dependency-cruiser.cjs"`.
- `.dependency-cruiser.cjs` (new) — encodes the CLAUDE.md boundaries as `error` rules: shared↛main/renderer,
  shared↛electron, renderer↛main, combat-engine-pure, transports-no-cross-import (both directions);
  `no-circular` as `warn` (informational). `tsPreCompilationDeps` so type-only crossings are caught too.
- `eslint.config.mjs` — added `**/.claude/**` to `ignores` (nested git worktrees were being linted, their
  `test/**` files missing the `test/**` rule override → spurious gate-reddening errors); added a `**/*.cjs`
  override (Node CJS scripts legitimately use `require()`/`module.exports`, no TS return types) — covers the
  new config + `docs/sdk/examples/*.cjs`.

**Verification (full gate).**
- `npm run typecheck` → ✅
- `npm run check:deps` → ✅ **no violations (236 modules, 766 deps)** — boundaries already respected in code.
- `npm run lint` → ✅ **0 errors** (was 15 errors, all in `.claude/` worktree + a `.cjs` example). 110
  prettier-formatting **warnings** remain (format drift in real test files, non-failing) — deferred quick-win
  (`npm run format` would fix ~69 but churns many test files; out of scope for this commit).
- `npm run test` → ✅ 689 pass / 78 files.

**Notes / follow-ups.**
- CLAUDE.md's boundaries bullet names the typed IPC surface as `shared/ipc`; the real surface is
  `window.api` (preload). The encoded rule (`renderer↛main`) captures the intent; left CLAUDE.md text as-is
  (minor). The `check:deps` claim in CLAUDE.md is now **true**.
- Prettier warning drift (110) noted for a later `npm run format` pass.
