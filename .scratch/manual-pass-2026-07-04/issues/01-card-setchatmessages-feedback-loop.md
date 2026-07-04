# 01 — Card setChatMessages re-fires the card's own MVU events → infinite loop

Status: ready-for-agent

## Symptom (owner manual pass 2026-07-04, finding #1)

命定之诗 first page: clicking the start button in the regex-replaced inline UI makes the message
box flash and spams the log forever with the cycle
`MVU re-evaluate → wcv setChatMessages → write-back adaptive_regex_last_message_id → write-back date ×7 → repeat`.

## Confirmed cause (all file:line verified 2026-07-04)

1. The card's vars-update handler writes vars (tagged `card-write`, fine — WS-3 holds), then
   re-renders message 0 via `setChatMessages` with **unchanged text**.
2. `chatWriteService.setChatMessages` (src/main/services/chatWriteService.ts:15-30) never compares
   content — a no-change edit still counts as touched (`n=1`).
3. `wcv-host-set-chat-messages` (src/main/ipc/wcvIpc.ts:551-558) then re-folds via
   `reevaluateVariables` (src/main/services/generationService.ts:261-279) which replays model
   `<UpdateVariable>` only — wiping the card's floor-0 write-backs, so next cycle's re-writes are
   always real changes.
4. The rebuilt vars broadcast (wcvIpc.ts:46-59) with origin `'external'` and **no sender
   exclusion** — unlike `wcv-host-apply-vars` (wcvIpc.ts:189-206) which passes `e.sender.id` +
   `'card-write'`. The card's own MVU events re-fire → loop. `pushHostReload` per cycle = the flash.
5. The varsWrite runaway backstop (src/main/services/generation/varsWrite.ts) never trips: the two
   write signatures alternate, so no 40-streak accumulates.
6. Indirect echo too: `pushHostReload` → App.tsx:86-90 reloads via `setActiveChat` →
   `lastVarsOrigin: 'external'` → App.tsx:93-101 rebroadcasts `'external'` to ALL panels.
7. Inline transport has the same hole: cardBridge host.ts:47-52 `reloadFloors` → `setActiveChat`.

Red repro: `test/cardChatEditFeedbackLoop.test.ts` (automaton hits the 26-cycle cap; no-change
`setChatMessages` returns 1).

## Fix (prescriptive spec given to the implementer; summary)

- A: no-op guard in `chatWriteService.setChatMessages` (skip messages whose text is unchanged).
- B: card-initiated mutation echoes (set/delete/saveChat handlers in wcvIpc, host-reload path in
  App.tsx + cardBridge host.ts) tagged `card-write` + sender-excluded, matching the apply-vars
  pattern and MVU's fire-on-model-fold-only semantics.

## Comments
