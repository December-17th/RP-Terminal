# STScript / `triggerSlash` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** make `TavernHelper.triggerSlash(cmd)` run the common STScript subset (pipes / closures / named args
/ `{{pipe}}` + `{{macros}}` / chat-var built-ins / `/gen` `/genraw` `/trigger` `/send`) **identically in both
transports**, by relocating the existing pure interpreter to `shared/` and driving it from the SP1 `Host`
seam — command dispatch + chat-var/generate/setInput stay in the shared runtime over already-parity `Host`
methods; the only new adapter/IPC code is a persistent global-var pair (owner-confirmed).

**Architecture:** the interpreter ([plugin/stscript.ts](../../../src/renderer/src/plugin/stscript.ts)) is
already pure + unit-tested; move it to `src/shared/stscript.ts`, then `createThRuntime` builds an `StCtx`
from the `Host` so `triggerSlash` runs over methods both adapters already implement
(`statData`/`applyVariableOps`/`generate`/`generateRaw`/`setInput`) — plus new `getGlobalVars`/`setGlobalVar`
for persistent `/setglobalvar`. The dead `host.triggerSlash` stub is removed from the seam + both adapters.
Parity by construction (spec §3.1, §6).

**Spec:** [docs/superpowers/specs/2026-06-23-stscript-triggerslash-domain.md](../specs/2026-06-23-stscript-triggerslash-domain.md)

## Global Constraints

- Prettier no-semi/single-quote/2-space/printWidth 100. `any` intentional at the card boundary.
- `shared/**` imports nothing realm-specific (renderer/electron/DOM). `shared/stscript.ts` may import only
  `shared/macros`. Clean-room (no js-slash-runner source).
- Run `npm run typecheck` + `npm test` + `npm run build` before each task's commit; no new lint.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- **Move** `src/renderer/src/plugin/stscript.ts` → `src/shared/stscript.ts`; old path → re-export.
- Modify `src/shared/stscript.ts` — optional `char`/`user`/`persona` on `StCtx` (spec §3.5).
- Modify `src/shared/thRuntime/types.ts` — remove `triggerSlash`; add `getGlobalVars`/`setGlobalVar` (spec §4).
- Modify `src/shared/thRuntime/index.ts` — `runTriggerSlash` helper + wire `triggerSlash` (spec §5).
- Modify `src/renderer/src/cardBridge/host.ts`, `src/preload/wcvHost.ts` — drop the `triggerSlash` stub; add the
  global-var pair.
- Modify `src/main/ipc/wcvIpc.ts` — `wcv-host-get-global-vars` / `wcv-host-set-global-var` handlers.
- Modify `test/thRuntime.test.ts` — drop mock `triggerSlash`, add the global-var pair + `triggerSlash` tests.
  `test/stscript.test.ts` stays untouched (proves the relocation is a no-op).

---

### Task 1: Relocate the interpreter to `shared/` (pure no-op)

**Files:** move `plugin/stscript.ts` → `shared/stscript.ts`; old path re-exports.

- [ ] **Step 1:** `git mv src/renderer/src/plugin/stscript.ts src/shared/stscript.ts`. Change its macro import
      from `'../../../shared/macros'` → `'./macros'`.
- [ ] **Step 2:** recreate `src/renderer/src/plugin/stscript.ts` as `export * from '../../../shared/stscript'`
      (keeps `slash.ts` + `test/stscript.test.ts` imports valid).
- [ ] **Step 3:** confirm no other importer of `plugin/stscript` (grep `plugin/stscript`); leave them on the
      re-export path.

**Verify:** `npm test` (`stscript.test.ts` green, **unchanged**) + typecheck + build. This commit must be a
pure relocation — zero behavior change.

### Task 2: `StCtx` macro context + thRuntime `triggerSlash` + tests (the core)

**Files:** `shared/stscript.ts`, `shared/thRuntime/types.ts`, `shared/thRuntime/index.ts`,
`cardBridge/host.ts`, `preload/wcvHost.ts`, `test/thRuntime.test.ts`.

- [ ] **Step 1 (macro ctx):** add optional `char?`/`user?`/`persona?` to `StCtx`; in `runCommand`'s `expand`,
      pass them into `expandMacros({ vars, globals, rng, char, user, persona })`. Additive — `stscript.test.ts`
      stays green.
- [ ] **Step 2 (seam):** remove `triggerSlash` from the `Host` interface (`types.ts`) + both adapter stubs +
      the mock; **add** `getGlobalVars`/`setGlobalVar` to `Host`, both adapters (inline →
      `window.api.pluginGetVars/pluginVars` global scope; WCV → `wcv-host-get-global-vars`/`-set-global-var` IPC
      in `wcvIpc.ts` → `pluginService`), and the mock.
