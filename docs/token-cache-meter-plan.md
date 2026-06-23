# Token Meter + Cache-Hit History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live floating token/cache-hit overlay and a history/diagnostics workspace view, backed by per-floor metrics (each turn's own numbers + a cumulative snapshot incl. running averages), with optional user-priced cost.

**Architecture:** Metrics are computed in main (`buildFloorMetrics`, pure) right after each successful turn and stored on the floor row (`floors.metrics`, JSON) next to the existing `request`. The renderer already loads floors into `chatStore`, so both surfaces derive live from `chatStore.floors` — no new live IPC. Cost is derived in the renderer from stored token fields + a user-editable price table, so editing a price re-prices history. Source: `docs/token-cache-meter-design.md`.

**Tech Stack:** TypeScript (strict), Electron main + React renderer, zustand stores, Vitest (`vitest run`), better-sqlite3. Pure function modules with named exports.

## Global Constraints

- **Prettier (source of truth):** 2-space indent, single quotes, **no semicolons**, printWidth 100, **no trailing commas**. Match exactly.
- **Services/modules are function modules** (named exports); no classes, no DI.
- **All generation/persistence happens in main.** The renderer is a thin UI over IPC.
- **Shared boundary:** modules under `src/shared` import nothing from `src/main` or `src/renderer`. Main and renderer may both import from `src/shared`.
- **Tests** live in `test/*.test.ts`, run with `npx vitest run test/<file>.test.ts`. `electron` and `better-sqlite3` are aliased to stubs in `vitest.config.ts` — so the **DB layer (floorService/db) is not unit-testable here**; DB-touching wiring is validated by `npm run typecheck` and the manual checklist, matching how existing floor/DB code is verified.
- **Renderer components have no test harness** (no @testing-library); they are validated by `npm run typecheck` + the manual checklist.
- **Must pass before every commit:** `npm run typecheck` (and `npm test` where unit tests exist).
- **Level-0 invariance:** metrics are computed *from* the already-assembled `messages` (post-hoc), so the assembled prompt stays byte-identical to today.

### Refinements vs the spec (intentional)

1. Metric **types live in `src/shared/usageTypes.ts`** (renderer needs `FloorMetrics`); `promptCacheMetrics.ts` re-exports `Usage`.
2. **No `metrics-turn` IPC event / no `usageStore`** — surfaces derive from `chatStore.floors` (the returned floor already carries `metrics`). Backfill keeps its IPC (it writes the DB).

### Shared type shapes (defined in Task 1, referenced everywhere)

```ts
export interface Usage { cacheRead: number; cacheWrite: number; input: number; output: number }
export interface TurnMetric {
  ts: string
  provider: string
  model: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  promptTokens: number
  proxyTokens: number
  proxyPct: number
  outputTokens: number
  usage: Usage | null
}
export interface CumulativeMetric {
  turns: number
  usageTurns: number
  totalPromptTokens: number
  totalProxyTokens: number
  totalOutputTokens: number
  usage: Usage | null
  avgPromptTokens: number
  avgOutputTokens: number
  avgProxyPct: number
  avgCacheHitPct: number
}
export interface FloorMetrics { turn: TurnMetric; cumulative: CumulativeMetric }
export interface ModelRates { input: number; output: number; cacheRead: number; cacheWrite: number }
```

---

### Task 1: Shared types + cost/cache-hit functions

Pure foundation used by every later task.

**Files:**
- Create: `src/shared/usageTypes.ts`
- Create: `src/shared/usageCost.ts`
- Test: `test/usageCost.test.ts`

**Interfaces:**
- Produces: the type shapes above (from `usageTypes.ts`); `costFor(usage, rates) → number | null` and `cacheHitPct(usage) → number` (from `usageCost.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/usageCost.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { costFor, cacheHitPct } from '../src/shared/usageCost'

describe('cacheHitPct', () => {
  it('is cacheRead over total input (read+write+fresh)', () => {
    expect(cacheHitPct({ cacheRead: 90, cacheWrite: 0, input: 10, output: 5 })).toBeCloseTo(90, 5)
  })
  it('is 0 when there is no input', () => {
    expect(cacheHitPct({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 })).toBe(0)
  })
})

describe('costFor', () => {
  const rates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
  it('weights each token class by its per-million rate', () => {
    const c = costFor({ cacheRead: 1_000_000, cacheWrite: 0, input: 0, output: 0 }, rates)
    expect(c).toBeCloseTo(0.5, 6)
    const c2 = costFor({ cacheRead: 0, cacheWrite: 0, input: 1_000_000, output: 1_000_000 }, rates)
    expect(c2).toBeCloseTo(30, 6)
  })
  it('returns null when usage or rates are missing', () => {
    expect(costFor(null, rates)).toBeNull()
    expect(costFor({ cacheRead: 1, cacheWrite: 0, input: 0, output: 0 }, undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/usageCost.test.ts`
Expected: FAIL — module `../src/shared/usageCost` not found.

- [ ] **Step 3: Create the types**

Create `src/shared/usageTypes.ts`:

```ts
/** Provider-neutral cache usage for one turn. */
export interface Usage {
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
}

/** One generated turn's own metrics. */
export interface TurnMetric {
  ts: string
  provider: string
  model: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  promptTokens: number
  proxyTokens: number
  proxyPct: number
  outputTokens: number
  usage: Usage | null
}

/** Running tally over all generated floors up to and including this one. */
export interface CumulativeMetric {
  turns: number
  usageTurns: number
  totalPromptTokens: number
  totalProxyTokens: number
  totalOutputTokens: number
  usage: Usage | null
  avgPromptTokens: number
  avgOutputTokens: number
  avgProxyPct: number
  avgCacheHitPct: number
}

/** Persisted on each generated floor (floors.metrics). */
export interface FloorMetrics {
  turn: TurnMetric
  cumulative: CumulativeMetric
}

/** $ per 1,000,000 tokens, per token class. */
export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
```

- [ ] **Step 4: Create the cost/cache-hit functions**

Create `src/shared/usageCost.ts`:

```ts
import { Usage, ModelRates } from './usageTypes'

/** Real per-turn cache hit: fraction of input tokens served from cache (0 when no input). */
export const cacheHitPct = (u: Usage): number => {
  const denom = u.cacheRead + u.cacheWrite + u.input
  return denom > 0 ? (u.cacheRead / denom) * 100 : 0
}

/** Estimated $ for a turn from its real usage + per-model rates. Null when either is absent. */
export const costFor = (usage: Usage | null, rates: ModelRates | undefined): number | null => {
  if (!usage || !rates) return null
  return (
    (usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite +
      usage.input * rates.input +
      usage.output * rates.output) /
    1e6
  )
}
```

- [ ] **Step 5: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/usageCost.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/usageTypes.ts src/shared/usageCost.ts test/usageCost.test.ts
git commit -m "feat(meter): shared usage types + costFor/cacheHitPct"
```

---

### Task 2: `buildFloorMetrics` (pure)

The per-turn + cumulative metric builder.

**Files:**
- Modify: `src/main/services/promptCacheMetrics.ts`
- Test: `test/buildFloorMetrics.test.ts`

**Interfaces:**
- Consumes: `stablePrefixTokens`, `estimateTokens`, `ChatMessage` (existing in this file); `cacheHitPct` from `../../shared/usageCost`; types from `../../shared/usageTypes`.
- Produces: `buildFloorMetrics(args) → FloorMetrics`; re-exports `Usage` from shared.

- [ ] **Step 1: Write the failing test**

Create `test/buildFloorMetrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildFloorMetrics } from '../src/main/services/promptCacheMetrics'
import { ChatMessage } from '../src/main/services/promptBuilder'

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })
const base = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  cacheLevel: 1 as number,
  l1Mode: 'diff' as const,
  ts: '2026-06-22T00:00:00Z',
  responseText: 'hello there'
}

