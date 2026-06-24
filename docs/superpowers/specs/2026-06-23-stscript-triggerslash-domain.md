# STScript / `triggerSlash` Domain

> The last TH-domain slice of the [JSR faithful-host architecture](2026-06-23-jsr-faithful-host-architecture.md)
> roadmap (the "XL last track"), and the one remaining functional gap in
> [the parity status](2026-06-23-th-parity-status.md). Builds on SP1 `thRuntime` + the worldbook/chat-write
> pattern. Clean-room. Branch: `feat/tavern-events` (off `main`).

## 1. Problem

`TavernHelper.triggerSlash(cmd)` lets a card run SillyTavern slash-commands/STScript (`/setvar`, `/gen`,
`/echo a | /echo {{pipe}}`, `/if …`). Today the thRuntime delegates it to `host.triggerSlash`, which is a
`async () => ''` **stub in both adapters** ([index.ts:252](../../../src/shared/thRuntime/index.ts),
[cardBridge/host.ts:170](../../../src/renderer/src/cardBridge/host.ts),
[wcvHost.ts:94](../../../src/preload/wcvHost.ts)). So a card's `triggerSlash` is a no-op in both transports —
at parity, but non-functional.

**Most of the work already exists.** [src/renderer/src/plugin/stscript.ts](../../../src/renderer/src/plugin/stscript.ts)
is a **pure, unit-tested clean-room STScript interpreter**: `splitPipes` / `parseCommand` / `parseScript` /
`runScript` / `looksLikeStScript`, with pipes (`|`), named args (`key=value`), quoted + closure values
(`{: … :}`), `{{pipe}}` threading, `{{…}}` macro interpolation, and built-ins
(`echo`/`comment`/`abort`/`setvar`/`getvar`/`addvar` + `global` variants /`if`/`run`). It imports **only**
`shared/macros` — no renderer dependency. The renderer coupling lives entirely in
[slash.ts](../../../src/renderer/src/plugin/slash.ts), which builds the interpreter's `StCtx` from renderer
stores + `window.api`.

So the gap is **not** "write an interpreter." It is: (a) move that pure interpreter into `shared/` so the
realm-agnostic thRuntime can use it, and (b) build an `StCtx` from the **`Host`** so `triggerSlash` runs over
methods both adapters already implement.

## 2. Goal & non-goals

**Goal:** `triggerSlash(cmd)` runs the common STScript subset — pipes, closures, named args, `{{pipe}}` +
`{{macros}}`, the variable built-ins (read/write chat vars), and `/gen` / `/genraw` / `/trigger` / `/send` —
**identically in both transports**, driven from the SP1 `Host` seam, with **no new IPC and no new adapter
code**.

**Non-goals (deferred, documented):**
- `while`/loops, sub-pipe expansion beyond the existing closure support, and the long-tail command set
  (`/messages`, `/cut`, `/inject`, regex commands, …).
- Dispatching **card-registered** commands (`registerFrameCommand`) from a card's own `triggerSlash` (those
  are chat-input commands; rarely self-invoked).
- `/send` as a real **history insert** (it maps to the composer — see §3.3), consistent with how
  `createChatMessages` already routes onboarding text through `host.setInput`.

## 3. Design decisions (defaulted — flag if you disagree)

1. **Run the interpreter in the shared runtime, over the `Host`.** `triggerSlash` builds an `StCtx` whose
   variable reads/writes and command fallback go through `Host` methods (`statData`, `applyVariableOps`,
   `generate`, `generateRaw`, `setInput`). Because every one of those is **already implemented in both
   adapters**, `triggerSlash` reaches parity **by construction** — no `wcv-host-trigger-slash` round-trip
   (the cross-process worry the parity-status doc flagged is avoided entirely). The interpreter never touches
   the renderer's `slash.ts` registry.
2. **Relocate, don't duplicate.** Move `plugin/stscript.ts` → `src/shared/stscript.ts` (it already imports
   only `shared/macros`). `plugin/stscript.ts` becomes a one-line re-export so `slash.ts` and the existing
   `test/stscript.test.ts` keep working unchanged — **zero behavior change** for the renderer slash path.
