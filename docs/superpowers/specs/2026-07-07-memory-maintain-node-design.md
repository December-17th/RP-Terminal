# Dedicated memory-maintenance node (`memory.maintain`) — design — 2026-07-07

**Status:** point-in-time design spec, drafted for owner sign-off. Supersede with a new dated file;
don't rewrite. LAYERS ON the agent & memory UX build (`2026-07-07-agent-memory-ux-design.md`, all 9
WPs shipped on `claude/inspiring-euclid-c951f0`). Owner already approved the high-level shape in the
2026-07-07 manual-pass review (see `.scratch/memory-node-2026-07-07/design-context.md`); this spec
formalizes it with grounding and resolves the open sub-decisions.

## Problem (owner manual-pass finding, issue 2 — the second half)

The five-node memory chain (`history.recent → table.read → agent.llm → parse.extract → table.apply`)
is the *brain* of a memory system, but its real intelligence — the **per-table maintenance
instructions** (`note`/`initNode`/`insertNode`/`updateNode`/`deleteNode`) — is **invisible and
uneditable from the workflow editor**. Those prompts live in the bound table-template file
(`types/tableTemplate.ts:69-74`) and are rendered into the model call by `table.read`
(`renderTableBlock`, `tableMaintenance.ts:33-51`), but the editor shows only the generic scaffold
`agent.llm.messages`. The owner's example — `SQL-命定之诗Can改5.9 貂(地理特调).json`, 8 tables with
large maintenance programs — is entirely opaque in-app. Two owner asks:

1. **One node, not five.** Collapse read→compose→call→parse→apply into a single dedicated node so the
   canvas is simple and the run trace shows one node with rich detail (matches the 数据库-plugin mental
   model).
2. **Edit the per-table prompts in-app**, writing back to the **template file** (per-chat binding), so
   every chat using the template sees the change and export round-trips it.

The dropped-`{{input}}` bug (fixed: `c9b573f`) and the composed-prompt trace (added: `b1906ae`) closed
the "is it even being sent" question; this closes the "I can't see or edit the actual instructions"
question.

## Grounding (verified 2026-07-07 on `claude/inspiring-euclid-c951f0`)

- **Per-table prompts + patch schema already exist.** `TableDef` carries `note`, `initNode`,
  `insertNode`, `updateNode`, `deleteNode`, `updateFrequency` (`types/tableTemplate.ts:69-80`).
  `TableDefPatchSchema`/`TableTemplatePatchSchema` (`:95-116`) already whitelist exactly these
  editable fields (structural DDL/sqlName deliberately excluded — editing DDL without re-instantiating
  desyncs every chat).
- **Write-back IPC already exists end to end.** `table-template-update → updateTableTemplate`
  (`ipc/tableMemoryIpc.ts:31-32`, `services/tableTemplateService.ts:121`), `table-template-get`
  (`:25`), and `chat-table-template-get` (`:50`) — so the panel can resolve the active chat's template,
  read it, and patch per-table prompts with NO new IPC.
- **Compose is a shared helper.** `renderTableBlock(table, read, includeRules, resolvedFreq)` emits
  `## <name> (sql) — cadence / 【表定义】/【初始化规则】(only at 0 rows)/【插入】【更新】【删除】/【当前数据】`
  (`tableMaintenance.ts:33-51`); `MAINTAINER_RULES` (`:59-64`) is the shared rule block; the backfill
  path reuses both (`backfillMaintainerPrompt`, `:72-88`). `table.read` is exactly a loop over
  `renderTableBlock` (`tableNodes.ts:337-369`).
- **The five nodes' internals are reusable.**
  - history slice: `history.recent` (`agentNodes.ts:66-86`) — self-seeds `buildGenContext(profileId,
    chatId, '')`, last-N floors, thinking stripped, both sides.
  - prompt compose: `agent.llm` (`agentNodes.ts:208-294`) — `interpolate` (`messageNodes.ts:37-64`)
    with `{{input}}`/`{history}`/`{{lore}}` splices, `providerShape`, then `runLlmCall`
    (`generationNodes.ts`).
  - parse: `extractTagAll(text, 'TableEdit')` (`parseNodes.ts:34`).
  - apply: `table.apply` (`tableNodes.ts:61-`) — `tryBeginTableWrite`/`endTableWrite` busy-guard,
    `applySqlBatch`, `appendOps`, `advance_progress` pointer advance, class-A/B error on the `error`
    port.
