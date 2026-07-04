# Session handoff — agent workflow system (2026-07-04)

Point-in-time reference for resuming work after the agent-workflow build. Supersede with a new
dated file; don't rewrite.

## Where things stand

- **main = `8a39ca7`** (PR #48 merged 2026-07-04): the complete arc — pack-model design + build
  (phases 1–5), the ADR 0011 pivot, and the one-canvas rebuild (WP6.1–6.6) — is on main.
- Gate at merge: typecheck clean, dependency-cruiser 0 violations (386 modules), **1965 tests**.
- Work branch was `claude/great-mirzakhani-c49499` (worktree great-mirzakhani-c49499); nothing
  unmerged remains on it.

## The system as built (one paragraph)

The workflow editor (title bar → Workflow) is THE surface: one canvas holds the narrator chain
and every agent chain. An agent is a trigger-rooted chain (`trigger.state/cadence/manual` nodes —
the trigger is the timing config and the off-switch; disabled chains stay visible, dimmed; live
captions show "now X · at Y"). The consolidated node set is trigger → `history.recent` →
`agent.llm` (role-alternating prompt + API preset) → `parse.extract` → `table.apply` (with
`advance_progress`); both memory experiences ship as example docs (`docs/workflows/memory-fill*.
rptflow`). Linked nodes group into modules (doc-metadata `groups`, exposed settings chosen per
inner node) and export/import as `.rptmodule` files after inspected review. Run drawer replays
stored runs onto the canvas; the assemble node previews the next prompt; the Memory sheet hosts
template binding + backfill. Headless runs evaluate triggers at commit boundaries against
committed state, never block a turn (ADR 0003/0004 semantics, doc-driven since WP6.1).

## Authoritative documents

- Decisions: `docs/adr/0001–0011` (0011 = the pivot; earlier ADRs are accurate pre-pivot history).
- Spec: `docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-4.md` (r4 =
  current; r1–r3 = superseded).
- Execution records: `docs/superpowers/plans/2026-07-03-one-canvas-rebuild-plan.md` (WP6.x,
  BUILT) and `2026-07-03-agent-packs-master-plan.md` (phases 1–5 + Amendments log).
- Glossary: root `CONTEXT.md` (post-pivot language: canvas, agent, trigger node, module).

## Open items, in priority order

1. **Owner hands-on pass (pending).** Three journeys, app-level: (a) build a memory agent from
   palette nodes, wire, group into a module, expose two settings, toggle its trigger from the
   node card; (b) export that module to a `.rptmodule`, re-import, confirm collapsed + reminted +
   unwired with exposed settings intact; (c) open `memory-fill-async` in a chat with a table
   template — read the whole setup at a glance, watch a headless run land in the drawer, replay
   it. Owner testing found real issues five times in this project; expect findings.
2. **Tier-2 cleanup (deliberately dormant, recorded in the rebuild plan's WP6.6 DEFERRED
   section):** main-side pack machinery — agentPackService/Store/Ipc (the module/runs/doc-trigger
   IPC channels live in `agentPackIpc.ts`, so retirement needs channel relocation),
   headlessRunService's pack path, compose/checkpoints/attachments' pack surface, pack+recipe
   transfer services, fragment-session machinery (`openFragment`/`updatePackFragment`), pack DB
   tables. All tested, unreferenced by UI. Delete only when it starts costing; expect large
   deliberate test deletions.
3. **Parked features:** `.rptrecipe` world-setup sharing (format + services built + tested; UI
   entries removed — needs a rethink in the module world, probably "share the workflow doc");
   module insertion at viewport center (lands at a fixed position; needs an RF handle plumbed);
   `editorToDoc` base-spread refactor (task chip open — the whitelist has dropped fields twice).
4. **Never started:** card-cartridge bundling of modules (re-spec against `.rptmodule` +
   `data.extensions.rp_terminal`; touches the card contract → `docs/sdk/` update in the same
   change), module versioning/upgrade UX, fan-in text-merge node, wall-clock triggers (rejected
   by ADR 0004; additive if ever wanted).

## Process rules in force (owner directives, also in auto-memory)

- Implementers are **Opus 4.8 medium** agents; every dispatch names model+effort in the agent
  description ("WP6.x foo [opus-4.8/medium]").
- **Controller grounds the code first and writes prescriptive specs** (exact files, signatures,
  schemas, named tests, NON-GOALS + size budget with a stop-and-report clause) into the plan
  doc; agents execute, they don't design. "Ground and decide" only for genuinely unknowable
  facts.
- Every UI WP's acceptance includes **walking the primary user journey end-to-end** from where
  users actually start.
- Gate before done: `npm run typecheck && npm run check:deps && npm run test`; controller
  re-runs it before every commit; commit messages via heredoc (backticks in `-m` get eaten).

## Gotchas for the next session

- **The 48px rule:** the app runs Electron `titleBarOverlay` height 48 (`main/index.ts:43`);
  native window controls paint ABOVE the DOM top-right. Any full-window overlay header must span
  48px (`minHeight: 48`) and reserve the right corner via `env(titlebar-area-x/width)` — two
  clipping bugs came from this.
- **Context-transplant bugs:** components/styles designed for one container (the dead control
  center) mis-render when re-hosted; check geometry, not just compile.
- **`editorToDoc` is a field whitelist** — any new doc-level field must be added there or it is
  silently dropped on save (bit `kind`, `attachments`, then `groups`).
- **KEEP-ALIVE modules that look pack-era but are load-bearing:** `runTimeline.ts` (RunDrawer),
  `previewDisplay.ts` (assemble preview), `MemoryPane.tsx`/`memoryPaneModel.ts` (Memory sheet),
  `.rpt-agents-chip` css (ModuleImportSheet), `agents.cap.*` + `runs.*` i18n keys,
  `listAgentPackRuns` IPC (drawer; rename deferred).
- **`sys.trigger` note:** trigger baselines persist per (chat, doc, trigger NODE id) in
  `workflow_trigger_state`; the pack-era positional table is dormant.
