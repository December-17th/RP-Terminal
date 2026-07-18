# Import is the trust act; remote code needs an isolated-realm high-trust opt-in

- **Status:** Accepted 2026-07-17 (grill session over `.scratch/st-preset-compat/PLAN.md`).
- **Evidence:** corpus audit — 3 of 8 presets carry SoliUmbra scripts fetching code from `jnai2d9kgnbs6xzx5c.com`; ST's own model quarantines embedded preset/character scripts behind per-preset allow-lists (`extensions/regex/engine.js` allow checks).

## Context
Imported presets embed executable content at three weights: regex rules and EJS templates (sandboxed, bounded), TavernHelper scripts (isolated card realm, Host API), and scripts that fetch **remote code** at runtime. SillyTavern answers with allow-list ceremony per preset. RPT's standing stance is "no real harm" (prompt injection accepted; API keys main-side; hardening deferred). The open questions were the default posture and whether remote-fetching scripts may run at all — and if so, *where*.

## Decision
- **Importing a preset is the trust act.** Its regex, EJS, and TavernHelper scripts execute immediately; the import summary is an *inventory* (counts + capabilities), not a gate. No ST-style allow-lists.
- **Remote-code scripts are the one exception:** they require an explicit per-preset high-trust opt-in.
- **High-trust unlocks the isolated realm only:** network fetch + full DOM freedom inside the WCV card realm, plus the documented Host API. The app renderer, main process, and keys stay unreachable **at every trust level**; a script needing app-renderer DOM surfaces as a diagnostic, not a grant. Worst case is a wrecked card view.

## Consequences
- The two Dramatron-family presets' SPreset loaders and the 命定之诗/狐神抚/Aether binder scripts become runnable without weakening the app boundary.
- "No real harm" survives as an architectural property (realm isolation), not a policy promise.
- The run-by-default posture is calibrated to a single-user install. **Revisit at public-release time** — the WP-0.3 capability inventory keeps a later allow-list retrofit cheap.
- The realm gate itself is **cooperative/advisory today**: the `isolatedRealm` flag consumed by `get-runtime-scripts` (`src/main/ipc/scriptIpc.ts:44`) is caller-supplied, not sender-validated, so it distinguishes the transports by convention rather than enforcing them. Hardening it into a real boundary is pending the WCV `contextIsolation` work already tracked as future hardening; until then "high-trust unlocks the isolated realm only" holds by cooperation, and the underlying safety property remains realm isolation (worst case is a wrecked card view), not this flag.
- The `hasRemoteCodeLoad` detector (`src/main/services/scriptService.ts`) is a best-effort, statically-evadable trust **label**, not a security boundary — obfuscation or a runtime-assembled URL slips past its patterns, and that is accepted; the real containment is the WCV isolated realm (contextIsolation hardening is separately owner-pending, per the consequence above).
- Fetching remote script code for offline *study* (hash-pinned, read-only) is permitted for research; executing it in-app always goes through the opt-in.
