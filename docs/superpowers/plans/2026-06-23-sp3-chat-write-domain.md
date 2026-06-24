# SP3 — Chat-Write Domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** make the chat-write methods (`setChatMessages`, `deleteChatMessages`, `saveChat`, `reloadChat`,
`setInput`) work identically in both transports from ONE implementation — extract the logic trapped inside
`wcvIpc.ts` into a shared `chatWriteService`, expose it to both the WCV IPC and a new inline `window.api`/IPC,
and implement the inline `Host` stubs against it. Result: a card's chat edit/delete/save — and the 命定之诗
home's greeting-swipe "start game" — work in **inline** mode, not just WCV.

**Architecture:** `chatWriteService` (main) owns set/delete/save over floors (via `floorService`/`chatService`/
`generationService`), using a pure `chatIndexMap` (moved to `shared/thRuntime/shapes.ts`). `wcvIpc` handlers
and a new `chatWriteIpc` both call it. The inline `Host` adapter (`cardBridge/host.ts`) calls the new
`window.api` + reloads its own Zustand store; the WCV adapter is unchanged. Strangler migration keeps the app
green at each step; the WCV refactor is behavior-preserving.

**Tech Stack:** TypeScript (strict), Vitest, electron IPC, Zustand, the SP1 `thRuntime` + adapters.

**Spec:** [docs/superpowers/specs/2026-06-23-sp3-chat-write-domain.md](../specs/2026-06-23-sp3-chat-write-domain.md)

## Global Constraints

- Prettier: **no semicolons, single quotes, 2-space indent, printWidth 100, no trailing commas**.
- `any` is intentional at the card boundary (the repo disables `@typescript-eslint/no-explicit-any`).
- `src/shared/thRuntime/**` imports nothing realm-specific (only its own modules/types).
- Clean-room: never copy/vendor JSR source.
- Run `npm run typecheck`, `npm test`, `npm run build` before each task's commit; no new lint errors.
- **Behavior-preserving WCV refactor:** Task 3 must not change what the `wcv-host-*` handlers do — same
  edits, same pushes — only the source of the logic.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Create `src/main/services/chatWriteService.ts` — `setChatMessages`/`deleteChatMessages`/`saveChat`/`afterChatMutation`.
- Create `src/main/ipc/chatWriteIpc.ts` — `chat-set-messages`/`chat-delete-messages`/`chat-save` → the service.
- Modify `src/shared/thRuntime/shapes.ts` — add pure `chatIndexMap`.
- Modify `src/main/ipc/wcvIpc.ts` — handlers call the service; drop the inline logic + local `chatIndexMap`.
- Modify the main IPC index — register `chatWriteIpc`.
- Modify `src/preload/index.ts` — `setChatMessages`/`deleteChatMessages`/`saveChat` on `window.api`.
- Modify `src/renderer/src/cardBridge/host.ts` — implement the five stubs.
- Create `test/chatWriteShapes.test.ts` (or extend `thRuntimeShapes.test.ts`), `test/chatWriteService.test.ts`.

---

### Task 1: pure `chatIndexMap` in `shapes.ts` (+ tests)

**Files:** Modify `src/shared/thRuntime/shapes.ts`; create/extend the shapes test.

