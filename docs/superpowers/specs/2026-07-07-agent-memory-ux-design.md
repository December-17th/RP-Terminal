# Agent & memory UX design — 2026-07-07

**Status:** point-in-time design spec, owner-reviewed in-session 2026-07-07. Supersede with a new
dated file; don't rewrite. This spec LAYERS ON the one-canvas model
(`2026-07-03-agent-pack-workflow-ux-design-revision-4.md`, ADR 0011) — it does not replace it.
Implementation plan: to be written as a work-package plan doc after spec sign-off.

## Problem (owner findings, 2026-07-07 review session)

1. Memory workflows must be manually imported from `docs/workflows/*.rptflow` — nothing in-app.
2. The canvas gets messy as agents accumulate; the memory examples ship as ~15 loose ungrouped
   nodes ([memory-fill-async.rptflow](../../workflows/memory-fill-async.rptflow) has no `groups`).
3. Agent chains are unlabelled on the graph unless the user manually groups them.
4. Memory table viewing is awkward: data lives in the workspace Tables view, configuration in the
   editor's Memory sheet — two disconnected surfaces, raw grid.
5. The memory prompt is invisible: it is `agent.llm`'s `messages` config, rendered by the generic
   schema-form `objectArray` control in the narrow config panel
   (`src/renderer/src/components/workflow/schemaForm.ts:14`, `NodeConfigPanel.tsx`).
6. Which memory system is active is encoded by *which workflow doc is selected* — the owner wants
   it inside the default workflow, mutually exclusive, switchable in place.

## Grounding (verified 2026-07-07, main = 67ee48d)

- Named groups + collapse-to-one-node + exposed settings ALREADY EXIST:
  `src/renderer/src/components/workflow/groupModel.ts` (collapsedView re-points boundary edges to
  the module node), `FlowCanvas.tsx` (`RptModuleNode` shows name + member count + collapse toggle;
  `RptGroupFrameNode` shows the frame header). Gap: collapsed cards drop the trigger switch/badge;
  grouping requires manual multi-select ≥2 nodes.
- Trigger nodes are graph ROOTS with no inputs; the headless evaluator fires them OUTSIDE the graph
  (`src/main/services/nodes/builtin/triggerNodes.ts:11-31`). Live "now/at" badges + the on/off
  `disabled` switch render per trigger node on the canvas (`FlowCanvas.tsx:86-155`).
- `DEFAULT_GRAPH` is the BARE narrator chain (ctx → assemble → llm → parse → apply → write) with
  no memory (`src/main/services/nodes/builtin/defaultGraph.ts`). It is the read-only builtin
  (`workflowService.ts` BUILTIN_WORKFLOW_ID; clone-to-edit).
- The two memory example chains are structurally IDENTICAL (trigger → history.recent → agent.llm →
  parse.extract → table.apply, plus table.read into `input`); only the trigger differs (cadence vs
  table-backlog state). Verified against `docs/workflows/memory-fill-async.rptflow`.
- Recall is turn-coupled (send-button): `table.export` → assemble `entries` +
  `context.trimProcessed` inline on the narrator path; both fail-soft (no template ⇒ empty export;
  pointer at 0 ⇒ no trim).
- `Lore` port type + `lorebook.select` / `lorebook.entries` exist
  (`src/main/services/nodes/builtin/lorebookNodes.ts`); entries are identified by `comment` (the
  ST title field); `tool.lorebookSearch` already takes an optional `books: Lore` input
  (`toolNodes.ts:103-105`).
- Per-world/world-tier persistence precedent: `_selection.json` (workflowService selection tiers)
  and `workflow_trigger_state` keyed (chat, doc, trigger node id).
- `GroupDecl` = `{ id, name, nodeIds, collapsed?, exposed? }`
  (`src/shared/workflow/types.ts:81-92`). Exact `ExposedGroupSetting` shape: verify at plan time.
