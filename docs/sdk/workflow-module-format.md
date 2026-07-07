# Workflow module format — the agent UI contract

**Status:** ✅ contract surface built (agent & memory UX WP-A); ✅ `control.mode` node + engine
`wiredInputs` (WP-B); ✅ seeded "Default" memory doc + open-slot convention (WP-C). Living doc —
edit in place.

A workflow **module** is a reusable slab of a workflow graph: a named group of in-place nodes, its
internal edges, and the settings it exposes. It ships as a `.rptmodule` file
(`src/shared/workflow/moduleEnvelope.ts`) or lives inline in a workflow doc as a `GroupDecl`
(`src/shared/workflow/types.ts:81`). This page is the **creator-facing contract** for what a module
must contain to get the stock agent UI — no side manifest, purely the document shape.

## The agent UI contract

An **agent** is a named `GroupDecl` whose member chain is rooted at a **trigger** node. Anything
matching that shape gets the full agent UI (status sentence, on/off switch, prompt editor, runs). A
node type is a trigger when its descriptor sets `isTrigger` (`src/shared/workflow/types.ts:38`); the
three built-in triggers set it (`src/main/services/nodes/builtin/triggerNodes.ts:88,101,113`).
Everything below is derived from the doc — the only required authoring is the group name.

| UI element | Source | Author work |
|---|---|---|
| Name | `group.name` (`types.ts:83`) | required |
| On/off toggle | trigger node `disabled` flag; flips ALL triggers in the group | none |
| Status sentence | derived: trigger description + last run | none |
| Settings tab | `group.exposed` (`types.ts` `ExposedGroupSetting`, :72) | pick fields |
| Mode dropdown | any exposed enum field (static schema `enum`, else `dynamicEnum`) | expose the field |
| Prompt tab / card excerpt | node-type descriptor `promptFields` | none (inherited) |
| Runs | runs keyed by trigger node id → mapped through membership | none |
| Setup note | `group.note` (`types.ts`, rendered verbatim in a warning tint) | optional |

## Schema additions (agent & memory UX WP-A — additive)

All additive and optional; a pre-WP-A doc/module is unaffected.

### `GroupDecl.note?: string`

