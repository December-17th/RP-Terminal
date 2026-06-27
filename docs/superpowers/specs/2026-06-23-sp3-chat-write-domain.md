# SP3 — Chat-Write Domain (parity + shared service)

> First **TH-domain slice** of the [JSR faithful-host architecture](2026-06-23-jsr-faithful-host-architecture.md)
> roadmap step (B) ("SP3…n — TH domains, one slice per spec"). Builds on the SP1 `thRuntime` + SP2
> rendering-env. Clean-room. Branch: stacks on `feat/sp2-rendering-env-parity` (a new
> `feat/sp3-chat-write-domain` off it).
>
> **Slice choice + rationale (redirectable):** the **chat-write domain** — `setChatMessages`,
> `deleteChatMessages`, `saveChat`, `reloadChat`, `setInput`. Chosen first because (1) the **inline host
> stubs all of them** while the WCV host implements them → a concrete inline↔WCV parity gap on the DEFAULT
> mode; (2) the just-validated 命定之诗 home's "start game" does a greeting-swipe → `saveChat` + `reloadChat`,
> which **silently no-op inline** today; (3) the backing services already exist (the logic is just trapped
> inline in `wcvIpc.ts`), so this is wiring + an anti-drift extraction, not new infrastructure. Other
> domains (worldbook CRUD/bind, regex write, audio, var-macros, full `tavern_events`) are equally valid
> first slices — say the word and I'll repoint.

## 1. Problem

After SP1, both transports build the card surface from one `thRuntime`, but the `Host` **adapters** still
diverge for chat writes:

- **WCV host** (`src/preload/wcvHost.ts`): `setChatMessages`/`deleteChatMessages`/`saveChat`/`reloadChat`/
  `setInput` → `ipcRenderer.invoke('wcv-host-…')`. The real logic (index→floor mapping, content edit,
  truncate, assistant→floor save with swipes, re-fold + reload) lives **inline in the handlers** in
  `src/main/ipc/wcvIpc.ts`, backed by `floorService`/`chatService`/`generationService`.
- **Inline host** (`src/renderer/src/cardBridge/host.ts`): the same five methods are **stubs**
  (`async () => false`, `async () => true`, `() => {}`). A card's chat edit/delete/save silently does
  nothing inline — including the home's greeting-swipe start (`saveChat` + `reloadCurrentChat`).

So the chat-write logic is (a) **not reachable from the inline path** and (b) **only implemented once, inside
WCV IPC handlers** — if we re-implement it in the renderer for inline, we reintroduce exactly the
inline/WCV drift SP1 set out to kill.

## 2. Goal & non-goals

**Goal:** the chat-write methods work **identically in both transports**, from **one** implementation.
Extract the logic out of `wcvIpc.ts` into a shared main **service**; expose it to both the WCV IPC and a new
`window.api`/IPC the inline host calls; implement the inline `Host` adapter against it. The home's
greeting-swipe start works inline.

**Non-goals (later slices):**

- `createChat`, general `createChatMessages` (insert a NEW message), `triggerSlash` — **stubs in BOTH**
  today, need a floor-model design decision (the floor couples user+assistant) → **SP3.2 (onboarding/create
  path)**.
- Other TH domains: worldbook CRUD/bind, regex write, audio, var-macros, broader `tavern_events` (later
  slices).
- Per-message swipe/variable editing beyond what `saveChat` already round-trips.

## 3. Current state (the parity gap)

| Method               | Inline `host.ts`           | WCV `wcvHost.ts` → `wcvIpc.ts`                                                                | Backing                                                 |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `setChatMessages`    | `async () => false` (stub) | `invoke('wcv-host-set-chat-messages')` — index→floor, edit content, saveFloor, re-fold+reload | `floorService`, `generationService.reevaluateVariables` |
| `deleteChatMessages` | `async () => false`        | `invoke('wcv-host-delete-chat-messages')` — truncate from earliest targeted floor             | `chatService.truncateFloors`                            |
| `saveChat`           | `async () => true`         | `invoke('wcv-host-save-chat')` — assistant→floors (content + `swipes`/`swipe_id`), re-fold    | `floorService.saveFloor`, `reevaluateVariables`         |
| `reloadChat`         | `async () => true`         | `invoke('wcv-host-reload-chat')` — `wcvManager.pushHostReload`                                | (renderer reload)                                       |
| `setInput`           | `() => {}` (no-op)         | `send('wcv-host-set-input')` → composer                                                       | composer store                                          |

Renderer surface that already exists to lean on: `window.api.editFloor(profile,chat,floorIdx,user,resp)`,
`window.api.reevaluateVariables(profile,chat)`, `chatStore.loadChats`/`setActiveChat`/`applyVariableOps`.
Missing on `window.api`: discrete `setChatMessages`/`deleteChatMessages`/`saveChat` and a `truncateFloors`.

## 4. Design

### 4.1 Extract a shared chat-write service (main) — the anti-drift core

New `src/main/services/chatWriteService.ts` (or a section of `chatService`), with the logic **moved out of**
`wcvIpc.ts` verbatim, taking explicit `(profileId, chatId, …)`:

- `setChatMessages(profileId, chatId, messages)` → index→floor map, edit content, `saveFloor`, returns
  count touched.
- `deleteChatMessages(profileId, chatId, ids)` → resolve earliest targeted floor, `chatService.truncateFloors`.
- `saveChat(profileId, chatId, chat)` → assistant→floors (content + `swipes`/`swipe_id`), `saveFloor`.
- A shared `afterChatMutation(profileId, chatId)` returning the rebuilt latest `variables` (re-fold via
  `reevaluateVariables`), so each caller can do its own host push/notify.

