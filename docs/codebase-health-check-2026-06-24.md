# RP Terminal — Codebase Health Check (2026-06-24)

_Read-only diagnostic. Scope: whole-repo orientation, reconciliation of the previous health check's
backlog, docs↔code drift, and duplicate-implementation hunting. No runtime behavior was changed; the
only edits made during this review were this file and a memory note._

_Supersedes [codebase-health-check.md](codebase-health-check.md) (2026-06-22), whose metrics are now
stale (see §1)._

---

## Verdict: **HEALTHY — and materially improved since 2026-06-22**

All objective gates are green and the prior cleanup backlog is essentially closed. **171 commits** landed
since the last check, concentrated on TavernHelper "both transports" parity (inline `cardBridge` + WCV
`wcvPreload`), reasoning/`<think>` display, and prompt-template (EJS/macro) fidelity.

| Check | Result |
| --- | --- |
| `npm run typecheck` (node + web) | ✅ passes |
| `npm test` | ✅ **499 pass / 59 files** (was 304 / 34) |
| `npm run lint` | ✅ **clean** (was 761 problems; config tuned in the interim) |
| Unfinished-work markers | ✅ **1 TODO** in all of `src/` (the documented `agentic` stub, `generationService.ts:118`) |
| `dangerouslySetInnerHTML` / `rehype-raw` usage | ✅ **none** in `src/` |
| Secrets committed | ✅ none (keys encrypted via `safeStorage`, resolved main-side, sent via headers) |

What's left is **minor hygiene** — a couple of small duplicate literals, two stale doc statements, and a
short list of deferred-by-design security items. Nothing is broken or on fire.

---

## §1. Previous backlog — done / not-done

The [maintainability-plan.md](maintainability-plan.md) reports **all phases 0–4 complete**. Independently
re-verified against current code:

| Item | Plan status | Verified now |
| --- | --- | --- |
| **Phase 0** — restore lint gate | ✅ done | ✅ `npm run lint` exits 0, clean |
| **Phase 1a** — delete `MessageScriptFrame.tsx` | ✅ done | ✅ file gone; no references |
| **Phase 1b** — route service `console.*` → `logService` | ✅ done | ✅ (parsers intentionally console-only) |
| **Phase 2** — extract `shared/objectPath.ts` + migrate copies | ✅ done | ✅ `templateEngine`/`mvuParser`/`mvuZod`/`mvuSchema`/`pluginService`/`workspaceLayout` import it; holdouts documented in the module header |
| **Phase 3** — settle dual card-host stack | ✅ Option A (freeze) | ✅ now an intentional **dual-mode** feature (inline default / WCV isolated), kept at deliberate parity — no longer "cruft" |
| **Phase 4a** — `ts-prune` sweep | ✅ done | ✅ no confirmed orphans (kept as a manual check, not a CI gate) |
| **Phase 4b** — doc status headers | ✅ mostly | ⚠️ **one still open** — see §2 |

**Net: the entire prior backlog is closed except one doc-status line.** Tests grew 304 → 499; the XSS
risk the old architecture note flagged is now mitigated (see §4).

---

## §2. Docs ↔ code drift — _severity: Low_

The docs are in good shape overall: the recent `docs/superpowers/specs/*` (esp.
[th-parity-status](superpowers/specs/2026-06-23-th-parity-status.md)) accurately match the code, and
`plugin-api.md` is internally consistent (card scripts have **no direct** network; host-mediated
`rpt.net` is plugin-only — matches `pluginNetService.ts`). Two confirmed drifts:

1. **`world-card-design.md:3` says "Draft — design-doc-first, no code yet"**, but
   `buildWorldCardExport` exists and is wired in [characterService.ts:279,304](src/main/services/characterService.ts).
   The export path is at least partially built. (Phase 4b explicitly left this "for owner verification";
   still unfixed.) _Fix: update the status header to "partial — export implemented"._
2. **The prior [codebase-health-check.md](codebase-health-check.md) is now stale** on every headline
   metric (304 tests, lint 761, `MessageScriptFrame` orphan, `objectPath` not yet extracted). It's a
   point-in-time diagnostic, so this is expected — but a fresh reader is misled. _Fix: this file adds a
   "superseded" banner; consider one on the old file too._

_Lower-confidence, worth an owner pass:_ `plugin-api.md §13` lists `rpt.chat.sendUserMessage` /
`rpt.lorebook.*` as "not yet callable." Chat-write + worldbook CRUD now exist in the **TavernHelper
transport** (per th-parity-status), but that's a different surface from the `rpt.v1` plugin namespace —
verify whether `rpt.v1` itself now exposes them before treating §13 as drift.

---

## §3. Duplicate implementations — _severity: Low_

The two TavernHelper compat layers are **intentional** (dual-mode parity, built over one
`shared/thRuntime`), not duplication to remove. The genuine small duplicates:

