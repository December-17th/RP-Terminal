# Dedicated memory node — design decisions + session context (2026-07-07)

Status: ready-for-agent (design approved by owner; spec+plan to be written, then implement)

## Where this came from

Owner manual pass on the agent-memory-ux build (branch `claude/inspiring-euclid-c951f0`,
worktree `.claude/worktrees/eloquent-feistel-0673e3`, all 9 WPs A–I committed through
`16a9ecd` + excerpt-width fix `3c3cc5a`). Two issues were reported:

### Issue 1 — mode change gives no graph feedback (fix in flight)

"Changing the memory mode in the Agents ▾ dropdown does nothing to the trigger toggles."
Diagnosis: by design mode gates at `control.mode` and never writes `trigger.disabled`; the
defect is zero visual feedback. Approved fix (was being implemented by the background Opus
agent when quota ran out — CHECK `git log`/`git status` in the worktree for a commit like
"fix(workflow): mode-gated trigger feedback" or uncommitted WIP):
- `agentModel.ts`: pure `modeGatedTriggerIds(nodes, edges, group)` — trigger is mode-gated
  iff ALL its out-edges land on non-selected `control.mode` when-slots (options[i] ↔
  when{i+1}; selected key with no wired slot, e.g. 'off', gates every when-wired trigger).
- FlowCanvas: mode-gated triggers render dimmed + "gated by mode" chip (distinct from
  user-disabled). i18n both locales.
- `agentStatusSentence`: compose from EFFECTIVE triggers (not disabled AND not mode-gated);
  all gated ⇒ "Off · would run…" variant.
- Pure-model tests; gate green; one commit.

### Issue 2 — imported table-template prompts never reach the model (root-caused, unfixed)

Two layered findings:
1. **`{{input}}` substitution bug (pre-existing on main 67ee48d):** `agent.llm` passes its
   `input` port payload as slot `in1` (`agentNodes.ts` run), but `interpolate`
   (`messageNodes.ts:60-62`) only substitutes literal `{{in1}}`–`{{in4}}`. The maintainer
   prompt (and `memory-fill*.rptflow` fixtures, and the WP-C seeded doc) use `{{input}}`,
   which is documented at `agentNodes.ts:96` but NEVER substituted. Result: the whole
   `table.read` block (table definitions + per-op prompts + data) is silently dropped —
   exactly what the owner observed ("not in the logs"). Fix regardless of the node redesign:
   split-join `{{input}}` before interpolate (the `{{lore}}` pattern). Also recommended:
   record the composed sendMessages in the node trace so the sent prompt is inspectable in
   the run drawer (currently only text/error outputs are traced).
2. **Invisibility:** per-table prompts (`note`, `initNode`, `insertNode`, `updateNode`,
   `deleteNode` — see `types/tableTemplate.ts:69-74`) are the real brain of a memory
   template (owner's example: `C:\Users\wnc74\Downloads\SQL-命定之诗Can改5.9 貂(地理特调).json`,
   8 tables with huge maintenance programs). `table.read` renders them per table via
   `renderTableBlock` (`tableMaintenance.ts:33-49`: 表定义/初始化(only when 0 rows)/插入/更新/
   删除 rules + 当前数据), but they are invisible + uneditable from the workflow editor.

## Owner-approved design decisions (AskUserQuestion, 2026-07-07)

1. **Node scope: ALL-IN-ONE.** One dedicated node (working name `memory.maintain`) absorbs
   read tables → compose prompt → LLM call → parse TableEdit → apply SQL. Simplest canvas;
   run trace shows one node with rich detail; matches 数据库-plugin behavior.
2. **Edit target: TEMPLATE FILE.** Per-table prompt edits in the node panel write to the
   bound table template via the existing patch IPC (`TableDefPatchSchema`). Every chat
   using the template sees the change; export round-trips edits. Panel must show WHICH
   template is being edited (binding is per-chat → resolve via active chat; surface e.g.
   "editing template: <name>").
3. **Process: spec+plan first** was recommended; owner ran out of quota before choosing —
   default to the usual pipeline (spec + WP plan in docs/superpowers/, then Opus agent
   implements; see memory `rpt-agent-pipeline-process`).

## Design sketch (discussed with owner, not yet spec'd)

- New node `memory.maintain` with a CUSTOM details panel (not schema form):
  - **Prompt tab**: scaffold prompt (doc config, editable — the current maintainer prompt)
    + one expandable section per bound-template table showing its per-op prompts, editable,
    writing back via template patch IPC.
  - **Preview**: the actual composed prompt (scaffold + rendered table blocks + history)
    so "is it being sent" is never a mystery.
- Trigger/`control.mode` wiring unchanged; seeded default doc v2 becomes
  `trigger.cadence/trigger.state → control.mode → memory.maintain` (needs a new seed marker,
  e.g. `default-memory-v2`, respecting the existing tombstone machinery in
  `workflowService`, see plan §0.3 of 2026-07-07-agent-memory-ux-plan.md).
- The generic 5-node chain + `{{input}}` stay supported (imported modules, power users).
- Keep the engine card-agnostic (memory `rpt-keep-app-engine-generic`).

## Remaining TODO (in order)

1. ~~Verify/land the issue-1 fix~~ — DONE: landed as `f564dd9` (mode-gated trigger feedback).
2. ~~`{{input}}` substitution in `agent.llm` (+ tests)~~ — DONE: landed as `c9b573f`.
   `interpolate` now substitutes `{{input}}` from an `input` slot (LAST, as data — the `{{inN}}`
   invariant), so the table.read block reaches the model; the .rptflow fixtures + seeded doc work.
   Gate green (2146 tests). **STILL OPEN from item 2:** composed-prompt trace visibility — record
   the composed `sendMessages` in the node trace so the sent prompt is inspectable in the run drawer
   (crosses main `NodeTrace`/`workflowEvents` → IPC → renderer `RunDrawer`/`workflowTraceStore`;
   deferred as a separate change, not blocking the fix).
3. Spec + plan the `memory.maintain` node per the decisions above; then implement.
4. Owner manual pass on the whole branch; then push + PR (NOTHING pushed yet; branch is
   local-only in the worktree).