- Memory config vs data split: `MemoryPane.tsx` (template binding + backfill, hosted in the
  editor's Memory sheet) vs `TablesView.tsx` (editable grid, workspace view).

## Design principles

- **Nothing hardcoded to "memory".** Every capability ships as generic workflow-system features
  (nodes, groups, exposed settings, ports). The memory system is doc content.
- **The contract is the document format.** An imported agent gets the full stock UI purely from
  what its module doc contains — no side manifest.
- **The canvas keeps its current spatial layout** so the user can see where agents tap the
  narrator path. Collapse is per-group and optional; collapsed modules keep boundary edges.
- **Agents report in prose** (the signature UX move): every surface leads with a generated
  sentence composed from the already-localized trigger description + run history, e.g.
  "Fills memory tables when the backlog reaches 6 · ran 2 min ago". No status-icon decoding.
- Chrome stays neutral; ONE new derived token pair `--rpt-agent` / `--rpt-agent-dim` mapped in all
  three themes (dark/carbon/light), WCAG-AA. All new strings via `t()`, en + zh.

## 1. The agent UI contract

An **agent** = a named `GroupDecl` whose member chain is rooted at a `trigger.*` node. Anything
matching that shape gets the entire UI below. Everything else is derived or optional:

| UI element | Source | Author work |
|---|---|---|
| Name (canvas, dropdown, panel, runs) | `group.name` | required (exists) |
| On/off toggle | trigger node `disabled` flag; toggle flips ALL triggers in the group | none |
| Status sentence | derived: describeTrigger/explainDocTriggers + last run | none |
| Settings tab | `group.exposed` | pick fields |
| Mode dropdown (panel + Agents ▾) | any exposed enum field (`control.mode.selected` = common case) | expose the field |
| Prompt tab | node-type descriptor `promptFields` hint (`agent.llm.messages`, `text.template.template`) — inherited via built-in node types | none |
| Card prompt excerpt | first system row of the first prompt-bearing member | none |
| Runs tab / drawer labels | runs keyed by trigger node id → mapped through group membership | none |
| Setup note | NEW optional `group.note` (plain string, rendered verbatim in a warning tint) | optional |

Schema additions (both additive): `note?: string` on `GroupDecl`; `promptFields?: string[]` on
the node-type descriptor surfaced through `list-node-types`. Both are creator-facing module-format
surface → **`docs/sdk/` module-format page updates in the same change.**

## 2. Agent library in the palette

Palette gains a top **Agent library** section above the node list, plus a search box filtering
both sections. Entries:

- Built-in module templates compiled into the app (the way `DEFAULT_GRAPH` is code-built), listed
  over IPC alongside node types. v1 contents: "Table memory" (the merged agent of §3, for
  re-adding after deletion) and any future stock agents.
- "Import module…" (the existing `.rptmodule` flow with its review sheet) as the last entry; an
  imported module can be saved into the user library for reuse.

Click/drag inserts the template **pre-grouped, named, collapsed**, with its `note` visible in the
panel. `docs/workflows/*.rptflow` files stop being the distribution mechanism (kept as dev
fixtures/CI pins).

## 3. Memory merges into the default workflow

### 3.1 New node `control.mode` (generic mode selector)

- Config: `options: [{ key, label }]` (≤4), `selected: key`. Rendered as an enum dropdown.
- Inputs: `when1..when4: Signal` (optional).
- Outputs: `fired: Signal` — passes through ONLY the selected slot's `when` (fires iff that when
  fired; if the selected slot is unwired, fires unconditionally, so the node also works as a
  standalone config-driven gate) — plus `selected: Text` (the selected key as data).
- Slots fixed at 4 (matches `control.switch` case1–4 convention; raise later, additive).
- Mutual exclusion is structural: non-selected `when`s are dead ends.
- Placement is AFTER triggers (triggers are inputless roots — grounded above). "Selector before
  the trigger" is not expressible; this is the deliberate resolution.

### 3.2 The merged default doc

