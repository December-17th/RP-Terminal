# Node Workflow Phase 2b-1a: Extract + Characterize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the `generationService.generate()` monolith into a sequence of coarse stage functions under a new `src/main/services/generation/` folder — behavior-preserving, pinned at every step by a parity characterization test that snapshots `{ sendMessages, writtenFloor }`.

**Architecture:** CLAUDE.md's mandate — *extract behind an interface, keep tests green at each step*. Build the characterization harness FIRST (Task 1); it captures the current `generate()` output as a snapshot baseline. Then move one stage at a time into its own file, re-pointing `generate()` at it, keeping the snapshot byte-identical. No engine, no nodes yet (that's 2b-1b). Nothing about generation *behavior* changes.

**Tech Stack:** TypeScript, Vitest (`vi.mock`, `vi.useFakeTimers`). No new runtime dependencies.

**Spec/Plan:** `docs/superpowers/specs/2026-07-01-node-workflow-engine-design.md`; parent plan `docs/superpowers/plans/2026-07-01-node-workflow-phase2b-plan.md` (the extraction map + resolved decisions).

## Global Constraints

- **Parity is the contract.** After every task, the characterization snapshot (`{ sendMessages, writtenFloor }`) MUST be byte-identical to Task 1's baseline. That snapshot IS the test. No intended behavior change in this phase.
- **Stage location:** each stage is its own file under `src/main/services/generation/`; `generationService.ts` imports them and `generate()` becomes the thin sequence. The `GenContext` bundle type lives in `generation/types.ts`.
- **Preserve the parity hazards exactly** (from the parent plan): `workingVars` is passed BY REFERENCE into assembly so build-time `setvar()` mutations persist onto the floor; abort-with-empty returns `null`; the stored `request` is the provider-ordered `sendMessages`; `saveGlobals` runs after fold, before floor build; memory compaction stays post-response/async/fail-open.
- **Module boundaries:** `generation/*` is `src/main` — may import other `src/main/services` + `src/shared`; never `src/renderer`. `check:deps` clean.
- **Verification gate:** `npm run typecheck && npm run check:deps && npm run test` all pass before done.
- **Prettier:** no semicolons, single quotes, 2-space indent, no trailing commas.
- **Commit trailer:** end every commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File structure

- `src/main/services/generation/types.ts` — the `GenContext` bundle interface (Task 2).
- `src/main/services/generation/genContext.ts` — `buildGenContext` (Task 2).
- `src/main/services/generation/memoryRecall.ts` — `recallMemory` (Task 3).
- `src/main/services/generation/assemble.ts` — `matchWorldInfo` + `assemblePrompt` (Task 4).
- `src/main/services/generation/callModel.ts` — `callModel` (Task 5).
- `src/main/services/generation/parseResponse.ts` — `parseResponse` + `computeMetrics` (Task 6).
- `src/main/services/generation/foldState.ts` — `foldState` (Task 6).
- `src/main/services/generation/persistFloor.ts` — `persistFloor` + `compactMemory` (Task 7).
- `src/main/services/generationService.ts` — MODIFIED each task: import the new stage, delete the inlined code.
- `test/generation/generateParity.test.ts` — the characterization harness + snapshot (Task 1).

Reference signatures (read these when writing fixtures/moves):
- `FloorFile` — `src/main/types/chat.ts:25`. `Settings` — `src/main/types/models.ts:67`. `Preset` + `getDefaultPreset()` — `src/main/types/preset.ts:48,62`.
- `getDefaultSettings()` — `src/main/services/settingsService.ts`. `buildPrompt(BuildPromptArgs)` — `promptBuilder.ts:341/139`.
- `streamProvider(settings, messages, params, onDelta, signal?, onUsage?)` — `apiService.ts:16`. `selectMemories(profileId, chatId, scanText, settings) → {block, rows}` — `retrievalService.ts:160`.
- The current `generate()` body being carved up — `generationService.ts:111-449`.

---

### Task 1: Characterization harness + baseline snapshot

**Files:**
- Create: `test/generation/generateParity.test.ts`

**Interfaces:**
- Produces: the parity baseline. No production code changes — this task only adds a test that pins the CURRENT `generate()` output. Every later task re-runs it unchanged.

This is the safety net the whole phase leans on. It mocks every service `generate()` depends on with deterministic fixtures, calls `generate()`, and snapshots `{ sendMessages, writtenFloor }`.

- [ ] **Step 1: Write the characterization test**

