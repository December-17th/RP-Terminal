# 03 — Table-template prompts are invisible and uneditable in the app

Status: ready-for-agent

## Report (owner manual pass 2026-07-04, finding #2)

"There is no way to directly import the prompt included in a SQL table template (example:
SQL-命定之诗Can改5.9 貂(地理特调).json), and no way to edit table-specific prompts."

## Grounded assessment

- The prompts ARE imported: `parseChatSheets` maps `sourceData.note` + `{init,insert,update,delete}Node`
  per sheet into `TableDef` (src/main/types/tableTemplate.ts:68-74; docs/sdk/table-templates.md mapping
  table), and `table.read` renders them into the maintainer prompt block (【表定义】/【插入规则】/…)
  when the maintenance workflow runs.
- The GAP is surface, not import: the Tables view (TablesView.tsx) shows data + status only — none of
  the five prompt fields are displayed anywhere; and although `tableTemplateService.saveTableTemplate`
  exists, there is NO update IPC channel and NO UI to modify a template after import (surface =
  list/get/delete/import-dialog/export-dialog, src/main/ipc/tableMemoryIpc.ts). The only workaround is
  editing the JSON externally and re-importing — which requires re-assigning and wipes the chat's
  sandbox + op log.

## Proposed feature (pending owner scope decision)

Per-table prompt inspector/editor in the app:
- Show the five prompt fields (+ updateFrequency) per table of the assigned/selected template.
- Editable, saved through a new `table-template-update` IPC → `saveTableTemplate`. Prompt edits are
  safe live: `table.read`/`table.gate` re-read the template each pass; NO sandbox rebuild needed.
- DDL / headers stay READ-ONLY (DDL only ever executes at instantiation; changing it without
  re-instantiating desyncs the sandbox).
- Note: a template is shared by every chat assigned to it — edits apply to all.

## Owner scope decision (2026-07-04)

Inline in the Tables view. Editable = "all features needed for the template to work properly" —
the template targets the 数据库 (shujuku/AutoCardUpdater) TavernHelper script; local reference copy
at E:\Projects\shujuku, **clean-room only (no code reuse — repo has no LICENSE)**. v1 editable set:
the five prompts + updateFrequency + the full exportConfig (incl. injection templates + placements).
Structural fields (ddl / sqlName / headers / initialRows / table add-remove) stay read-only.
Scheduler-semantics parity gaps split into issue 04.

## Comments
