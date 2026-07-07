# Agent & memory UX — implementation plan (2026-07-07)

**Status:** point-in-time work-package plan for the implementing agent. Supersede with a new dated
file; don't rewrite.
**Spec:** [2026-07-07-agent-memory-ux-design.md](../specs/2026-07-07-agent-memory-ux-design.md)
(owner-reviewed). This plan resolves every "decide/verify/finalize at plan time" item in that spec.
**Baseline:** main = 67ee48d (2012 tests / 213 files green).
**Process:** one work package = one branch = one PR (CLAUDE.md "one module per change/PR"). Gate
before declaring any WP done: `npm run typecheck && npm run check:deps && npm run test`. Follow
CLAUDE.md grounding rules — read every file you touch before editing; the citations below were
verified 2026-07-07 but re-verify line numbers at implementation time.

---

## 0. Plan-time decisions (resolving the spec's deferred items)

### 0.1 `ExposedGroupSetting` shape (spec §Grounding "verify at plan time") — VERIFIED

`{ node: string; path: string; label: string }` where `path` is a **top-level config field key
only** (nested paths not exposable), stale paths render empty, deliberately unvalidated
(`src/shared/workflow/types.ts:67-76`). Consequences for the merged default's exposed settings
(§3.2): every field we need to expose IS top-level — `control.mode.selected`,
`trigger.cadence.everyNFloors`, `trigger.state.value` (the backlog threshold),
`agent.llm.api_preset_id`. No change to `ExposedGroupSetting` needed. The prompt is NOT an exposed
setting — it surfaces via the separate `promptFields` descriptor hint (WP-A).

### 0.2 `control.mode` firing semantics — REFINED (one deliberate spec deviation)

Engine grounding (`src/main/services/workflowEngine.ts:128-170`):

- A node with incoming Signal edges is `gatedOff` (skipped, downstream dead) when ALL its Signal
  in-edges are dead; it RUNS when at least one fired.
- For each LIVE in-edge the engine assigns `inputs[port] = state.outputs...` — for a Signal port
  the value is `undefined` but **the key is created**; for a dead edge the key is absent. So
  `run()` can detect "this specific `when` slot fired" via key presence
  (`Object.prototype.hasOwnProperty.call(inputs, 'when1')`).
- What `run()` CANNOT see today is which inputs are **wired at all** — so "wired but not fired"
  and "unwired" are indistinguishable, and the spec's "unwired selected slot ⇒ fires
  unconditionally" is not implementable as written.

Two decisions:

1. **Additive engine change:** extend the third `run()` argument (currently `{ id, config }`,
   `workflowEngine.ts:157`) with `wiredInputs: string[]` — the input-port names that have at least
   one incoming edge. The engine already has `ins` in hand at that call site; this is a few lines
   and type-additive (`src/main/services/nodes/types.ts` NodeImpl signature). No existing node
   reads it, so behavior is unchanged for the whole registry.
