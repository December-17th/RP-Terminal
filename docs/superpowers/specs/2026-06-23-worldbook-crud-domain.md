# Worldbook CRUD / Bind Domain

> A TH-domain slice of the [JSR faithful-host architecture](2026-06-23-jsr-faithful-host-architecture.md)
> roadmap step (B). Builds on SP1 `thRuntime` + the SP3 chat-write pattern. Clean-room. Branch:
> `feat/worldbook-crud` (off the chat-write line).

## 1. Problem

A card's worldbook (lorebook) API today is **read + replace-of-its-own-book**: `getWorldbook` /
`getLorebookEntries` (the card's own `character_book`, id == characterId), `replaceWorldbook` /
`updateWorldbookWith` (read-modify-write that one book), and `getWorldbookNames` — which is **derived from
the character** (primary = char name, additional = `[]`), NOT the real library. Missing: **list** the
actual library, **create** a new worldbook, **delete** one, read/write a worldbook **by name** (not just
the card's own), and **bind/unbind** a worldbook to the session. So a card can't manage worldbooks the way
a faithful TH host allows.

**The backing already exists** — `lorebookService` has `listLorebooks` / `createLorebook` /
`deleteLorebookById` / `getLorebookById` / `saveLorebookById`, `chatService.setChatLorebookIds` binds the
session's active set, and `window.api` already exposes `listLorebooks`/`createLorebook`/`deleteLorebook`/
`setChatLorebooks` (the renderer app uses them). The gap is purely the **card-facing surface**: the `Host`
methods + thRuntime helpers + the two adapters (+ a few WCV IPC handlers).

## 2. Goal & non-goals

**Goal:** a card can **list / create / delete** worldbooks, **read/write a worldbook by name**, and
**bind/unbind** one to the session — identically in both transports, from the SP1 `Host` seam.

**Non-goals (later):** entry-level CRUD beyond the existing whole-array replace (add/remove/edit already
work via `replaceWorldbook`/`updateWorldbookWith`); per-entry recursion/position editors; importing
external worldbook files from a card; char-`primary`-pointer rebinding beyond the embedded book.

## 3. Design decisions (defaulted — flag if you disagree)

1. **Name ↔ id.** RPT lorebooks are **id-keyed** (uuid, or `characterId` for the card's own book); TH
   worldbooks are **name-keyed**. Resolve a name → id via `listLorebooks` (first case-insensitive name
   match; the card's own book also matches its content name / `characterId`). `createWorldbook` returns the
   **name** (TH contract) but the runtime keeps the id→name map for subsequent `getWorldbook(name)` /
   `saveWorldbook(name)`. Ambiguous duplicate names resolve to the first match (documented).
2. **Scope = full library (trusted cards).** A card may list/create/delete/read/write **any** worldbook in
   its profile's library — consistent with the **trusted-card stance** ([[rp-terminal-security-stance]]) and
   with `window.api` already exposing full CRUD to the renderer. (The alternative — scope a card to its own
   book + books it created — is more restrictive than the host already is; rejected unless you want it.)
3. **Bind = the session's active lorebook set.** `bindWorldbook(name, on)` adds/removes that worldbook's id
   from the chat's `lorebook_ids` (`setChatLorebookIds`) — RPT's real "which books are active this session"
   model. A char-`primary` rebind (TH `setCurrentCharPrimaryLorebook`) maps to the card's embedded book
   (id == characterId) and is out of scope here (rarely used; the embedded book is already primary).

## 4. The `Host` seam additions

```ts
listWorldbooks(): { id: string; name: string }[]          // sync — the real library
createWorldbook(name: string): Promise<string>             // returns the new id (runtime maps id↔name)
deleteWorldbook(id: string): Promise<boolean>
getWorldbookById(id: string): Promise<{ name?: string; entries: any[] }>   // read ANY book
saveWorldbookById(id: string, entries: any[]): Promise<void>               // write ANY book
chatWorldbookIds(): string[]                               // sync — the session's active set
bindWorldbook(id: string, on: boolean): Promise<void>      // add/remove from the active set
```

(Existing `getWorldbook`/`saveWorldbook` stay as the card's-own-book convenience; the new `*ById` are the
general path. `worldbookNames()` stays for the char-derived primary.)

## 5. thRuntime helpers (card-facing surface)

In `createThRuntime` (`shared/thRuntime/index.ts`), keep an **id↔name map** (seeded from `host.listWorldbooks()`,
refreshed on create) and add/upgrade:

- `getWorldbookNames()` → `host.listWorldbooks().map(w => w.name)` (the **real** library — was char-derived).
- `getLorebooks()` / `getWorldbooks()` → `host.listWorldbooks()` (id+name).
- `createWorldbook(name)` / `createLorebook(name)` → `host.createWorldbook(name)`; record id↔name; return name.
- `deleteWorldbook(name)` / `deleteLorebook(name)` → resolve name→id → `host.deleteWorldbook(id)`.
- `getWorldbook(name?)` → name given → resolve→id → `host.getWorldbookById(id)`; else the card's own
  (`host.getWorldbook()` as today).
- `replaceWorldbook(name, entries)` / `updateWorldbookWith(name, fn)` → resolve name→id →
  `host.saveWorldbookById(id, entries)` (fall back to the own-book path when name is the card's own/empty).
- `bindLorebook(name, on)` / `setChatWorldbook(name, on)` → resolve→id → `host.bindWorldbook(id, on)`.

Name resolution helper (in the runtime): `name → id` via the cached map, falling back to a fresh
`listWorldbooks()` lookup; an unknown name with a write creates nothing (returns false / no-op, logged).

## 6. The adapters

- **Inline (`cardBridge/host.ts`)** — all backing already on `window.api`:
  `listWorldbooks` → `window.api.listLorebooks(profileId)` (sync? it's `invoke` → async; provide a **sync
  snapshot** via the lorebook store if one exists, else seed once + cache — see §8 risk);
  `createWorldbook`/`deleteWorldbook` → `window.api.createLorebook`/`deleteLorebook`;
  `getWorldbookById`/`saveWorldbookById` → `window.api.getLorebook`/`saveLorebook`;
  `chatWorldbookIds` → the chat store's active set (sync); `bindWorldbook` → `window.api.setChatLorebooks`
  (read current ids, add/remove, set).
- **WCV (`preload/wcvHost.ts` + `wcvIpc`)** — add ctx-scoped handlers: `wcv-host-list-worldbooks-sync`,
  `wcv-host-create-worldbook`, `wcv-host-delete-worldbook`, `wcv-host-get-worldbook-by-id`,
  `wcv-host-save-worldbook-by-id`, `wcv-host-chat-worldbook-ids-sync`, `wcv-host-bind-worldbook` →
  `lorebookService` / `chatService`. (Mirror the existing worldbook handlers' ctx resolution.)

`listWorldbooks` + `chatWorldbookIds` are **sync** (cards call them without await — the SP1 sync-getter
rule); the rest are async.

## 7. Files

**Changed**
- `src/shared/thRuntime/types.ts` — the §4 `Host` additions.
- `src/shared/thRuntime/index.ts` — id↔name map + the §5 helpers.
- `src/renderer/src/cardBridge/host.ts` — inline adapter (window.api + stores).
- `src/preload/wcvHost.ts` — WCV adapter (sendSync/invoke).
- `src/main/ipc/wcvIpc.ts` — the new `wcv-host-*` worldbook handlers.
- `test/thRuntime.test.ts` — mock-Host additions + helper behavior (name→id, create, bind).

**Reused / unchanged**
- `lorebookService` (list/create/delete/get/save), `chatService.setChatLorebookIds`, `window.api` lorebook
  methods, the existing `getWorldbook`/`saveWorldbook`/`worldbookNames` own-book path.

## 8. Decisions / open questions

1. **`listWorldbooks` sync source (inline).** Sync getters can't `await window.api`. Options: (a) a
   renderer lorebook store holding the library (if one exists) read synchronously; (b) seed a cache at
   bridge construction (one `await` up front) + refresh on create/delete. **Lean (b)** if no sync store —
   the library changes rarely; verify whether a `lorebookStore` already holds the list.
2. **Scope** (§3.2) — full library vs own+created. **Defaulted to full library** (trusted cards). Flag to
   change.
3. **Duplicate names** resolve to the first match. Acceptable; documented.

## 9. Tests

- `thRuntime` (mock Host): `getWorldbookNames` returns the library names; `createWorldbook` calls
  `host.createWorldbook` + the returned name resolves on a later `getWorldbook(name)`; `deleteWorldbook`
  resolves name→id; `bindLorebook(name,on)` resolves→id → `host.bindWorldbook(id,on)`; an unknown name on a
  write no-ops.
- Existing suites stay green.
- **Manual (Electron, both transports):** a card lists books, creates one, writes entries to it by name,
  binds it to the session (confirm it then matches into prompts), unbinds, deletes — inline + Isolated.

## 10. Acceptance criteria

- The §4 `Host` methods + §5 thRuntime helpers exist; both adapters implement them; cards can
  list/create/delete/read/write-by-name/bind worldbooks identically in both transports.
- New unit tests pass; `npm test` + `typecheck` + `build` green; no new lint.
- Entry-level fine CRUD, file import, and char-primary rebind remain out of scope (noted).
