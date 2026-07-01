# Node Workflow Engine — Phase 3: Persistence + Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflows a real user resource (spec §12): file-based storage + CRUD, `.rptflow`
import/export with a validation gate, the four-tier resolution order (session → world → global →
built-in default) driving `generate()`, per-workflow `node_state` keying, and a minimal
workspace view to manage and select workflows — unlocking the Phase 2b-2 agentic nodes for
actual use before any canvas editor exists.

**Architecture:** `workflowService` mirrors `presetService` exactly (per-profile JSON files +
a `_selection.json` sidecar for global/world defaults; the session override is a nullable
`chats.workflow_id` column mirroring `lorebook_ids`). `generate()` swaps its hardcoded
`DEFAULT_GRAPH` for `resolveWorkflowDoc()`, whose final fallback IS the built-in default graph —
so with nothing selected, behavior is byte-identical (parity suites prove it). `node_state` is
re-keyed `(chat_id, workflow_id, node_id)` so two workflows sharing node ids can't cross-talk.

**Tech Stack:** TypeScript, Vitest, zod v4, better-sqlite3 (one new column + one table rebuild),
React + Zustand + `t()` i18n for the minimal view. No new dependencies.

## Global Constraints

- **Parity stays green.** With no workflow selected anywhere, `generate()` must produce the same
  bytes as today: `test/generation/generateParity.test.ts` + `generateParity.abort.test.ts` stay
  green (their chatService mocks gain a `getChatWorkflowId: () => null` export in the same commit
  that makes workflowService need it — a deliberate fixture completion, not a behavior change).
- **Module boundaries** (`npm run check:deps`): `shared/workflow` stays pure (the new doc schema
  imports only zod, like `shared/cardZod.ts`); renderer talks only through IPC/preload; no
  import cycles — `workflowService` may import `chatService` + `nodes/builtin`, but `chatService`
  must NOT import `workflowService` (deletion cleanup lives in chatService as a dumb
  `removeWorkflowIdFromChats`, called BY workflowService — same shape as
  `removeLorebookIdFromChats`).
- **Verification gate per task:** `npm run typecheck && npm run check:deps && npm run test`.
- **Prettier:** no semicolons, single quotes, 2-space indent, no trailing commas.
- **i18n:** every user-facing string in the view goes through `t('key')` with the key added to
  BOTH `src/renderer/src/i18n/locales/en.ts` and `zh.ts` (workflow = 工作流).
- **Never block a turn:** resolution failures (dangling id, invalid stored doc) fall through to
  the next tier with a `log('error', …)` — the built-in default graph is always the safety net.
- **TDD**: failing test first for every behavior task.

## Settled design decisions (grounded 2026-07-01)

1. **File-based storage, NOT a SQL table** — deliberate deviation from spec §12's "workflows
   table" sketch. The spec also says "mirrors presetService", and `db.ts`'s schema comment
   explicitly excludes portable user-shareable artifacts (presets/lorebooks/regex) from SQL.
   Workflows are exactly that (`.rptflow` is the interchange format). Layout mirrors presets
   verbatim: `profiles/{profileId}/workflows/{uuid}.json` + `_selection.json`
   (`{ global?: string|null, worlds?: Record<characterId, workflowId> }`).
2. **Selection tiers:** session override = `chats.workflow_id TEXT` (nullable; null = inherit —
   the `lorebook_ids` pattern, chatService.ts:97-102/171-181). World default keyed by the chat's
   `character_id` (a "world" IS a character card in RPT). Global default in `_selection.json`.
   Resolution: session → world → global → `BUILTIN_WORKFLOW_ID`.
3. **`BUILTIN_WORKFLOW_ID = 'default'`** (matches `DEFAULT_GRAPH.id`). The built-in appears in
   `listWorkflows()` flagged `builtin: true`; it can be exported and cloned, never saved-over or
   deleted (service rejects).
4. **`node_state` re-key** to PK `(chat_id, workflow_id, node_id)`. The 2-column table shipped
   only today (merged this morning, `memory.enabled`-style never-run-live) — no data to
   preserve, so the migration DROPS a legacy-shaped table (detected via
   `PRAGMA table_info` lacking `workflow_id`) before the `CREATE IF NOT EXISTS`. `nodeStateService`
   get/set gain a `workflowId` param; `RunContext` gains `workflowId?: string`; `buildTurnContext`
   threads the resolved id. Clones keep their node ids (state isolation now comes from the
   workflow id, so id reuse across workflows is safe).
