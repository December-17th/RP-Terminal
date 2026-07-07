# Workflow module format — the agent UI contract

**Status:** ✅ contract surface built (agent & memory UX WP-A). Living doc — edit in place.

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
resolving this hint against the node instance's current config. The catalog surface exists as of
WP-A; the first node to stamp it (`control.mode.selected ⇐ options[].key`) lands in WP-B.

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