3. **Command → `Host` mapping (the `StCtx.fallback`).** Built-ins stay in the interpreter; everything else
   the fallback maps to a `Host` method:

   | Command | Backing | Result |
   | --- | --- | --- |
   | `/setvar` `/getvar` `/addvar` (+ chat scope) | interpreter + `StCtx.setVar` → `setVarOps`/`writeVars` | persisted chat var (stat_data) |
   | `/setglobalvar` `/getglobalvar` `/addglobalvar` | interpreter + `host.getGlobalVars`/`setGlobalVar` | **persisted** global var (§3.4) |
   | `/echo` `/comment` `/abort` `/if` `/run` `/pass` | interpreter | pipe value |
   | `/gen` | `host.generate(text || pipe)` | generated text |
   | `/genraw` | `host.generateRaw(normRaw(args))` | generated text |
   | `/trigger` | `host.generate('')` | regenerated turn |
   | `/send` | `host.setInput(text || pipe)` | `''` (composer inject — §3.3) |
   | unknown | no-op, `console.warn` | `''` |

4. **Both chat and global vars persist.** `StCtx.setVar(key, v, 'local')` → `writeVars(setVarOps(key, v))` —
   the **same** path `Mvu.setMvuVariable` uses, so a card's `/setvar`, its `{{getvar}}`, and its EJS all read
   one `stat_data` store. `ctx.vars` is the **live** cached `stat` (optimistic in-place update, mirroring
   `setMvuVariable`; the authoritative refresh still flows back via `onVarsChanged`) so a later read in the
   same script/tick sees the write. `global` scope persists to the per-profile template-globals store via the
   new `host.getGlobalVars()` (snapshot at script start) + `host.setGlobalVar(key, value)` — the same store
   the renderer's chat-input slash uses (`pluginVars` global scope). This adds the one bit of WCV IPC the
   domain would otherwise avoid.
5. **Full macro context.** Extend `StCtx` with **optional** `char` / `user` / `persona`, threaded into the
   interpreter's `expandMacros` call, so a script's `{{char}}` / `{{user}}` expand (today only
   `getvar`/`pipe`/`roll` do). Additive + optional → `test/stscript.test.ts` and `slash.ts` unaffected.
6. **Remove the dead seam.** `host.triggerSlash` is now unused; drop it from the `Host` interface and both
   adapter stubs (the runtime owns `triggerSlash`). One fewer stub, one fewer parity asymmetry to reason about.

## 4. The `Host` seam changes

**Remove** `triggerSlash(cmd): Promise<string>` (the runtime now owns it). **Add** the persistent global-var
pair (the chat-var/generate/setInput backings already exist):

```ts
getGlobalVars(): Promise<Record<string, any>>   // snapshot of the per-profile globals
setGlobalVar(key: string, value: any): Promise<void>
```

## 5. thRuntime wiring (`shared/thRuntime/index.ts`)

- `import { runScript, type StCtx } from '../stscript'`.
- A `runTriggerSlash(command: string): Promise<string>` helper in `createThRuntime` (near `substMacros`,
  which already has `stat` / `host` / `normRaw` in scope) that builds the `StCtx` per §3.3–§3.5 and returns
  `runScript(command, ctx)` (the interpreter swallows `/abort`; wrap in the existing `errorCatched`-style
  try/catch so a script error returns `''` rather than throwing into the card).
- Point `TavernHelper.triggerSlash` (line 252) — and any alias (`triggerSlashWithResult`, a `STscript`/
  `SillyTavern.executeSlashCommands*` shim if present; grep first) — at `runTriggerSlash`.

## 6. The adapters

Both lose the dead `triggerSlash` stub and gain the global-var pair (the only new code):
- **Inline (`cardBridge/host.ts`)** — `getGlobalVars` → `window.api.pluginGetVars(...).global`; `setGlobalVar`
  → `window.api.pluginVars(..., { op:'set', scope:'global', key, value })`.
