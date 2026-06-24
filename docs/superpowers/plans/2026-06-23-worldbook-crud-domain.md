# Worldbook CRUD / Bind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** expose worldbook **list / create / delete / read-write-by-name / bind** through the SP1 `Host`
seam + thRuntime helpers + both adapters, so a card manages worldbooks identically in both transports. The
backing (`lorebookService`, `chatService.setChatLorebookIds`, `window.api` lorebook methods) already exists.

**Architecture:** new `Host` methods (sync `listWorldbooks`/`chatWorldbookIds`; async create/delete/
getById/saveById/bind); `createThRuntime` keeps an **id↔name map** and the card-facing helpers resolve TH
**names** → RPT **ids** through it; the inline adapter wires `window.api` + the chat store, the WCV adapter
adds ctx-scoped IPC. Trusted-card scope = full library (spec §3.2).

**Spec:** [docs/superpowers/specs/2026-06-23-worldbook-crud-domain.md](../specs/2026-06-23-worldbook-crud-domain.md)

## Global Constraints

- Prettier no-semi/single-quote/2-space/printWidth 100. `any` intentional at the card boundary.
- `shared/thRuntime/**` imports nothing realm-specific. Clean-room (no JSR source).
- Run `npm run typecheck` + `npm test` + `npm run build` before each task's commit; no new lint.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Modify `src/shared/thRuntime/types.ts` — `Host` additions (spec §4).
- Modify `src/shared/thRuntime/index.ts` — id↔name map + helpers (spec §5).
- Modify `src/renderer/src/cardBridge/host.ts` — inline adapter.
- Modify `src/preload/wcvHost.ts` + `src/main/ipc/wcvIpc.ts` — WCV adapter + handlers.
- Modify `test/thRuntime.test.ts` — mock-Host additions + helper tests.

---

### Task 1: Host seam + thRuntime helpers + tests (the core)

**Files:** `types.ts`, `index.ts`, `test/thRuntime.test.ts`.

- [ ] **Step 1:** add the §4 methods to the `Host` interface.
- [ ] **Step 2:** in `createThRuntime`, build an `idByName` map seeded from `host.listWorldbooks()` at
  construction; a `resolveId(name)` helper (cached lookup → fresh `host.listWorldbooks()` fallback →
  undefined). Refresh the map on `createWorldbook`/`deleteWorldbook`.
- [ ] **Step 3:** add/upgrade the helpers (spec §5): real `getWorldbookNames`/`getLorebooks`,
  `createWorldbook`/`createLorebook` (→ host + record id↔name + return name), `deleteWorldbook`/
  `deleteLorebook` (resolve→id→host), `getWorldbook(name?)` (name→id→`getWorldbookById`, else own book),
  `replaceWorldbook`/`updateWorldbookWith` (name→id→`saveWorldbookById`, else own book), `bindLorebook`/
  `setChatWorldbook` (resolve→id→`bindWorldbook`). Unknown name on a write → no-op (logged), returns false.
- [ ] **Step 4:** extend the mock Host in `test/thRuntime.test.ts` (track `createWorldbook`/`bindWorldbook`
  calls; `listWorldbooks` returns a fixture). Tests: `getWorldbookNames` = library names; `createWorldbook`
  returns the name + a later `getWorldbook(name)` resolves to its id via `getWorldbookById`;
  `deleteWorldbook(name)` → `host.deleteWorldbook(id)`; `bindLorebook(name, true)` → `host.bindWorldbook(id,
  true)`; unknown name write no-ops.