2. **Refined firing rule** (deviation from the spec's literal text — log it in the PR body): the
   spec says an unwired selected slot "fires unconditionally, so the node also works as a
   standalone config-driven gate". Taken literally that BREAKS the `off` mode: with `off` mapped
   to an unwired slot, a firing backlog trigger on `when2` would un-gate the node, the unwired
   selected slot would "fire unconditionally", and the memory chain would run with memory off.
   Rule as implemented:
   - `fired` fires iff **(selected slot is wired AND its key is present in `inputs`)** OR
     **(no `whenN` slot is wired at all)**.
   - i.e. unconditional firing applies only in the true standalone-gate case (zero wired whens);
     in a wired graph an unwired selected slot is a dead end — which is exactly what makes `off`
     (an option key with no wired slot) the master off-switch of §3.2.
   - `selected: Text` always emits the selected key (it's data, not a gate).

Turn-run safety holds with no special casing: in a turn all triggers are excluded and their edges
seeded dead (`triggerNodes.ts:21-31`), so `control.mode` is `gatedOff` and the whole headless
chain prunes — regardless of mode.

### 0.3 Seeding migration rule (spec §3.3 "exact migration rule: decide at plan time")

Follow the `seedBuiltinPacks` precedent (`src/main/services/agentPackService.ts:57-77`): **lazy +
idempotent seeding at the read entry points** of `workflowService` (list + resolve), covering both
new profiles and existing profiles on first launch after update, with no separate migration hook:

- Seed marker: the seeded doc carries `meta.seeded = 'default-memory-v1'`. Idempotence = "a doc
  with this marker exists" (survives rename; deletion is respected — see below).
- Seed condition, evaluated once per profile per process (module-level `Set` like
  `seededProfiles`): seed the "Default" doc iff **no doc carries the marker** AND **no existing
  user doc contains a `table.apply` or `agent.llm` node** (the spec's "no user-created docs
  reference memory" made concrete — those two types are the memory-writing surface).
- Selection: after seeding, set `selection.global` to the new doc id **only if `selection.global`
  is currently null/unset** (`_selection.json`, `workflowService.ts:205-243`) — never stomp an
  explicit user choice.
- Deletion tombstone: if the user deletes the seeded doc, we must not re-seed next launch. On
  delete of a doc whose `meta.seeded` marker is set, record the marker string in `_selection.json`
  (new optional field `seededTombstones: string[]`) and include it in the seed condition. This is
  the one new sidecar field; keep it additive.

### 0.4 Lorebook pick store shape (spec §7 "finalize at plan time")

- **worldId = `chat.character_id`** — that is exactly what the workflow world tier already keys on
  (`workflowService.ts:248-253` reads `selection.worlds[chat.character_id]`).
- Storage: a per-profile JSON sidecar next to `_selection.json` in the workflows dir —
  `_lore-picks.json` (pattern precedent: `_selection.json`; the SQLite `workflow_trigger_state`
  precedent is for per-chat mutable counters, which this is not). Atomic write via the existing
  `writeJsonSyncAtomic` helper.
- Shape:

  ```jsonc
  {
    "version": 1,
    // worldId → docId → nodeId → picks
    "picks": {
      "<characterId>": {
        "<docId>": {
          "<nodeId>": [
            { "book": "<lorebook id>", "uid": 3, "title": "last-seen comment" }
          ]
        }
      }
    }
  }
  ```

- Entry identity: `book` = the lorebook id from `listLorebooks`
  (`src/main/services/lorebookService.ts:28-34`), `uid` = the ST entry uid, `title` = last-seen
  `comment` for the "N missing" display. **Verify at implementation time** that entries carry a
  stable numeric `uid` in `src/main/types` (ST v3 lorebooks do); if any import path produces
  entries without uids, fall back to keying by `comment` (the identity `lorebook.entries` already
  uses per spec grounding) and record the fallback in the SDK doc.
- Missing resolution: a pick whose (book, uid) no longer resolves is skipped at run time
  (fail-soft, spec §11) and counted as missing in the picker via the stored `title`.

### 0.5 Descriptor hints surfaced through the catalog

`NodeTypeInfo` / `listNodeTypes` (`src/main/services/nodes/catalog.ts:7-36`) currently surfaces
`type/title/ports/isMainOutputCapable/configSchema` — note it does NOT surface `isTrigger`; the
renderer mirrors it with a `type.startsWith('trigger.')` check (`FlowCanvas.tsx:90-92`). Additive
descriptor surface for this feature (all optional, all flowing through `list-node-types` IPC and
the renderer's `EditorNodeType` twin in `editorModel.ts:17-24`):

- `isTrigger?: boolean` — surface the existing impl flag; switch the renderer's prefix check to it
  (keep the prefix check only as fallback for a stale catalog).
- `promptFields?: string[]` — spec §1. Set on `agent.llm` (`['messages']`) and `text.template`
  (`['template']`).
- `dynamicEnum?: { path: string; optionsPath: string; keyField: string; labelField: string }` —
  needed because `control.mode.selected` cannot be a static zod enum (its options live in the
  sibling `options` config array). The generic exposed-enum renderer (WP-E/WP-F) uses: static JSON
  Schema `enum` if present, else `dynamicEnum` resolved against the node's current config. This
  keeps "Mode dropdown = any exposed enum field" (spec §1) true without hardcoding `control.mode`
  anywhere in the renderer.

### 0.6 Theme tokens

`theme.ts` ALREADY has an `--rpt-agent-*` family (gate/headless/region tokens,
`src/renderer/src/theme.ts:34-47` and per-theme repeats) — do not mistake it for this feature.
Add the spec's new pair `--rpt-agent` / `--rpt-agent-dim` to all three themes (dark/carbon/light),
WCAG-AA against the surfaces they're used on (agent-card chrome, status-sentence text, Agents ▾
rows). Contrast-check all three themes (memory: contrast-safety is a hard constraint).

### 0.7 `GroupDecl.note` round-trip — smaller than the spec feared

`editorToDoc` passes `groups` through wholesale from `base` (`editorModel.ts:159`), so a nested
`note` survives the whitelist **without** an editorModel change. What DOES need changing is
`GroupDeclSchema` in `src/shared/workflow/docSchema.ts:85` (a doc with `note` must validate) and
the module envelope round-trip. Still add the explicit round-trip test (spec §11) — the gotcha has
bitten three times; the test is cheap insurance against a future editorToDoc refactor.

---

## 1. Work packages

Dependency graph (each letter = one PR):

```
WP-A (contract/schema)
 ├─→ WP-B (control.mode + engine wiredInputs)
 │     └─→ WP-C (merged default doc + seeding)
 ├─→ WP-D (canvas: agent cards + grouping)   ← also wants B for the demo doc, not a hard dep
 │     ├─→ WP-E (universal details panel + prompt editor)
 │     │     └─→ WP-F (Agents ▾ dropdown)
 │     └─→ WP-G (agent library palette)      ← needs C's template to have content
 ├─→ WP-H (agent.llm lore port + picker)     ← picker UI hosts in E's panel; land after E
 └─→ WP-I (memory sheet tabs + shared grid)  ← independent; any time
```

Recommended serial order: **A → B → C → D → E → F → G → H → I.** (I can be done any time; H needs
E's panel shell for the picker row placement.)

---

### WP-A — Agent contract schema + catalog surfacing

**Goal:** the additive format/IPC surface everything else builds on (spec §1).

Files: `src/shared/workflow/types.ts`, `src/shared/workflow/docSchema.ts`,
`src/main/services/nodes/types.ts` (NodeImpl descriptor), `src/main/services/nodes/catalog.ts`,
`src/main/services/nodes/builtin/agentNodes.ts` (+ `text.template`'s home, verify:
`messageNodes.ts`), `src/renderer/src/components/workflow/editorModel.ts` (EditorNodeType twin),
`src/main/services/moduleTransferService.ts` (envelope carries groups+note — verify current
envelope contents), `docs/sdk/` module-format page.

Tasks:
1. `note?: string` on `GroupDecl` (types.ts) + `GroupDeclSchema` (docSchema.ts:85).
2. Descriptor hints per §0.5: `promptFields`, `dynamicEnum`, and surfacing `isTrigger` through
   `NodeTypeInfo`/`listNodeTypes`; mirror the fields on the renderer's `EditorNodeType`.
3. Stamp hints on the built-ins: `agent.llm.promptFields = ['messages']`; `text.template`
   `['template']`; `control.mode.dynamicEnum` lands in WP-B with the node.
4. Switch `FlowCanvas.tsx:92`'s trigger detection to catalog `isTrigger` (prefix fallback kept).
5. `docs/sdk/` module-format page: document `GroupDecl.note`, `promptFields`, `dynamicEnum`, and
   the agent contract ("named group rooted at a trigger ⇒ stock agent UI") — spec §1 table.
   Check `docs/sdk/README.md`'s touch-map and add these files to it if absent.

Tests: docSchema characterization update (deliberate, same commit — a group with `note`
validates; unknown fields still rejected if that's current behavior — pin whichever it is);
editorToDoc round-trip keeps `groups[].note` (§0.7); catalog test that `list-node-types` carries
the new hint fields.

Acceptance: gate green; no behavior change anywhere (pure surface).

---

### WP-B — `control.mode` node + engine `wiredInputs`

**Goal:** the generic mode selector (spec §3.1) with the refined firing rule (§0.2).

Files: `src/main/services/workflowEngine.ts` (pass `wiredInputs` at the `run()` call site, :157),
`src/main/services/nodes/types.ts` (NodeImpl run signature — additive third-arg field),
`src/main/services/nodes/builtin/controlNodes.ts` (the node lives with control.if/control.switch),
`src/main/services/nodes/builtin/index.ts` (register), catalog hint (`dynamicEnum` per §0.5),
locale files (node title).

Node contract (final):
- type `control.mode`, title "Mode"; config
  `{ options: [{ key, label }] (1..4), selected: string }` (zod; validate `selected` ∈ options at
  run, fail-soft to first option with a trace-visible log if not).
- inputs `when1..when4: Signal`; outputs `fired: Signal`, `selected: Text`.
- `run()`: emits `selected` key as Text always; fires `fired` per §0.2's rule using
  key-presence (`inputs`) + `wiredInputs`.
- Option→slot mapping: `options[i]` corresponds to `when{i+1}` (document this in the SDK page and
  the config schema description — it's the contract that lets an imported module join the mutual
  exclusion by wiring a free slot, spec §3.2).

Tests (spec §11 names them): selected-slot passthrough fires; non-selected fired slot ⇒ `fired`
dead but node runs; selected wired-but-unfired ⇒ dead; **zero whens wired ⇒ fires
unconditionally** (standalone gate); unwired selected + a different wired slot fired ⇒ dead (the `off`
case — the §0.2 refinement, test named accordingly); slot bounds (≤4 options); `selected` Text
output always present. Engine test: `wiredInputs` reflects wiring and existing nodes are
unaffected (a characterization-style spot check on one legacy node).

Acceptance: gate green; generateParity untouched (no narrator-path change).

---

### WP-C — Merged default doc + seeded editable "Default"

**Goal:** spec §3.2–§3.3. Memory lives INSIDE an editable seeded default doc; the code builtin
stays byte-untouched.

Files: new `src/main/services/nodes/builtin/defaultMemoryTemplate.ts` (or similar — code-built
like `DEFAULT_GRAPH`), `src/main/services/workflowService.ts` (lazy seeding per §0.3 + tombstone),
`docs/workflows/` fixtures untouched (they become dev fixtures/CI pins, spec §2), SDK doc note.

Tasks:
1. Build the template doc in code. Content — verify node/port names against
   `docs/workflows/memory-fill-async.rptflow` + `table-memory-default.rptflow` and the node impls
   before wiring (grounding rule; the spec's chain list is the design, the .rptflow files are the
   proven wiring):
   - Narrator/turn path: `input.context → context.trimProcessed → prompt.assemble → llm.sample →
     parse.response → apply.state → output.writeFloor` + `table.export → assemble.entries`
     (recall; fail-soft in every mode).
   - Headless path: `trigger.cadence → control.mode.when1`; `trigger.state (table backlog ≥ N) →
     control.mode.when2`; `control.mode.fired → history.recent → agent.llm →
     parse.extract(tag TableEdit) → table.apply(advance_progress)`; `table.read →
     agent.llm.input`; `table.apply.error → util.log`. Options
     `[{key:'every_turn'},{key:'async'},{key:'off'}]` — `off` has no wired slot (that IS the off
     switch, §0.2). `when3`/`when4` free for imported systems.
   - The memory nodes pre-grouped as ONE `GroupDecl` "Table memory", `collapsed: true`, with
     `exposed`: mode (`control.mode.selected`), cadence (`trigger.cadence.everyNFloors`), backlog
     threshold (`trigger.state.value`), `agent.llm.api_preset_id`; `note` set (setup guidance:
     needs a bound table template + an API preset). Prompt reaches the UI via `promptFields`, not
     `exposed`.
   - Take the maintainer prompt verbatim from the shipped .rptflow (it's the proven zh prompt).
2. Seeding per §0.3 (lazy, marker, tombstone, selection-only-if-null). `DEFAULT_GRAPH` and
   `BUILTIN_WORKFLOW_ID` resolution untouched.
3. Doc positions: lay the group out to the side of the narrator spine (positions are part of the
   template; keep the owner's "see where agents tap the narrator path").

Tests: template validates (`docSchema` + workflow validation incl. group rules); seeding
idempotence (second call no-op); tombstone respected after delete; selection set only when null;
existing-profile-with-memory-docs NOT seeded; **generateParity suite untouched and green**
(spec §11); a composed-behavior test: turn run of the seeded doc with mode=off ≡ turn run of
`DEFAULT_GRAPH` given no bound table template (both fail-soft paths — pin equivalence at the
trace level like `tableMemoryPackEquivalence.test.ts` does).

Acceptance: fresh profile gets an editable "Default" selected globally; flipping
`control.mode.selected` between the three options changes which trigger's headless run survives
(manual check via the run drawer — give the owner explicit steps in the PR body per the
manual-testing workflow).

---

### WP-D — Canvas: agent cards, frames, one-click grouping

**Goal:** spec §4. Pure renderer + one pure-model module; no engine changes.

Files: `src/renderer/src/components/workflow/groupModel.ts` (+ new pure `agentModel.ts` —
see below), `FlowCanvas.tsx`, `workflowEditor.css`, `workflowEditorStore.ts`,
`ModuleImportSheet.tsx` (auto-group offer), theme.ts (§0.6 tokens), locales.

Tasks:
1. New pure module `agentModel.ts` (vitest-pure like groupModel):
   - `isAgentGroup(doc, group)` — a member chain rooted at a trigger node (contract §1; use
     catalog `isTrigger` via the types map, fall back to prefix).
   - `agentStatusSentence(...)` — composes trigger description + last-run recency. Inputs: the
     localized describeTrigger output the renderer already gets from `explainDocTriggers`
     (`FlowCanvas.tsx` DocTriggerBadge / preload surface) + the newest matching `StoredRunRecord`.
     Emits an i18n key + params (NOT concatenated English) so zh renders natively; add the
     sentence patterns to both locale files ("Runs every {n} floors · ran {ago}",
     "Off · would run every {n} floors", …).
   - `promptExcerpt(doc, group, types)` — first system row of the first prompt-bearing member
     (via `promptFields`).
   - `downstreamClosure(doc, triggerId)` — the one-click-grouping walk: downstream closure of the
     trigger, EXCLUDING nodes reachable from any non-member root (keeps `input.context` and
     narrator-shared nodes out; spec §4).
2. Run attribution: agent Runs need runs keyed by trigger node id mapped through membership
   (spec §1). Verify what the doc-path persist stores today
   (`headlessRunService.ts:845` — "module attribution arrives with WP6.3"): if
   `StoredRunRecord` lacks trigger-node ids, extend it additively (`triggerNodeIds?: string[]`)
   at the doc-path persist point + thread through `runHistoryStore`. Old records without the
   field simply don't attribute (fail-soft).
3. Upgrade `RptModuleNode` (FlowCanvas.tsx:199-229) into the agent card: on/off switch proxying
   ALL member triggers' `disabled` (mixed state = off + dot; flipping writes all), status
   sentence, last-run dot + relative time, member count, prompt excerpt (1 line), validation dot
   (doc validation errors filtered by membership), dimmed when disabled. Non-agent groups keep
   the current plain module card.
4. Group frame header (expanded): same switch + sentence; inline rename on double-click.
5. One-click grouping: context menu on trigger nodes → "Collapse chain into module" (uses
   `downstreamClosure`, mints via `nextGroupId`, `collapsed: true`); toolbar "Collapse all
   agents / Expand all".
6. Prompt excerpt on ungrouped `agent.llm` cards (2 lines).
7. `.rptflow` import review: auto-group offer (checked by default) when trigger chains are
   ungrouped — reuse `downstreamClosure`.
8. Tokens per §0.6.

Tests: agentModel pure tests (closure walk incl. the narrator-shared-node exclusion; status
sentence key/param derivation incl. "Off · would…"; excerpt; mixed-disabled proxy state).
Characterization updates for groupModel/editorModel projections ONLY if collapsed rendering data
shapes change (spec §11 — deliberate, same commit).

Acceptance: seeded Default doc (WP-C) renders "Table memory" as an agent card with a working
switch + sentence; right-click grouping works on the memory-fill fixtures imported ungrouped.

---

### WP-E — Universal details panel + prompt editor

**Goal:** spec §6. One panel shell, three selection contexts, four tabs.

Files: `NodeConfigPanel.tsx` (recompose into the shell — likely new `DetailsPanel.tsx` hosting
tabs, with today's schema form as the node Settings tab body), `schemaForm.ts` (exposed-enum +
`dynamicEnum` rendering per §0.5; prompt fields excluded from the schema form and routed to the
Prompt tab), new `PromptEditor.tsx`, `WorkflowEditorView.tsx` (selection context: agent vs node vs
nothing — group/module selection already exists on canvas), `RunDrawer.tsx` reuse for the Runs
tab slice, locales, css.

Tasks:
1. Panel shell with left-edge vertical icon tab rail; tab visibility per the spec §6 table
   (Prompt tab only when `promptFields` present; agent Runs = membership-filtered runs from
   WP-D.2; node Runs = last-run trace slice; Docs tab = port + config docs moved out of the
   settings scroll).
2. Agent context: enabled switch (same proxy as the card), trigger timing (the trigger nodes'
   schema forms or the badge data), exposed settings rendered generically (static enum →
   dropdown; `dynamicEnum` → dropdown from the node's `options` config; others → the matching
   schemaForm control), `note` rendered verbatim in a warning tint, "N nodes · show on canvas"
   (expand + pan), Export module (existing module export flow).
3. Prompt editor (v1 scope only): role-chip rows, auto-growing monospace textareas, placeholder
   chips (`{history}`, `{{input}}`, `{{user}}`, `{{char}}` — source the chip list from a constant
   next to the editor, documented), drag-reorder, add/remove. Writes back to the node's
   `messages`/`template` config through the same store path the schema form uses (one write path;
   no drift). NO preview render (spec §9).
4. Nothing-selected context: workflow name/description + validation error list (move from
   wherever they render today — verify current placement in `WorkflowEditorView.tsx`).

Tests: pure tab-visibility/selection-context logic extracted and unit-tested; prompt editor
round-trip (rows ↔ config array, reorder, role change) as component-free model tests where
possible.

Acceptance: the memory prompt is editable in a real editor from both the `agent.llm` node and the
"Table memory" agent selection; imported agents (any group matching the contract) get the same
panel with zero extra authoring.

---

### WP-F — Agents ▾ master dropdown

**Goal:** spec §5. Toolbar dropdown, one row per agent.

Files: `WorkflowEditorView.tsx` (toolbar), a new `AgentsDropdown.tsx`, reuse `agentModel` +
exposed-enum rendering from WP-E, locales, css.

Tasks: rows = on/off switch · name · `imported` provenance chip (source: group came from a module
import — record provenance at import time as a group-level meta; verify whether
`confirmModuleImport` (`moduleTransferService.ts:230`) already stamps anything reusable, else add
an optional `origin?: 'import'` field to `GroupDecl` in WP-A… **decision: carry it as
`note`-adjacent optional `GroupDecl.origin` added in WP-A to avoid a second schema PR**) · status
sentence · inline dropdowns for exposed enum settings (shared renderer from WP-E) · locate button
(pan/zoom via the React Flow instance). Disabled rows use the "Off · would …" sentence variant
(already in agentModel).

Tests: row derivation from a doc (pure agentModel extension); enum write-through shares the WP-E
path (no new write path).

Acceptance: memory mode flippable from the dropdown without opening the group.

---

### WP-G — Agent library in the palette

**Goal:** spec §2. Built-in module templates + import entry + save-imported-to-library.

Files: main — new `moduleTemplates.ts` (built-in template registry; v1 = the WP-C "Table memory"
group extracted as an insertable template: nodes + edges + group + note), a `list-module-templates`
IPC (alongside `list-node-types` — verify the IPC home, likely `src/main/ipc/` workflow ipc file +
`shared/ipc` typing + preload), user-library persistence as envelope JSON files under the
profile's workflows dir (reuse `buildModuleEnvelope`/inspection from `moduleTransferService.ts`);
renderer — palette section in `WorkflowEditorView.tsx` (palette is the left column there) with the
search box filtering BOTH sections, insert = add nodes/edges/group pre-grouped-named-collapsed at
a free canvas spot (id-remap on insert — reuse whatever the module import flow uses for id
collision; verify `confirmModuleImport`'s remap and share it), "Import module…" last entry
(existing flow + its review sheet), "save to library" affordance on the import review sheet.

Tests: template insert id-remap (no collisions with existing nodes/groups); IPC listing; search
filter model.

Acceptance: after deleting the memory group, the user can re-add "Table memory" from the palette
and get the identical pre-grouped agent; `docs/workflows/*.rptflow` no longer referenced by any
user-facing flow (they stay as fixtures).

---

### WP-H — Lorebook entry selector on `agent.llm`

**Goal:** spec §7. Wire-wins-then-config lore resolution + per-world picks + picker UI.

Files: main — `agentNodes.ts` (new optional `lore: Lore` input; config `lorebook?: 'main' |
'custom'` default `'main'`; injection per spec §7.3), new `workflowLorePicksStore.ts` (§0.4
sidecar) + IPC (get/set picks for `(worldId, docId, nodeId)`, list books+entries for the picker —
reuse `listLorebooks`/`getLorebookById`), `lorebookService.ts` reuse (`matchAcross` :129 for
`main` mode — verify it implements the SAME resolution the narrator's assemble uses; if assemble
uses a richer path in `generationNodes.ts:65-93`, reuse THAT); renderer — Lorebook row in
`agent.llm`'s node Settings tab (WP-E panel) + `LorebookPickerSheet.tsx` per the spec's picker
spec (search over titles, titles only, collapsible book groups with tri-state select-all,
selected + missing counts, Clear/Done, save on Done); locales.

Resolution in `run()` (document in SDK page):
1. `lore` input wired (key present in `inputs` — same live-edge detection as §0.2, but Lore
   carries a value) ⇒ use it; picker row shows "wired on canvas", disabled.
2. else config `main` ⇒ standard matching over the `history` input against the chat's active
   lorebooks (via `buildGenContext`, which `agent.llm` already builds — verify it exposes the
   active books; else resolve via the same service assemble uses).
3. else `custom` ⇒ exactly the stored picks for `(chat.character_id, docId, nodeId)`; missing
   entries skipped fail-soft; no picks yet ⇒ fall back to `main` + panel hint (spec).
4. Injection: `{{lore}}` placeholder in a template row if present, else appended system row when
   non-empty. Empty result ⇒ no row (fail-soft).

Tests (spec §11): lore port/config resolution precedence (wired beats config), `custom` exact
injection, missing-entry fail-soft + missing count derivation, no-picks fallback to main,
`{{lore}}` vs appended-row placement, store round-trip + per-world isolation (two worlds, same
doc/node, different picks). `llm.sample` untouched (spec §9) — parity green.

Acceptance: picker opens from the node Settings tab; picks survive app restart; switching chats
to a different character resolves that world's picks.

---

### WP-I — Memory sheet tabs + shared grid

**Goal:** spec §8. Independent of A–H; schedule anywhere.

Files: `src/renderer/src/components/workspace/MemoryPane.tsx`, `TablesView.tsx`, new shared
`TableGrid.tsx` (extract the editable grid), the editor's Memory sheet host (verify where
MemoryPane mounts), locales, css.

Tasks: tab the Memory sheet (Setup = today's MemoryPane; Data = shared grid; Maintenance =
backfill/progress/per-table processed-next-unprocessed — the backfill machinery exists per the
SQL-table-memory work, verify `tableBackfillService`/`tableProgressService` surfaces). Grid
polish in the SHARED component so the workspace Tables view inherits it: sticky header, column
autosizing, search/filter, maintenance-pointer marker, row provenance on hover (floor-attributed
op-log — verify the op-log exposes floor attribution; if not, surface it additively over IPC).

Tests: grid model logic (filter/autosize/pointer derivation) pure-tested; no regression in
TablesView editing (characterize the current edit write path first if untested).

Acceptance: memory data, config, and maintenance reachable from one sheet; Tables view visually
identical-or-better with the shared grid.

---

## 2. Cross-cutting obligations (every WP)

- **i18n:** every user-facing string via `t()`, added to BOTH `locales/en.ts` + `locales/zh.ts`
  (use ST-ecosystem zh terms: 世界书/预设/正则/脚本). Status sentences are keyed patterns with
  params, never concatenated fragments (§WP-D.1).
- **SDK docs:** WP-A/B/C/H change creator-facing module-format surface — update `docs/sdk/` in the
  SAME PR (spec §11; CLAUDE.md). Cite file:line for every behavioral claim.
- **Parity:** `DEFAULT_GRAPH` byte-untouched (verify with git diff on the file in WP-C review);
  generateParity suite green unchanged in every WP.
- **Characterization tests:** update deliberately in the same commit when a pinned projection
  changes; never delete to go green.
- **Module boundaries:** renderer imports main ONLY via `shared/ipc`; new IPC surfaces typed
  there. `check:deps` must pass without rule edits — none of these WPs should need a boundary
  change.
- **Testing gotcha:** brace all `beforeEach` bodies (`beforeEach(() => { mock.mockReset() })`) —
  a returned mock registers as a teardown hook.
- **Gate:** `npm run typecheck && npm run check:deps && npm run test` before declaring any WP
  done. New tests land in `test/` mirroring existing layout (`test/workflow/*` for engine/node
  tests).

## 3. Known risks / verify-first list (for the implementing agent)

1. **`wiredInputs` engine change (WP-B)** — smallest possible diff at `workflowEngine.ts:157`;
   spot-check no node relies on the third arg's exact object identity.
2. **Run attribution (WP-D.2)** — the doc-path `StoredRunRecord` may lack trigger-node ids
   (headlessRunService.ts:845 comment says module attribution never arrived). Additive field +
   fail-soft display for old records.
3. **`agent.llm` active-lorebook resolution (WP-H)** — must match the narrator's assemble rules;
   read `generationNodes.ts` assemble before choosing `matchAcross` vs a shared helper. If a
   shared helper doesn't exist, extract one rather than duplicating matching rules.
4. **Entry `uid` presence (WP-H, §0.4)** — verify against `src/main/types` lorebook shape +
   `normalizeLorebookData` (`lorebookService.ts:184-204`) which currently normalizes `comment`
   only; imports may need uid backfill on read (assign-if-missing at load is NOT acceptable if it
   mutates user files silently — prefer comment-fallback identity in that case).
5. **Group provenance chip (WP-F)** — needs `GroupDecl.origin?` added in WP-A (one schema PR, not
   two); docSchema + SDK page in the same change.
6. **Existing `--rpt-agent-*` token family (§0.6)** — the new `--rpt-agent`/`--rpt-agent-dim` pair
   coexists by name-prefix with it; don't rename the existing family.
7. **Spec deviation log** — the §0.2 `control.mode` firing refinement is the only deliberate
   deviation; restate it in the WP-B PR body so the owner sees it.
