# RP Terminal — Card SDK docs

The **SDK** is everything a character/world card can rely on when it runs in RP Terminal: the runtime API
it calls, the environment it renders in, the format it's stored as, and how an existing SillyTavern /
TavernHelper card is transformed into that format.

These docs are **load-bearing for card compatibility** — a card author (or the importer that transforms ST
cards) reads them as the contract. They must track the code.

## Contents

- **[component-inventory.md](component-inventory.md)** — the catalog: runtime API, rendering environment,
  authoring format, the ST→RPT transformation mapping, the PNG-cartridge direction, and the game-platform
  component targets. Start here.
- **[../rpt-api.md](../rpt-api.md)** — the method-level API reference (the detailed companion to the
  inventory's Layer A).
- **[../compat-comparison.md](../compat-comparison.md)** — RPT vs TavernHelper vs ST-Prompt-Template feature
  parity.
- **[../world-card-design.md](../world-card-design.md)** — the bundle format + one-click import + PNG
  cartridge plan (the "container" the inventory points to).
- **[table-templates.md](table-templates.md)** — SQL-table memory: the chatSheets v2 import surface,
  World Card `table_templates[]` library import/update policy, new-session assignment reminder, and
  the per-session `table.sqlite` layout used by portable `.rpsave` archives,
  the sheet→`TableTemplate` mapping, per-chat sandbox-DB enablement, the DDL-safety choke point, and
  the SQL write path (allowlist + op-log/rewind + the `parse.extract`/`table.apply` nodes), the
  prompt-projection path (`table.export` + the `entries` port on `prompt.assemble`/`prompt.preset`), the
  main-prompt memory injection (`injectionPolicy` + `settings.tables.injection_max_rows`, folded into the
  `memoryBlock` tail by `tablesInjectionService` — WS4),
  the maintenance pipeline (now the built-in Memory Maintenance Agent; the legacy
  `table-memory-default.rptflow` example is retained for history only), the Tables-view hand-editing +
  template-export + last-maintained surface (issue 06), and the chat-level progress store +
  manual-backfill engine + auto-retry (issue 07 — `table_progress`, `tableProgressService`,
  `tableBackfillService`; the gate's per-workflow node-state pointer is retired).
- **[workflow-module-format.md](workflow-module-format.md)** — **SUPERSEDED.** The legacy workflow
  **module / agent** format and its runtime were removed on `agent-system` by the Agent Runtime cutover
  ([ADR 0020](../adr/0020-agent-runtime-replaces-workflow-system.md)). The file is retained for history
  only; agents are now authored as `.rptagent` Agent Definitions (see component-inventory §4).
- **[../card-script-wcv-surfaces-design.md](../card-script-wcv-surfaces-design.md)** — design (not built):
  run full-page card scripts in a process-isolated WCV and let cards register their own panel/modal surfaces
  (the `创意工坊` case). Touches `thRuntime` + the format when implemented — update this contract then.

## Maintenance contract (read before changing card-facing code)

The SDK docs are **living**, not point-in-time. The single rule:

> **If you change the card-facing surface, update the SDK docs in the same change.**

The card-facing surface is:

| If you touch…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Update…                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [`shared/thRuntime/`](../../src/shared/thRuntime/index.ts) (runtime API — both transports)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | component-inventory §2 + rpt-api.md |
| [`cardBridge/`](../../src/renderer/src/cardBridge/) or [`preload/wcvPreload.ts`](../../src/preload/wcvPreload.ts) (transports)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | component-inventory §2–3            |
| [`shared/cardEnv.ts`](../../src/shared/cardEnv.ts) / `cardLibs` (rendering env, injected libs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | component-inventory §3              |
| [`types/character.ts`](../../src/main/types/character.ts) (`RPTerminalExtSchema` — the format / bundle slots)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | component-inventory §4              |
| the import / transform pipeline (`stPngParser`, `characterService`, the parsers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | component-inventory §5–6            |
| [`parsers/chatSheetsParser.ts`](../../src/main/parsers/chatSheetsParser.ts) / [`types/tableTemplate.ts`](../../src/main/types/tableTemplate.ts) / `tableTemplateService` / `tableDbService` / `tableSql` / `tableOpsService` / `tableExportService` / `tableEditService` / `tableStatusService` / `tableProgressService` / `tableMaintenance` / `tableBackfillService` / `tableBackfillEvents` / `tableMemoryIpc` (SQL-table memory: import + export + sandbox + write path/op-log + hand editing + prompt projection + progress store + manual backfill + status)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | table-templates.md                  |
| [`shared/agentRuntime/`](../../src/shared/agentRuntime/index.ts) (Agent contracts + the held `rpt.agents` card API), [`services/agentRuntime/catalog/builtins.ts`](../../src/main/services/agentRuntime/catalog/builtins.ts) (built-in Agents incl. Memory Maintenance), and the `.rptagent` import format ([`catalog/agentFolder.ts`](../../src/main/services/agentRuntime/catalog/agentFolder.ts)) | component-inventory §2, §4           |

Keep status markers honest (✅ built / 🟡 partial / 🔁 stub / ⬜ planned) and **cite the file each claim was
verified against** — per the repo's grounding rule (`CLAUDE.md`), never describe behavior from a name or
from memory. When two docs disagree, the one with file:line citations wins; reconcile the other to it.

Point-in-time docs (health checks, `docs/superpowers/specs|plans/*`, `progress-log.md`) are **snapshots** —
supersede them with a new dated file, don't silently rewrite them. The SDK docs are the opposite: edit in
place to stay current.