Turn path (send-coupled — this is RECALL, per the owner's recall/compaction split):
`input.context → context.trimProcessed → prompt.assemble → llm.sample → parse.response →
apply.state → output.writeFloor`, with `table.export → assemble.entries`. Shared by all modes
because recall is fail-soft; mode `off` degrades to today's behavior naturally.

Headless (compaction / table filling): `trigger.cadence → control.mode.when1`,
`trigger.state (backlog ≥ N) → control.mode.when2`, `control.mode.fired →` ONE shared chain
`history.recent → agent.llm → parse.extract(tag TableEdit) → table.apply(advance_progress)` with
`table.read → agent.llm.input` and `table.apply.error → util.log`. Options:
`every turn | async backlog | off` (`off` selected = neither chain runs — the master memory
switch, owner-confirmed). ONE prompt, one chain.

The whole memory system ships pre-grouped ("Table memory"), with exposed settings: the mode
(`control.mode.selected`), the cadence N, the backlog threshold, `api_preset_id`, and the prompt
(via `promptFields`).

Slots `when3`/`when4` are left open **so imported memory systems can join the mutual exclusion**:
an imported module wires its trigger into a free slot and becomes a fourth option in the same
mode dropdown. Pure wiring; no app code.

### 3.3 Seeded editable default (the decision this forces)

The code builtin `default` is read-only (clone-to-edit) and parity-pinned — users could not flip
the mode inside it. Resolution (owner-approved after plain-language explanation):

- The code builtin `DEFAULT_GRAPH` stays UNTOUCHED as the invisible fallback → parity suite
  untouched.
- On profile creation, seed an ordinary EDITABLE workflow doc "Default" (narrator + the Table
  memory group, labelled) into the profile's workflow list and select it as the global default —
  same model as seeded presets. Existing profiles: seed on first launch after update if no
  user-created docs reference memory (exact migration rule: decide at plan time).
- Trade-off accepted: app updates don't retroactively improve an already-seeded doc.

### 3.4 Known behavior (accept in v1; fast-follow optimization)

With mode = every-turn, the backlog state trigger still fires headless runs that immediately gate
off (no LLM call; appears as a skipped run in the drawer). Fast-follow: evaluator skip-rule for a
trigger whose only consumer is a non-selected `control.mode` slot.

## 4. Canvas

- Layout unchanged (owner directive: keep the sense of WHERE agents work). No lanes/dashboard.
- **Agent card** (upgraded collapsed module node): name · on/off switch (proxied to the inner
  trigger(s), same semantics as the existing per-trigger switch) · the status sentence · last-run
  dot + relative time · member count · one-line prompt excerpt when a prompt-bearing member
  exists · validation dot when an inner node is invalid. Disabled agents render dimmed.
- Expanded group frames get the same switch + sentence in the frame header; group name editable
  inline (double-click).
- **One-click grouping:** right-click a trigger node → "Collapse chain into module" — walks the
  downstream closure, stopping at nodes reachable from non-member roots (narrator-shared nodes
  like `input.context` stay out). "Collapse all agents / Expand all" in the toolbar.
- Import review sheet offers auto-grouping (checked by default) for `.rptflow` imports whose
  trigger chains are ungrouped.
- On-card prompt excerpt also renders on ungrouped `agent.llm` node cards (2 lines, first system
  row).

## 5. Agents ▾ master dropdown (editor toolbar)

One row per agent (contract §1): on/off switch · name · provenance chip (`imported`) when the
group came from a module file · the status sentence · **inline enum dropdowns for exposed enum
settings** (owner-confirmed; the memory mode is flippable from here) · a locate button that pans/
zooms the canvas to the agent. Rows for disabled agents show "Off · would …" sentences.

## 6. Universal details panel (right side)

One component, left-edge vertical icon tab rail on the panel's left border. Three selection
contexts, same shell:

| Selection | Settings | Prompt | Runs | Docs |
|---|---|---|---|---|
| Agent (module card / group frame) | enabled switch, trigger timing, exposed settings, `note`, "N nodes · show on canvas", Export module | shown iff a member has `promptFields` | the agent's runs | member overview |
| Single node | the node's schema form (today's NodeConfigPanel content) | iff this node has `promptFields` | this node's last-run trace slice (status, ms, output preview) | port + config docs (moved out of the settings scroll) |
| Nothing | workflow name/description, validation error list | — | — | — |

Prompt tab = a real editor replacing the `objectArray` control for prompt fields: role-chip rows
(system/user/assistant), auto-growing monospace textareas, insertable placeholder chips
(`{history}`, `{{input}}`, `{{user}}`, `{{char}}`, …), drag-reorder, add/remove. "Preview render"
(interpolate against the current chat) is a v2 nice-to-have, not v1.

Nothing in the panel is agent-specific: it renders trigger config + exposed settings + descriptor
hints generically, which is what makes imported agents first-class (contract §1).

## 7. Lorebook entry selector on `agent.llm`

Resolution order — wire wins, then config:

1. NEW optional input port `lore: Lore` on `agent.llm`. Wired ⇒ that wins; the Settings row shows
   "wired on canvas" and the picker is disabled.
2. Unwired ⇒ config `lorebook: 'main' | 'custom'`, default `'main'`.
   - `main`: run the STANDARD worldinfo matching (same resolution rules the narrator's assemble
     uses) over the agent's `history` input against the world's active lorebooks.
   - `custom`: inject exactly the picked entries — constant, no keyword scan
     (`lorebook.entries` semantics).