- **Seeded default doc + tombstones.** `buildDefaultMemoryDoc()` (`defaultMemoryTemplate.ts`) is the
  editable "Default" doc seeded lazily by `seedDefaultMemoryWorkflow` (`workflowService.ts:146-182`);
  idempotence via `meta.seeded = 'default-memory-v1'` (`DEFAULT_MEMORY_SEED_MARKER`), deletion via
  `_selection.json` `seededTombstones` (`:304-319, :452`). The chain hangs off `control.mode`'s
  `fired` slot (WP-B), triggers → `when1/when2`, `off` = unwired `when3` (`:173-195`). The verbatim
  maintainer prompt (`MAINTAINER_SYSTEM_PROMPT`, `:46-47`) uses `{{input}}` for the table block +
  `{history}` for the transcript.
- **Node-type-specific panels are an established pattern.** `NodeConfigPanel.tsx` already branches on
  `node.type` — `subgraph.call` (`:900`) and `prompt.assemble → <AssemblePreview>` (`:907`); the tab
  rail is `settings|prompt|runs|docs` with the Prompt tab gated by node-type `promptFields`
  (`detailsPanelModel.ts:17,38`). `agent.llm` sets `promptFields:['messages']` (`agentNodes.ts:213`).

## Design

### 1. The node: `memory.maintain` (main-side, `nodes/builtin/memoryNodes.ts`)

An all-in-one, self-seeding maintenance node. **Reuses the shared internals — no copy** (clean-room
constraint + DRY): the plan extracts the reusable cores behind small interfaces first, so `table.apply`
and `history.recent` keep calling the SAME code the node does.

- **Ports.** `inputs: [{ when: Signal }]` only (self-seeds its Context off the RunContext like
  `history.recent`, so a trigger-rooted chain needs no Context edge). `outputs: [{ report: Text }, {
  error: Error }]` — `error` routes failures to `util.log` exactly as `table.apply.error` does today;
  `report` is a short "applied N statements to M tables" line for the trace/downstream.
- **Config** (`memory.maintain`): `messages` (the scaffold prompt — same role-tagged shape as
  `agent.llm`, routed to the Prompt tab via `promptFields:['messages']`), `lastNFloors` (default 6),
  `max_rows` (default 30), `include_rules` (default true), `advance_progress` (default true), plus the
  shared LLM knobs (`llmCallConfigSchema.extend`: `api_preset_id`, `temperature`, `stream:false`,
  `retries`, …). **Per-table prompts are NOT config** — they live in the template file.
