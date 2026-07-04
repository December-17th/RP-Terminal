# 04 — chatSheets updateConfig / globalInjection parity gaps vs the 数据库 script

Status: needs-triage

## Context

Owner intends imported chatSheets v2 templates (e.g. SQL-命定之诗Can改5.9) to "work properly" as
they do with the 数据库 (shujuku / AutoCardUpdater) TavernHelper script. Clean-room reference:
E:\Projects\shujuku (NO code reuse — no LICENSE file). Observed semantics (from
src/service/table/update-scheduler.ts + src/shared/models/table-data.ts, read 2026-07-04):

- `updateConfig.updateFrequency`: `-1` = use the GLOBAL default (plugin setting, not "every turn");
  `0` = table EXCLUDED from auto-update; `N` = due when unrecorded floors ≥ N.
- `updateConfig.contextDepth`: how many recent AI floors are in update scope (-1/0 → global
  `autoUpdateThreshold`, default 3). Floors older than the window never get maintained by auto-update.
- `updateConfig.skipFloors`: exclude the NEWEST N AI floors from maintenance (a settling lag).
- `updateConfig.batchSize`: floors per update call (-1 → global, default 3).
- `updateConfig.groupId`: tables with the same (groupId, schedule, batch) share ONE LLM call.
- `mate.globalInjectionConfig.{readableEntryPlacement,wrapperPlacement}`: positions of the plugin's
  own readable-tables digest entry + its built-in wrapper prompt (texts are plugin-side, not in the
  template JSON).

## RPT divergences (verified in src/main/parsers/chatSheetsParser.ts + docs/sdk/table-templates.md)

1. Importer normalizes `updateFrequency -1 → 1` (every turn) — plugin means "global default"
   (typically 3). Mitigated by `table.gate`'s `every` override (the example workflow ships every: 3),
   but the imported per-table value is semantically wrong.
2. `updateFrequency 0` (= off) not representable — schema requires positive int.
3. `contextDepth` / `skipFloors` / `batchSize` / `groupId` are dropped at import; RPT's maintenance
   model (gate span + one maintainer call over all due tables) has no equivalents.
4. `globalInjection` is imported losslessly but consumed by NOTHING (only the parser/type touch it).

## Decision needed

Whether RPT's workflow-driven maintenance should honor these per-table scheduler knobs (map them
onto gate/read behavior), or whether the `every` override + workflow authoring is the intended
replacement (then: fix only the `-1` mis-normalization + document the contract in
docs/sdk/table-templates.md).

## Comments
