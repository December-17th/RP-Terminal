# 02 — reevaluateVariables discards ALL card write-backs on any chat mutation

Status: ready-for-agent

## Problem

`generationService.reevaluateVariables` (src/main/services/generationService.ts:261-279) rebuilds
every floor's `stat_data` by replaying model `<UpdateVariable>` blocks from scratch. Card/panel
write-backs applied via `applyVariableOps` (start-button choices, init writes, bookkeeping vars
like `adaptive_regex_last_message_id`) are NOT re-derivable from response text, so **any** chat
mutation that triggers the re-fold (`chatWriteService.afterChatMutation` — card `setChatMessages` /
`deleteChatMessages` / `saveChat`, host edit/delete via chatIpc.ts:40-54) silently destroys them.

Concrete user-visible case (命定之诗): the start button writes the player's setup choices to
floor 0; a later message edit wipes them. This was also the fuel for issue 01's infinite loop
(every cycle's re-write was a "real change" because the previous one had just been wiped).

## Why it's not part of the 01 fix

Architectural: needs a decision on how card writes participate in replay — e.g. persist write-back
ops per floor and replay them after the model blocks (an op-log like the SQL-table memory rewind),
or snapshot non-model keys and merge them back, or scope the re-fold to floors ≥ the mutated one.
Each option changes MVU-fidelity semantics; needs owner input + a check against real MVU behavior
(what does MagVarUpdate do with programmatic `Mvu.setMvuVariable` writes on re-evaluation? —
unverified).

## Owner decision (2026-07-04)

Option 1 — op-log the card variable writes and replay them after the model blocks during
`reevaluateVariables` (the `table_ops` rewind pattern). New `vars_ops` app-DB table; logged at
`applyVariableOps` (patch) + the card whole-replace path (`wcv-host-set-vars`); truncation clamps
via `chatService.truncateFloors`; the Variables-view debug editor (`setFloorStatData`) stays
UNLOGGED deliberately (re-derive-from-scratch remains its contract).

## Comments