1. **`CARD_CSP` literal copied across the process boundary.** Defined in
   [wcvManager.ts:20](src/main/services/wcvManager.ts) (main) and hand-copied verbatim in
   [WcvMessageFrame.tsx:27](src/renderer/src/components/WcvMessageFrame.tsx) (renderer; comment: "can't
   import a main-process module here"). True — but it can live in `src/shared` (like `cardEnv.ts`), which
   both processes import. A CSP change to one won't propagate to the other today. _(Low)_
2. **Provider system-prompt-hoist + same-role-merge logic duplicated** in `apiService`:
   [streamAnthropic:283–303](src/main/services/apiService.ts) and
   [buildGeminiBody:394–411](src/main/services/apiService.ts) both implement the same three steps (hoist
   the leading system run, demote a later system message to `user`, merge consecutive same-role turns).
   Extract a shared `splitSystemAndMerge(messages)` helper. _(Low–Medium — same logic, two providers, must
   stay in lockstep.)_
3. **Residual `JSON.parse(JSON.stringify(...))` deep-clones** that could use `objectPath.clone`:
   `cacheLayers.ts:12`, `shared/thRuntime/index.ts:33`, `generationService.ts:133/406`,
   `layoutDefaults.ts:36`, `stores/workspaceStore.ts:71`. The `objectPath` header documents why some
   stay; a couple (cacheLayers, thRuntime) are folddable. _(Low — cosmetic.)_

`estimateTokens` is defined once (`promptBuilder.ts:24`) and imported by `promptCacheMetrics` — no dup.

---

## §4. Correctness / robustness findings (fresh)

1. **Shared per-chat `AbortController` collision** — _Medium-low._ Both `generate`
   ([generationService.ts:277,291](src/main/services/generationService.ts)) and `generateRaw`
   ([:491,500](src/main/services/generationService.ts)) do `activeControllers.set(chatId, controller)` /
   `finally { delete(chatId) }`. If a card-script `generateRaw` overlaps a normal turn on the same chat,
   the second `set` orphans the first's controller (so `abortGeneration` can't stop it) and the
   first-finishing `finally` deletes the other's entry. Reachable because `generateRaw` is exposed to
   scripts via IPC. _Fix: key the map by a generation id, or refuse/queue concurrent generation per chat._
2. **Unconditional legacy-table `DROP` with no migration guard** — _Low (irreversible)._
   [db.ts:117](src/main/services/db.ts) runs `DROP TABLE IF EXISTS presets / lorebooks / lorebook_entries
   / profile_state` on every startup. The comment asserts the on-disk JSON is authoritative, but nothing
   verifies the SQL→file export succeeded before the drop. Historical/early-phase risk; still, an
   unconditional irreversible drop deserves a one-time guard. _Fix: drop only after confirming the file
   store exists / a migration flag is set._
3. **Dead dependency `rehype-raw`** — _Trivial._ In `package.json:37`, referenced nowhere in `src/`
   (only a design doc). Remove it.
4. **Dependency placement inconsistency** — _Low (packaging)._ `react`/`react-dom` are `devDependencies`
   while other bundled renderer libs (`react-markdown`, `dompurify`, `zustand`) are `dependencies`. For a
   fully bundled renderer they'd all be devDeps; `vue`/`jquery`/`lodash` correctly stay runtime deps
   (required by the card preload). Only affects packaged `node_modules` size.

---

## §5. Security posture

Per the owner's standing decision, broad security hardening is **parked until before a public release**;
the one retained measure (API-key masking, keys resolved main-side and sent via headers) is intact and
correct. The XSS risk flagged in the old architecture memory is now **mitigated**: message markdown
renders through `react-markdown` **without `rehype-raw`** (raw HTML is escaped), and HTML blocks go
through `DOMPurify.sanitize` + a **script-less** `sandbox="allow-same-origin"` iframe
([MessageContent.tsx:143–151,201](src/renderer/src/components/MessageContent.tsx)); scripted cards run in
the intentional WCV/inline sandboxes. The plugin net proxy ([pluginNetService.ts](src/main/services/pluginNetService.ts))
has solid SSRF mitigations (https-only, disk-read host allow-list, manual redirect, `credentials: 'omit'`,
size/time caps).

**Deferred hardening (for the pre-release pass, not now):**

- `setWindowOpenHandler` → `shell.openExternal(details.url)` with **no scheme allow-list**
  ([index.ts:50–53](src/main/index.ts)) — a card-opened `file://`/`smb://` link goes straight to the OS.
- No `will-navigate` guard pinning the main window to its origin.
- Renderer CSP is permissive — `script-src 'unsafe-inline' … https:` ([index.html:26](src/renderer/index.html)).
  Currently mitigated by not rendering raw HTML, but it removes the second line of defense if that regresses.

---

## Prioritized backlog

**Worth doing (cheap):**
1. Fix the `generateRaw`/`generate` AbortController collision (§4.1) — the only real correctness item.
2. Remove the dead `rehype-raw` dep; fix `world-card-design.md` status; (optionally) hoist `CARD_CSP` to `src/shared`. (§2.1, §3.1, §4.3)

**Worth doing soon (small refactors):**
3. Extract the shared provider system-hoist/merge helper in `apiService` (§3.2).
4. Add a guard to the legacy-table `DROP` (§4.2).

**Deferred by design (don't reopen now):** the Electron-hardening items (§5), the dual-mode card-host
parity (intentional), the documented `agentic`/`generateImage` stubs, the quickjs sandbox.

---

_Bottom line: the project has clearly matured since 2026-06-22 — the prior backlog is closed, the test
suite grew ~65%, lint is a real gate again, and the XSS exposure is mitigated. The remaining items are
one genuine concurrency edge and a thin layer of hygiene._
