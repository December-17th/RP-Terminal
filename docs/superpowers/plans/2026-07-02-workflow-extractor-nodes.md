# Plan: Workflow Extractor + Variable Components

**Date:** 2026-07-02 · **Status:** PLANNED (owner-approved direction; plan pending Sonnet QA)
**Branch:** `claude/workflow-extractors` (off main `c22d22e`)
**Process:** plan → Sonnet plan-QA → Sonnet implementation → Opus implementation-QA → gate → PR

## 1. Motivation (owner direction, 2026-07-02)

Features like **世界推进** (world advancement: send world-state variables to an AI to evolve the
world in the background) and **剧情推进** (plot advancement: recall memories with a custom query
and plan the next few interactions) must NOT be built into the app case-by-case. Instead, build
the **node components** they need; the features themselves are **workflows** users/creators
assemble — fine-tunable by players, freely varied by content creators.

Concretely the owner asked for:
1. The context broken into **extractor pieces** (not one opaque `input.context` bundle) so a side
   call assembles ONLY what it needs — explicitly to **save tokens** (e.g. world-progress calls
   don't need most lorebook entries).
2. A component to **save custom floor variables** (the persistence surface for such features).
3. **Read/write of session variables** (the per-chat KV store) as well.

Persisted results flow into FUTURE main prompts via the existing `{{getvar}}`/EJS evaluation in
presets/cards — no new injection mechanism. `input.context`/`prompt.assemble` and the default
graph are **untouched** (parity).

### Example assembly this enables (goes in the PR body, not code)

```
世界推进:  ctx ─gen→ control.when (每月一次, via vars.get world.month + changed)
                        │fires
           vars.get(world) ─text→ prompt.messages ←in2─ tool.lorebookSearch(book_filter:"世界观", query wired)
                                      │Messages
                                  llm.sample(stream:false, panel:"世界推进", retries)
                                      │raw
                                  vars.save(path: world.state)      ← post-response, fail-open

剧情推进:  context.history ─transcript→ prompt.messages ←in2─ memory.query(query: wired text)
                                      │
                                  llm.sample(stream:false) → vars.save(path: plot.plan)
```

## 2. New node components (5 nodes + 1 extension)

All in `src/main/services/nodes/builtin/`. Every node below takes `gen: Context` as an input
port. All are side-branch friendly (optional `when: Signal` gate where noted). Register each in
`builtin/index.ts`; the executor/editor pick them up automatically (registry + zod → JSON-schema
config forms).

### 2.1 `vars.get` — Get Variable (`varsNodes.ts`, new file)

- inputs: `gen: Context`
- outputs: `value: Any`, `text: Text` (`''` for null/undefined; strings pass through; other
  values `JSON.stringify(value, null, 2)`)
- configSchema: `z.object({ scope: z.enum(['floor','session']).optional(), path: z.string().min(1) })`
  (scope default `'floor'`)
- Behavior:
  - `floor`: read `getPath(tree, path)` over the **latest floor's `variables` tree** —
    `getAllFloors(gen.profileId, gen.chatId)` last element's `.variables`; when there are no
    floors fall back to `gen.workingVars`, then `{}`. `stat_data` is readable here (read-only).
  - `session`: read over `getChatCardVars(gen.profileId, gen.chatId)`.

### 2.2 `vars.save` — Save Variable (`varsNodes.ts`)

- inputs: `gen: Context`, `value: Any`, `when: Signal`
- outputs: `error: Error` (routed give-ups only; success returns `{ outputs: {} }`)
- configSchema: same as `vars.get`
- Behavior:
  - `inputs.value === undefined` → return `{ outputs: {} }` silently (unwired/pruned upstream).
  - `session`: read KV via `getChatCardVars`, `setPath(kv, path, value)`, write back whole object
    via `setChatCardVars(profileId, chatId, kv)` (that service is whole-object by design).
  - `floor`: **refuse reserved roots** — if the first path segment (split on `.` or `[`) is
    `stat_data` or `delta_data`, `throw new NodeRunFailure('B', <message pointing at mvu.set>, 1,
    'reserved-path')`. stat_data writes must go through `mvu.set` (the MVU write-back bridge with
    delta tracking + runaway-loop guard) — **`applyVariableOps` operates INSIDE stat_data only**
    (verified: `generation/varsWrite.ts` builds `sd = f.variables.stat_data` and patches that), so
    this node has its own write path.
  - `floor` write: `getAllFloors` → last floor (none → return `{ outputs: {} }`) → copy
    `variables` (`{ ...last.variables }`), `setPath(variables, path, value)`, assign back,
    `saveFloor(profileId, chatId, last)`.
  - Rationale recorded in the node's doc comment: custom floor variables **survive MVU
    re-evaluate** (`reevaluateVariables` rebuilds only `stat_data`/`delta_data`, spreading the
    rest of `f.variables`) and are readable from presets/cards via EJS/getvar.

### 2.3 `context.history` — History (`contextNodes.ts`, new file)

- inputs: `gen: Context`
- outputs: `transcript: Text` (lines `User: …` / `Assistant: …`, `\n`-joined),
  `messages: Messages` (role-tagged `ChatMessage[]`)
- configSchema: `z.object({ count: z.number().int().min(1).max(50).optional(), include:
  z.enum(['both','user','assistant']).optional() })` (defaults 4 / both)
- Behavior: over `gen.floors.slice(-count)`; user side = `f.user_message?.content` trimmed;
  assistant side = `stripThinking(f.response?.content)` trimmed (import from
  `../../../parsers/contentParser`); skip empty strings; `include` filters one side out of BOTH
  outputs.

### 2.4 `context.card` — Card Field (`contextNodes.ts`)

- inputs: `gen: Context` · outputs: `text: Text`
- configSchema: `z.object({ field: z.enum(['description','personality','scenario','first_mes',
  'name','all']).optional() })` (default `description`)
- Behavior: read `gen.card.data.<field>` (empty string fallback). `all` = the four narrative
  fields (`name`, `description`, `personality`, `scenario`) that are non-empty, each as
  `[field]\n<content>`, joined by blank lines.

### 2.5 `context.persona` — Persona (`contextNodes.ts`)

- inputs: `gen: Context` · outputs: `name: Text` (= `gen.userName`), `text: Text`
  (= `gen.settings.persona?.description || ''`) · no config.

### 2.6 `memory.query` — Query Memories (append to existing `memoryNodes.ts`)

- inputs: `gen: Context`, `query: Text`, `when: Signal`
- outputs: `block: Text` (labelled blocks joined by blank lines), `rows: Any` (chosen entries)
- configSchema: `z.object({ count: z.number().int().min(1).max(20).optional(), token_budget:
  z.number().int().min(50).max(4000).optional(), collections: z.string().optional() })`
  (defaults 5 / 600 / '' = all enabled; `collections` = comma-separated collection ids;
  count/budget are PER COLLECTION, matching the standard recall's semantics)
- Behavior: blank/whitespace query → `{ block: '', rows: [] }` **without** touching the store.
  Otherwise, for each selected collection from `gen.settings.memory?.collections ?? []`
  (filter: ids in the csv when given, else `c.enabled`):
  `entries = getEntries(gen.profileId, gen.chatId, c.id)` (from `../../memoryStore`), then
  - stream shape → `selectFromEntries(entries, query, count, budget)` + `formatBlock(c.inject.label, chosen)`
  - entity shape → `selectEntitiesInScope(entries, query, count, budget)` + `formatEntityBlock(...)`
  (all four from `../../retrievalService`, already exported). Skip empty blocks.
- Deliberate scope: **keyword ranking only** (no query embedding in v1); custom-prompt
  reranking is achieved by wiring `rows`/`block` into `prompt.messages → llm.sample` — the
  selection prompt is just another authored node (components-not-features).

### 2.7 `tool.lorebookSearch` extension (edit existing `toolNodes.ts`)

Extend `searchConfig` with:
- `book_filter: z.string().optional()` — comma-separated substrings; case-insensitive match
  against `lorebook.name`; empty = all session books. Filter `gen.lorebooks` BEFORE `matchAcross`.
- `max_chars: z.number().int().min(0).max(100000).optional()` — hard cap: `block.slice(0,
  max_chars)` when set and exceeded (0/unset = uncapped).
Update the node's doc comment + the i18n description (token-saving rationale).

## 3. Registration & catalog

- `builtin/index.ts`: import + register `memoryQuery`, `varsGet`, `varsSave`, `contextHistory`,
  `contextCard`, `contextPersona`.
- `test/nodeCatalog.test.ts`: add `'memory.query','vars.get','vars.save','context.history',
  'context.card','context.persona'` to the covered-types list.

## 4. i18n (both locales — REQUIRED, per CLAUDE.md)

Add to `src/renderer/src/i18n/locales/en.ts` + `zh.ts`, following the existing
`workflowEditor.nodeTitle.*` / `workflowEditor.nodeDesc.*` sections:

| key suffix | en title | zh title |
|---|---|---|
| `memory.query` | Query Memories | 记忆查询 |
| `vars.get` | Get Variable | 读取变量 |
| `vars.save` | Save Variable | 保存变量 |
| `context.history` | History | 历史记录 |
| `context.card` | Card Field | 角色卡字段 |
| `context.persona` | Persona | 用户人设 |

Descriptions (one per node, both languages) must state: vars.get scopes; vars.save's
survive-re-evaluate + stat_data-refusal (point to 设置变量/mvu.set); history's
transcript+messages dual output + thinking stripped; card field selector; persona name+description;
memory.query's wired-query (not chat scan) + rerank-by-composition note. Also EXTEND the existing
`workflowEditor.nodeDesc.tool.lorebookSearch` in both locales with the book/size-filter sentence.

## 5. Tests (`test/workflow/extractorNodes.test.ts`, new)

Mock `floorService` (getAllFloors/saveFloor/getFloor), `chatCardVarsService`, `memoryStore`
(getEntries) via `vi.hoisted` + `vi.mock`. Use a plain `gen` fixture with floors (one response
containing `<think>…</think>` to prove stripping), card data, persona, and one enabled stream
collection. **Braces in `beforeEach` bodies** (`beforeEach(() => { m.mockReset() })`) — a returned
mock becomes a vitest teardown hook (known repo gotcha).

Required cases (12):
1. vars.get floor scope reads latest-floor variables (custom key AND `stat_data.hp`).
2. vars.get session scope reads the chat KV.
3. vars.save floor scope writes a custom path and persists via saveFloor; `stat_data` sibling
   untouched.
4. vars.save refuses `stat_data.*` → NodeRunFailure kind B, code `'reserved-path'`, no save.
5. vars.save session scope round-trips through get→setPath→set (whole-object write asserted).
6. vars.save with `value === undefined` → `{ outputs: {} }`, no writes.
7. context.history transcript + messages for last N floors, thinking stripped.
8. context.history `include: 'user'` narrows both outputs.
9. context.card single field; `all` contains labelled blocks.
10. context.persona name + description.
11. memory.query ranks the wired query; **assert exclusivity with `count: 1`** —
    `selectFromEntries` BACKFILLS up to `count` with unmatched (recency) entries, so a 2-entry
    store with default count returns both; this is production recall semantics, not a bug.
12. memory.query blank query → empty outputs, `getEntries` never called.

## 6. Boundaries, gate, non-goals

- No new dependencies; no IPC/preload/renderer changes; `shared/*` untouched except none.
- All new imports are main-internal (floorService, chatCardVarsService, memoryStore,
  retrievalService, contentParser, shared/objectPath) — no cycles expected (none of these import
  generationService); `npm run check:deps` must stay at **0 violations**.
- Gate before declaring done: `npm run typecheck && npm run check:deps && npm run test`
  (baseline: 1212 tests / 158 files green on this branch's base).
- **Non-goals:** decomposing `prompt.assemble` / default-graph changes; vector/hybrid
  `memory.query`; sub-graph packaging; any UI work beyond i18n strings.

## 7. QA checklists

**Plan QA (Sonnet):** verify every claimed API against the real source (signatures, export
names, module paths); check the node specs compose (port types legal per `portCompatible`;
`when` gating semantics); check test list is sufficient + mocks match real module shapes; flag
anything under-specified before implementation.

**Implementation QA (Opus):** diff review for parity risk (default graph untouched), boundary
violations, reserved-path bypasses (e.g. `stat_data` via bracket path `["stat_data"]…` — the
root check must split on `.` AND `[`), i18n completeness (both locales, no hardcoded strings),
test honesty (assertions actually pin the behaviors above), gate re-run.