The **pure** index↔floor mapping (`chatIndexMap` in `wcvIpc.ts`) moves to
`src/shared/thRuntime/shapes.ts` next to `floorsToThMessages` (it's the inverse), shared by the service and
any future caller. (Reuse, not a second copy.)

### 4.2 WCV path — call the service (behavior-preserving refactor)

`wcvIpc.ts`'s `wcv-host-set-chat-messages`/`-delete-chat-messages`/`-save-chat` handlers become thin: resolve
`ctx` from the sender, call the service, then the existing WCV-specific push (`pushHostVars`/
`notifyVarsChanged`/`pushHostReload`). No behavior change — same outputs, logic now shared.

### 4.3 Inline path — new `window.api` + IPC

New main IPC (`chatWriteIpc` or extend an existing chat IPC module): `chat-set-messages`,
`chat-delete-messages`, `chat-save` → the service (explicit `profileId,chatId`). New `window.api`:
`setChatMessages(profileId,chatId,messages)`, `deleteChatMessages(profileId,chatId,ids)`,
`saveChat(profileId,chatId,chat)`. (`reloadChat`/`setInput` need no main call inline — see 4.4.)

### 4.4 Inline `Host` adapter (`host.ts`) — implement the stubs

- `setChatMessages`/`deleteChatMessages`/`saveChat` → the new `window.api.*` (with `ctx.profileId/chatId`),
  then `useChatStore.getState().setActiveChat(ctx.profileId, ctx.chatId)` (or `loadChats`) to refresh the
  renderer's own floors (the renderer IS the host — no push needed, just reload its store).
- `reloadChat` → `useChatStore.getState().setActiveChat(ctx.profileId, ctx.chatId)` (reloads floors +
  re-folds), returning true.
- `setInput` → the composer store directly (`useComposerStore.getState().setInput(text)` — verify the
  store/action name; same effect as WCV's `wcv-host-set-input`). No longer a no-op.

### 4.5 saveChat swipes

`editFloor` is content-only, so `saveChat` (which also persists `swipes`/`swipe_id`) must go through the new
service path, not `editFloor`. The service mirrors `wcvIpc`'s current `saveChat` field handling exactly.

## 5. Files

**New**

- `src/main/services/chatWriteService.ts` — the extracted logic (or a `chatService` section).
- `src/main/ipc/chatWriteIpc.ts` (or extend chat IPC) — `chat-set-messages`/`-delete-messages`/`-save`.
- `src/shared/thRuntime/shapes.ts` — add pure `chatIndexMap`.
- `test/chatWriteShapes.test.ts` (or extend `thRuntimeShapes.test.ts`) — `chatIndexMap`.
- `test/chatWriteService.test.ts` — the service against a mock floor store.

**Changed**

- `src/main/ipc/wcvIpc.ts` — handlers call the service; remove the inline logic + the local `chatIndexMap`.
- `src/preload/index.ts` — `window.api.setChatMessages`/`deleteChatMessages`/`saveChat`.
- `src/renderer/src/cardBridge/host.ts` — implement the five stubs.
- Register the new IPC in the main IPC index.

**Reused / unchanged**

- The WCV host adapter (`wcvHost.ts`) and `thRuntime` surface — the `Host` signatures already exist (SP1);
  only the inline adapter's bodies change. The WCV adapter is untouched.

## 6. Decisions / open questions

1. **Service home** — a new `chatWriteService` vs extending `chatService`. Lean a new file (cohesive; keeps
   `chatService` focused on session/floor CRUD).
2. **Inline reload mechanism** — `setActiveChat` (reloads floors + re-folds) vs a lighter floor-only reload.
   Lean `setActiveChat` (it already exists and does the re-fold); confirm it doesn't reset scroll/UX
   unpleasantly. (WCV does a full host reload, so parity is fine.)
3. **`setInput` store** — confirm the composer store's action name/shape before wiring (the WCV path proves
   the effect; the inline call is direct).
4. **Delete semantics** — keep WCV's "truncate from the earliest targeted floor" (the floor model couples
   user+assistant; arbitrary mid-chat single-message deletes aren't supported). Documented, not changed.
5. **createChat/createChatMessages-insert/triggerSlash** — explicitly deferred to SP3.2 (need the floor
   model decision); they stay stubs in both this slice.

## 7. Tests

- `chatIndexMap` (pure): floors with/without user content → correct `{floorIdx,isUser}` per chat index;
  empty floors → empty.
- `chatWriteService` (mock floor store): `setChatMessages` edits the mapped floor's right role + counts
  touched + skips non-string/out-of-range ids; `deleteChatMessages` truncates from the earliest targeted
  floor; `saveChat` maps assistant messages back in order (content + swipes + swipe_id), leaves user
  messages; `afterChatMutation` re-folds. (Pure-ish: inject the floor store or stub `floorService`.)
- Existing suites stay green; the WCV refactor changes no test outputs (behavior-preserving).
- **Manual (Electron, both transports):** a card edits a message, deletes-from-here, and the **home's
  greeting-swipe start** — now works **inline** (not just WCV); confirm identical in Isolated.

## 8. Acceptance criteria

- One `chatWriteService` implements set/delete/save; **both** `wcvIpc` and the new inline IPC call it (no
  duplicated logic); `chatIndexMap` is shared in `shapes.ts`.
- The inline `Host` adapter implements all five methods (no stubs left for this domain); the home's
  greeting-swipe start works inline.
- New unit tests pass; full `npm test` + `typecheck` + `build` green; no new lint; WCV behavior unchanged.
- `createChat`/`createChatMessages`-insert/`triggerSlash` remain explicitly deferred (SP3.2).