describe('buildFloorMetrics', () => {
  it('first turn: proxy 0, cumulative turns 1, averages = this turn', () => {
    const r = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'hi')],
      prevMessages: null,
      usage: null,
      prevCumulative: null
    })
    expect(r.turn.proxyTokens).toBe(0)
    expect(r.turn.proxyPct).toBe(0)
    expect(r.cumulative.turns).toBe(1)
    expect(r.cumulative.usageTurns).toBe(0)
    expect(r.cumulative.avgProxyPct).toBe(0)
    // no provider usage → output estimated from responseText
    expect(r.turn.outputTokens).toBeGreaterThan(0)
  })

  it('second turn with a stable prefix raises proxy + aggregates cumulative', () => {
    const t1 = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'hi')],
      prevMessages: null,
      usage: { cacheRead: 0, cacheWrite: 10, input: 5, output: 3 },
      prevCumulative: null
    })
    const t2 = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'hi'), m('assistant', 'r'), m('user', 'next')],
      prevMessages: [m('system', 'AAAA'), m('user', 'hi')],
      usage: { cacheRead: 8, cacheWrite: 0, input: 2, output: 4 },
      prevCumulative: t1.cumulative
    })
    expect(t2.turn.proxyTokens).toBeGreaterThan(0)
    expect(t2.cumulative.turns).toBe(2)
    expect(t2.cumulative.usageTurns).toBe(2)
    expect(t2.cumulative.usage?.cacheRead).toBe(8)
    // avgCacheHitPct only averages over usage turns; t2 hit = 8/(8+0+2) = 80%
    expect(t2.cumulative.avgCacheHitPct).toBeGreaterThan(0)
    expect(t2.cumulative.avgPromptTokens).toBeCloseTo(
      t2.cumulative.totalPromptTokens / 2,
      5
    )
  })

  it('a usage-less turn does not move usageTurns or avgCacheHitPct', () => {
    const withUsage = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA')],
      prevMessages: null,
      usage: { cacheRead: 9, cacheWrite: 0, input: 1, output: 1 },
      prevCumulative: null
    })
    const noUsage = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'x')],
      prevMessages: [m('system', 'AAAA')],
      usage: null,
      prevCumulative: withUsage.cumulative
    })
    expect(noUsage.cumulative.usageTurns).toBe(1)
    expect(noUsage.cumulative.avgCacheHitPct).toBe(withUsage.cumulative.avgCacheHitPct)
    // output falls back to an estimate when usage is null
    expect(noUsage.turn.usage).toBeNull()
    expect(noUsage.turn.outputTokens).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildFloorMetrics.test.ts`
Expected: FAIL — `buildFloorMetrics` is not exported.

- [ ] **Step 3: Implement `buildFloorMetrics`**

In `src/main/services/promptCacheMetrics.ts`, add the imports near the top (after the existing `import { ChatMessage, estimateTokens } from './promptBuilder'` line):

```ts
import { cacheHitPct } from '../../shared/usageCost'
import { TurnMetric, CumulativeMetric, FloorMetrics } from '../../shared/usageTypes'
export type { Usage } from '../../shared/usageTypes'
```

> The file's existing local `interface Usage { … }` may stay — it is structurally identical to the shared one, so values interoperate. (Optional cleanup: delete the local one and rely on the re-export; not required for this task.)

At the end of the file, add:

```ts
const sumUsage = (
  a: { cacheRead: number; cacheWrite: number; input: number; output: number } | null,
  b: { cacheRead: number; cacheWrite: number; input: number; output: number } | null
): { cacheRead: number; cacheWrite: number; input: number; output: number } | null => {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return {
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    input: a.input + b.input,
    output: a.output + b.output
  }
}

/**
 * Build one floor's metrics: its own turn numbers (the deterministic stable-prefix proxy +
 * optional real usage) plus a cumulative snapshot derived from the previous floor's cumulative
 * (so each floor is a self-contained, truncation-safe graph point). Averages are running means.
 */
export const buildFloorMetrics = (args: {
  messages: ChatMessage[]
  prevMessages: ChatMessage[] | null
  usage: { cacheRead: number; cacheWrite: number; input: number; output: number } | null
  provider: string
  model: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  ts: string
  responseText: string
  prevCumulative: CumulativeMetric | null
}): FloorMetrics => {
  const proxy = args.prevMessages
    ? stablePrefixTokens(args.prevMessages, args.messages)
    : { messages: 0, tokens: 0 }
  const promptTokens = args.messages.reduce((n, msg) => n + estimateTokens(msg.content), 0)
  const outputTokens = args.usage ? args.usage.output : estimateTokens(args.responseText)
  const turn: TurnMetric = {
    ts: args.ts,
    provider: args.provider,
    model: args.model,
    cacheLevel: args.cacheLevel,
    l1Mode: args.l1Mode,
    promptTokens,
    proxyTokens: proxy.tokens,
    proxyPct: promptTokens > 0 ? (proxy.tokens / promptTokens) * 100 : 0,
    outputTokens,
    usage: args.usage
  }

  const c = args.prevCumulative
  const prevTurns = c?.turns ?? 0
  const prevUsageTurns = c?.usageTurns ?? 0
  const turns = prevTurns + 1
  const hadUsage = !!args.usage
  const usageTurns = prevUsageTurns + (hadUsage ? 1 : 0)
  const totalPromptTokens = (c?.totalPromptTokens ?? 0) + promptTokens
  const totalProxyTokens = (c?.totalProxyTokens ?? 0) + proxy.tokens
  const totalOutputTokens = (c?.totalOutputTokens ?? 0) + outputTokens
  const avgProxyPct = ((c?.avgProxyPct ?? 0) * prevTurns + turn.proxyPct) / turns
  const avgCacheHitPct = hadUsage
    ? ((c?.avgCacheHitPct ?? 0) * prevUsageTurns + cacheHitPct(args.usage!)) / usageTurns
    : (c?.avgCacheHitPct ?? 0)

  const cumulative: CumulativeMetric = {
    turns,
    usageTurns,
    totalPromptTokens,
    totalProxyTokens,
    totalOutputTokens,
    usage: sumUsage(c?.usage ?? null, args.usage),
    avgPromptTokens: totalPromptTokens / turns,
    avgOutputTokens: totalOutputTokens / turns,
    avgProxyPct,
    avgCacheHitPct
  }
  return { turn, cumulative }
}
```

- [ ] **Step 4: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/buildFloorMetrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/promptCacheMetrics.ts test/buildFloorMetrics.test.ts
git commit -m "feat(meter): buildFloorMetrics (turn + cumulative snapshot)"
```