Create `test/generation/generateParity.test.ts`. Mock every dependency `generate()` imports (see `generationService.ts:1-53` for the exact import list). Use the REAL pure transforms (`buildPrompt`, `fitToBudget`, `systemToUser`, `mergeConsecutiveRoles`, `orderForProvider`, `parseContent`, `parseMvuCommands`, `applyMvuCommands`, `applyJsonPatch`, `buildFloorMetrics`, `buildScanText`, `matchAcross`, `buildTemplateContext`, `composeAddendum`, `applyEvent`) — do NOT mock those; the snapshot must exercise them. Mock only the data sources, sinks, network, and non-determinism:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
import type { FloorFile } from '../../src/main/types/chat'

// --- deterministic fixtures ------------------------------------------------
const settings = (() => {
  const s = getDefaultSettings()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'test-model' }
  s.agent = { mode: 'off' } // classic path: lore re-matched per turn, no FSM tuning
  s.memory = { ...s.memory, enabled: false } // memory covered separately; keep the base snapshot simple
  return s
})()

const preset = getDefaultPreset()

const card = {
  id: 'card1',
  data: {
    name: 'Testchar',
    description: 'A calm guide.',
    personality: 'patient',
    scenario: 'a quiet room',
    first_mes: 'Hello.',
    extensions: {}
  }
} as any

// two prior floors so history + lastFloor are non-trivial
const floors: FloorFile[] = [
  {
    floor: 0,
    chat_id: 'chat1',
    timestamp: '2020-01-01T00:00:00.000Z',
    user_message: { content: '', timestamp: '2020-01-01T00:00:00.000Z' },
    response: { content: 'Hello.', model: 'test-model', provider: 'openai' },
    events: [],
    variables: { stat_data: { hp: 10 } }
  },
  {
    floor: 1,
    chat_id: 'chat1',
    timestamp: '2020-01-01T00:01:00.000Z',
    user_message: { content: 'look around', timestamp: '2020-01-01T00:01:00.000Z' },
    response: { content: 'You see a door.', model: 'test-model', provider: 'openai' },
    events: [],
    variables: { stat_data: { hp: 10 } }
  }
]

// a canned model response: reasoning + an MVU update + an rpt-event, so fold/parse run for real
const RAW = '<thinking>plan</thinking>You open the door.\n<UpdateVariable>_.set("hp", 9)</UpdateVariable>'

let capturedSend: unknown = null
let capturedFloor: FloorFile | null = null

vi.mock('../../src/main/services/chatService', () => ({
  getChat: () => ({ id: 'chat1', character_id: 'card1', floor_count: 2, lorebook_ids: null }),
  getChatLorebookIds: () => null,
  getChatMode: () => 'explore',
  getCachedWorldInfo: () => null,
  setCachedWorldInfo: () => {},
  appendFloor: (_p: string, _c: string, f: FloorFile) => {
    capturedFloor = f
  },
  truncateFloors: () => {}
}))
vi.mock('../../src/main/services/characterService', () => ({ getCharacter: () => card }))
vi.mock('../../src/main/services/settingsService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSettings: () => settings
}))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => preset,
  getActivePresetId: () => 'preset1'
}))
vi.mock('../../src/main/services/lorebookService', () => ({
  getLorebookById: () => ({ id: 'card1', name: 'lb', entries: [] }),
  matchAcross: () => [] // no lore for the base snapshot (deterministic)
}))
vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: () => floors,
  getFloor: () => floors[floors.length - 1],
  saveFloor: () => {}
}))
vi.mock('../../src/main/services/retrievalService', () => ({
  selectMemories: async () => ({ block: '', rows: [] })
}))
vi.mock('../../src/main/services/compactionService', () => ({ maybeCompact: async () => {} }))
vi.mock('../../src/main/services/memoryEvents', () => ({ notifyMemoryRecalled: () => {} }))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({}),
  saveGlobals: () => {}
}))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))
vi.mock('../../src/main/services/apiService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamProvider: async (_s: unknown, messages: unknown) => {
    capturedSend = messages
    return RAW
  }
}))

import { generate } from '../../src/main/services/generationService'