- **`run()` (the folded chain).**
  1. `gen = buildGenContext(profileId, chatId, '')`; `template = chatTemplate(gen)`. No template →
     silent no-op (`table.read`/`table.apply` read-semantics precedent), no error.
  2. Render `tablesBlock` = each in-scope table via `renderTableBlock(…, resolveUpdateFrequency(…))`,
     joined — the SAME output `table.read` produces.
  3. `history` = last-N-floors transcript (shared history-slice helper reused by `history.recent`).
  4. Compose: interpolate each `messages` row substituting **`{{tables}}`** (canonical) → `tablesBlock`,
     with **`{{input}}` accepted as an alias** so the proven verbatim `MAINTAINER_SYSTEM_PROMPT`
     transfers unchanged; `{history}` splices the transcript (reuse `agent.llm`'s splice + `interpolate`).
  5. `runLlmCall(ctx, gen, providerShape(…), params, callCfg)` — the SAME provider core; `stream:false`.
  6. `extractTagAll(reply, 'TableEdit')[0]` → the SQL batch.
  7. Apply via the extracted shared apply-core (busy-guard + `applySqlBatch` + `appendOps` +
     `advance_progress`), errors classified A/B → `error` port.
  8. Record the composed prompt on `debug['prompt (sent)']` (the `b1906ae` channel) and emit `report`.

### 2. Custom details panel (renderer, `MemoryMaintainPanel.tsx`)

Follows the `AssemblePreview` precedent — a `node.type === 'memory.maintain'` branch in
`NodeConfigPanel.tsx`. Three parts, all inside the node's details panel:

- **Prompt tab** (via `promptFields:['messages']`, reusing the existing `PromptEditor`): the scaffold
  prompt, with `{{tables}}`/`{history}` added to `PROMPT_PLACEHOLDERS` (`detailsPanelModel.ts:51`).
- **Per-table sections** (custom, in the Settings or a dedicated area): resolve the active chat's
  template (`chat-table-template-get` → `table-template-get`); render one collapsible section per table
  showing its `displayName (sqlName)` and editable `note`/`initNode`/`insertNode`/`updateNode`/
  `deleteNode` (+ `updateFrequency`). Edits debounce-write via `table-template-update` with a
  `TableTemplatePatch`. A header line names the template being edited ("editing template: <name>") and
  states the per-chat-binding caveat. No active chat / no bound template → an explanatory empty state.
- **Preview**: the actual composed prompt (scaffold + rendered `renderTableBlock`s + a placeholder
  history note) so "what gets sent" is never a mystery — mirrors `AssemblePreview`, computed from the
  same main-side helpers via a small read-only IPC (`memory-maintain-preview`) or reused
  `table-read`-style call.

All new UI strings routed through `t()` in `en.ts` + `zh.ts` (i18n constraint). Per-table prompt CONTENT
stays as authored (the maintainer prompt is zh, card data — not app chrome, not localized).

### 3. Seeded default doc v2

`buildDefaultMemoryDocV2()` + marker `default-memory-v2`: identical to v1 (narrator spine + turn-path
recall + triggers + `control.mode`) EXCEPT the `{history, read, agent, sql, tableapply, log-apply}`
subgraph collapses to ONE `memory.maintain` node gated by `mode.fired`, with `memory.maintain.error →
util.log`. Group `exposed` keeps Mode/Cadence/Backlog + the node's `api_preset_id`.

**Migration (non-destructive — recommended).** `seedDefaultMemoryWorkflow` seeds v2 for a profile only
when **neither** the v1 nor the v2 marker is present on disk **and** neither is tombstoned — so:

- **New profiles** get the v2 (single-node) default.
- **Existing profiles** keep their already-seeded (possibly hand-edited) v1 doc **untouched** — the
  five-node chain still works; nothing is clobbered.
- `memory.maintain` is additive in the palette, so existing users adopt it opt-in.

An auto-upgrade action ("replace the chain with the memory node") is a possible later nicety, out of
scope here. The **rejected alternative** is tombstoning v1 and seeding v2, which would destroy user
edits to the existing default doc.

### 4. Backward compatibility & scope guards

- The five generic nodes stay registered and documented — imported `.rptflow`s and power-user chains
  keep working. `memory.maintain` is purely additive.
- **Engine stays card-agnostic** (`rpt-keep-app-engine-generic`): the node hard-codes NO poem/card
  content; the maintainer prompt is doc config, the per-table prompts are template data.
- **SDK docs**: `memory.maintain` is a new card-facing node → add it to `docs/sdk/` (node catalog /
  workflow-module-format) in the same change, per `docs/sdk/README.md`.

## Open decisions (owner sign-off)

1. **Migration policy** — recommend the non-destructive "new profiles get v2, existing keep v1"
   above. Confirm, or prefer auto-tombstone-and-reseed (clobbers edits), or ship v2 palette-only with
   no seeded default change.
2. **Per-table editor placement** — inside the node's Settings/Prompt panel (this spec) vs. folded into
   the existing tabbed **Memory sheet** (WP-I `TableGrid`), which already owns Setup/Data/Maintenance.
   Recommend the node panel for locality to the prompt, cross-linked from the Memory sheet.
3. **`report`/preview IPC** — add a tiny `memory-maintain-preview` read IPC vs. reuse a `table-read`
   dry-run. Recommend a dedicated preview call for an exact composed-prompt match.

## Testing strategy (characterization + new)

- Pure/unit: compose parity — `memory.maintain`'s `tablesBlock` byte-equals `table.read`'s for the same
  template/data; `{{tables}}`/`{{input}}` alias substitution; history slice parity with `history.recent`.
- Node integration (mirror `memoryFillChain.test.ts`): a cadence run drives `memory.maintain` end to
  end — SQL lands, pointer advances, `debug['prompt (sent)']` carries the table block + history, `error`
  routes on a bad batch.
- Seeding: v2 seeds for a fresh profile; a profile with a v1 doc is NOT double-seeded; tombstones honored.
- Apply-core extraction: `table.apply`'s existing characterization tests stay green (same shared core).

## Work-package outline (detailed plan is a separate doc)

- **WP0** Extract shared cores behind interfaces (history slice; table-edit apply-core) — refactor,
  tests green.
- **WP1** `memory.maintain` node (compose/call/parse/apply) + `debug` prompt + tests.
- **WP2** Custom panel: per-table editor (patch IPC) + `{{tables}}` placeholder + preview + i18n.
- **WP3** Seeded default doc v2 + non-destructive migration + seeding tests.
- **WP4** SDK docs (`docs/sdk/`) + example `.rptflow` using `memory.maintain`.

One module per WP; gate green at each step.