---

### Task 3: Persist `metrics` on the floor row

Add the storage column + (de)serialization. DB-layer wiring → validated by typecheck (the DB is stubbed under vitest).

**Files:**
- Modify: `src/main/services/db.ts:127` (migration block)
- Modify: `src/main/types/chat.ts` (`FloorFile`)
- Modify: `src/main/services/floorService.ts` (`FloorRow`, `rowToFloor`, `saveFloor`)

**Interfaces:**
- Consumes: `FloorMetrics` from `../../shared/usageTypes`.
- Produces: `FloorFile.metrics?: FloorMetrics`, persisted/loaded like `request`.

- [ ] **Step 1: Add the migration**

In `src/main/services/db.ts`, immediately after the `addColumnIfMissing(db, 'floors', 'request', 'request TEXT')` line, add:

```ts
  // Per-turn cache/token metrics (turn + cumulative snapshot) — see token-cache-meter-design.md.
  addColumnIfMissing(db, 'floors', 'metrics', 'metrics TEXT')
```

- [ ] **Step 2: Extend the `FloorFile` type**

In `src/main/types/chat.ts`, add the import at the top:

```ts
import { FloorMetrics } from '../../shared/usageTypes'
```

Then add the field to `FloorFile` (after the `request?` field):

```ts
  /** Cache/token metrics for this floor (this turn's numbers + a cumulative snapshot).
   * Absent on greeting/legacy floors that never went through a metered generation. */
  metrics?: FloorMetrics
```

- [ ] **Step 3: (De)serialize in `floorService`**

In `src/main/services/floorService.ts`:

(a) Add `metrics: string | null` to the `FloorRow` interface (after `request: string | null`).

(b) In `rowToFloor`, add to the returned object (after the `request:` line):

```ts
    metrics: r.metrics ? safeJson(r.metrics, undefined) : undefined
```

(c) In `saveFloor`, add `metrics` to the INSERT column list and the `VALUES` placeholders, and to the `ON CONFLICT … DO UPDATE SET` clause. The column list becomes:

```ts
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, user_timestamp, response_content,
         response_model, response_provider, swipes, swipe_id, events, variables, request, metrics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, floor) DO UPDATE SET
         timestamp = excluded.timestamp,
         user_content = excluded.user_content,
         user_timestamp = excluded.user_timestamp,
         response_content = excluded.response_content,
         response_model = excluded.response_model,
         response_provider = excluded.response_provider,
         swipes = excluded.swipes,
         swipe_id = excluded.swipe_id,
         events = excluded.events,
         variables = excluded.variables,
         request = excluded.request,
         metrics = excluded.metrics`
```

(d) In the `.run(...)` bind list, add a final argument after the `request` bind:

```ts
      floor.request ? JSON.stringify(floor.request) : null,
      floor.metrics ? JSON.stringify(floor.metrics) : null
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/db.ts src/main/types/chat.ts src/main/services/floorService.ts
git commit -m "feat(meter): persist floors.metrics column (turn + cumulative)"
```

---

### Task 4: Compute + attach metrics in generation; retire the in-memory accumulator

Wire `buildFloorMetrics` into `generate`, attach to the floor, and remove the superseded `cacheMetricsService`. Validated by typecheck + the full suite (level-0 prompt unchanged).

**Files:**
- Modify: `src/main/services/generationService.ts`
- Delete: `src/main/services/cacheMetricsService.ts`, `test/cacheMetricsService.test.ts`

**Interfaces:**
- Consumes: `buildFloorMetrics`, `normalizeUsage` from `./promptCacheMetrics`.

- [ ] **Step 1: Swap the imports**

In `src/main/services/generationService.ts`, replace:

```ts
import { normalizeUsage } from './promptCacheMetrics'
import { recordTurn, resetChat } from './cacheMetricsService'
```

with:

```ts
import { normalizeUsage, buildFloorMetrics } from './promptCacheMetrics'
```

- [ ] **Step 2: Compute metrics and attach to the floor**

In `generate`, replace the existing line:

```ts
  // Cache harness: record this turn's assembled prompt (what was sent) + provider usage.
  recordTurn(chatId, messages, normalizeUsage(settings.api.provider, rawUsage))
```

with:

```ts
  // Cache meter: compute this turn's metrics (proxy + provider usage) + the cumulative snapshot,
  // chaining from the previous floor (its stored `request` is the proxy anchor; its cumulative is
  // the prior tally). Persisted on the floor below; both UI surfaces derive from it.
  const turnMetrics = buildFloorMetrics({
    messages,
    prevMessages: (lastFloor?.request as ChatMessage[] | undefined) ?? null,
    usage: normalizeUsage(settings.api.provider, rawUsage),
    provider: settings.api.provider,
    model: settings.api.model,
    cacheLevel,
    l1Mode,
    ts: new Date().toISOString(),
    responseText: raw,
    prevCumulative: lastFloor?.metrics?.cumulative ?? null
  })
  log(
    'info',
    `cache — stable prefix ${turnMetrics.turn.proxyTokens}/${turnMetrics.turn.promptTokens} tok (${Math.round(turnMetrics.turn.proxyPct)}%)`
  )
```

Then add `metrics: turnMetrics` to the `floor` object literal (after the `variables` field):

```ts
    events: parsed.events,
    variables,
    metrics: turnMetrics
  }
```

- [ ] **Step 3: Remove the now-dead `resetChat` calls**

In `regenerate`, delete the line `  resetChat(chatId)` (right after `truncateFloors(profileId, chatId, lastIndex)`).
In `generateSwipe`, delete the line `  resetChat(chatId)` (right after its `truncateFloors(...)`).

> After truncation the reloaded `lastFloor` is the floor before the regenerated one, whose cumulative is already correct — so the proxy/cumulative chain self-heals with no reset.

- [ ] **Step 4: Delete the superseded service + its test**

```bash
git rm src/main/services/cacheMetricsService.ts test/cacheMetricsService.test.ts
```

- [ ] **Step 5: Run typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck clean; suite green (the removed `cacheMetricsService` test is gone; no other test imported it). The assembled prompt is unchanged (metrics are post-hoc).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(meter): attach per-floor metrics from generation; retire cacheMetricsService"
```