describe('generate() — parity baseline', () => {
  beforeEach(() => {
    capturedSend = null
    capturedFloor = null
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-06-01T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('produces a stable sendMessages array + written floor', async () => {
    const floor = await generate('profile1', 'chat1', 'open the door')
    expect(floor).not.toBeNull()
    // the two things the parity contract pins:
    expect(capturedSend).toMatchSnapshot('sendMessages')
    expect(capturedFloor).toMatchSnapshot('writtenFloor')
  })
})
```

Notes for the implementer:
- Align each mock's return shape with the real signatures cited in the file-structure section. If a mocked function `generate()` calls is missing, the test throws a clear "not a function" — add it.
- `getDefaultSettings()` may not expose a `memory` key with the exact fields; set `s.memory = { enabled: false }` (cast if needed) — the base snapshot runs with memory OFF.
- Some services are imported with `async (orig) => ({ ...await orig(), override })` so the REAL pure exports (e.g. `apiService.orderForProvider`, `isOpenAiCompatibleProvider`, `templateService.buildTemplateContext`) remain, and only the side-effectful one is overridden.

- [ ] **Step 2: Run the test to generate the baseline snapshot**

Run: `npx vitest run test/generation/generateParity.test.ts -u`
Expected: PASS; writes `test/generation/__snapshots__/generateParity.test.ts.snap` with the `sendMessages` + `writtenFloor` baseline. Open the snapshot and sanity-check it looks like a real assembled prompt + a floor whose `variables.stat_data.hp === 9` (the MVU update applied) and `response.content === RAW`.

- [ ] **Step 3: Run WITHOUT `-u` to confirm it's stable**

Run: `npx vitest run test/generation/generateParity.test.ts`
Expected: PASS against the committed snapshot (no update). This proves the baseline is deterministic.

- [ ] **Step 4: Commit**

```bash
git add test/generation/generateParity.test.ts test/generation/__snapshots__/generateParity.test.ts.snap
git commit -m "test(generation): parity characterization baseline for generate()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Extract `buildGenContext` + `GenContext` type

**Files:**
- Create: `src/main/services/generation/types.ts`
- Create: `src/main/services/generation/genContext.ts`
- Modify: `src/main/services/generationService.ts` (replace lines ~117-167 with a `buildGenContext(...)` call)

**Interfaces:**
- Produces:
  - `interface GenContext { profileId: string; chatId: string; chat: ChatSession; card: RPTerminalCard; settings: Settings; preset: Preset; fsmEnabled: boolean; mode: string; modeConfig: ModeConfig; lorebookIds: string[]; lorebooks: Lorebook[]; floors: FloorFile[]; lastFloor: FloorFile | undefined; workingVars: Record<string, any>; globals: Record<string, unknown>; userName: string; cacheLevel: number; l1Mode: 'partition' | 'diff'; floor0Vars: Record<string, unknown>; frozenVars: Record<string, any>; scanDepth: number; maxRecursion: number; scanText: string }`
  - `buildGenContext(profileId: string, chatId: string, userAction: string): GenContext` — moves generate()'s setup block (generationService.ts:117-167) verbatim; throws the same "Chat session not found" / "Character card not found" errors; still calls `resetWriteLoopGuard(chatId)` (keep that call in `generate()` itself, before `buildGenContext`, OR move it in — keep it in `generate()` to avoid changing the reset timing).

- [ ] **Step 1: Move the setup block**

Cut generationService.ts:124-167 (the block from `const card = getCharacter(...)` through `const scanText = buildScanText(...)`, plus the `getChat` at :117-118) into `buildGenContext`. Populate and return a `GenContext`. Import the required services into `genContext.ts` (the same ones generate() used for this block). In `generate()`, replace the cut block with:
```ts
  resetWriteLoopGuard(chatId)
  const ctx = buildGenContext(profileId, chatId, userAction)
```
then rewrite the rest of `generate()` to read from `ctx.` (e.g. `ctx.card`, `ctx.settings`, `ctx.preset`, `ctx.floors`, `ctx.workingVars`, `ctx.scanText`, `ctx.matchedEntries`… ). Keep every downstream line otherwise identical.

- [ ] **Step 2: Run the parity test (no `-u`)**

Run: `npx vitest run test/generation/generateParity.test.ts`
Expected: PASS — the snapshot is UNCHANGED. If it changed, the extraction altered behavior; diff and fix before continuing. Do NOT run with `-u`.

- [ ] **Step 3: Full gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
```bash
git add src/main/services/generation/types.ts src/main/services/generation/genContext.ts src/main/services/generationService.ts
git commit -m "refactor(generation): extract buildGenContext (parity preserved)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extract `recallMemory`

**Files:**
- Create: `src/main/services/generation/memoryRecall.ts`
- Modify: `src/main/services/generationService.ts` (replace lines ~204-217)

**Interfaces:**
- Consumes: `GenContext`.
- Produces: `recallMemory(ctx: GenContext): Promise<{ block: string; rows: MemoryEntry[] }>` — moves the `selectMemories(...).catch(...)` + the `notifyMemoryRecalled` + the two `log(...)` lines (generationService.ts:204-217) verbatim. Returns the memory result so `generate()` passes `memory.block` into assembly.

- [ ] **Step 1: Move the recall block** into `recallMemory`; in `generate()` replace with `const memory = await recallMemory(ctx)`.
- [ ] **Step 2: Parity test (no `-u`)** — `npx vitest run test/generation/generateParity.test.ts` → snapshot UNCHANGED.
- [ ] **Step 3: Gate + commit** (`git add src/main/services/generation/memoryRecall.ts src/main/services/generationService.ts`; message `refactor(generation): extract recallMemory (parity preserved)` + trailer).

---

### Task 4: Extract `matchWorldInfo` + `assemblePrompt`

**Files:**
- Create: `src/main/services/generation/assemble.ts`
- Modify: `src/main/services/generationService.ts` (replace lines ~176-199 and ~219-331)

**Interfaces:**
- Consumes: `GenContext`, the memory block.
- Produces:
  - `matchWorldInfo(ctx: GenContext): LorebookEntry[]` — the fsm-cached / per-turn `matchAcross` block (176-199) verbatim.
  - `assemblePrompt(ctx: GenContext, matchedEntries: LorebookEntry[], memoryBlock: string): { sendMessages: ChatMessage[]; params: PresetParameters }` — the `buildPrompt(...)` → `fitToBudget` → system→user → `mergeConsecutiveRoles` → maxTokens/params → `orderForProvider` block (219-331), plus the request `log`. **CRITICAL:** `buildPrompt`'s `template` context is built from `ctx.workingVars` BY REFERENCE (do not clone it) so build-time `setvar()` mutations land on the floor — this is the top parity hazard.

- [ ] **Step 1: Move both blocks** into `assemble.ts`; `generate()` calls `const matchedEntries = matchWorldInfo(ctx)` then `const { sendMessages, params } = assemblePrompt(ctx, matchedEntries, memory.block)`.
- [ ] **Step 2: Parity test (no `-u`)** → snapshot UNCHANGED. (This is the highest-risk task — if the snapshot moves, the `workingVars`-by-reference invariant was broken.)
- [ ] **Step 3: Gate + commit** (`git add src/main/services/generation/assemble.ts src/main/services/generationService.ts`; message `refactor(generation): extract matchWorldInfo + assemblePrompt (parity preserved)` + trailer).

---

### Task 5: Extract `callModel`

**Files:**
- Create: `src/main/services/generation/callModel.ts`
- Modify: `src/main/services/generationService.ts` (replace lines ~333-362)

**Interfaces:**
- Consumes: `GenContext`, `sendMessages`, `params`, `onDelta`.
- Produces: `callModel(ctx: GenContext, sendMessages: ChatMessage[], params: PresetParameters, onDelta: DeltaCallback): Promise<{ raw: string; rawUsage: unknown; stopped: boolean } | null>` — moves the controller registration + `streamProvider` + try/catch + the abort/stopped handling (333-362) verbatim. Returns `null` for the abort-with-empty case (the current `return null` at :359) so `generate()` early-returns `null`. Keep `activeControllers`/`abortGeneration` in `generationService.ts` (the controller map is shared with `generateRaw`); pass the map or expose a small setter — SIMPLEST: keep the `AbortController` creation + `activeControllers.set/delete` in `callModel` by importing the shared map from `generationService.ts`? To avoid a circular import, keep the controller map + its set/delete in `generate()` and pass `controller.signal` + `onUsage` into `callModel`, which only does the `streamProvider` call + abort-classification. Adjust the interface to `callModel(ctx, sendMessages, params, onDelta, signal): Promise<{ raw; rawUsage; stopped } | null>`.

- [ ] **Step 1: Move the model-call block** (keeping the `AbortController` lifecycle in `generate()`); `generate()` calls `const r = await callModel(ctx, sendMessages, params, onDelta, controller.signal); if (!r) return null; const { raw, rawUsage, stopped } = r`.
- [ ] **Step 2: Parity test (no `-u`)** → snapshot UNCHANGED.
- [ ] **Step 3: Gate + commit** (message `refactor(generation): extract callModel (parity preserved)` + trailer).

---

### Task 6: Extract `parseResponse` + `computeMetrics` + `foldState`

**Files:**
- Create: `src/main/services/generation/parseResponse.ts`, `src/main/services/generation/foldState.ts`
- Modify: `src/main/services/generationService.ts` (replace lines ~364-422)

**Interfaces:**
- Produces:
  - `parseResponse(raw: string): { cleaned: string; parsed: ReturnType<typeof parseContent>; mvu: ReturnType<typeof parseMvuCommands> }` — `stripThinking` → `parseContent` → `parseMvuCommands` (388-392).
  - `computeMetrics(ctx, sendMessages, raw, rawUsage): FloorMetrics` — the `buildFloorMetrics(...)` call (367-382) incl. its `log`.
  - `foldState(ctx: GenContext, parsed, mvu, raw): Record<string, any>` — applies `applyEvent` for each event + MVU commands/patches onto `ctx.workingVars.stat_data` + the combat cue (396-422) verbatim; returns the mutated `variables` (=`ctx.workingVars`).
- Consumes: `GenContext`.

- [ ] **Step 1: Move the three blocks.** In `generate()`: `const { cleaned, parsed, mvu } = parseResponse(raw)` (note `cleaned` may be unused downstream — keep only what's used), `const turnMetrics = computeMetrics(ctx, sendMessages, raw, rawUsage)`, `const variables = foldState(ctx, parsed, mvu, raw)`. Keep the exact ordering (metrics before fold, matching the current 364→396 order — verify `buildFloorMetrics` doesn't depend on folded vars; it doesn't).
- [ ] **Step 2: Parity test (no `-u`)** → snapshot UNCHANGED (the floor's `variables.stat_data.hp === 9` still holds).
- [ ] **Step 3: Gate + commit** (`git add` the two new files + generationService.ts; message `refactor(generation): extract parseResponse + computeMetrics + foldState (parity preserved)` + trailer).

---

### Task 7: Extract `persistFloor` + `compactMemory`; `generate()` is now a thin sequence

**Files:**
- Create: `src/main/services/generation/persistFloor.ts`
- Modify: `src/main/services/generationService.ts` (replace lines ~424-448)

**Interfaces:**
- Produces:
  - `persistFloor(ctx: GenContext, args: { userAction: string; raw: string; sendMessages: ChatMessage[]; events: RPEvent[]; variables: Record<string, unknown>; metrics: FloorMetrics }): FloorFile` — `saveGlobals(ctx.profileId, ctx.globals)` then build the `FloorFile` (427-439) then `appendFloor` (441); returns the floor.
  - `compactMemory(profileId: string, chatId: string): void` — the `void maybeCompact(...).catch(...)` (445-447). Post-response; fire-and-forget; fail-open.
- Consumes: `GenContext`.

- [ ] **Step 1: Move both blocks.** `generate()`'s tail becomes:
```ts
  const floor = persistFloor(ctx, { userAction, raw, sendMessages, events: parsed.events, variables, metrics: turnMetrics })
  compactMemory(profileId, chatId)
  return floor
```
- [ ] **Step 2: Parity test (no `-u`)** → snapshot UNCHANGED.
- [ ] **Step 3: Full gate + commit.** Run `npm run typecheck && npm run check:deps && npm run test`. `git add src/main/services/generation/persistFloor.ts src/main/services/generationService.ts`; message `refactor(generation): extract persistFloor + compactMemory; generate() is now a thin sequence` + trailer.

---

## Phase 2b-1a exit criteria

- `generate()` is a thin, readable sequence over `buildGenContext → recallMemory → matchWorldInfo → assemblePrompt → callModel → parseResponse/computeMetrics/foldState → persistFloor → compactMemory`, all under `src/main/services/generation/`.
- The parity snapshot is byte-identical to Task 1's baseline (never `-u`'d after Task 1).
- Full gate green; no `src/renderer` import; no generation *behavior* change.

## What 2b-1a excludes (2b-1b)

- Any workflow-engine involvement: the stage functions are plain sequential calls here. 2b-1b wraps them as default-graph nodes, extends `RunContext` with the `GenContext` fields + `nodeStateService`, builds the default graph, and re-plumbs `generate()` to `runWorkflow(...)` — with the SAME parity snapshot proving the graph reproduces this baseline.