- [ ] **Step 1:** add `export function chatIndexMap(floors: FloorLike[]): Array<{ floorIdx: number; isUser: boolean }>`
  — the inverse of `floorsToThMessages`: per floor, push `{floorIdx,isUser:true}` IF `user_message.content`
  is non-empty, then always `{floorIdx,isUser:false}`. (Copy the semantics from `wcvIpc.ts`'s current
  `chatIndexMap` exactly — it's the index space `getChatMessages`/`setChatMessages` share.)
- [ ] **Step 2:** tests — floors with and without user content map to the right `{floorIdx,isUser}` order;
  empty floors → `[]`; assert it aligns with `floorsToThMessages` ids (index i ↔ message i).

**Verify:** `npm test` (new tests green), typecheck. No wiring yet — pure addition.

---

### Task 2: `chatWriteService` (main) — extract the logic (+ tests)

**Files:** Create `src/main/services/chatWriteService.ts`, `test/chatWriteService.test.ts`.

**Interfaces (produced):**
```ts
setChatMessages(profileId, chatId, messages): number        // count of floors touched
deleteChatMessages(profileId, chatId, ids): boolean
saveChat(profileId, chatId, chat): boolean
afterChatMutation(profileId, chatId): { variables: any } | null   // re-fold; returns rebuilt latest
```

- [ ] **Step 1:** move the logic VERBATIM from `wcvIpc.ts` into the service, parameterized by
  `(profileId, chatId)` instead of `ctx`: `setChatMessages` (map via `chatIndexMap`, edit content by role,
  `floorService.saveFloor`, return touched count); `deleteChatMessages` (earliest targeted floor →
  `chatService.truncateFloors`); `saveChat` (assistant→floors: `response.content` + `swipes` + `swipe_id`,
  `saveFloor`); `afterChatMutation` (`generationService.reevaluateVariables` → return the rebuilt latest floor).
  Import `chatIndexMap` from `shared/thRuntime/shapes`.
- [ ] **Step 2:** tests against a **stubbed `floorService`/`chatService`/`generationService`** (vi.mock or
  injected): `setChatMessages` edits the mapped floor's correct role, skips non-string/out-of-range ids,
  counts touched; `deleteChatMessages` truncates from the earliest targeted floor (and false on no valid
  ids); `saveChat` writes content+swipes+swipe_id to assistant floors in order, leaves user messages.

**Verify:** `npm test`, typecheck. Not wired into IPC yet (no behavior change in the app).

---

### Task 3: `wcvIpc` calls the service (behavior-preserving refactor)

**Files:** Modify `src/main/ipc/wcvIpc.ts`.

- [ ] **Step 1:** rewrite `wcv-host-set-chat-messages`/`-delete-chat-messages`/`-save-chat` to: resolve
  `ctx` from the sender, call `chatWriteService.*(ctx.profileId, ctx.chatId, …)`, then run the EXISTING
  WCV-specific push (`pushHostVars`/`notifyVarsChanged`/`pushHostReload`) using `afterChatMutation`'s result.
  Keep the same return values + logs.
- [ ] **Step 2:** delete the now-unused local `chatIndexMap` and the inline edit/truncate/save logic from
  `wcvIpc.ts`. Keep `afterChatMutation`'s WCV push wrapper (or call the service's `afterChatMutation` then
  push). `wcv-host-save-chat`'s re-fold + push stays equivalent.

**Verify:** `npm test` + `build` green; **WCV behavior unchanged** (same edits/pushes). Manual WCV smoke
(card edit/delete; home greeting-swipe in Isolated) deferred to the end — no output should differ.

---

### Task 4: inline IPC + `window.api`

**Files:** Create `src/main/ipc/chatWriteIpc.ts`; register it in the main IPC index; modify `src/preload/index.ts`.

- [ ] **Step 1:** `chatWriteIpc`: `ipcMain.handle('chat-set-messages', (_e, profileId, chatId, messages) => {
  const n = chatWriteService.setChatMessages(profileId, chatId, messages); if (n) chatWriteService.afterChatMutation(profileId, chatId); return n > 0 })`,
  and likewise `chat-delete-messages`, `chat-save` (each calls the service + `afterChatMutation` on success).
  (No WCV-style push — the inline renderer reloads its own store in Task 5.)
- [ ] **Step 2:** register `registerChatWriteIpc` in the IPC index (next to the other `register*Ipc`).
- [ ] **Step 3:** `window.api`: `setChatMessages(profileId, chatId, messages)`,
  `deleteChatMessages(profileId, chatId, ids)`, `saveChat(profileId, chatId, chat)` → the new channels.

**Verify:** typecheck + build (preload + main). No renderer caller yet.

---

### Task 5: inline `Host` adapter — implement the five stubs

**Files:** Modify `src/renderer/src/cardBridge/host.ts`.