Author setup guidance, rendered verbatim in a warning tint on the agent panel (e.g. "needs a bound
table template + an API preset"). Plain string, never interpreted. Declared in the doc schema
(`src/shared/workflow/docSchema.ts` `GroupDeclSchema`) — **zod strips undeclared keys**, so an
un-declared field would silently vanish on a round-trip through `parseWorkflowDoc`. It also travels
with a `.rptmodule` export: `ModulePayload.note` (`moduleEnvelope.ts`), populated from the group by
`buildModuleEnvelope` (`src/main/services/moduleTransferService.ts`).

### `GroupDecl.origin?: 'import'`

Import provenance. `'import'` marks a group that arrived via a `.rptmodule` import (the Agents ▾
dropdown shows an `imported` chip). Stamped by the importer at insert time, **not** carried in the
module envelope — a module file never asserts its own provenance. `'import'` is the only accepted
value (`GroupDeclSchema` uses `z.literal('import')`).

### Node-type descriptor `promptFields?: string[]`

The config field name(s) that hold an **authored prompt** — a role-message array or a template
string. Surfaced through the `list-node-types` catalog
(`src/main/services/nodes/catalog.ts` `NodeTypeInfo` / `listNodeTypes`) so the editor routes those
fields to the dedicated Prompt editor instead of the generic schema-form control, and derives the
on-card prompt excerpt. Set on the built-ins:

- `agent.llm` → `['messages']` (`src/main/services/nodes/builtin/agentNodes.ts`)
- `text.template` → `['template']` (`src/main/services/nodes/builtin/messageNodes.ts`)

An imported agent inherits this from its built-in node types — no author work.

### Node-type descriptor `dynamicEnum?`

`{ path, optionsPath, keyField, labelField }` (`DynamicEnumHint`, `src/shared/workflow/types.ts`).
Describes an enum config field whose options are **not** a static zod enum but live in a sibling
config array. The generic exposed-enum renderer prefers a static JSON-Schema `enum`, falling back to
resolving this hint against the node instance's current config. First stamped by `control.mode`
(WP-B): `{ path: 'selected', optionsPath: 'options', keyField: 'key', labelField: 'label' }`
(`src/main/services/nodes/builtin/controlNodes.ts`).

## The `control.mode` node (WP-B)

The generic **mode selector** (spec §3.1, plan §0.2) that makes agent chains mutually exclusive
behind one exposed enum. Lives in `src/main/services/nodes/builtin/controlNodes.ts`; registered in
`builtin/index.ts`.

- **Config:** `{ options: [{ key, label? }] (1–4), selected: string }`. `label` is optional — the
  renderer falls back to `key`. A `selected` key not present in `options` **fails soft** to the
  first option (logged); it never throws.
- **Ports:** inputs `when1..when4: Signal`; outputs `fired: Signal`, `selected: Text`.
- **Slot mapping (the contract):** `options[i]` corresponds to `when{i+1}` — the first option to
  `when1`, the second to `when2`, and so on. Fixed at 4 slots (mirrors `control.switch` `case1–4`).
  An imported system joins the mutual exclusion by wiring its trigger into a free slot and adding an
  option — pure wiring, no app code.
- **Firing rule** (plan §0.2 — a deliberate refinement of the spec's literal text): `fired` fires
  iff **(the selected option's slot is wired AND that slot's edge was live this run)** OR **(no
  `whenN` slot is wired at all)**. Consequences:
  - Non-selected slots are dead ends — structural mutual exclusion.
  - An option whose slot is unwired (e.g. `off`) selects "nothing runs": in a wired graph an
    unwired selected slot is a dead end, which is what makes `off` the master off-switch.
  - Zero wired `when` slots ⇒ fires unconditionally — the node doubles as a standalone
    config-driven gate.
- **`selected: Text`** always emits the (fail-soft-resolved) selected key whenever the node runs —
  it is data, not a gate. Note the node only runs at all if ≥1 wired slot fired or no slot is wired
  (standard engine Signal gating, `src/main/services/workflowEngine.ts`).
- **Engine support:** `run()`'s third argument (`NodeMeta`, `src/main/services/nodes/types.ts`)
  carries `wiredInputs: string[]` — the input-port names with ≥1 incoming edge, live or dead —
  supplied at the single run call site (`workflowEngine.ts`). This is how a node distinguishes
  "wired but not fired" from "not wired at all". Additive: no other built-in reads it.

## The seeded "Default" doc + the open-slot convention (WP-C)

Every profile is lazily seeded with an ordinary, EDITABLE workflow doc named **"Default"**: the
narrator spine plus a collapsed **"Table memory"** group (`buildDefaultMemoryDoc`,
`src/main/services/nodes/builtin/defaultMemoryTemplate.ts`; seeding rule in
`src/main/services/workflowService.ts` `seedDefaultMemoryWorkflow`). The code builtin
`DEFAULT_GRAPH` stays untouched as the invisible fallback.

- **Seeding rule** (plan §0.3): lazy at the `listWorkflows` entry point; idempotent via the
  `meta.seeded = 'default-memory-v1'` marker (survives rename/edit); skipped when any user doc
  already contains `table.apply` or `agent.llm`; the global selection is set to the seeded doc only
  when nothing was selected; deleting the seeded doc records the marker in `_selection.json`
  `seededTombstones` so it never comes back. Ships with mode `off` (safe default — no side LLM
  calls until the user configures a table template and flips the mode).
- **The open-slot convention for imported memory systems** (spec §3.2): the seeded doc's
  `control.mode` uses `when1` (cadence trigger) and `when2` (backlog state trigger); **`when3` and
  `when4` are deliberately left unwired.** An imported memory/agent module joins the mutual
  exclusion by (1) wiring its own trigger's `fired` into a free slot and (2) adding a matching
  option `{ key, label? }` to the mode's `options` — options map to slots in order
  (`options[i] ↔ when{i+1}`). Pure wiring; no app code. The `off` option deliberately has NO wired
  slot — selecting it dead-ends the chain (the WP-B firing rule), which is the master memory
  off-switch.

### `isTrigger` surfaced through the catalog

`NodeTypeInfo.isTrigger` mirrors the descriptor flag through `list-node-types`, so the canvas keys
its agent detection + on/off switch off the catalog rather than a `trigger.*` name prefix (the prefix
is kept only as a fallback for a stale/absent catalog entry —
`src/renderer/src/components/workflow/FlowCanvas.tsx`).

## Round-trip guarantees

- **Doc save/load:** every field above is declared in `docSchema.ts` (groups) or surfaced by
  `catalog.ts` (descriptor hints). The editor's `editorToDoc` passes `groups` through wholesale from
  the base doc (`src/renderer/src/components/workflow/editorModel.ts`), so `note`/`origin` survive its
  field whitelist. Pinned by `test/workflow/docSchema.test.ts` + `test/workflow/editorModel.test.ts`.
- **`.rptmodule` export/import:** `ModulePayload.note` is in the serialize key order, the parse
  schema, and the known-keys set (`moduleEnvelope.ts`). Pinned by
  `test/moduleTransferService.test.ts`. `origin` is intentionally not carried.