---

### Task 5: Backfill / recompute service + IPC + preload bridge

A pure floor-chain recompute (testable) + DB/IPC wrappers for the "Backfill proxy" button.

**Files:**
- Create: `src/main/services/usageMetricsService.ts`
- Test: `test/usageMetricsService.test.ts`
- Modify: `src/main/ipc/chatIpc.ts` (handler)
- Modify: `src/preload/index.ts` (bridge) + `src/preload/index.d.ts` (type)

**Interfaces:**
- Consumes: `buildFloorMetrics` from `./promptCacheMetrics`; `FloorFile` from `../types/chat`; `getAllFloors`, `saveFloor` from `./floorService`.
- Produces: `recomputeMetricsForFloors(floors) → FloorFile[]` (pure); `backfillUsageMetrics(profileId, chatId) → FloorFile[]` (DB); IPC `backfill-usage-metrics`; `window.api.backfillUsageMetrics(profileId, chatId)`.

- [ ] **Step 1: Write the failing test**

Create `test/usageMetricsService.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { recomputeMetricsForFloors } from '../src/main/services/usageMetricsService'
import { FloorFile } from '../src/main/types/chat'

const floor = (n: number, req: { role: string; content: string }[] | undefined): FloorFile => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: `u${n}`, timestamp: 't' },
  response: { content: `resp ${n}`, model: 'm', provider: 'anthropic' },
  events: [],
  variables: {},
  request: req
})

describe('recomputeMetricsForFloors', () => {
  it('recomputes proxy + cumulative across a request-bearing chain, usage stays null', () => {
    const floors = [
      floor(0, [{ role: 'system', content: 'AAAA' }, { role: 'user', content: 'hi' }]),
      floor(1, [
        { role: 'system', content: 'AAAA' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'r' },
        { role: 'user', content: 'next' }
      ])
    ]
    const out = recomputeMetricsForFloors(floors)
    expect(out[0].metrics?.turn.proxyTokens).toBe(0) // first floor has no previous
    expect(out[0].metrics?.cumulative.turns).toBe(1)
    expect(out[1].metrics?.turn.proxyTokens).toBeGreaterThan(0)
    expect(out[1].metrics?.cumulative.turns).toBe(2)
    expect(out[1].metrics?.turn.usage).toBeNull()
    expect(out[1].metrics?.cumulative.usage).toBeNull()
  })

  it('leaves floors without a stored request untouched (no metrics)', () => {
    const out = recomputeMetricsForFloors([floor(0, undefined)])
    expect(out[0].metrics).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/usageMetricsService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/main/services/usageMetricsService.ts`:

```ts
import { FloorFile } from '../types/chat'
import { buildFloorMetrics } from './promptCacheMetrics'
import { ChatMessage } from './promptBuilder'
import { CumulativeMetric } from '../../shared/usageTypes'
import { getAllFloors, saveFloor } from './floorService'
import { log } from './logService'

/**
 * Pure: recompute the deterministic proxy + cumulative for a floor chain from each floor's
 * stored `request`. Real provider usage is unavailable retroactively, so `usage` stays null
 * (the proxy is still meaningful). Floors that never captured a `request` are left untouched.
 */
export const recomputeMetricsForFloors = (floors: FloorFile[]): FloorFile[] => {
  let prevMessages: ChatMessage[] | null = null
  let prevCumulative: CumulativeMetric | null = null
  return floors.map((f) => {
    if (!f.request) return f
    const metrics = buildFloorMetrics({
      messages: f.request as ChatMessage[],
      prevMessages,
      usage: null,
      provider: f.response.provider || '',
      model: f.response.model || '',
      cacheLevel: f.metrics?.turn.cacheLevel ?? 0,
      l1Mode: f.metrics?.turn.l1Mode ?? 'partition',
      ts: f.timestamp,
      responseText: f.response.content,
      prevCumulative
    })
    prevMessages = f.request as ChatMessage[]
    prevCumulative = metrics.cumulative
    return { ...f, metrics }
  })
}

/**
 * Forward-only backfill: recompute the deterministic proxy metrics for any floor missing them
 * and persist. Real usage isn't recoverable, so backfilled turns show the estimate (proxy) only.
 */
export const backfillUsageMetrics = (profileId: string, chatId: string): FloorFile[] => {
  const floors = getAllFloors(profileId, chatId)
  const recomputed = recomputeMetricsForFloors(floors)
  for (const f of recomputed) if (f.request) saveFloor(profileId, chatId, f)
  log('info', `cache meter — backfilled proxy metrics for ${recomputed.length} floor(s)`)
  return recomputed
}
```

- [ ] **Step 4: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/usageMetricsService.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the IPC handler**

In `src/main/ipc/chatIpc.ts`, add the import after the existing `import * as generationService …` lines:

```ts
import * as usageMetricsService from '../services/usageMetricsService'
```

Then register a handler inside `registerChatIpc` (e.g. after the `get-floors` handler):

```ts
  ipcMain.handle('backfill-usage-metrics', (_, profileId, chatId) =>
    usageMetricsService.backfillUsageMetrics(profileId, chatId)
  )
```

- [ ] **Step 6: Expose it in preload**

In `src/preload/index.ts`, add to the `api` object (e.g. after the `getFloors` entry):

```ts
  backfillUsageMetrics: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('backfill-usage-metrics', profileId, chatId),
```

In `src/preload/index.d.ts`, add the matching signature to the `api` interface (return type `Promise<unknown[]>` is sufficient for the renderer, which reloads floors after):

```ts
    backfillUsageMetrics: (profileId: string, chatId: string) => Promise<unknown[]>
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/services/usageMetricsService.ts test/usageMetricsService.test.ts src/main/ipc/chatIpc.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(meter): proxy backfill service + IPC bridge"
```

---

### Task 6: Settings — `ui.usage_meter`, `ui.usage_view`, `pricing`

Add config to the schema, defaults, and normalize; mirror the renderer type.

**Files:**
- Modify: `src/main/types/models.ts` (`Settings`)
- Modify: `src/main/services/settingsService.ts` (`getDefaultSettings`, `normalize`)
- Modify: `src/renderer/src/stores/settingsStore.ts` (renderer `Settings`)
- Test: `test/settingsService.test.ts`

**Interfaces:**
- Produces: `Settings['ui']['usage_meter']`, `Settings['ui']['usage_view']`, `Settings['pricing']` with defaults + merge.

- [ ] **Step 1: Write the failing test**