**Verify:** `npm test` (new tests) + typecheck. Adapters still satisfy the widened `Host` only after T2/T3,
so temporarily the adapter files won't compile — do T1→T2→T3 together before the first green commit, OR add
the new `Host` methods as the adapters are wired (recommended: land T1 with the interface + helpers + tests,
and stub the two adapters' new methods in the SAME commit so typecheck passes, then flesh them in T2/T3).

### Task 2: Inline adapter (`cardBridge/host.ts`)

- [ ] **Step 1:** `listWorldbooks` (sync) — read a renderer lorebook store if one holds the library; else a
  module cache seeded by a one-time `window.api.listLorebooks(ctx.profileId)` (refreshed after create/delete).
  Verify whether a `lorebookStore` exists first (spec §8.1).
- [ ] **Step 2:** `createWorldbook` → `window.api.createLorebook`; `deleteWorldbook` →
  `window.api.deleteLorebook`; `getWorldbookById` → `window.api.getLorebook`; `saveWorldbookById` →
  `window.api.saveLorebook` (wrap entries into the `{name, entries}` shape like the existing own-book save).
- [ ] **Step 3:** `chatWorldbookIds` (sync) — the chat store's active lorebook ids; `bindWorldbook(id, on)`
  → read current ids, add/remove `id`, `window.api.setChatLorebooks(ctx.profileId, ctx.chatId, next)`.

**Verify:** typecheck + build (renderer). Inline cards unaffected until used.

### Task 3: WCV adapter (`wcvHost.ts` + `wcvIpc.ts`)

- [ ] **Step 1:** `wcvIpc` ctx-scoped handlers (mirror the existing worldbook handlers' ctx resolution):
  `wcv-host-list-worldbooks-sync` (→ `lorebookService.listLorebooks`), `-create-worldbook`,
  `-delete-worldbook`, `-get-worldbook-by-id`, `-save-worldbook-by-id`, `-chat-worldbook-ids-sync`
  (→ `chatService.getChatLorebookIds`), `-bind-worldbook` (read ids → add/remove → `setChatLorebookIds`).
- [ ] **Step 2:** `wcvHost.ts` implements the new `Host` methods over those channels (sync via `sendSync`,
  async via `invoke`).

**Verify:** typecheck + `npm test` + build green. **Manual (Electron, both transports):** a card lists /
creates / writes-by-name / binds (then confirm it matches into prompts) / unbinds / deletes a worldbook —
inline + Isolated identical.

---

## Sequencing & acceptance

```
T1 Host seam + thRuntime helpers + tests (stub adapter methods so it compiles)
→ T2 inline adapter  → T3 WCV adapter + IPC  (parity)
```

Each task its own commit (typecheck + test + build green). **Acceptance** = spec §10: the Host methods +
helpers exist, both adapters implement them, cards manage worldbooks identically in both transports; new
tests pass; entry-level fine CRUD / file import / char-primary rebind stay out of scope.

## Risks

- **Sync `listWorldbooks`/`chatWorldbookIds`** (cards call them without await) — needs a sync source; cache
  + refresh if no store (spec §8.1). The cache can go stale vs an external library edit; refresh on
  create/delete covers card-driven changes.
- **Scope** = full library (trusted) — a card can delete any book; accepted per the trusted-card stance
  (flag if you want it scoped to own+created).
- **Adapter/interface lockstep** — widening `Host` breaks both adapters until wired; land the interface +
  adapter stubs together so typecheck stays green (Task 1 note).

## Status (built 2026-06-23, branch `feat/worldbook-crud`)

DONE — T1 `7aadcc7` (Host seam + thRuntime id↔name resolver/helpers + tests), T2 `eabf2fb` (inline adapter
via `window.api` + `lorebookStore`), T3 `020fc91` (WCV adapter + ctx-scoped `wcv-host-*` IPC). Static gate
green throughout (`typecheck` + `npm test` 471 + `build`). Both transports have full worldbook CRUD/bind at
parity (scope = full library, user-confirmed). **Pending Electron smoke:** a card lists/creates/writes-by-
name/binds (then confirm it matches into prompts)/unbinds/deletes a worldbook — inline + Isolated. Out of
scope (noted): entry-level fine CRUD, file import, char-primary rebind.
