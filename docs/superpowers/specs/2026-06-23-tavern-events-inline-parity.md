# tavern_events — Inline Event Parity

> A TH-domain slice of the [JSR faithful-host architecture](2026-06-23-jsr-faithful-host-architecture.md)
> roadmap (B). Builds on the SP1 `thRuntime` + the SP3/worldbook adapters. Clean-room. Branch:
> `feat/tavern-events` (off `main`).

## 1. Problem

WCV cards receive the TavernHelper lifecycle/mutation events; **inline cards don't**. The renderer hub
(`App.tsx`) already computes them once from the chat-store transition — `chatTransitionEvents`
(generation start/end) + `messageMutationEvents` (message received/updated/deleted/swiped), from
`plugin/events.ts` — and the streamed-token event in `onGenerationDelta` — but it **broadcasts only to WCV**
(`window.api.wcvBroadcastEvent`). The `thRuntime` feeds `host.onHostEvent` into each card's event bus, but
the **inline** adapter's `onHostEvent` is a no-op (`cardBridge/host.ts`, a known SP1 deferral), so inline
cards only ever see the MVU + `MESSAGE_UPDATED` events the runtime fires on a var change — never
`GENERATION_STARTED/ENDED`, `MESSAGE_SENT/RECEIVED`, `CHAT_CHANGED`, or `STREAM_TOKEN_RECEIVED`.

## 2. Goal & non-goals

**Goal:** inline cards receive the **same** lifecycle/mutation/stream events as WCV cards, from the **same**
already-computed events (no recomputation, no drift) — i.e. implement the inline `onHostEvent`.

**Non-goals:** the full ~100-name TavernHelper `tavern_events` enum (most have no RPT trigger and would never
fire — adding only the ones RPT actually emits keeps it honest); new event _sources_ beyond what `App.tsx`
already computes; STScript / `triggerSlash` (separate track).

## 3. Design

A tiny renderer-local emitter that `App.tsx` dual-dispatches to, and the inline adapter subscribes to:

- **New `src/renderer/src/cardBridge/cardHostEvents.ts`** — a module singleton: `emitCardHostEvent(name,
payload)` + `onCardHostEvent(cb): () => void` (a `Set` of callbacks; emit is try/catch per-cb). Pure, no
  deps. Guard `typeof window` is unnecessary (renderer-only module).
- **`App.tsx`** — at each existing WCV broadcast point, ALSO emit to the local bus:
  - in `onGenerationDelta`: `emitCardHostEvent('stream_token_received', streamingText)`;
  - in the chat-store-transition subscription: `for (const ev of events) emitCardHostEvent(ev.name, ev.payload)`
    (alongside the `wcvBroadcastEvent` loop — same `events` array, no recomputation).
- **`cardBridge/host.ts`** — `onHostEvent: (cb) => onCardHostEvent((name, payload) => cb(name, payload))`
  (returns the unsubscribe). The `thRuntime` already wires `host.onHostEvent` → the card's bus + re-emits;
  nothing else changes.

The WCV adapter (`wcvHost.ts`) is untouched — it already implements `onHostEvent` over `wcv-event`. Both
transports now feed `onHostEvent`, so parity holds by construction.

## 4. Files

**New:** `src/renderer/src/cardBridge/cardHostEvents.ts`; `test/cardHostEvents.test.ts`.
**Changed:** `src/renderer/src/App.tsx` (dual-dispatch); `src/renderer/src/cardBridge/host.ts` (`onHostEvent`).
**Reused:** `plugin/events.ts` (the pure event computation), the `thRuntime` event bus, the WCV path.

## 5. Decisions

1. **Renderer-local emitter, not `window.api`/IPC.** Inline cards run in the renderer; the events originate
   in the renderer (`App.tsx`). A module singleton is the right channel (the WCV path uses IPC because it's
   cross-process). One global bus is fine — events carry `chatId`-free payloads today and inline cards are
   scoped to the active chat (the only chat `App.tsx` computes for).
2. **No enum explosion.** Keep the existing `tavern_events` names; the value is delivering the events inline,
   not enumerating events that never fire.

## 6. Tests

- `cardHostEvents` (pure): `emitCardHostEvent` reaches all subscribers; the returned unsubscribe stops
  delivery; a throwing subscriber doesn't break others.
- Existing suites stay green.
- **Manual (Electron, inline):** a card with `eventOn('generation_ended'|'stream_token_received'|
'message_received', …)` fires inline (e.g. the status card reacting live to a model turn), at parity with
  Isolated.

## 7. Acceptance

- Inline `onHostEvent` delivers the generation/message/chat/stream events `App.tsx` computes; WCV unchanged.
- New unit test passes; `npm test` + `typecheck` + `build` green; no new lint.
