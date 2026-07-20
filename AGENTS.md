# AGENTS.md

This file describes common mistakes and confusion points an agent might hit while working in this project,
plus the project's general direction. If something in the project is a confirmed, recurring project-wide
trap, alert the developer and record it here. Keep one-off issues and task-specific findings out of this file.

## Project direction

RP Terminal is a **standalone Electron app** (React 19 + Zustand renderer; generation centralized in the
main process; SQLite + file-based storage). The goal is to evolve the **SillyTavern + TavernHelper +
ST-Prompt-Template** experience from a chat tool into a **full game platform** — customizable UI,
card-authored panels / beautifications / mini-games, local combat, and cache optimization — while staying
**format-compatible** with ST cards, lorebooks, regex, presets, and MVU.

- **Compatibility is tiered, NOT "any card runs unmodified."** The supported contract is the dominant
  declarative + framework stack: `chara_card_v3` data, lorebooks, regex, ST-Prompt-Template/EJS, native
  MVU, a documented subset of the TavernHelper JS API, and the standard env libs (jQuery/-UI, Vue, Pinia,
  Tailwind, FontAwesome). Arbitrary custom-JS cards that reach past that surface are **best-effort /
  out-of-contract**. Don't let the long tail of bespoke cards set the roadmap; make the supported stack
  solid and report what falls outside it.
- **No separate card spec.** The "standard" is `chara_card_v3` with everything RPT-specific under
  `data.extensions.rp_terminal` (`src/main/types/character.ts`). The intended distributable is a **PNG
  cartridge** embedding that JSON (+ an appended ZIP for binary assets). See `docs/world-card-design.md`
  and `docs/sdk/`.
- **Clean-room only (licensing).** Never copy or vendor **js-slash-runner / TavernHelper** (AFPL,
  non-free) — reimplement from public docs / observed behavior. **MVU / MagVarUpdate is MIT** and reusable
  with attribution. The ST-Prompt-Template engine is a clean-room reimplementation.
- **The card runtime is ONE surface** (`src/shared/thRuntime`, `createThRuntime` over a `Host` seam) with
  **two transports at parity**: inline `cardBridge` (default) and WCV `wcvPreload` (isolated). Change
  behavior in the shared runtime so both transports inherit it; never let them drift.
- **Internationalization — respect it.** The app UI is localized via a minimal `t()`
  (`src/renderer/src/i18n/`): `useT()` in components, string maps in `locales/en.ts` + `locales/zh.ts`,
  locale persisted in `settings.ui.locale` (currently **English + 简体中文**, extensible). When you add or
  change ANY user-facing string, route it through `t('key')` and add the key to **both** locale files —
  never hardcode display text. Use the ST-ecosystem Chinese terms (世界书 = lorebook, 预设 = preset, 正则 =
  regex, 脚本 = scripts). Card content is separate (it carries its own `staticLocale`).

## Grounding

- Never infer how existing code behaves from names, signatures, or memory. Open and read the file before
  editing or explaining it.
- If unsure about a library, API, or ST / TavernHelper / MVU / EJS behavior, read the actual source
  (`node_modules`, the extension's repo) or the official docs before writing code. Treat your training
  knowledge of these tools as outdated and verify it.
- Cite the exact files (and line ranges) you actually read when explaining behavior. If you haven't
  verified something, label it "unverified" rather than stating it as fact.

## Implementation discipline — prove before platform

- Start with one externally observable outcome and the nearest test or manual check that proves it.
  Trace the existing production path, then implement the smallest end-to-end slice through that path.
- Reuse existing seams. Add an abstraction, framework, persistence layer, public API, configuration
  surface, or compatibility path only when the current outcome requires it, two existing consumers
  already need it, a repository rule mandates it, or a demonstrated material risk justifies it.
  Hypothetical future consumers are not evidence.
- For replacement work, route one real production use case through the narrowest new seam and prove
  parity before building generalized catalogs, schedulers, tools, plans, replay systems, or UI. An
  atomic final cutover does not justify implementing every subsystem before the first working slice.
- Do not silently absorb later roadmap phases, unrelated cleanup, speculative flexibility, or
  unrequested edge cases. Record them as deferred. If the discovered work materially expands the
  requested outcome or introduces a new subsystem/user-facing surface, stop and get owner approval.
- Stop when the requested outcome and required verification pass. Scaffolding, test volume,
  documentation volume, and architectural sophistication are not substitutes for working product
  behavior.

## Documentation maintenance

Two kinds of docs — treat them differently:

- **Living** (keep current; edit in place): `docs/sdk/*`, `docs/rpt-api.md`, `docs/compat-comparison.md`,
  and the status header of `docs/world-card-design.md`.
- **Point-in-time** (snapshots; supersede with a new dated file, don't silently rewrite): the
  `codebase-health-check*.md` files, `docs/superpowers/specs|plans/*`, and `docs/progress-log.md`.

The **SDK docs (`docs/sdk/`) are the contract for card compatibility.** When you change the card-facing
surface — `shared/thRuntime`, `cardBridge` / `wcvPreload`, `shared/cardEnv.ts`, the `RPTerminalExtSchema`
in `types/character.ts`, or the import/transform pipeline (`stPngParser`, `characterService`, the
parsers) — **update `docs/sdk/` in the same change.** `docs/sdk/README.md` has the exact "if you touch X,
update Y" mapping.

- Cite the file each behavioral claim is verified against. When two docs disagree, the one with file:line
  citations wins — reconcile the other to it.
## Module boundaries — ENFORCED by `npm run check:deps` (dependency-cruiser)

- `shared/thRuntime` is the ONLY module the card transports import from; transports
  (`cardBridge`, `wcvPreload`) never import each other.
- `renderer` imports `main` ONLY through the typed IPC surface (`shared/ipc`), never main internals.
- The combat/game engine is pure: it must NOT import renderer, Electron, or IPC.
- `shared/*` must not import from `renderer` or `main`.
- Crossing a boundary = change the dependency-cruiser rule deliberately in the same PR.
  Do NOT add an eslint-disable or bypass the check.

## Verification

- Before declaring code, dependency, or build-configuration changes done, run `npm run verify`.
  For documentation-only or instruction-only changes, run `git diff --check` and any relevant focused
  documentation check; the full test suite is not required unless executable behavior or build inputs change.
- Characterization tests pin current behavior on the cores: thRuntime/bridge parity,
  MVU parser, EJS engine, combat engine, converter declarative path. They assert "same as
  before," not "correct." If a change SHOULD alter behavior, update the characterization
  test in the SAME commit, deliberately — never delete a failing one to go green.
## Agent skills

### Issue tracker

Issues and PRDs live as local markdown files under `.scratch/<feature>/` in this repo (no
external tracker). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage states written as a `Status:` line on each issue file, using the default
strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, created lazily by
`/domain-modeling`. See `docs/agents/domain.md`.