- **WCV (`wcvHost.ts` + `wcvIpc`)** — one ctx-scoped IPC pair `wcv-host-get-global-vars` /
  `wcv-host-set-global-var` → `pluginService.getVars(...).global` / `pluginVars(..., scope:'global')`.

The interpreter, the variable/chat/generate/setInput backings, and all command dispatch stay in the shared
runtime — so `/setvar` `/gen` `/echo` `/if`… reach parity by construction with zero adapter code.

## 7. Files

**Changed**
- `src/renderer/src/plugin/stscript.ts` → **moved** to `src/shared/stscript.ts` (import `./macros`); the old
  path becomes `export * from '../../../shared/stscript'`.
- `src/shared/stscript.ts` — add optional `char`/`user`/`persona` to `StCtx`; thread into `expandMacros`.
- `src/shared/thRuntime/types.ts` — remove `triggerSlash`; add `getGlobalVars`/`setGlobalVar` to `Host`.
- `src/shared/thRuntime/index.ts` — `runTriggerSlash` helper + wire `triggerSlash`.
- `src/renderer/src/cardBridge/host.ts`, `src/preload/wcvHost.ts` — drop the `triggerSlash` stub; add the
  global-var pair (inline via `window.api.pluginVars/pluginGetVars`; WCV via the new IPC).
- `src/main/ipc/wcvIpc.ts` — `wcv-host-get-global-vars` / `wcv-host-set-global-var` handlers.
- `test/thRuntime.test.ts` — mock-Host: drop `triggerSlash`, add the global-var pair; add `triggerSlash` tests.

**Reused / unchanged**
- The interpreter logic, `test/stscript.test.ts` (still imports the re-export path), `slash.ts` (the renderer
  chat-input slash path), `shared/macros`.

## 8. Decisions / open questions

1. **Global-var persistence** (§3.4) — **persisted** (user-confirmed) to the per-profile template-globals
   store via the new `Host` pair + one WCV IPC pair. (Earlier draft defaulted to ephemeral; revised.)
2. **`/send` semantics** (§3.3) — maps to `host.setInput` (composer), not a silent history insert. Matches
   the onboarding `createChatMessages` decision. Flag if a real append is wanted (needs a floor-model call).
3. **`/trigger` → `host.generate('')`** — regenerates a turn with empty input. Confirm that's the intended
   mapping for the inline `generate` (appends a floor) vs WCV.
4. **Remove `host.triggerSlash`** (§3.6) — **removed** (dead; runtime owns it).

## 9. Tests

- **`test/stscript.test.ts`** — unchanged, still green via the re-export (proves the relocation is a no-op).
- **`test/thRuntime.test.ts`** (mock Host): `triggerSlash('/setvar key=hp 5 | /getvar key=hp')` → `'5'` **and**
  `applyVariableOps` called with `{ op:'set', path:'/hp', value:5 }`; `triggerSlash('/echo {{char}}')` →
  `'Ellia'` (macro context); `triggerSlash('/gen hi there')` → `'gen:hi there'` via `host.generate` (mock);
  `triggerSlash('/echo a | /echo {{pipe}}!')` → `'a!'`; unknown command → `''`.
- **Manual (Electron, both transports):** a card calls `triggerSlash('/setvar key=hp 10 | /getvar key=hp')`
  (var round-trips), `triggerSlash('/gen …')` (a turn generates), and a piped `/echo` — inline + Isolated
  produce identical results.

## 10. Acceptance criteria

- `triggerSlash` runs the §2 subset; the interpreter lives in `shared/`; the renderer slash path is unchanged
  (relocation is a no-op — `test/stscript.test.ts` green untouched).
- Parity by construction: command dispatch + chat-var/generate/setInput stay in the shared runtime; the only
  new adapter/IPC code is the persistent global-var pair. `host.triggerSlash` removed from the seam + both
  adapters.
- Chat **and** global vars persist; new thRuntime tests pass; `npm test` + `typecheck` + `build` green; no new
  lint.
- Loops/long-tail commands, card-registered-command dispatch, and `/send`-as-insert remain out of scope.