5. **Validation gate** (spec §12): structural zod `WorkflowDocSchema` (new
   `src/shared/workflow/docSchema.ts`) THEN graph `validateWorkflow(doc,
   builtinRegistry.descriptors())`. Save/import reject with human-readable reasons; invalid
   workflows are never written.
6. **Import assigns a fresh uuid** and rewrites `doc.id` to it (file name === doc.id invariant).
   Export writes pretty-printed JSON via a save dialog (`.rptflow` filter; plain `.json` accepted
   on import too).
7. **Minimal UI, not the editor:** a `workflow` view registered in `viewRegistry` (the
   `VariablesView` pattern — `profileId` prop, `useChatStore` for the active session): workflow
   list (built-in first) with export/clone/delete, an import button, and three selection dropdowns
   (global default / world default for the active chat's character / session override). React Flow
   canvas, config panels, run-trace = the later editor phase (spec §13).
8. **`resolveWorkflowDoc` returns `{ id, doc }`** so `generate()` gets both the doc to run and the
   id to thread into node-state keying.

---

## File map

| File | Change |
|---|---|
| `src/shared/workflow/docSchema.ts` | NEW — zod structural schema + `parseWorkflowDoc` |
| `src/main/services/workflowService.ts` | NEW — CRUD, selection, resolution, import/export |
| `src/main/services/chatService.ts` | +`getChatWorkflowId`/`setChatWorkflowId`/`removeWorkflowIdFromChats` |
| `src/main/services/db.ts` | +`chats.workflow_id` column; node_state legacy-drop + 3-col PK |
| `src/main/services/nodeStateService.ts` | get/set gain `workflowId` |
| `src/main/services/nodes/types.ts` | `RunContext.workflowId?: string` |
| `src/main/services/nodes/turnContext.ts` | thread `workflowId` |
| `src/main/services/generationService.ts` | `generate()` resolves the workflow |
| `src/main/ipc/workflowIpc.ts` | NEW + register in `src/main/ipc/index.ts` |
| `src/preload/index.ts` + `src/preload/index.d.ts` | workflow API surface |
| `src/renderer/src/components/workspace/WorkflowView.tsx` | NEW minimal view |
| `src/renderer/src/components/workspace/viewRegistry.tsx` | register `workflow` view |
| `src/renderer/src/i18n/locales/{en,zh}.ts` | `workflow.*` keys |
| Tests | `test/workflow/docSchema.test.ts`, `test/workflowService.test.ts`, `test/workflow/nodeState.rekey.test.ts` (extends existing), parity fixture updates, `test/generation/generateResolve.test.ts` |

---

### Task 1: Shared structural schema — `WorkflowDocSchema` + `parseWorkflowDoc`

**Files:**
- Create: `src/shared/workflow/docSchema.ts`
- Test: `test/workflow/docSchema.test.ts` (new)

**Interfaces:**
- Consumes: `WorkflowDoc` from `src/shared/workflow/types.ts` (fields: id, name, version,
  schemaVersion, description?, nodes[], edges[], meta?).
- Produces: `WorkflowDocSchema` (zod) and
  `parseWorkflowDoc(raw: unknown): { ok: true; doc: WorkflowDoc } | { ok: false; error: string }`.
  Task 2's validation gate calls `parseWorkflowDoc` first, then `validateWorkflow`.

- [x] **Step 1: Write the failing test** (`test/workflow/docSchema.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { parseWorkflowDoc } from '../../src/shared/workflow/docSchema'
import { DEFAULT_GRAPH } from '../../src/main/services/nodes/builtin/defaultGraph'

const minimal = {
  id: 'w1',
  name: 'My Flow',
  version: 1,
  schemaVersion: 1,
  nodes: [{ id: 'n1', type: 'input.context', isMainOutput: true }],
  edges: []
}

describe('parseWorkflowDoc', () => {
  it('accepts a minimal structurally-valid doc', () => {
    const r = parseWorkflowDoc(minimal)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.name).toBe('My Flow')
  })

  it('accepts the built-in default graph (round-trip safety)', () => {
    expect(parseWorkflowDoc(JSON.parse(JSON.stringify(DEFAULT_GRAPH))).ok).toBe(true)
  })

  it('accepts optional node fields (config, position, panel)', () => {
    const r = parseWorkflowDoc({
      ...minimal,
      nodes: [
        {
          id: 'n1',
          type: 'text.template',
          config: { template: 'hi' },
          position: { x: 10, y: 20 },
          panel: { show: true, label: 'Plan' },
          isMainOutput: true
        }
      ]
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a wrong schemaVersion with a readable error', () => {
    const r = parseWorkflowDoc({ ...minimal, schemaVersion: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('schemaVersion')
  })

  it('rejects non-object input, missing nodes, and malformed edges', () => {
    expect(parseWorkflowDoc('nope').ok).toBe(false)
    expect(parseWorkflowDoc({ ...minimal, nodes: undefined }).ok).toBe(false)
    expect(
      parseWorkflowDoc({ ...minimal, edges: [{ from: { node: 'a' } }] }).ok
    ).toBe(false)
  })

  it('rejects empty-string ids', () => {
    expect(parseWorkflowDoc({ ...minimal, id: '' }).ok).toBe(false)
    expect(
      parseWorkflowDoc({ ...minimal, nodes: [{ id: '', type: 'x', isMainOutput: true }] }).ok
    ).toBe(false)
  })
})
```

- [x] **Step 2: Run — expect FAIL** (`npx vitest run test/workflow/docSchema.test.ts`) — module
  not found.

- [x] **Step 3: Implement** `src/shared/workflow/docSchema.ts`:

```ts
// Structural (zod) validation for WorkflowDoc — the first half of the spec §12 validation
// gate (the second half is validate.ts's graph validation, which needs node descriptors and
// so runs main-side). Pure: imports only zod + the shared types, like shared/cardZod.ts.
import { z } from 'zod'
import { WorkflowDoc } from './types'

const EdgeEndSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })

export const WorkflowDocSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number(),
  // Bump + migrate (spec §15) when the doc shape changes; only v1 exists today.
  schemaVersion: z.literal(1),
  description: z.string().optional(),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      config: z.record(z.string(), z.unknown()).optional(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      panel: z
        .object({
          show: z.boolean(),
          label: z.string().optional(),
          collapsed: z.boolean().optional()
        })
        .optional(),
      isMainOutput: z.boolean().optional()
    })
  ),
  edges: z.array(z.object({ from: EdgeEndSchema, to: EdgeEndSchema })),
  meta: z.record(z.string(), z.unknown()).optional()
})

/** Structural parse with a single human-readable error string (shown on import/save reject). */
export const parseWorkflowDoc = (
  raw: unknown
): { ok: true; doc: WorkflowDoc } | { ok: false; error: string } => {
  const r = WorkflowDocSchema.safeParse(raw)
  if (r.success) return { ok: true, doc: r.data as WorkflowDoc }
  const error = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  return { ok: false, error }
}
```

- [x] **Step 4: Run — PASS**, then the full gate (check:deps confirms shared purity).
- [x] **Step 5: Commit** — `feat(workflow): structural zod schema for WorkflowDoc`

---

### Task 2: `workflowService` — file CRUD + validation gate + import/export

**Files:**
- Create: `src/main/services/workflowService.ts`
- Test: `test/workflowService.test.ts` (new — REAL fs against the test app dir, the
  `test/regexScope.test.ts` pattern: exercise round-trips under `getAppDir()`, clean up in
  `afterAll`)

**Interfaces:**
- Consumes: `parseWorkflowDoc` (Task 1), `validateWorkflow` (`src/shared/workflow/validate.ts`),
  `builtinRegistry` + `DEFAULT_GRAPH` (`src/main/services/nodes/builtin`), storage helpers
  (`getAppDir`, `ensureDir`, `readJsonSync`, `writeJsonSyncAtomic`, `listFilesSync` from
  `./storageService` — exactly presetService.ts:1-14's imports), `randomUUID` from `crypto`.
- Produces (Task 3/6 rely on these exact names):

```ts
export const BUILTIN_WORKFLOW_ID = 'default'
export interface WorkflowSummary { id: string; name: string; description?: string; builtin?: boolean }
export type WorkflowWriteResult = { ok: true; id: string } | { ok: false; error: string }
export const validateWorkflowDoc: (raw: unknown) => { ok: true; doc: WorkflowDoc } | { ok: false; error: string }
export const listWorkflows: (profileId: string) => WorkflowSummary[]          // builtin first
export const getWorkflowById: (profileId: string, id: string) => WorkflowDoc | null
export const saveWorkflow: (profileId: string, id: string, raw: unknown) => WorkflowWriteResult
export const createWorkflowFromDoc: (profileId: string, raw: unknown) => WorkflowWriteResult
export const cloneWorkflow: (profileId: string, sourceId: string) => WorkflowSummary | null
export const deleteWorkflow: (profileId: string, id: string) => boolean
export const importWorkflowFromFile: (profileId: string, filePath: string) => WorkflowWriteResult
export const exportWorkflowToFile: (profileId: string, id: string, filePath: string) => boolean
```

Key behaviors (each pinned by a test):
- `validateWorkflowDoc` = `parseWorkflowDoc` then `validateWorkflow(doc,
  builtinRegistry.descriptors())`; graph errors joined into the single `error` string
  (`v.errors.map((e) => e.message).join('; ')`).
- Storage: `profiles/{profileId}/workflows/{id}.json`; files starting with `_` skipped by list
  (presetService.ts:78-88 pattern).
- `listWorkflows` returns `{ id: 'default', name: DEFAULT_GRAPH.name, builtin: true }` FIRST,
  then user files sorted by name.
- `getWorkflowById(p, 'default')` returns `DEFAULT_GRAPH`.
- `saveWorkflow`/`deleteWorkflow` on `'default'` → rejected (`{ ok: false, error }` / `false`) —
  the built-in is never mutated (spec §12 clone-to-edit).
- `createWorkflowFromDoc` assigns a fresh uuid, rewrites `doc.id` to it, validates, writes.
- `cloneWorkflow` deep-copies the source (builtin included), fresh uuid + `doc.id`, name suffixed
  `" (copy)"`, node ids KEPT (decision 4).
- `deleteWorkflow` unlinks the file, then calls `clearWorkflowSelections(profileId, id)` (Task 3)
  — in THIS task, stub that call site with a local no-op and a `// wired in Task 3` note is NOT
  allowed (no placeholders): instead Task 2 ships without deletion-cleanup and Task 3's step adds
  the call + its test in the same commit as the cleanup functions. `deleteWorkflow` here only
  unlinks + returns whether the file existed.
- `importWorkflowFromFile` reads JSON (try/catch → `{ ok: false, error: 'invalid JSON: …' }`),
  delegates to `createWorkflowFromDoc`.
- `exportWorkflowToFile` pretty-prints (`JSON.stringify(doc, null, 2)`) with `fs.writeFileSync`;
  returns false when the id doesn't resolve.

- [x] **Step 1: Failing tests** — cover: list has builtin first; create→get round-trip; save
  rejects builtin id; save rejects a structurally-invalid doc AND a graph-invalid doc (e.g. two
  `isMainOutput` nodes → error mentions main-output); clone of builtin gets fresh id + " (copy)"
  name + node ids preserved; delete removes the file, delete builtin returns false;
  import from a temp file (valid → listed; invalid JSON → `{ ok: false }`); export round-trips
  through `importWorkflowFromFile`. Use a throwaway profile id (`wf-test-${randomUUID()}`),
  `afterAll` removes `profiles/{testProfile}` recursively.
- [x] **Step 2: Run — FAIL** (module not found).
- [x] **Step 3: Implement** (mirror presetService.ts structure: dir helpers, `ensureWorkflowsDir`,
  then each export; ~120 lines).
- [x] **Step 4: Run — PASS**, full gate.
- [x] **Step 5: Commit** — `feat(workflow): file-based workflowService with validation gate`

---

### Task 3: Selection tiers + resolution (`chats.workflow_id`, `_selection.json`, `resolveWorkflowDoc`)

**Files:**
- Modify: `src/main/services/db.ts` (add `addColumnIfMissing(db, 'chats', 'workflow_id', 'workflow_id TEXT')` after the `memory_state` line, with a one-line comment citing spec §12)
- Modify: `src/main/services/chatService.ts` (three functions, `lorebook_ids` pattern)
- Modify: `src/main/services/workflowService.ts` (selection + resolution + delete-cleanup)
- Test: extend `test/workflowService.test.ts`

**Interfaces:**
- Consumes: `getChat` + the `lorebook_ids` accessor pattern (chatService.ts:97-102, 171-181,
  200-213).
- Produces:

```ts
// chatService
export const getChatWorkflowId: (profileId: string, chatId: string) => string | null
export const setChatWorkflowId: (profileId: string, chatId: string, id: string | null) => void
export const removeWorkflowIdFromChats: (profileId: string, workflowId: string) => void
// workflowService
export interface WorkflowSelection { global: string | null; worlds: Record<string, string> }
export const getSelection: (profileId: string) => WorkflowSelection
export const setGlobalWorkflow: (profileId: string, id: string | null) => void
export const setWorldWorkflow: (profileId: string, characterId: string, id: string | null) => void
export const resolveWorkflowId: (profileId: string, chatId: string) => string
export const resolveWorkflowDoc: (profileId: string, chatId: string) => { id: string; doc: WorkflowDoc }
```

Key behaviors:
- `_selection.json` in the workflows dir (skipped by list via the `_` prefix rule); missing file →
  `{ global: null, worlds: {} }`.
- `resolveWorkflowId`: try `getChatWorkflowId(chatId)`, then
  `getSelection().worlds[chat.character_id]` (chat via `getChat`; a missing chat skips this tier),
  then `getSelection().global`, else `BUILTIN_WORKFLOW_ID`. A tier whose id no longer resolves via
  `getWorkflowById` **falls through to the next tier** with `log('error', …)` (never-block-a-turn).
- `resolveWorkflowDoc`: `resolveWorkflowId` → `getWorkflowById`; a stored doc that now fails
  `validateWorkflowDoc` (e.g. hand-edited on disk) also falls through — final fallback always
  `{ id: 'default', doc: DEFAULT_GRAPH }`.
- `deleteWorkflow` now also: `removeWorkflowIdFromChats(profileId, id)` + clears matching
  `global`/`worlds` entries from `_selection.json`.
- `setGlobalWorkflow`/`setWorldWorkflow` with `null` clear the entry.

- [x] **Step 1: Failing tests** — resolution precedence (all four tiers), dangling-id
  fall-through at each tier, invalid-doc fall-through, delete clears session + world + global
  references. chatService fns tested through the service against the test DB **only if the DB
  stub allows** — it does NOT (better-sqlite3 is a no-op stub, `test/mocks/better-sqlite3.ts`), so
  the chats-column accessors are exercised via a `vi.mock` of chatService inside the resolution
  tests (mock `getChatWorkflowId`/`getChat` per scenario), and the real SQL paths ride the manual
  e2e like every other chats-column accessor.
- [x] **Step 2: Run — FAIL.**
- [x] **Step 3: Implement** (db.ts one-liner; chatService copies the `lorebook_ids` trio with
  `workflow_id`; workflowService adds selection IO + resolution; delete-cleanup call).
- [x] **Step 4: Run — PASS**, full gate.
- [x] **Step 5: Commit** — `feat(workflow): 4-tier workflow selection + resolution (session/world/global/builtin)`

---

### Task 4: `node_state` re-key by workflow

**Files:**
- Modify: `src/main/services/db.ts` (SCHEMA block + legacy-drop pre-migration)
- Modify: `src/main/services/nodeStateService.ts`
- Modify: `src/main/services/nodes/types.ts` (`workflowId?: string` on RunContext, doc-comment)
- Modify: `src/main/services/nodes/turnContext.ts` (`workflowId` arg, thread into both wirings)
- Test: modify `test/nodeStateService.test.ts` (codec tests unchanged),
  `test/workflow/turnContext.test.ts` (delegation assertions gain the workflow id — deliberate
  characterization update in the same commit)

**Interfaces:**
- Produces: `getNodeState(chatId, workflowId, nodeId)`, `setNodeState(chatId, workflowId,
  nodeId, value)`; `BuildTurnContextArgs.workflowId: string`; `RunContext.workflowId?: string`.
  Task 5 passes the resolved id into `buildTurnContext`.

Key changes:
- db.ts SCHEMA: `node_state` gains `workflow_id TEXT NOT NULL` and
  `PRIMARY KEY (chat_id, workflow_id, node_id)`; comment updated to cite the keying decision.
- db.ts `getDb()`, BEFORE `db.exec(SCHEMA)`:

```ts
  // node_state pre-migration: the 2-column-PK shape shipped 2026-07-01 and never ran live
  // (no selection surface existed), so a legacy table is dropped rather than migrated —
  // CREATE IF NOT EXISTS below rebuilds it keyed (chat_id, workflow_id, node_id).
  const nodeStateCols = db
    .prepare(`PRAGMA table_info(node_state)`)
    .all() as Array<{ name: string }>
  if (nodeStateCols.length > 0 && !nodeStateCols.some((c) => c.name === 'workflow_id')) {
    db.exec('DROP TABLE node_state')
  }
```

- nodeStateService: both SQL statements gain the `workflow_id` predicate/column; signatures as
  above. `control.when` (the only state consumer) reads state through `ctx.get/setNodeState`,
  which turnContext now closes over `(chatId, workflowId)` — the NODE code doesn't change.
- turnContext: `getNodeState: (nodeId) => getNodeState(args.chatId, args.workflowId, nodeId)`
  (and set alike). `RunContext.workflowId = args.workflowId` for trace/debug use.

- [x] **Step 1: Failing tests** — turnContext delegation now asserts
  `getNodeState).toHaveBeenCalledWith('c1', 'wf9', 'n9')` (fixture passes `workflowId: 'wf9'`);
  nodeStateService codec tests unchanged.
- [x] **Step 2: Run — FAIL** (signature mismatch).
- [x] **Step 3: Implement.** All `buildTurnContext` call sites: only `generationService.generate()`
  — give it `workflowId: 'default'` as a literal in THIS task (Task 5 replaces it with the
  resolved id), so the task compiles and parity is untouched.
- [x] **Step 4: Run — PASS**, full gate (parity suites must be untouched — the default graph
  runs under `workflowId: 'default'` and nothing reads node state in it).
- [x] **Step 5: Commit** — `feat(workflow): key node_state by (chat, workflow, node)`

---

### Task 5: `generate()` resolves the active workflow

**Files:**
- Modify: `src/main/services/generationService.ts` (swap `DEFAULT_GRAPH` for the resolver)
- Modify: `test/generation/generateParity.test.ts` + `test/generation/generateParity.abort.test.ts`
  (chatService mock gains `getChatWorkflowId: () => null` — fixture completion, same commit)
- Test: `test/generation/generateResolve.test.ts` (new)

**Interfaces:**
- Consumes: `resolveWorkflowDoc(profileId, chatId): { id, doc }` (Task 3),
  `buildTurnContext({ …, workflowId })` (Task 4).

`generate()` change (generationService.ts:72-83 today):

```ts
    const { id: workflowId, doc } = resolveWorkflowDoc(profileId, chatId)
    const ctx = buildTurnContext({
      profileId,
      chatId,
      userAction,
      workflowId,
      signal: controller.signal,
      onDelta
    })
    const res = await runWorkflow(doc, builtinRegistry, ctx)
```

(`DEFAULT_GRAPH` import moves out of generationService — the resolver owns the fallback.)

- [x] **Step 1: Failing tests.** `generateResolve.test.ts`: `vi.mock` workflowService so
  `resolveWorkflowDoc` returns `{ id: 'custom-1', doc: DEFAULT_GRAPH }` and assert (a) it was
  called with `('profile1', 'chat1')`, (b) generation still completes (reuse the abort-test
  fixture mocks wholesale — copy that file's mock block, swap the scenario for plain `'text'`
  mode), (c) `buildTurnContext` received `workflowId: 'custom-1'` — assert via a
  `vi.mock('../../src/main/services/nodes/turnContext')` spy that wraps the real implementation
  (`importActual`) and records its args. Parity files: add the `getChatWorkflowId` mock line;
  snapshots must NOT change.
- [x] **Step 2: Run — FAIL** (resolveWorkflowDoc not called / workflowId literal).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run — PASS**; full gate; parity snapshots byte-identical.
- [x] **Step 5: Commit** — `feat(workflow): generate() runs the resolved workflow (4-tier fallback)`

---

### Task 6: IPC + preload surface

**Files:**
- Create: `src/main/ipc/workflowIpc.ts`
- Modify: `src/main/ipc/index.ts` (import + `registerWorkflowIpc(ipcMain)`)
- Modify: `src/preload/index.ts` (invoke wrappers) + `src/preload/index.d.ts` (types)
- Test: none new (IPC files carry no logic — every handler is a one-line delegation, the
  presetIpc.ts pattern; the service behavior is already pinned by Tasks 2-3)

**Channels** (presetIpc naming style):

```ts
import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as workflowService from '../services/workflowService'
import * as chatService from '../services/chatService'

export const registerWorkflowIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('list-workflows', (_, profileId) => workflowService.listWorkflows(profileId))
  ipcMain.handle('get-workflow', (_, profileId, id) =>
    workflowService.getWorkflowById(profileId, id)
  )
  ipcMain.handle('save-workflow', (_, profileId, id, doc) =>
    workflowService.saveWorkflow(profileId, id, doc)
  )
  ipcMain.handle('clone-workflow', (_, profileId, sourceId) =>
    workflowService.cloneWorkflow(profileId, sourceId)
  )
  ipcMain.handle('delete-workflow', (_, profileId, id) =>
    workflowService.deleteWorkflow(profileId, id)
  )
  ipcMain.handle('get-workflow-selection', (_, profileId) =>
    workflowService.getSelection(profileId)
  )
  ipcMain.handle('set-global-workflow', (_, profileId, id) =>
    workflowService.setGlobalWorkflow(profileId, id)
  )
  ipcMain.handle('set-world-workflow', (_, profileId, characterId, id) =>
    workflowService.setWorldWorkflow(profileId, characterId, id)
  )
  ipcMain.handle('get-chat-workflow', (_, profileId, chatId) =>
    chatService.getChatWorkflowId(profileId, chatId)
  )
  ipcMain.handle('set-chat-workflow', (_, profileId, chatId, id) =>
    chatService.setChatWorkflowId(profileId, chatId, id)
  )
  ipcMain.handle('resolve-workflow-id', (_, profileId, chatId) =>
    workflowService.resolveWorkflowId(profileId, chatId)
  )
  ipcMain.handle('import-workflow-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'RPT Workflow', extensions: ['rptflow', 'json'] }]
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return workflowService.importWorkflowFromFile(profileId, result.filePaths[0])
    }
    return null
  })
  ipcMain.handle('export-workflow-dialog', async (event, profileId, id, name) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${name || id}.rptflow`,
      filters: [{ name: 'RPT Workflow', extensions: ['rptflow'] }]
    })
    if (result.canceled || !result.filePath) return false
    return workflowService.exportWorkflowToFile(profileId, id, result.filePath)
  })
}
```

Preload wrappers (`src/preload/index.ts`, after the preset block, same style as its lines
94-107): `listWorkflows`, `getWorkflow`, `saveWorkflow`, `cloneWorkflow`, `deleteWorkflow`,
`getWorkflowSelection`, `setGlobalWorkflow`, `setWorldWorkflow`, `getChatWorkflow`,
`setChatWorkflow`, `resolveWorkflowId`, `importWorkflowDialog`, `exportWorkflowDialog` — each a
one-line `ipcRenderer.invoke` mirroring the channel; matching entries in `index.d.ts` (typed
`Promise<…>` using `WorkflowSummary`-shaped inline types; the d.ts file uses loose inline types
throughout — follow its existing style, do not import main types into it if it doesn't already).

- [x] **Step 1: Implement all three files** (no TDD — declarative wiring; the gate is typecheck).
- [x] **Step 2: Full gate** (`typecheck` catches preload/d.ts drift; `check:deps` the boundaries).
- [x] **Step 3: Commit** — `feat(workflow): workflow IPC + preload surface`

---

### Task 7: Minimal `WorkflowView` + i18n

**Files:**
- Create: `src/renderer/src/components/workspace/WorkflowView.tsx`
- Modify: `src/renderer/src/components/workspace/viewRegistry.tsx` (import, wrapper Panel,
  registry entry `workflow` — copy the `VariablesPanel` shape at viewRegistry.tsx:57-60)
- Modify: `src/renderer/src/i18n/locales/en.ts` + `zh.ts`
- Test: none (declarative view; renderer components in this codebase are exercised manually —
  give the owner the manual-test steps below)

**View contents** (the `VariablesView` pattern: `profileId` prop, `useChatStore((s) => s.activeChatId)`
+ `useChatStore((s) => s.chats)` for the active chat's `character_id`, `const api = (): any =>
(window as unknown as { api: any }).api`, `useT()`, toast on failure):

1. **Workflow list** — `api().listWorkflows(profileId)` on mount into local state. Each row:
   name (+ `t('workflow.builtin')` badge when `builtin`), Export button
   (`exportWorkflowDialog(profileId, id, name)`), Clone button (`cloneWorkflow` then reload),
   Delete button (skipped for builtin; `confirm(t('workflow.confirmDelete'))` first, then
   `deleteWorkflow` + reload + selection refresh).
2. **Import button** — `importWorkflowDialog(profileId)`; on `{ ok: false, error }` toast
   `t('workflow.importFailed')` + the error; on success reload.
3. **Three selectors** (each a `<select>` whose options are the workflow list plus a
   `t('workflow.inherit')` empty option):
   - Global default → `getWorkflowSelection` / `setGlobalWorkflow`.
   - World default for the ACTIVE chat's character (hidden when no active chat) →
     `setWorldWorkflow(profileId, characterId, idOrNull)`.
   - Session override for the active chat (hidden when no active chat) →
     `getChatWorkflow` / `setChatWorkflow`.
   Under them, a live line: `t('workflow.resolved')` + `resolveWorkflowId(profileId, chatId)`
   re-fetched after every selection change.

**i18n keys** (add to BOTH locales; zh uses 工作流):
`workflow.heading` (Workflows / 工作流), `workflow.builtin` (Built-in / 内置),
`workflow.import` (Import / 导入), `workflow.export` (Export / 导出),
`workflow.clone` (Clone / 克隆), `workflow.delete` (Delete / 删除),
`workflow.confirmDelete` (Delete this workflow? Selections pointing at it will be cleared. /
删除该工作流？指向它的选择将被清除。), `workflow.importFailed` (Import failed / 导入失败),
`workflow.globalDefault` (Global default / 全局默认), `workflow.worldDefault`
(World default / 世界默认), `workflow.sessionOverride` (Session override / 会话覆盖),
`workflow.inherit` (Inherit / 继承), `workflow.resolved` (Active workflow: / 当前生效：),
`workflow.viewTitle` (Workflows / 工作流).

- [x] **Step 1: Implement view + registry entry + i18n keys** (registry `title` uses the
  `useT()`-driven pattern the file already uses for other entries — check how existing entries
  localize titles and match it).
- [x] **Step 2: Full gate** (typecheck catches store/api drift). Then request a manual check:
  open the workflow view in a workspace panel → clone the built-in → set it as session override →
  send a turn (behaves identically — the clone IS the default graph) → export it → delete it →
  confirm the session override cleared and resolution shows `default`.
- [x] **Step 3: Commit** — `feat(workflow): minimal workflow manager view (list/import/select)`

---

### Task 8: Docs + final gate

- [x] **Step 1:** Full gate. Re-read the plan decisions vs the code; fix drift.
- [x] **Step 2:** Update `docs/superpowers/plans/2026-07-01-node-workflow-phase2b-plan.md` (the
  2b-2 status block gains "Phase 3 persistence BUILT — see 2026-07-01-node-workflow-phase3-persistence.md").
  Check `docs/sdk/README.md`'s "if you touch X update Y" map — workflows are a user resource, not
  card-facing, so no SDK doc change is expected; note that check in the commit message.
- [x] **Step 3:** Mark this plan's checkboxes, commit —
  `docs(workflow): mark phase 3 persistence complete`

---

## Self-review notes

- **Spec §12 coverage:** storage+CRUD (T2), binding/selection + resolution order (T3), clone-to-edit
  (T2 clone + builtin write-protection), companion-file import/export `.rptflow` (T2/T6 dialogs),
  validation gate (T1+T2), node_state separation from the doc (T4). Deviation from the "table"
  sketch is decision 1 (deliberate, argued). Editor UX, run-trace, RPM = later phases.
- **Parity:** T4 keeps `workflowId: 'default'` literal; T5 swaps in the resolver whose empty-state
  answer is the same graph — each step independently parity-checked.
- **Type consistency:** `WorkflowWriteResult` (T2) is what T6's `save-workflow`/`import-workflow-dialog`
  returns and what T7's import toast reads; `resolveWorkflowDoc` `{ id, doc }` (T3) matches T5's
  destructuring; `BuildTurnContextArgs.workflowId: string` (T4) matches T5's call.