- [ ] **Step 3 (wire):** in `createThRuntime`, add `runTriggerSlash(command)`:
  - `ctx.vars` = the **live** cached `stat` (optimistic, mirroring `setMvuVariable`); `ctx.globals` =
    `await host.getGlobalVars()`; `ctx.char/user/persona` = `host.charData()?.name` / `host.personaName()`
    (×2).
  - `ctx.setVar(key, value, scope)` → `scope === 'global'` ? `host.setGlobalVar(key, value)` :
    `writeVars(setVarOps(key, value))` (same path as `setMvuVariable` — JSON-pointer via `setVarOps`).
  - `ctx.fallback(cmd, pipe)` → switch on `cmd.name`: `gen` → normalize `host.generate(cmd.value || pipe)`
    to its string content; `genraw` → `host.generateRaw(normRaw({ user_input: cmd.value || pipe, ...cmd.named }))`;
    `trigger` → `host.generate('')` content; `send` → `host.setInput(cmd.value || pipe)` then `''`; default →
    `console.warn('[triggerSlash] unknown', cmd.name)` and `''`.
  - return `await runScript(String(command ?? ''), ctx)` wrapped so a throw → `''`.
  - Point `TavernHelper.triggerSlash` (index.ts:252) + any alias (grep `triggerSlash`,
    `executeSlashCommands`, `STscript`) at `runTriggerSlash`. Import `runScript` + `StCtx` from `../stscript`.
- [ ] **Step 4 (tests):** in `test/thRuntime.test.ts`, add: `triggerSlash('/setvar key=hp 5 | /getvar key=hp')`
      → `'5'` and `calls.applyVariableOps` got `[{ op:'set', path:'/hp', value:5 }]`; `triggerSlash('/echo {{char}}')`
      → `'Ellia'`; `triggerSlash('/gen hi there')` → `'gen:hi there'` (mock `generate`); `triggerSlash('/echo a |
/echo {{pipe}}!')` → `'a!'`; unknown command → `''`.

**Verify:** `npm test` + typecheck + build green. **Manual (Electron, both transports):** a card runs
`triggerSlash('/setvar key=hp 10 | /getvar key=hp')` (round-trips the var), `triggerSlash('/gen …')` (a turn
generates), and a piped `/echo` — inline + Isolated identical.

---

## Sequencing & acceptance

```
T1 relocate interpreter to shared/ (pure no-op; stscript.test.ts green untouched)
→ T2 StCtx macro ctx + thRuntime runTriggerSlash + remove dead host.triggerSlash + tests
```

Each task its own commit (typecheck + test + build green). **Acceptance** = spec §10: `triggerSlash` runs the
subset; interpreter in `shared/`; renderer slash path unchanged; command dispatch stays in the shared runtime
(only the persistent global-var pair is new adapter/IPC code); `host.triggerSlash` removed; chat + global vars
persist; new tests pass.

## Risks

- **Relocation must be a true no-op.** The re-export keeps `slash.ts` + `stscript.test.ts` valid; if any
  importer used a default or a deep path, fix it in T1. Keep T1 free of any logic change so a regression is
  obviously the relocation.
- **Optimistic cache update.** `ctx.vars` is the **live** `stat`; the interpreter's in-place write IS the
  optimistic update (as `setMvuVariable` does) so a later read in the same script sees it. The authoritative
  refresh still comes via `applyVariableOps` → `onVarsChanged`; a failed write leaves `stat` optimistically
  ahead until the next refresh — the same accepted tradeoff `setMvuVariable` already makes.
- **`/send` and `/trigger` semantics** (spec §8.2–8.3) — `/send` → composer inject (not a history insert);
  `/trigger` → `host.generate('')`. Confirm in smoke; both are deliberate simplifications.

## Status

DONE (2026-06-23, branch `feat/tavern-events`). T1 `ed68921` (pure relocation to `shared/`; `stscript.test.ts`
12 green untouched), T2 `<this commit>` (`StCtx`-from-`Host` `runTriggerSlash` + macro ctx + persistent
global-var pair + removed `host.triggerSlash` + tests). Gate green throughout (`typecheck` + `npm test` 478 +
`build`). **Revised from the plan:** per the owner, **global vars persist** (added `host.getGlobalVars`/
`setGlobalVar` + one ctx-scoped WCV IPC pair — the one bit of IPC the IPC-free draft would've skipped); and
`/setvar` writes the **live** cached `stat` optimistically via `setVarOps`/`writeVars` (mirroring
`setMvuVariable`), not a clone, so a card's `/setvar` / `{{getvar}}` / EJS all read one `stat_data` store.
**Pending Electron smoke** (both transports): `/setvar | /getvar` round-trip, `/setglobalvar` persists across
calls, `/gen`, and a piped `/echo` — inline + Isolated identical.