Append to `test/settingsService.test.ts` (add the import line if `normalize`/`getDefaultSettings` aren't already imported there):

```ts
import { describe, it, expect } from 'vitest'
import { normalize, getDefaultSettings } from '../src/main/services/settingsService'

describe('settings usage-meter + pricing', () => {
  it('defaults: overlay off, empty fields/columns, empty pricing', () => {
    const s = getDefaultSettings()
    expect(s.ui.usage_meter.enabled).toBe(false)
    expect(s.ui.usage_meter.x).toBeNull()
    expect(Array.isArray(s.ui.usage_meter.fields)).toBe(true)
    expect(s.ui.usage_view.columns.length).toBeGreaterThan(0)
    expect(s.pricing).toEqual({})
  })

  it('merges a stored usage_meter without wiping unset sub-fields', () => {
    const s = normalize({ ui: { usage_meter: { enabled: true, x: 12 } } } as any)
    expect(s.ui.usage_meter.enabled).toBe(true)
    expect(s.ui.usage_meter.x).toBe(12)
    expect(s.ui.usage_meter.collapsed).toBe(false) // default preserved
    expect(Array.isArray(s.ui.usage_meter.fields)).toBe(true)
  })

  it('keeps stored pricing rows', () => {
    const s = normalize({ pricing: { 'm1': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } } as any)
    expect(s.pricing.m1.output).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settingsService.test.ts`
Expected: FAIL — `usage_meter`/`pricing` are undefined.

- [ ] **Step 3: Extend the `Settings` type**

In `src/main/types/models.ts`, add the import at the top:

```ts
import type { ModelRates } from '../../shared/usageTypes'
```

Add fields to the `ui` block (after `show_fps: boolean`):

```ts
    /** Floating token/cache meter overlay. */
    usage_meter: {
      enabled: boolean
      /** Persisted drag position (px from top-left); null = default bottom-left. */
      x: number | null
      y: number | null
      collapsed: boolean
      /** Which metric rows the overlay shows (keys from the meter field catalog). */
      fields: string[]
    }
    /** History/diagnostics 'usage' workspace view config. */
    usage_view: {
      columns: string[]
      charts: string[]
    }
```

Add a new top-level field after the `cache` block (before the closing `}` of `Settings`):

```ts
  /** Optional per-model token prices ($ / 1M tokens). Empty ⇒ tokens-only (no cost shown). */
  pricing: Record<string, ModelRates>
```

- [ ] **Step 4: Add defaults**

In `src/main/services/settingsService.ts` `getDefaultSettings()`, replace the `ui: { … }` block with:

```ts
  ui: {
    theme: 'dark',
    font_size: 16,
    sidebar_collapsed: false,
    history_strip_visible: true,
    show_fps: false,
    usage_meter: {
      enabled: false,
      x: null,
      y: null,
      collapsed: false,
      fields: ['proxyPct', 'cacheHitPct', 'promptTokens', 'avgCacheHitPct']
    },
    usage_view: {
      columns: ['promptTokens', 'proxyPct', 'cacheHitPct', 'cacheRead', 'cacheWrite', 'outputTokens'],
      charts: ['cachePct']
    }
  },
```

And add a `pricing` default after the `cache: { … }` block:

```ts
  ,
  pricing: {}
```

> (The `cache` block is the last field today; add the leading comma + `pricing: {}` so the object stays valid.)

- [ ] **Step 5: Normalize**

In `src/main/services/settingsService.ts` `normalize`, replace `const ui = { ...d.ui, ...(stored.ui || {}) }` with a nested merge:

```ts
  const storedUi = (stored.ui || {}) as Partial<Settings['ui']>
  const ui = {
    ...d.ui,
    ...storedUi,
    usage_meter: { ...d.ui.usage_meter, ...(storedUi.usage_meter || {}) },
    usage_view: { ...d.ui.usage_view, ...(storedUi.usage_view || {}) }
  }
```

After the `const cache = …` line, add:

```ts
  const pricing = { ...d.pricing, ...(stored.pricing || {}) }
```

Add `pricing` to the returned object's field list (after `cache`):

```ts
    workspace,
    cache,
    pricing
  }
```

- [ ] **Step 6: Mirror the renderer type**

In `src/renderer/src/stores/settingsStore.ts`, add to the `ui` block (after `show_fps: boolean`):

```ts
    usage_meter: {
      enabled: boolean
      x: number | null
      y: number | null
      collapsed: boolean
      fields: string[]
    }
    usage_view: {
      columns: string[]
      charts: string[]
    }
```

And add a top-level field to the renderer `Settings` interface (after `workspace?`):

```ts
  pricing?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
```

- [ ] **Step 7: Run typecheck + test**

Run: `npm run typecheck && npx vitest run test/settingsService.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/types/models.ts src/main/services/settingsService.ts src/renderer/src/stores/settingsStore.ts test/settingsService.test.ts
git commit -m "feat(meter): settings — usage_meter, usage_view, pricing"
```

---

### Task 7: Floating overlay + Settings toggle

The live meter: derives from `chatStore.floors`, draggable with persisted position, gear field-checklist, collapse.

**Files:**
- Modify: `src/renderer/src/stores/chatStore.ts` (`Floor.metrics`)
- Create: `src/renderer/src/components/UsageOverlay.tsx`
- Modify: `src/renderer/src/App.tsx` (mount)
- Modify: `src/renderer/src/components/SettingsPanel.tsx` (enable toggle)

**Interfaces:**
- Consumes: `useChatStore().floors[*].metrics` (`FloorMetrics`), `useSettingsStore()`, `costFor`/`cacheHitPct` from `../../../shared/usageCost`.

- [ ] **Step 1: Add `metrics` to the renderer `Floor` type**

In `src/renderer/src/stores/chatStore.ts`, add the import at the top:

```ts
import type { FloorMetrics } from '../../../shared/usageTypes'
```

Add the field to the `Floor` interface (after `swipe_id?`):

```ts
  /** Cache/token metrics for this floor (present once it has been through a metered turn). */
  metrics?: FloorMetrics
```

- [ ] **Step 2: Create the overlay**

Create `src/renderer/src/components/UsageOverlay.tsx`:

```tsx
import React, { useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { FloorMetrics } from '../../../shared/usageTypes'
import { costFor } from '../../../shared/usageCost'

/** The metric rows the overlay can show, in display order. `group` splits This-turn vs Session. */
const FIELD_CATALOG: { key: string; label: string; group: 'turn' | 'session' }[] = [
  { key: 'promptTokens', label: 'prompt tok', group: 'turn' },
  { key: 'outputTokens', label: 'output tok', group: 'turn' },
  { key: 'proxyPct', label: 'est cache', group: 'turn' },
  { key: 'cacheHitPct', label: 'actual cache', group: 'turn' },
  { key: 'cacheRead', label: 'cache read', group: 'turn' },
  { key: 'cacheWrite', label: 'cache write', group: 'turn' },
  { key: 'cost', label: 'turn $', group: 'turn' },
  { key: 'turns', label: 'turns', group: 'session' },
  { key: 'avgProxyPct', label: 'avg est', group: 'session' },
  { key: 'avgCacheHitPct', label: 'avg cache', group: 'session' },
  { key: 'avgPromptTokens', label: 'avg prompt', group: 'session' },
  { key: 'sessionCost', label: 'session $', group: 'session' }
]

const pct = (n: number): string => `${Math.round(n)}%`
const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)

/** Resolve one field's display value from the latest floor metrics + pricing (null = hide row). */
const valueFor = (
  key: string,
  m: FloorMetrics,
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
): string | null => {
  const t = m.turn
  const c = m.cumulative
  switch (key) {
    case 'promptTokens':
      return tok(t.promptTokens)
    case 'outputTokens':
      return tok(t.outputTokens)
    case 'proxyPct':
      return pct(t.proxyPct)
    case 'cacheHitPct':
      return t.usage ? pct((t.usage.cacheRead / Math.max(1, t.usage.cacheRead + t.usage.cacheWrite + t.usage.input)) * 100) : '—'
    case 'cacheRead':
      return t.usage ? tok(t.usage.cacheRead) : '—'
    case 'cacheWrite':
      return t.usage ? tok(t.usage.cacheWrite) : '—'
    case 'cost': {
      const $ = costFor(t.usage, rates)
      return $ == null ? null : `$${$.toFixed(4)}`
    }
    case 'turns':
      return `${c.turns}`
    case 'avgProxyPct':
      return pct(c.avgProxyPct)
    case 'avgCacheHitPct':
      return c.usageTurns ? pct(c.avgCacheHitPct) : '—'
    case 'avgPromptTokens':
      return tok(c.avgPromptTokens)
    case 'sessionCost': {
      const $ = costFor(c.usage, rates)
      return $ == null ? null : `$${$.toFixed(2)}`
    }
    default:
      return null
  }
}

export const UsageOverlay: React.FC<{ profileId: string }> = ({ profileId }) => {
  const floors = useChatStore((s) => s.floors)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [gearOpen, setGearOpen] = useState(false)
  const dragState = useRef<{ dx: number; dy: number } | null>(null)

  if (!settings) return null
  const meter = settings.ui.usage_meter
  const latest = [...floors].reverse().find((f) => f.metrics)?.metrics ?? null
  const rates = latest ? settings.pricing?.[latest.turn.model] : undefined
  const enabledFields = new Set(meter.fields)

  const persist = (patch: Partial<typeof meter>): void => {
    updateSettings(profileId, { ui: { ...settings.ui, usage_meter: { ...meter, ...patch } } })
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragState.current = { dx: e.clientX - (meter.x ?? 16), dy: e.clientY - (meter.y ?? window.innerHeight - 160) }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragState.current) return
    persist({ x: e.clientX - dragState.current.dx, y: e.clientY - dragState.current.dy })
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    dragState.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  const pos: React.CSSProperties =
    meter.x != null && meter.y != null
      ? { left: meter.x, top: meter.y }
      : { left: 16, bottom: 16 }

  const rows = FIELD_CATALOG.filter((f) => enabledFields.has(f.key)).map((f) => ({
    ...f,
    value: latest ? valueFor(f.key, latest, rates) : '—'
  }))

  return (
    <div className="usage-overlay" style={{ position: 'fixed', zIndex: 60, ...pos }}>
      <div
        className="usage-overlay-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: 'move', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontWeight: 600 }}>usage</span>
        <button title="Fields" onClick={() => setGearOpen((v) => !v)}>⚙</button>
        <button title={meter.collapsed ? 'Expand' : 'Collapse'} onClick={() => persist({ collapsed: !meter.collapsed })}>
          {meter.collapsed ? '▣' : '▢'}
        </button>
        <button title="Hide (Settings to re-enable)" onClick={() => persist({ enabled: false })}>✕</button>
      </div>

      {gearOpen && (
        <div className="usage-overlay-gear">
          {FIELD_CATALOG.map((f) => (
            <label key={f.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={enabledFields.has(f.key)}
                onChange={(e) => {
                  const next = new Set(enabledFields)
                  e.target.checked ? next.add(f.key) : next.delete(f.key)
                  persist({ fields: FIELD_CATALOG.map((c) => c.key).filter((k) => next.has(k)) })
                }}
              />
              {f.label}
            </label>
          ))}
        </div>
      )}

      {!meter.collapsed && !gearOpen && (
        <div className="usage-overlay-body">
          {!latest && <div style={{ opacity: 0.6 }}>no turns yet</div>}
          {rows
            .filter((r) => r.value != null)
            .map((r) => (
              <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ opacity: 0.7 }}>{r.label}</span>
                <span>{r.value}</span>
              </div>
            ))}
        </div>
      )}

      {meter.collapsed && latest && (
        <div className="usage-overlay-chip">
          {pct(latest.turn.proxyPct)} · {tok(latest.turn.promptTokens)}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Mount it in App**

In `src/renderer/src/App.tsx`, add the import (after the `FpsOverlay` import):

```ts
import { UsageOverlay } from './components/UsageOverlay'
```

Add the mount right after the existing `{settings?.ui?.show_fps && <FpsOverlay />}` line:

```tsx
      {settings?.ui?.usage_meter?.enabled && <UsageOverlay profileId={activeProfile.id} />}
```

- [ ] **Step 4: Add the Settings toggle**

In `src/renderer/src/components/SettingsPanel.tsx`, add a toggle right after the existing "Show FPS counter" `<label>…</label>` block:

```tsx
            <label
              className="entry-toggles"
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}
            >
              <input
                type="checkbox"
                checked={settings.ui?.usage_meter?.enabled ?? false}
                onChange={(e) =>
                  updateSettings(profileId, {
                    ui: { ...settings.ui, usage_meter: { ...settings.ui.usage_meter, enabled: e.target.checked } }
                  })
                }
              />
              Show token / cache meter (floating overlay)
            </label>
