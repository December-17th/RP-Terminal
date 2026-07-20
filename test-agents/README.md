# Test-consumer Agents

Two Agent Definitions converted from the SillyTavern shujuku preset
`Can改数据库剧情推进预设-世界后台引擎v3.6.plot-preset.json` (命定之诗), used to exercise the Agent
Runtime end to end.

| File | From `plotTask` | Result slot | Gating |
| --- | --- | --- | --- |
| `character-progression.rptagent` | `defaultPlotTask` — 缝合怪+普赛克自动化系统 (stage 2, `OffstageDynamic`) | `variables.__rpt.agent_results.character_progression` | `blocksNextTurn: true` |
| `world-progression.rptagent` | `plotTask1781792437654` — 世界时局与经济简报+活体世界引擎 deepseek (stage 1, `WorldDynamic`) | `variables.__rpt.agent_results.world_progression` | async, card-triggered |

Both use the stock contract (`format: "rpt-agent"`, `formatVersion: 1`) with no schema extension. The
shujuku fields with no contract equivalent — `extractTags`, `extractInjectTags`, `mergeStrategy`,
`stage`, `order` — are recorded in each Agent's `description` rather than invented as new fields.

## Installing

Settings → **Agents** → **Scan agent folder**. Files are imported into the profile catalog as
`user-imported` rows; the DB remains the runtime store (design §3.1), so baselines, customization,
role bindings, and upgrade staging all behave normally.

The folder is `test-agents/` beside the running app; `RPT_AGENT_DIR` overrides it.

Re-scanning is safe and idempotent:

- the **filename** is the source key, so a file always maps to the same catalog row;
- the **content hash** is the source version, so an edited file is an *upgrade*, not a duplicate;
- if you edited the same field in the app that the file changes, the scan reports a **conflict** and
  changes nothing until you pick `Keep my edits` or `Use the file`.

## Triggering an Agent

The **live** trigger path is a declarative cadence on the Agent itself:
`trigger: { onFloorCommitted: { everyNFloors: N } }`, evaluated at the single commit boundary a new
floor emits (no timers, no variable-watching; replay never re-fires). Set it in the Agent editor's
Trigger section, or in the `.rptagent` file. This is how an imported Agent runs unattended today.

### Card-driven triggering (API currently held)

For *variable-predicate* schedules (a month boundary, a quest state), the design keeps scheduling
card-side — design §11: *"RP Terminal does not own a variable scheduler. A card script observes its
variables and chooses when to invoke an Agent."* The card `rpt.agents` API below is **built but held**
(decision D2) and does not run this release; the cadence trigger above is the shipped path. When the API
ships, the pattern is:

```js
// Card script. Fires once per committed floor; the card decides what a "month boundary" means.
rpt.agents.onFloorCommitted(async ({ floor, variables, previousVariables }) => {
  const month = (vars) => vars?.stat_data?.世界?.月份
  if (month(variables) === month(previousVariables)) return

  // The invocation is owned by the floor that caused it, so deleting that floor rewinds the result.
  await rpt.agents.run('World Progression', { floor })
})
```

`onFloorCommitted` fires only for a genuinely new floor — `emitCardFloorCommitted` is called inside
`saveFloor`'s callback under an `isNewFloor` guard (`src/main/services/chatService.ts:371-381`), and
it is the only emit site. Re-incorporating a result into an existing floor therefore cannot
re-trigger a monthly schedule.

## `blocksNextTurn` is live (fail-open)

`character-progression.rptagent` declares `blocksNextTurn: true`, and as of execution-plan M3 the flag
is **wired**: the direct Classic path awaits `waitForNextTurnBarriers(chatId)` before assembling the
next prompt (generate / regenerate / swipe). The failure policy is **fail-open with a visible warning**
(decision D5): if a required Agent fails, the barrier releases so the turn proceeds without that
result rather than hanging, and the failure surfaces on the run. A lost progression beat is
recoverable; a stuck turn is not.

Both Agents can also be exercised manually via **Run now** in the Agent Workspace against the latest
committed floor.