- [ ] **Step 1:** `setChatMessages`/`deleteChatMessages`/`saveChat` → the new `window.api.*` with
  `ctx.profileId, ctx.chatId`, returning its boolean; then refresh the renderer's floors via
  `useChatStore.getState().setActiveChat(ctx.profileId, ctx.chatId)` (re-loads + re-folds) so the card +
  native UI see the change. (Only refresh when the chat is the active one.)
- [ ] **Step 2:** `reloadChat` → `await useChatStore.getState().setActiveChat(ctx.profileId, ctx.chatId)`;
  return true.
- [ ] **Step 3:** `setInput` → the composer store's set-input action. **Verify the store + action name
  first** (the WCV path proves the effect via `wcv-host-set-input` → `wcvManager.pushHostInput` → composer);
  import it like `host.ts` imports the other stores. If the composer store isn't a clean fit, keep a guarded
  fallback but prefer the direct call.
- [ ] **Step 4:** remove the stub comments; confirm no other inline-host method regressed.

**Verify:** typecheck + `npm test` + build green. **Manual (Electron, inline mode):** a card edits a message,
delete-from-here, and the **home's greeting-swipe start now works inline**; toggle to Isolated → identical.

---

## Sequencing & acceptance

```
T1 chatIndexMap (shapes, +tests) → T2 chatWriteService (+tests) → T3 wcvIpc uses it (WCV unchanged)
→ T4 inline IPC + window.api → T5 inline Host implements the stubs (parity reached)
```

Each task is its own commit (typecheck + test + build green; no new lint). **Acceptance** = spec §8: one
`chatWriteService` called by both transports (no duplicated logic; `chatIndexMap` shared in `shapes.ts`); the
inline adapter implements all five methods; the home greeting-swipe start works inline; new unit tests pass;
WCV behavior unchanged; `createChat`/`createChatMessages`-insert/`triggerSlash` still deferred (SP3.2).

## Risks

- **WCV regression in T3** — the refactor must be byte-equivalent in behavior. Mitigate: move logic verbatim,
  keep the same returns/logs/pushes; lean on the existing WCV tests + the end-to-end manual smoke.
- **Inline reload UX (T5)** — `setActiveChat` re-loads floors; confirm it doesn't jar scroll/streaming.
  Acceptable parity with WCV's full reload; revisit if it feels heavy.
- **Composer store shape (T5)** — verify before wiring; the WCV path confirms such an action exists.
- **Floor-model coupling** — delete = truncate-from-floor (documented constraint), not arbitrary deletes;
  createChat/insert deferred to SP3.2 for the same reason.

## Status (built 2026-06-23, branch `feat/sp3-chat-write-domain`)

T1–T5 done: `b56dcce` (chatIndexMap → shapes), `9d344c6` (chatWriteService + 9 tests), `f1c9058` (wcvIpc
delegates; −49 net lines), `d033f51` (inline IPC + window.api), `24959a5` (inline Host implements the five
methods). Static gate green at every commit: `npm run typecheck` + `npm test` (466) + `npm run build`.
One `chatWriteService` now backs BOTH transports; the inline host reaches WCV parity for the chat-write
domain.

**Pending Electron smoke (yours):** a card edits a message + delete-from-here, and the 命定之诗 home's
**greeting-swipe "start game" now works inline** (was a silent no-op) — verify, then toggle to Isolated for
parity. WCV behavior should be unchanged by the T3 refactor.

**Findings / deferred:**
- **get/set message-id divergence — RESOLVED (`076c52c`):** `floorsToThMessages` (getChatMessages) +
  `currentMessageId` now DERIVE from the compact `chatIndexMap`, the same space `setChatMessages`/
  `deleteChatMessages` + `SillyTavern.chat[]` use — so a `message_id` round-trips get→set to the correct
  floor (previously getChatMessages numbered an empty user slot at `2i`, mismapping on floor 0's greeting).
  getChatMessages ids are now COMPACT, deliberately superseding SP1's 2-per-floor scheme. Tests updated; 467.
- **SP3.2:** `createChat`, general `createChatMessages` (insert a new message), `triggerSlash` — still stubs
  in both transports; need the floor-model create/insert design.