3. Injection point: a `{{lore}}` placeholder in the prompt template if present; otherwise an
   appended system row when non-empty.

**Per-world persistence:** node config stores ONLY the mode. Entry picks live in world-scoped
storage keyed `(worldId, docId, nodeId)` (pattern: `_selection.json` tiers /
`workflow_trigger_state`). The doc stays world-portable; each world keeps its own picks. A world
with no picks yet falls back to `main` with a panel hint. Entries deleted from the lorebook
resolve gracefully and surface as "N missing" in the picker. Store shape (book ref + entry uid +
last-seen title for the missing-display): finalize at plan time against the worldbook service.

**Picker UI** (opens from the Lorebook row in **`agent.llm`'s node Settings tab** — owner-placed;
reaches the agent level only if the author exposes the field): search bar filtering titles ·
entries listed as title (`comment`) ONLY, no content preview · collapsible book groups with
tri-state select-all checkboxes · selected count · missing count · Clear / Done. Saves on Done.

v1 scope: `agent.llm` only. `llm.sample` sits on the parity-pinned narrator path (lorebook context
already flows through assemble); extending later is additive.

## 8. Memory sheet + tables

The editor's Memory sheet becomes tabbed:

- **Setup** — template binding, import/export/delete (today's MemoryPane content).
- **Data** — the editable grid, extracted from `TablesView.tsx` into a shared grid component.
- **Maintenance** — backfill, progress, per-table processed/next/unprocessed.

Grid polish (shared component, used by both the sheet Data tab and the workspace Tables view):
sticky header, column autosizing, search/filter, maintenance-pointer marker (which floors are
already folded in), row provenance on hover (floor-attributed op-log → "written at floor N").

## 9. Deliberate non-goals (v1)

- No lanes/auto-layout changes to the canvas.
- No prompt "preview render" (v2).
- No `llm.sample` lorebook selector.
- No dynamic (>4) `control.mode` slots.
- No retroactive upgrade of seeded default docs.
- No module versioning/upgrade UX, no card-cartridge bundling (unchanged from the handoff's
  never-started list).
- Existing granular nodes (`prompt.messages`, `lorebook.select`, …) stay registered and usable —
  nothing is removed.

## 10. Owner decisions log (2026-07-07 session)

- Right panel universal for ALL agents; Settings/configuration tab required. ✔ (§6)
- Canvas layout stays similar to current. ✔ (§4)
- Master agent toggle = a dropdown. ✔ (§5)
- Memory INSIDE the default workflow, mutually exclusive, selector after/before trigger. ✔ (§3;
  "after" — triggers are inputless roots)
- Trigger = compaction/table-filling only; recall is send-coupled. ✔ (§3.2)
- Custom memory / plot-planner replaceability; nothing hardcoded; add nodes if needed. ✔
  (`control.mode`; contract §1; open when3/4 slots)
- `off` as a third mode option. ✔ owner-confirmed.
- 4 fixed selector slots. ✔ owner-deferred to controller; decided 4.
- Seeded editable default. ✔ owner-approved after plain-language re-explanation.
- Agents ▾ shows exposed enums inline. ✔ owner-confirmed.
- Imported agents must use the stock UI; contract designed upfront. ✔ (§1)
- Lorebook entry selector: per-world persistence, search bar, titles only, default = main. ✔ (§7)
- Selector lives in the NODE panel's configuration tab. ✔ owner-corrected placement (§7).

## 11. Verification obligations for the plan

- Parity: builtin `DEFAULT_GRAPH` byte-untouched; generateParity suite green unchanged.
- Characterization updates (deliberate, same-commit): editorModel/groupModel projections if agent
  cards change collapsed rendering; docSchema for `GroupDecl.note`.
- New-node tests: `control.mode` (selected passthrough, unwired-selected fires, non-selected dead,
  slot bounds), `agent.llm` lore port/config resolution incl. fail-soft missing entries.
- `editorToDoc` is a FIELD WHITELIST — `note` (and any new doc-level field) must be added there or
  it silently drops on save (recorded gotcha; it has bitten three times).
- Gate: `npm run typecheck && npm run check:deps && npm run test`.
- `docs/sdk/` module-format page updated in the same change as contract schema additions.