```

- [ ] **Step 5: Add minimal overlay styles**

Append to the global stylesheet `src/renderer/src/assets/main.css` (the app's main CSS — confirm the import path in `main.tsx`; if a different global CSS file is used, append there):

```css
.usage-overlay {
  background: var(--rpt-bg-elevated, #1e1e24);
  border: 1px solid var(--rpt-border, #333);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  min-width: 140px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  user-select: none;
}
.usage-overlay-head button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0 2px;
}
.usage-overlay-gear {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
  margin-top: 6px;
}
.usage-overlay-body {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/stores/chatStore.ts src/renderer/src/components/UsageOverlay.tsx src/renderer/src/App.tsx src/renderer/src/components/SettingsPanel.tsx src/renderer/src/assets/main.css
git commit -m "feat(meter): floating usage overlay + Settings toggle"
```

---

### Task 8: History view (`'usage'`) + SVG chart + export + backfill

The diagnostics surface: summary, est-vs-actual chart, per-turn table, CSV/JSON export, backfill button.

**Files:**
- Create: `src/renderer/src/components/TurnChart.tsx`
- Create: `src/renderer/src/components/UsageView.tsx`
- Modify: `src/renderer/src/components/workspace/viewRegistry.tsx` (register `usage`)
- Test: `test/turnChart.test.ts` (the pure path helper)

**Interfaces:**
- Consumes: `useChatStore().floors`, `useSettingsStore()`, `costFor`/`cacheHitPct`.
- Produces: a `'usage'` entry in `ViewRegistry` (so it appears in `VIEW_OPTIONS`).

- [ ] **Step 1: Write the failing test for the chart path helper**

Create `test/turnChart.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { linePath } from '../src/renderer/src/components/TurnChart'

describe('linePath', () => {
  it('maps values to an SVG polyline path scaled to width/height', () => {
    const p = linePath([0, 50, 100], 100, 10, 0, 100)
    // 3 points → "M x,y L x,y L x,y"; first x=0, last x=100; y inverts (100 → 0, 0 → height)
    expect(p.startsWith('M0,')).toBe(true)
    expect(p).toContain('L100,0') // value 100 maps to top (y=0)
    expect(p).toContain('L0,10') // value 0 maps to bottom (y=height)
  })
  it('returns empty string for fewer than 2 points', () => {
    expect(linePath([5], 100, 10, 0, 100)).toBe('')
    expect(linePath([], 100, 10, 0, 100)).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/turnChart.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the chart component**

Create `src/renderer/src/components/TurnChart.tsx`:

```tsx
import React from 'react'

/** Pure: build an SVG path ("M..L..") mapping values across width, inverted to height,
 * scaled between min..max. Empty for <2 points. Exported for unit testing. */
export const linePath = (
  values: number[],
  width: number,
  height: number,
  min: number,
  max: number
): string => {
  if (values.length < 2) return ''
  const span = max - min || 1
  const step = width / (values.length - 1)
  return values
    .map((v, i) => {
      const x = Math.round(i * step)
      const y = Math.round(height - ((v - min) / span) * height)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')
}

export interface Series {
  label: string
  color: string
  values: number[]
}

/** A small multi-series line chart (hand-rolled SVG, no chart dep). */
export const TurnChart: React.FC<{ series: Series[]; min: number; max: number; height?: number }> = ({
  series,
  min,
  max,
  height = 80
}) => {
  const width = 280
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {series.map((s) => (
        <path key={s.label} d={linePath(s.values, width, height, min, max)} fill="none" stroke={s.color} strokeWidth={1.5} />
      ))}
    </svg>
  )
}
```

- [ ] **Step 4: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/turnChart.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the Usage view**

Create `src/renderer/src/components/UsageView.tsx`:

```tsx
import React from 'react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProfileStore } from '../stores/profileStore'
import type { FloorMetrics } from '../../../shared/usageTypes'
import { costFor, cacheHitPct } from '../../../shared/usageCost'
import { TurnChart } from './TurnChart'

const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)
const pct = (n: number): string => `${Math.round(n)}%`

/** Flatten the active chat's floors into a per-turn metric series. */
const useSeries = (): { floor: number; m: FloorMetrics }[] => {
  const floors = useChatStore((s) => s.floors)
  return floors.filter((f) => f.metrics).map((f) => ({ floor: f.floor, m: f.metrics as FloorMetrics }))
}

export const UsageView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const series = useSeries()
  const settings = useSettingsStore((s) => s.settings)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChat = useChatStore((s) => s.setActiveChat)
  const activeProfile = useProfileStore((s) => s.activeProfile)

  if (!settings) return null
  if (series.length === 0) {
    return (
      <div style={{ padding: 12 }}>
        <div style={{ opacity: 0.6 }}>No metered turns in this chat yet.</div>
        <BackfillButton profileId={profileId} chatId={activeChatId} onDone={() => activeProfile && setActiveChat(profileId, activeChatId!)} />
      </div>
    )
  }

  const last = series[series.length - 1].m
  const c = last.cumulative
  const rates = settings.pricing?.[last.turn.model]
  const sessionCost = costFor(c.usage, rates)

  const estPct = series.map((s) => s.m.turn.proxyPct)
  const actualPct = series.map((s) => (s.m.turn.usage ? cacheHitPct(s.m.turn.usage) : 0))

  const exportData = (kind: 'csv' | 'json'): void => {
    const rows = series.map((s) => ({
      floor: s.floor,
      promptTokens: s.m.turn.promptTokens,
      proxyPct: s.m.turn.proxyPct,
      cacheHitPct: s.m.turn.usage ? cacheHitPct(s.m.turn.usage) : null,
      cacheRead: s.m.turn.usage?.cacheRead ?? null,
      cacheWrite: s.m.turn.usage?.cacheWrite ?? null,
      outputTokens: s.m.turn.outputTokens,
      cost: costFor(s.m.turn.usage, rates)
    }))
    let blob: Blob
    if (kind === 'json') {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    } else {
      const cols = Object.keys(rows[0])
      const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => (r as any)[k] ?? '').join(','))].join('\n')
      blob = new Blob([csv], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usage-${activeChatId}.${kind}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px', fontSize: 13 }}>
        <span>turns</span><span>{c.turns}</span>
        <span>avg est cache</span><span>{pct(c.avgProxyPct)}</span>
        <span>avg actual cache</span><span>{c.usageTurns ? pct(c.avgCacheHitPct) : '—'}</span>
        <span>avg prompt tok</span><span>{tok(c.avgPromptTokens)}</span>
        <span>total read / write</span>
        <span>{c.usage ? `${tok(c.usage.cacheRead)} / ${tok(c.usage.cacheWrite)}` : '—'}</span>
        <span>session $</span><span>{sessionCost == null ? '—' : `$${sessionCost.toFixed(2)}`}</span>
      </div>

      <div>
        <div style={{ fontSize: 12, opacity: 0.7, display: 'flex', gap: 12 }}>
          <span style={{ color: '#7aa2f7' }}>— est (proxy)</span>
          <span style={{ color: '#4caf72' }}>— actual</span>
        </div>
        <TurnChart
          min={0}
          max={100}
          series={[
            { label: 'est', color: '#7aa2f7', values: estPct },
            { label: 'actual', color: '#4caf72', values: actualPct }
          ]}
        />
      </div>

      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'right', opacity: 0.7 }}>
            <th style={{ textAlign: 'left' }}>#</th>
            <th>prompt</th><th>est</th><th>actual</th><th>read</th><th>write</th><th>out</th><th>$</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const t = s.m.turn
            const $ = costFor(t.usage, rates)
            return (
              <tr key={s.floor} style={{ textAlign: 'right' }}>
                <td style={{ textAlign: 'left' }}>{s.floor}</td>
                <td>{tok(t.promptTokens)}</td>
                <td>{pct(t.proxyPct)}</td>
                <td>{t.usage ? pct(cacheHitPct(t.usage)) : '—'}</td>
                <td>{t.usage ? tok(t.usage.cacheRead) : '—'}</td>
                <td>{t.usage ? tok(t.usage.cacheWrite) : '—'}</td>
                <td>{tok(t.outputTokens)}</td>
                <td>{$ == null ? '—' : `$${$.toFixed(4)}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => exportData('csv')}>Export CSV</button>
        <button onClick={() => exportData('json')}>Export JSON</button>
        <BackfillButton profileId={profileId} chatId={activeChatId} onDone={() => activeProfile && setActiveChat(profileId, activeChatId!)} />
      </div>
    </div>
  )
}

const BackfillButton: React.FC<{ profileId: string; chatId: string | null; onDone: () => void }> = ({
  profileId,
  chatId,
  onDone
}) => {
  const [busy, setBusy] = React.useState(false)
  if (!chatId) return null
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await window.api.backfillUsageMetrics(profileId, chatId)
        setBusy(false)
        onDone()
      }}
    >
      {busy ? 'Backfilling…' : 'Backfill proxy'}
    </button>
  )
}
```

- [ ] **Step 6: Register the view**

In `src/renderer/src/components/workspace/viewRegistry.tsx`:

(a) Add the import (after the `StatusView` import):

```ts
import { UsageView } from '../UsageView'
```

(b) Add a wrapper component (after `StatusPanel`):

```tsx
const UsagePanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <UsageView profileId={profileId} />
}
```

(c) Add the entry to `ViewRegistry` (after the `status:` entry):

```ts
  usage: { title: 'Usage', Component: UsagePanel, fill: true },
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/TurnChart.tsx src/renderer/src/components/UsageView.tsx src/renderer/src/components/workspace/viewRegistry.tsx test/turnChart.test.ts
git commit -m "feat(meter): usage history view + SVG chart + export + backfill"
```

---

### Task 9: Pricing editor in Settings

The user-editable per-model price table (empty by default ⇒ tokens-only).

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `settings.pricing`, `settings.api.model`, `updateSettings`.

- [ ] **Step 1: Add the pricing editor section**

In `src/renderer/src/components/SettingsPanel.tsx`, add this `<details>` block right before the existing `<details className="settings-section">` Plugins block:

```tsx
        {settings && (
          <details className="settings-section" style={{ marginTop: 20 }}>
            <summary>Token pricing ($ / 1M tokens)</summary>
            <div className="settings-section-body">
              <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 6 }}>
                Optional. Empty ⇒ the meter shows tokens only. Keyed by exact model id.
              </div>
              {Object.entries(settings.pricing ?? {}).map(([model, rates]) => (
                <div key={model} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ flex: 1, fontSize: 12 }}>{model}</span>
                  {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((k) => (
                    <input
                      key={k}
                      type="number"
                      title={k}
                      style={{ width: 64 }}
                      value={rates[k]}
                      onChange={(e) =>
                        updateSettings(profileId, {
                          pricing: {
                            ...settings.pricing,
                            [model]: { ...rates, [k]: Number(e.target.value) || 0 }
                          }
                        })
                      }
                    />
                  ))}
                  <button
                    title="Remove"
                    onClick={() => {
                      const next = { ...(settings.pricing ?? {}) }
                      delete next[model]
                      updateSettings(profileId, { pricing: next })
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                style={{ marginTop: 6 }}
                onClick={() => {
                  const model = settings.api.model || 'model-id'
                  if (settings.pricing?.[model]) return
                  updateSettings(profileId, {
                    pricing: {
                      ...settings.pricing,
                      [model]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                    }
                  })
                }}
              >
                + Add row for “{settings.api?.model || 'current model'}”
              </button>
            </div>
          </details>
        )}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(meter): user-editable per-model token pricing"
```

---

### Task 10: Full regression + manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm test`
Expected: PASS — all suites green; no existing test regressed. (Confirms level-0 prompt assembly is unchanged: metrics are computed from the assembled `messages`, post-hoc.)

- [ ] **Step 2: Manual checklist (run `npm run dev`)**

1. Settings → enable **Show token / cache meter** → the overlay appears (bottom-left).
2. Drag it → reload the app → it reopens at the dragged position.
3. Click ⚙ → toggle fields → the displayed rows change; reopen the app → the field set persists.
4. Collapse → it shows the `est% · tok` chip; expand back.
5. Send 2–3 turns → overlay updates each turn; open the **Usage** view (panel view-picker) → summary fills, the est-vs-actual chart draws, the table fills.
6. On an Anthropic key, confirm `actual` cache % and `read`/`write` are non-`—` from turn 2+.
7. Settings → **Token pricing** → “Add row for current model”, enter rates → `$` appears in the overlay/view; clear the row → back to tokens-only.
8. Usage view → **Export CSV** and **JSON** → open the files and sanity-check.
9. Open an older chat (pre-feature) → "No metered turns"/`—` → **Backfill proxy** → est % fills across floors, `actual` stays `—`.
10. Truncate the chat (regenerate/swipe an earlier turn) → earlier floors' numbers + the chart up to that point are unchanged.

- [ ] **Step 3: Commit any doc/log notes if needed (otherwise nothing to commit).**

---

## Self-Review

- **Spec coverage:** §3 data model → Tasks 1–2; §4 compute/persist/retire-accumulator/backfill → Tasks 2–5; §5 overlay → Task 7; §6 history view + chart + export + backfill button → Task 8; §7 pricing → Tasks 1 (cost fn) + 6 (settings) + 9 (editor); §9 testing → unit tests in Tasks 1/2/5/8 + regression + manual in Task 10. The spec's `metrics-turn` event is intentionally dropped (see "Refinements"); its functional intent (live overlay) is met by `chatStore.floors` derivation.
- **Placeholder scan:** every code step shows full content; no TBD/"handle edge cases".
- **Type consistency:** `Usage`/`TurnMetric`/`CumulativeMetric`/`FloorMetrics`/`ModelRates` defined once in `src/shared/usageTypes.ts` (Task 1) and consumed unchanged by `buildFloorMetrics` (Task 2), `FloorFile`/`floorService` (Task 3), `usageMetricsService` (Task 5), settings (Task 6), and the renderer (Tasks 7–9). `costFor`/`cacheHitPct` (Task 1) consumed by overlay (Task 7) and view (Task 8). `buildFloorMetrics` signature in Task 2 matches its call sites in Tasks 4 and 5. `backfillUsageMetrics` IPC (Task 5) matches its caller in Task 8.
