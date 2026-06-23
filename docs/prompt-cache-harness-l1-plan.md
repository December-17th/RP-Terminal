# Prompt-Cache Optimization — Harness + L1 Frozen Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the measurement harness and the L1 "Frozen Core" cache level so a complex MVU card's character/lore prefix stays byte-stable across turns, with live state relocated to an ephemeral tail block — measured by a deterministic stable-prefix proxy and live provider cache usage.

**Architecture:** A `settings.cache.level` dial (0 = today's behavior, 1 = Frozen Core) gates a behavior change in `promptBuilder`: at level ≥ 1 the durable "frontier" (character description, examples, lore, persona, addendum) is rendered against a *frozen* variable snapshot so its bytes don't change between turns, and the current `stat_data` is appended as a tail block just before the user action. L1 has two sub-modes (`l1_mode`): `partition` (state shown as placeholders in the frontier — clean) and `diff` (state shown as floor-0 values in the frontier — corrected by the tail block). A `cacheMetricsService` records, per chat, the deterministic stable-prefix proxy plus normalized provider cache usage, and logs a per-session report. **No `apiService` breakpoint change is needed for L1** — the existing Anthropic `system`-hoist + `merged.length-2` breakpoint already caches the (now stable) frontier, and the tail state block lands in the final volatile user turn on every provider.

**Tech Stack:** TypeScript (strict), Electron main process, Vitest (`vitest run`). Pure function modules with named exports — no classes. quickjs-emscripten EJS engine (already initialized). better-sqlite3 + JSON-blob settings.

## Global Constraints

- **Prettier (source of truth):** 2-space indent, single quotes, **no semicolons**, printWidth 100, **no trailing commas**. Match this exactly.
- **Services are function modules** (named exports), imported as namespaces or named; no classes, no DI.
- **All generation happens in main.** The renderer never assembles prompts.
- **Shared boundary:** modules under `src/shared` import nothing from `src/main` or `src/renderer`. (The new metrics/layer modules live under `src/main/services`, so they may import from `promptBuilder`.)
- **Tests:** live in `test/*.test.ts`, import from `../src/main/...`. `electron` and `better-sqlite3` are aliased to stubs in `vitest.config.ts`, so importing `logService`/`settingsService` transitively is fine. Run with `npx vitest run test/<file>.test.ts`.
- **Must pass before every commit:** `npm run typecheck` and `npm test`.
- **Level 0 is behavior-preserving.** Every change in this plan must leave `cache.level === 0` output byte-identical to today; the harness only *observes* at level 0.

---

### Task 1: Settings `cache` section

Adds the `cache` config block (the A/B dial) with defaults and normalization. No behavior yet.

**Files:**
- Modify: `src/main/types/models.ts` (the `Settings` interface)
- Modify: `src/main/services/settingsService.ts` (`getDefaultSettings`, `normalize`)
- Test: `test/settingsService.test.ts`

**Interfaces:**
- Produces: `Settings['cache'] = { level: number; l1_mode: 'partition' | 'diff'; ttl: '5m' | '1h'; prewarm: boolean; breakpoint_optimizer: boolean }`; `getDefaultSettings().cache`; `normalize(stored).cache`.

- [ ] **Step 1: Write the failing test**

Append to `test/settingsService.test.ts` (add the import if `normalize`/`getDefaultSettings` are not already imported — check the file's existing import line first):

```typescript
import { describe, it, expect } from 'vitest'
import { normalize, getDefaultSettings } from '../src/main/services/settingsService'

describe('settings cache section', () => {
  it('defaults to level 0 / partition (behavior-preserving)', () => {
    const c = getDefaultSettings().cache
    expect(c.level).toBe(0)
    expect(c.l1_mode).toBe('partition')
    expect(c.ttl).toBe('5m')
    expect(c.prewarm).toBe(false)
    expect(c.breakpoint_optimizer).toBe(false)
  })

  it('merges a stored cache section over defaults without wiping unset fields', () => {
    const s = normalize({ cache: { level: 1, l1_mode: 'diff' } } as any)
    expect(s.cache.level).toBe(1)
    expect(s.cache.l1_mode).toBe('diff')
    // unset fields fall back to defaults
    expect(s.cache.ttl).toBe('5m')
    expect(s.cache.prewarm).toBe(false)
  })

  it('supplies the cache section when stored settings omit it entirely', () => {
    const s = normalize({})
    expect(s.cache.level).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settingsService.test.ts`
Expected: FAIL — `getDefaultSettings().cache` is `undefined` (`Cannot read properties of undefined`).

- [ ] **Step 3: Add the type**

In `src/main/types/models.ts`, inside the `Settings` interface, after the `workspace` field block, add:

```typescript
  /** Prompt-cache optimization dial (see docs/prompt-cache-optimization-design.md).
   *  level 0 = baseline (today); 1 = Frozen Core. l1_mode selects the L1 sub-experiment. */
  cache: {
    /** 0 = baseline, 1 = Frozen Core (2/3 reserved for later phases). */
    level: number
    /** L1 sub-mode: 'partition' (placeholder state in the frontier) | 'diff' (floor-0 state). */
    l1_mode: 'partition' | 'diff'
    /** Reserved for provider realization (Anthropic cache_control TTL). */
    ttl: '5m' | '1h'
    /** Reserved: pre-warm the cache at chat open. */
    prewarm: boolean
    /** Reserved: place Anthropic breakpoints at the true stable boundary. */
    breakpoint_optimizer: boolean
  }
```

- [ ] **Step 4: Add the default**

In `src/main/services/settingsService.ts`, inside the object returned by `getDefaultSettings()`, after the `workspace: { layouts: {} }` line, add:

```typescript
  cache: {
    level: 0,
    l1_mode: 'partition',
    ttl: '5m',
    prewarm: false,
    breakpoint_optimizer: false
  }
```

- [ ] **Step 5: Normalize it**

In `src/main/services/settingsService.ts`, inside `normalize`, after the `const workspace = ...` line add:

```typescript
  const cache = { ...d.cache, ...(stored.cache || {}) }
```

Then add `cache` to the returned object's field list (the `return { api, ..., workspace }` block):

```typescript
  return {
    api,
    api_presets,
    active_api_preset_id,
    persona,
    generation,
    lorebook,
    templates,
    modes,
    agent,
    ui,
    workspace,
    cache
  }
```

- [ ] **Step 6: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/settingsService.test.ts`
Expected: PASS (typecheck clean; all settings tests green).

- [ ] **Step 7: Commit**

```bash
git add src/main/types/models.ts src/main/services/settingsService.ts test/settingsService.test.ts
git commit -m "feat(cache): add settings.cache dial (level + l1_mode) with defaults + normalize"
```

---

### Task 2: Stable-prefix proxy + usage normalization (pure)

The deterministic metric and the provider-usage normalizer. No I/O — fully unit-tested.

**Files:**
- Create: `src/main/services/promptCacheMetrics.ts`
- Test: `test/promptCacheMetrics.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `estimateTokens` from `./promptBuilder`.
- Produces:
  - `interface Usage { cacheRead: number; cacheWrite: number; input: number; output: number }`
  - `stablePrefixTokens(prev: ChatMessage[], curr: ChatMessage[]): { messages: number; tokens: number }`
  - `normalizeUsage(provider: string, raw: unknown): Usage | null`
  - `interface TurnStat { msgs: number; promptTokens: number; stablePrefixMsgs: number; stablePrefixTokens: number; usage: Usage | null }`
  - `summarize(turns: TurnStat[]): CacheReport` where `interface CacheReport { turns: number; avgStablePrefixPct: number; totalPromptTokens: number; usage: Usage | null }`

- [ ] **Step 1: Write the failing test**

Create `test/promptCacheMetrics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  stablePrefixTokens,
  normalizeUsage,
  summarize,
  TurnStat
} from '../src/main/services/promptCacheMetrics'
import { ChatMessage } from '../src/main/services/promptBuilder'

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

describe('stablePrefixTokens', () => {
  it('counts the leading byte-identical messages and their tokens', () => {
    const prev = [m('system', 'AAAA'), m('user', 'hello'), m('assistant', 'old')]
    const curr = [m('system', 'AAAA'), m('user', 'hello'), m('assistant', 'NEW different')]
    const r = stablePrefixTokens(prev, curr)
    expect(r.messages).toBe(2) // system + user identical; assistant differs
    expect(r.tokens).toBeGreaterThan(0)
  })

  it('stops at the first differing message (role or content)', () => {
    const prev = [m('system', 'AAAA'), m('user', 'x')]
    const curr = [m('system', 'BBBB'), m('user', 'x')]
    expect(stablePrefixTokens(prev, curr).messages).toBe(0)
  })

  it('is 0 against an empty previous prompt', () => {
    expect(stablePrefixTokens([], [m('system', 'AAAA')]).messages).toBe(0)
  })
})

describe('normalizeUsage', () => {
  it('maps Anthropic usage', () => {
    const u = normalizeUsage('anthropic', {
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      input_tokens: 5,
      output_tokens: 50
    })
    expect(u).toEqual({ cacheRead: 100, cacheWrite: 20, input: 5, output: 50 })
  })

  it('maps Gemini usage (cached is a subset of prompt tokens)', () => {
    const u = normalizeUsage('google', {
      promptTokenCount: 120,
      candidatesTokenCount: 30,
      cachedContentTokenCount: 100
    })
    expect(u).toEqual({ cacheRead: 100, cacheWrite: 0, input: 20, output: 30 })
  })

  it('maps OpenAI usage', () => {
    const u = normalizeUsage('openai', {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 100 }
    })
    expect(u).toEqual({ cacheRead: 100, cacheWrite: 0, input: 20, output: 30 })
  })

  it('returns null for missing/garbage usage', () => {
    expect(normalizeUsage('anthropic', null)).toBeNull()
    expect(normalizeUsage('openai', undefined)).toBeNull()
  })
})

describe('summarize', () => {
  it('averages stable-prefix percent and sums usage when present', () => {
    const turns: TurnStat[] = [
      { msgs: 4, promptTokens: 100, stablePrefixMsgs: 0, stablePrefixTokens: 0, usage: null },
      {
        msgs: 5,
        promptTokens: 200,
        stablePrefixMsgs: 4,
        stablePrefixTokens: 150,
        usage: { cacheRead: 150, cacheWrite: 50, input: 50, output: 20 }
      }
    ]
    const r = summarize(turns)
    expect(r.turns).toBe(2)
    // turn1: 0/100 = 0%, turn2: 150/200 = 75% -> avg 37.5
    expect(r.avgStablePrefixPct).toBeCloseTo(37.5, 1)
    expect(r.totalPromptTokens).toBe(300)
    expect(r.usage).toEqual({ cacheRead: 150, cacheWrite: 50, input: 50, output: 20 })
  })

  it('reports null usage when no turn had usage', () => {
    const turns: TurnStat[] = [
      { msgs: 1, promptTokens: 10, stablePrefixMsgs: 0, stablePrefixTokens: 0, usage: null }
    ]
    expect(summarize(turns).usage).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/promptCacheMetrics.test.ts`
Expected: FAIL — module `../src/main/services/promptCacheMetrics` not found.

- [ ] **Step 3: Write the implementation**

Create `src/main/services/promptCacheMetrics.ts`:

```typescript
import { ChatMessage, estimateTokens } from './promptBuilder'

/** Provider-neutral cache usage for one turn. */
export interface Usage {
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
}

/** One recorded turn's metrics (proxy + optional live usage). */
export interface TurnStat {
  msgs: number
  promptTokens: number
  stablePrefixMsgs: number
  stablePrefixTokens: number
  usage: Usage | null
}

/** Aggregated per-session report. */
export interface CacheReport {
  turns: number
  avgStablePrefixPct: number
  totalPromptTokens: number
  usage: Usage | null
}

/**
 * Deterministic cache proxy: the length of the leading run of byte-identical
 * messages shared by two consecutive assembled prompts. This is the theoretical
 * cache-read ceiling (caches are a prefix match), computed without sending
 * anything — so prompt-build strategies can be A/B'd on identical inputs.
 * Message-granular (role + content), which matches how provider content blocks cache.
 */
export const stablePrefixTokens = (
  prev: ChatMessage[],
  curr: ChatMessage[]
): { messages: number; tokens: number } => {
  const len = Math.min(prev.length, curr.length)
  let messages = 0
  let tokens = 0
  while (
    messages < len &&
    prev[messages].role === curr[messages].role &&
    prev[messages].content === curr[messages].content
  ) {
    tokens += estimateTokens(curr[messages].content)
    messages++
  }
  return { messages, tokens }
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)

/**
 * Normalize a provider's raw usage object into the common shape. Anthropic reports
 * cache read/write directly; OpenAI and Gemini report a cached subset of the prompt
 * tokens (no explicit write), so `input` is the uncached remainder. Returns null when
 * the provider sent no usable usage.
 */
export const normalizeUsage = (provider: string, raw: unknown): Usage | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  if (provider === 'anthropic') {
    return {
      cacheRead: num(r.cache_read_input_tokens),
      cacheWrite: num(r.cache_creation_input_tokens),
      input: num(r.input_tokens),
      output: num(r.output_tokens)
    }
  }
  if (provider === 'google' || provider === 'gemini') {
    const cached = num(r.cachedContentTokenCount)
    return {
      cacheRead: cached,
      cacheWrite: 0,
      input: Math.max(0, num(r.promptTokenCount) - cached),
      output: num(r.candidatesTokenCount)
    }
  }
  // OpenAI-compatible
  const cached = num(r.prompt_tokens_details?.cached_tokens)
  return {
    cacheRead: cached,
    cacheWrite: 0,
    input: Math.max(0, num(r.prompt_tokens) - cached),
    output: num(r.completion_tokens)
  }
}

/** Aggregate a session's turns into a single report. */
export const summarize = (turns: TurnStat[]): CacheReport => {
  if (turns.length === 0) {
    return { turns: 0, avgStablePrefixPct: 0, totalPromptTokens: 0, usage: null }
  }
  let pctSum = 0
  let totalPromptTokens = 0
  const u: Usage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
  let anyUsage = false
  for (const t of turns) {
    pctSum += t.promptTokens > 0 ? (t.stablePrefixTokens / t.promptTokens) * 100 : 0
    totalPromptTokens += t.promptTokens
    if (t.usage) {
      anyUsage = true
      u.cacheRead += t.usage.cacheRead
      u.cacheWrite += t.usage.cacheWrite
      u.input += t.usage.input
      u.output += t.usage.output
    }
  }
  return {
    turns: turns.length,
    avgStablePrefixPct: pctSum / turns.length,
    totalPromptTokens,
    usage: anyUsage ? u : null
  }
}
```

- [ ] **Step 4: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/promptCacheMetrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/promptCacheMetrics.ts test/promptCacheMetrics.test.ts
git commit -m "feat(cache): stable-prefix proxy + provider usage normalization"
```

---

### Task 3: Capture provider cache usage (`onUsage` callback)

Surface each provider's usage object so the harness can record it. The deterministic proxy already works without this, so usage stays optional and null-safe.

**Files:**
- Modify: `src/main/services/apiService.ts` (`streamProvider` + the three `stream*` functions + OpenAI body)
- Test: `test/apiService.test.ts` (no new test for the SSE plumbing — it's covered by `normalizeUsage` in Task 2 + the integration verification in Task 9; this step is a wiring change validated by typecheck)

**Interfaces:**
- Produces: `streamProvider(settings, messages, params, onDelta, signal?, onUsage?)` where `onUsage?: (raw: unknown) => void`. Each provider calls `onUsage?.(usage)` with its raw usage object.
- Consumes (later, in Task 5): `generationService` passes `onUsage` and feeds the raw object to `normalizeUsage`.

- [ ] **Step 1: Add the callback type and thread it through `streamProvider`**

In `src/main/services/apiService.ts`, after the `DeltaCallback` type, add:

```typescript
/** Receives the provider's RAW usage object (shape differs per provider) once known. */
export type UsageCallback = (raw: unknown) => void
```

Change `streamProvider` to accept and forward `onUsage`:

```typescript
export const streamProvider = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback
): Promise<string> => {
  if (settings.api.provider === 'anthropic') {
    return streamAnthropic(settings, messages, params, onDelta, signal, onUsage)
  }
  if (settings.api.provider === 'google' || settings.api.provider === 'gemini') {
    return streamGemini(settings, messages, params, onDelta, signal, onUsage)
  }
  return streamOpenAICompatible(settings, messages, params, onDelta, signal, onUsage)
}
```

- [ ] **Step 2: Emit usage from the Anthropic path**

In `streamAnthropic`, add `onUsage?: UsageCallback` as the final parameter. It already captures `usage` in the SSE loop and logs it after; right after that existing `if (usage) { log(...) }` block, add:

```typescript
  if (usage) onUsage?.(usage)
```

- [ ] **Step 3: Emit usage from the Gemini path**

In `streamGemini`, add `onUsage?: UsageCallback` as the final parameter. It already captures `usage` (the `usageMetadata`) and logs it; right after that existing `if (usage) { log(...) }` block, add:

```typescript
  if (usage) onUsage?.(usage)
```

- [ ] **Step 4: Request + emit usage from the OpenAI-compatible path**

In `streamOpenAICompatible`, add `onUsage?: UsageCallback` as the final parameter.

(a) In the request body, ask for usage on the stream. Change the `body: JSON.stringify({ model, messages: outMessages, ...cleanParams(params), stream: true })` line to:

```typescript
    body: JSON.stringify({
      model,
      messages: outMessages,
      ...cleanParams(params),
      stream: true,
      stream_options: { include_usage: true }
    }),
```

(b) Capture usage from the stream. Inside the existing `await readSse(response, (data) => { ... })` handler, after the `const json = JSON.parse(data)` line, add (before the `delta` read is fine):

```typescript
        if (json.usage) usage = json.usage
```

(c) Declare `usage` alongside `full`: change `let full = ''` (in `streamOpenAICompatible`) to:

```typescript
  let full = ''
  let usage: any = null
```

(d) After the `readSse` try/catch completes (just before `return full`), add:

```typescript
  if (usage) onUsage?.(usage)
```

> Note: some OpenAI-compatible proxies ignore `stream_options` and send no usage chunk — `usage` stays null and `onUsage` is never called. That is expected; the harness degrades to proxy-only metrics.

- [ ] **Step 5: Run typecheck + existing tests**

Run: `npm run typecheck && npx vitest run test/apiService.test.ts`
Expected: PASS (typecheck clean; `buildGeminiBody` tests untouched and green).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/apiService.ts
git commit -m "feat(cache): surface provider cache usage via optional onUsage callback"
```

---

### Task 4: `cacheMetricsService` — per-chat accumulation + report

In-memory per-chat metrics with a logged per-session summary. (In-memory is sufficient for an A/B measurement within a run; it moves into the persisted PromptState at L3 — out of scope here.)

**Files:**
- Create: `src/main/services/cacheMetricsService.ts`
- Test: `test/cacheMetricsService.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `estimateTokens` from `./promptBuilder`; `stablePrefixTokens`, `summarize`, `TurnStat`, `Usage`, `CacheReport` from `./promptCacheMetrics`; `log` from `./logService`.
- Produces:
  - `recordTurn(chatId: string, messages: ChatMessage[], usage: Usage | null): TurnStat`
  - `getReport(chatId: string): CacheReport`
  - `resetChat(chatId: string): void`

- [ ] **Step 1: Write the failing test**

Create `test/cacheMetricsService.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { recordTurn, getReport, resetChat } from '../src/main/services/cacheMetricsService'
import { ChatMessage } from '../src/main/services/promptBuilder'

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

describe('cacheMetricsService', () => {
  beforeEach(() => resetChat('c1'))

  it('first turn has a 0 stable prefix (no previous prompt)', () => {
    const t = recordTurn('c1', [m('system', 'AAAA'), m('user', 'hi')], null)
    expect(t.stablePrefixMsgs).toBe(0)
    expect(t.msgs).toBe(2)
  })

  it('a stable frontier yields a growing stable prefix on later turns', () => {
    recordTurn('c1', [m('system', 'AAAA'), m('user', 'hi')], null)
    const t2 = recordTurn(
      'c1',
      [m('system', 'AAAA'), m('user', 'hi'), m('assistant', 'reply'), m('user', 'next')],
      { cacheRead: 4, cacheWrite: 0, input: 2, output: 1 }
    )
    expect(t2.stablePrefixMsgs).toBe(2) // system + first user identical
    const r = getReport('c1')
    expect(r.turns).toBe(2)
    expect(r.usage?.cacheRead).toBe(4)
  })

  it('resetChat clears prior turns and the previous-prompt anchor', () => {
    recordTurn('c1', [m('system', 'AAAA')], null)
    resetChat('c1')
    expect(getReport('c1').turns).toBe(0)
    const t = recordTurn('c1', [m('system', 'AAAA')], null)
    expect(t.stablePrefixMsgs).toBe(0) // anchor was cleared
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cacheMetricsService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/main/services/cacheMetricsService.ts`:

```typescript
import { ChatMessage, estimateTokens } from './promptBuilder'
import {
  stablePrefixTokens,
  summarize,
  TurnStat,
  Usage,
  CacheReport
} from './promptCacheMetrics'
import { log } from './logService'

interface ChatMetrics {
  prev: ChatMessage[] | null
  turns: TurnStat[]
}

const byChat = new Map<string, ChatMetrics>()

const get = (chatId: string): ChatMetrics => {
  let s = byChat.get(chatId)
  if (!s) {
    s = { prev: null, turns: [] }
    byChat.set(chatId, s)
  }
  return s
}

const promptTokens = (messages: ChatMessage[]): number =>
  messages.reduce((n, msg) => n + estimateTokens(msg.content), 0)

/**
 * Record one turn's assembled prompt (the array actually sent to the provider) plus
 * the provider's normalized usage (or null). Computes the deterministic stable-prefix
 * proxy against the previous turn, stores the stat, advances the anchor, and logs a
 * one-line summary. Returns the recorded stat.
 */
export const recordTurn = (
  chatId: string,
  messages: ChatMessage[],
  usage: Usage | null
): TurnStat => {
  const s = get(chatId)
  const prefix = s.prev ? stablePrefixTokens(s.prev, messages) : { messages: 0, tokens: 0 }
  const total = promptTokens(messages)
  const stat: TurnStat = {
    msgs: messages.length,
    promptTokens: total,
    stablePrefixMsgs: prefix.messages,
    stablePrefixTokens: prefix.tokens,
    usage
  }
  s.turns.push(stat)
  s.prev = messages
  const pct = total > 0 ? Math.round((prefix.tokens / total) * 100) : 0
  const live = usage ? ` · live read ${usage.cacheRead} / write ${usage.cacheWrite}` : ''
  log('info', `cache proxy — stable prefix ${prefix.tokens}/${total} tok (${pct}%)${live}`)
  return stat
}

/** Aggregate report for a chat's session so far. */
export const getReport = (chatId: string): CacheReport => summarize(get(chatId).turns)

/** Drop a chat's metrics + previous-prompt anchor (new chat, truncate, or reset). */
export const resetChat = (chatId: string): void => {
  byChat.delete(chatId)
}
```

- [ ] **Step 4: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/cacheMetricsService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cacheMetricsService.ts test/cacheMetricsService.test.ts
git commit -m "feat(cache): per-chat metrics accumulation + logged session report"
```

---

### Task 5: Wire the harness into `generationService` (level 0 = pure measurement)

Record metrics every turn without changing the prompt. This completes the harness; at `cache.level === 0` the assembled prompt is byte-identical to today.

**Files:**
- Modify: `src/main/services/generationService.ts`
- Test: covered by Task 9's end-to-end harness test (this wiring has no pure unit; validated by typecheck + the Task 9 verification).

**Interfaces:**
- Consumes: `streamProvider(..., onUsage)`, `normalizeUsage`, `recordTurn`.

- [ ] **Step 1: Add imports**

In `src/main/services/generationService.ts`, extend the `apiService` import and add two new imports near the other service imports (`resetChat` is used in Step 4):

```typescript
import { streamProvider, DeltaCallback, UsageCallback } from './apiService'
import { normalizeUsage } from './promptCacheMetrics'
import { recordTurn, resetChat } from './cacheMetricsService'
```

- [ ] **Step 2: Capture raw usage around the provider call**

In `generate`, just before `const controller = new AbortController()`, add:

```typescript
  let rawUsage: unknown = null
  const onUsage: UsageCallback = (u) => {
    rawUsage = u
  }
```

Change the provider call to pass `onUsage`:

```typescript
    raw = await streamProvider(settings, messages, params, onDelta, controller.signal, onUsage)
```

- [ ] **Step 3: Record the turn after a successful generation**

In `generate`, after the `log('response', ...)` line (the one that logs the raw response) and before `const cleaned = stripThinking(raw)`, add:

```typescript
  // Cache harness: record this turn's assembled prompt (what was sent) + provider usage.
  recordTurn(chatId, messages, normalizeUsage(settings.api.provider, rawUsage))
```

- [ ] **Step 4: Reset metrics on regenerate/truncate**

In `regenerate` (in the same file), the previous-prompt anchor goes stale after a truncate — reset it so the proxy isn't misled (`resetChat` was already imported in Step 1). Right after `truncateFloors(profileId, chatId, lastIndex)`:

```typescript
  resetChat(chatId)
```

- [ ] **Step 5: Run typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck clean; all existing tests green (no behavior change at level 0).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/generationService.ts
git commit -m "feat(cache): wire metrics harness into generation (level 0 = measurement only)"
```

---

### Task 6: L1 frozen-vars + tail state block (pure)

The two transforms that make L1 work: freeze the frontier's variable snapshot and build the tail state block.

**Files:**
- Create: `src/main/services/cacheLayers.ts`
- Test: `test/cacheLayers.test.ts`

**Interfaces:**
- Produces:
  - `frozenVarsFor(mode: 'partition' | 'diff', floor0Vars: Record<string, any>): Record<string, any>`
  - `buildStateBlock(liveVars: Record<string, any> | undefined): string | null`
  - `const STATE_PLACEHOLDER = '⟦state⟧'`

- [ ] **Step 1: Write the failing test**

Create `test/cacheLayers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  frozenVarsFor,
  buildStateBlock,
  STATE_PLACEHOLDER
} from '../src/main/services/cacheLayers'

describe('frozenVarsFor', () => {
  const floor0 = { config: { hard: true }, stat_data: { 主角: { 等级: 1, hp: 100 } } }

  it("'diff' returns a deep clone of the floor-0 vars (real seed values)", () => {
    const f = frozenVarsFor('diff', floor0)
    expect(f.stat_data.主角.等级).toBe(1)
    f.stat_data.主角.等级 = 999 // mutating the clone must not touch the source
    expect(floor0.stat_data.主角.等级).toBe(1)
  })

  it("'partition' replaces every stat_data leaf with a placeholder, keeping shape", () => {
    const f = frozenVarsFor('partition', floor0)
    expect(f.stat_data.主角.等级).toBe(STATE_PLACEHOLDER)
    expect(f.stat_data.主角.hp).toBe(STATE_PLACEHOLDER)
    expect(f.config.hard).toBe(true) // non-state vars untouched
  })

  it('handles missing / non-object stat_data without throwing', () => {
    expect(frozenVarsFor('partition', {}).stat_data).toBeUndefined()
    expect(frozenVarsFor('partition', { stat_data: 5 } as any).stat_data).toBe(5)
  })
})

describe('buildStateBlock', () => {
  it('serializes stat_data into a labelled block', () => {
    const b = buildStateBlock({ stat_data: { hp: 30 } })
    expect(b).toBe('[Current State]\n{"hp":30}')
  })

  it('returns null when there is no stat_data', () => {
    expect(buildStateBlock({})).toBeNull()
    expect(buildStateBlock(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cacheLayers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/main/services/cacheLayers.ts`:

```typescript
/**
 * L1 "Frozen Core" transforms (see docs/prompt-cache-optimization-design.md §6.1).
 * The frontier (character/lore/etc.) is rendered against a FROZEN variable snapshot
 * so its bytes don't change between turns; the live state is shown separately in a
 * tail block. The two L1 sub-modes differ only in what the frozen snapshot shows for
 * state: 'partition' shows placeholders (no stale value), 'diff' shows the floor-0
 * seed values (stale, corrected by the tail block).
 */

export const STATE_PLACEHOLDER = '⟦state⟧'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null))

/** Replace every leaf with the placeholder, preserving object/array shape. */
const placeholderize = (v: any): any => {
  if (Array.isArray(v)) return v.map(placeholderize)
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {}
    for (const k of Object.keys(v)) o[k] = placeholderize(v[k])
    return o
  }
  return STATE_PLACEHOLDER
}

/**
 * The frozen variable snapshot used to render the frontier. Both modes freeze on the
 * floor-0 variables (constant across the session); 'partition' additionally replaces
 * the `stat_data` leaves with a stable placeholder so no real value is ever embedded
 * (and thus none can go stale) in the cached prefix.
 */
export const frozenVarsFor = (
  mode: 'partition' | 'diff',
  floor0Vars: Record<string, any>
): Record<string, any> => {
  const base = clone(floor0Vars || {}) || {}
  if (mode === 'partition' && base.stat_data && typeof base.stat_data === 'object') {
    base.stat_data = placeholderize(base.stat_data)
  }
  return base
}

/**
 * The ephemeral tail block carrying the CURRENT state, placed just before the user
 * action so it never enters the cached prefix. Null when there is no state to show.
 */
export const buildStateBlock = (liveVars: Record<string, any> | undefined): string | null => {
  const sd = liveVars?.stat_data
  if (!sd || typeof sd !== 'object') return null
  return `[Current State]\n${JSON.stringify(sd)}`
}
```

- [ ] **Step 4: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/cacheLayers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cacheLayers.ts test/cacheLayers.test.ts
git commit -m "feat(cache): L1 frozen-vars (partition/diff) + tail state block"
```

---

### Task 7: Apply L1 in `buildPrompt` (frozen frontier render + tail state)

Wire the L1 transforms into prompt assembly: at level ≥ 1 render the frontier against frozen vars and append the tail state block. Level 0 stays byte-identical.

**Files:**
- Modify: `src/main/services/promptBuilder.ts` (`BuildPromptArgs`, the `makeRender`/`macroBase` closures, end of `buildPrompt`)
- Test: `test/promptBuilder.test.ts`

**Interfaces:**
- Consumes: `frozenVarsFor`, `buildStateBlock` from `./cacheLayers`.
- Produces (new `BuildPromptArgs` fields): `cacheLevel?: number`, `l1Mode?: 'partition' | 'diff'`, `frozenVars?: Record<string, any>`.

- [ ] **Step 1: Write the failing test**

Append to the `describe('buildPrompt — EJS in constant lore ...')` area of `test/promptBuilder.test.ts` a new block (it needs the engine, so keep it under a `beforeAll(initTemplates)` describe). Add at the end of the file, before the final `collectRenderMarkers` describe is fine, a new describe:

```typescript
describe('buildPrompt — L1 Frozen Core', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  const mkArgs = (statLevel: number, cacheLevel: number, l1Mode: 'partition' | 'diff'): any => ({
    card: card(),
    preset: preset([blk('char_description'), blk('world_info'), blk('chat_history')]),
    lorebooks: [
      book([
        {
          comment: '命定系统-核心',
          content: '等级:<%= getvar("stat_data.主角.等级") %>',
          constant: true
        }
      ])
    ],
    floors: [],
    userAction: 'go',
    cacheLevel,
    l1Mode,
    // floor-0 frozen vars (level 1 renders the frontier against these)
    frozenVars:
      l1Mode === 'partition'
        ? { stat_data: { 主角: { 等级: '⟦state⟧' } } }
        : { stat_data: { 主角: { 等级: 1 } } },
    template: {
      vars: { stat_data: { 主角: { 等级: statLevel } } },
      globals: {},
      constants: {}
    }
  })

  it('level 0 still renders live state into world info (unchanged behavior)', () => {
    const messages = buildPrompt(mkArgs(7, 0, 'partition'))
    const wi = messages.find((m) => m.content.startsWith('World Info:'))
    expect(wi?.content).toContain('等级:7')
  })

  it('partition: frontier world info is byte-identical across differing live state', () => {
    const a = buildPrompt(mkArgs(7, 1, 'partition'))
    const b = buildPrompt(mkArgs(42, 1, 'partition'))
    const wiA = a.find((m) => m.content.startsWith('World Info:'))!
    const wiB = b.find((m) => m.content.startsWith('World Info:'))!
    expect(wiA.content).toBe(wiB.content) // frozen → identical bytes
    expect(wiA.content).toContain('等级:⟦state⟧') // placeholder, not a real value
  })

  it("diff: frontier shows the floor-0 value (stable) regardless of live state", () => {
    const a = buildPrompt(mkArgs(7, 1, 'diff'))
    const b = buildPrompt(mkArgs(42, 1, 'diff'))
    const wiA = a.find((m) => m.content.startsWith('World Info:'))!
    const wiB = b.find((m) => m.content.startsWith('World Info:'))!
    expect(wiA.content).toBe(wiB.content)
    expect(wiA.content).toContain('等级:1') // floor-0 seed value
  })

  it('appends the current-state tail block right before the user action', () => {
    const messages = buildPrompt(mkArgs(7, 1, 'partition'))
    expect(last(messages)).toEqual({ role: 'user', content: 'go' })
    const penultimate = messages[messages.length - 2]
    expect(penultimate.role).toBe('system')
    expect(penultimate.content).toContain('[Current State]')
    expect(penultimate.content).toContain('"等级":7') // the LIVE value, in the tail
  })

  it('omits the tail state block when there is no stat_data', () => {
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('char_description'), blk('chat_history')]),
      lorebooks: [],
      floors: [],
      userAction: 'go',
      cacheLevel: 1,
      l1Mode: 'partition',
      frozenVars: {},
      template: { vars: {}, globals: {}, constants: {} }
    })
    expect(messages.some((m) => m.content.includes('[Current State]'))).toBe(false)
    expect(last(messages)).toEqual({ role: 'user', content: 'go' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/promptBuilder.test.ts`
Expected: FAIL — `cacheLevel`/`l1Mode`/`frozenVars` are not accepted/used; frontier still renders live values and there is no `[Current State]` block.

- [ ] **Step 3: Add the import and the `BuildPromptArgs` fields**

At the top of `src/main/services/promptBuilder.ts`, add (only `buildStateBlock` is used here; `frozenVarsFor` is consumed by `generationService` in Task 8):

```typescript
import { buildStateBlock } from './cacheLayers'
```

In the `BuildPromptArgs` interface, after the `template?: TemplateContext` field, add:

```typescript
  /** Prompt-cache level (0 = baseline; ≥1 = L1 Frozen Core). */
  cacheLevel?: number
  /** L1 sub-mode (partition = placeholder state, diff = floor-0 state). */
  l1Mode?: 'partition' | 'diff'
  /** Floor-0-derived frozen variable snapshot the frontier renders against at level ≥1. */
  frozenVars?: Record<string, any>
```

- [ ] **Step 4: Render the frontier against frozen vars**

In `buildPrompt`, replace the `macroBase` + `makeRender` + `render` + `personaContent` block (the section beginning `const macroBase = (pd: string): MacroContext => ({` through `const personaContent = personaInject ? makeRender('')(args.persona!.description) : ''`) with:

```typescript
  const macroBase = (
    pd: string,
    vars?: Record<string, any>,
    globals?: Record<string, any>
  ): MacroContext => ({
    user: userName,
    char: charName,
    persona: pd,
    vars: vars ?? args.template?.vars,
    globals: globals ?? args.template?.globals
  })
  const makeRender =
    (pd: string, tmpl?: TemplateContext): Renderer =>
    (t) => {
      const m = expandMacros(t, macroBase(pd, tmpl?.vars, tmpl?.globals))
      return tmpl ? evalTemplate(m, tmpl) : stripEjs(m).trim()
    }
  // L1 Frozen Core: at cache level ≥1 the durable frontier renders against a FROZEN
  // variable snapshot (floor-0 derived), so its bytes are byte-stable across turns and
  // the provider prefix cache holds. Live state moves to a tail block (appended below).
  const cacheLevel = args.cacheLevel ?? 0
  const frontierTemplate: TemplateContext | undefined = args.template
    ? cacheLevel >= 1
      ? { ...args.template, vars: args.frozenVars ?? {} }
      : args.template
    : undefined
  const render = makeRender(personaMacro, frontierTemplate)
  const personaContent = personaInject ? makeRender('', frontierTemplate)(args.persona!.description) : ''
```

> Every existing use of `render` in the block loop, world-info join, depth entries, and marker injections now goes through `frontierTemplate` — no other call-site changes are needed. History (`buildHistory`) keeps calling `macroBase(personaMacro)` directly (live vars), which is correct: stored history is fixed model text and is not part of the frozen frontier.

- [ ] **Step 5: Append the tail state block before the user action**

In `buildPrompt`, immediately before the final `return messages`, add:

```typescript
  // L1: relocate live state to one tail block, just before the user action (so it sits
  // in the volatile tail, never in the cached frontier). 'partition' showed placeholders
  // in the frontier; 'diff' showed floor-0 values — either way this block is the live truth.
  if (cacheLevel >= 1) {
    const stateBlock = buildStateBlock(args.template?.vars)
    if (stateBlock) {
      const insertAt = userAction !== '' ? messages.length - 1 : messages.length
      messages.splice(insertAt, 0, { role: 'system', content: stateBlock })
    }
  }
```

> `buildPrompt` receives the already-frozen `frozenVars` from its caller; it does not call `frozenVarsFor` itself (that lives in `generationService`, Task 8). Only `buildStateBlock` is imported here (per Step 3).

- [ ] **Step 6: Run typecheck + test to verify they pass**

Run: `npm run typecheck && npx vitest run test/promptBuilder.test.ts`
Expected: PASS — all existing buildPrompt tests still green (level 0 unchanged) and the new L1 block passes.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/promptBuilder.ts test/promptBuilder.test.ts
git commit -m "feat(cache): L1 frozen frontier render + tail state block in buildPrompt"
```

---

### Task 8: Activate L1 from `generationService`

Compute the frozen snapshot from floor-0 and pass the cache level/mode into `buildPrompt`.

**Files:**
- Modify: `src/main/services/generationService.ts`
- Test: covered by Task 9 end-to-end verification (this wiring has no isolated unit; validated by typecheck + Task 9).

**Interfaces:**
- Consumes: `frozenVarsFor` from `./cacheLayers`; the new `buildPrompt` fields from Task 7.

- [ ] **Step 1: Add the import**

In `src/main/services/generationService.ts`, add:

```typescript
import { frozenVarsFor } from './cacheLayers'
```

- [ ] **Step 2: Compute level/mode/frozen snapshot**

In `generate`, after the existing `const userName = settings.persona?.name || 'User'` line, add:

```typescript
  // Prompt-cache level (L1 Frozen Core when ≥1). The frozen snapshot is derived from the
  // FIRST floor's variables — constant across the session — so the frontier render is
  // byte-stable. 'partition' shows placeholders for state; 'diff' shows the floor-0 values.
  const cacheLevel = settings.cache?.level ?? 0
  const l1Mode = settings.cache?.l1_mode ?? 'partition'
  const floor0Vars = floors[0]?.variables ?? {}
  const frozenVars = cacheLevel >= 1 ? frozenVarsFor(l1Mode, floor0Vars) : {}
```

- [ ] **Step 3: Pass them into `buildPrompt`**

In the `buildPrompt({ ... })` call, add these three fields alongside `matchedEntries` / `modeAddendum` / `template` (e.g. right after the `promptRegex:` line):

```typescript
    cacheLevel,
    l1Mode,
    frozenVars,
```

- [ ] **Step 4: Run typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck clean; all tests green. (Default `cache.level` is 0, so the live app is unchanged until the user opts in.)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/generationService.ts
git commit -m "feat(cache): activate L1 frozen core from generation (floor-0 snapshot)"
```

---

### Task 9: A/B verification — proxy delta L0 vs L1a vs L1b

A deterministic, send-free test proving L1 raises the stable-prefix proxy on a state-mutating MVU card, and a manual app check confirming nothing regresses.

**Files:**
- Create: `test/cacheAbHarness.test.ts`

**Interfaces:**
- Consumes: `buildPrompt`, `ChatMessage` from `../src/main/services/promptBuilder`; `stablePrefixTokens` from `../src/main/services/promptCacheMetrics`; `frozenVarsFor` from `../src/main/services/cacheLayers`; `initTemplates`.

- [ ] **Step 1: Write the A/B test**

Create `test/cacheAbHarness.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { buildPrompt, ChatMessage } from '../src/main/services/promptBuilder'
import { stablePrefixTokens } from '../src/main/services/promptCacheMetrics'
import { frozenVarsFor } from '../src/main/services/cacheLayers'
import { RPTerminalCardSchema, LorebookSchema } from '../src/main/types/character'
import { initTemplates } from '../src/main/services/templateService'

// A card whose lorebook embeds live state via EJS (命定之诗 shape).
const card = (): any => RPTerminalCardSchema.parse({ data: { name: 'Aria' } })
const book = (): any =>
  LorebookSchema.parse({
    name: 'B',
    entries: [
      { comment: 'core', content: '好感度:<%= getvar("stat_data.主角.好感度") %>', constant: true }
    ]
  })
const preset = (): any => ({
  name: 'P',
  parameters: { temperature: 0.9, max_tokens: 100 },
  prompts: [
    { identifier: 'cd', name: 'cd', role: 'system', content: '', enabled: true, marker: 'char_description' },
    { identifier: 'wi', name: 'wi', role: 'system', content: '', enabled: true, marker: 'world_info' },
    { identifier: 'ch', name: 'ch', role: 'system', content: '', enabled: true, marker: 'chat_history' }
  ]
})
const floor = (n: number, user: string, resp: string, hp: number): any => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: user, timestamp: 't' },
  response: { content: resp, model: '', provider: '' },
  events: [],
  variables: { stat_data: { 主角: { 好感度: hp } } }
})

// Assemble turn N at a given cache level/mode, with state that changes every turn.
const assemble = (
  turn: number,
  cacheLevel: number,
  l1Mode: 'partition' | 'diff'
): ChatMessage[] => {
  const floors = Array.from({ length: turn }, (_, i) => floor(i, `u${i}`, `a${i}`, 10 + i * 5))
  const floor0Vars = floors[0]?.variables ?? { stat_data: { 主角: { 好感度: 10 } } }
  const liveVars = { stat_data: { 主角: { 好感度: 10 + turn * 5 } } }
  return buildPrompt({
    card: card(),
    preset: preset(),
    lorebooks: [book()],
    floors,
    userAction: `act ${turn}`,
    cacheLevel,
    l1Mode,
    frozenVars: cacheLevel >= 1 ? frozenVarsFor(l1Mode, floor0Vars) : {},
    template: { vars: liveVars, globals: {}, constants: {} }
  })
}

describe('cache A/B — stable-prefix proxy across L0 / L1a / L1b', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('L0 poisons the frontier: the World Info segment is NOT in the stable prefix', () => {
    const t1 = assemble(1, 0, 'partition')
    const t2 = assemble(2, 0, 'partition')
    // The world-info message renders live 好感度, so it differs turn-to-turn → low prefix.
    const wiIdx = t2.findIndex((m) => m.content.startsWith('World Info:'))
    const prefix = stablePrefixTokens(t1, t2)
    expect(prefix.messages).toBeLessThanOrEqual(wiIdx) // cache dies at/before the WI message
  })

  it('L1a (partition) keeps the frontier stable: prefix reaches past World Info', () => {
    const t1 = assemble(1, 1, 'partition')
    const t2 = assemble(2, 1, 'partition')
    const wiIdx = t2.findIndex((m) => m.content.startsWith('World Info:'))
    const prefix = stablePrefixTokens(t1, t2)
    expect(prefix.messages).toBeGreaterThan(wiIdx) // World Info now inside the stable prefix
  })

  it('L1b (diff) also keeps the frontier stable', () => {
    const t1 = assemble(1, 1, 'diff')
    const t2 = assemble(2, 1, 'diff')
    const wiIdx = t2.findIndex((m) => m.content.startsWith('World Info:'))
    expect(stablePrefixTokens(t1, t2).messages).toBeGreaterThan(wiIdx)
  })

  it('L1 strictly beats L0 on the proxy for a state-mutating card', () => {
    const l0 = stablePrefixTokens(assemble(1, 0, 'partition'), assemble(2, 0, 'partition'))
    const l1 = stablePrefixTokens(assemble(1, 1, 'partition'), assemble(2, 1, 'partition'))
    expect(l1.tokens).toBeGreaterThan(l0.tokens)
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/cacheAbHarness.test.ts`
Expected: PASS — L0 prefix dies at/before World Info; L1a and L1b carry it into the stable prefix; L1 tokens > L0 tokens.

- [ ] **Step 3: Run the full suite + typecheck (regression gate)**

Run: `npm run typecheck && npm test`
Expected: PASS — no existing test regressed.

- [ ] **Step 4: Manual app verification**

Run the app (`npm run dev`), then:
1. Open a chat using a state-bearing card (or any card; the synthetic test already proves the mechanism).
2. In Settings, set `cache.level` to `1` (edit settings or add a temporary toggle — a UI control is out of scope for this plan; set it via the settings store / DB for now).
3. Send 2–3 turns. In the **Logs** panel, confirm a `cache proxy — stable prefix X/Y tok (Z%)` line appears each turn and Z rises after the first turn.
4. On an Anthropic key, confirm the existing `cache — read … · write …` line shows non-zero `read` by turn 2+.
5. Confirm the right-panel widgets still render current state (state relocation didn't break MVU tracking) and the reply quality is unchanged.

Document the observed L0 vs L1 proxy percentages in the commit message.

- [ ] **Step 5: Commit**

```bash
git add test/cacheAbHarness.test.ts
git commit -m "test(cache): A/B harness proving L1 raises the stable-prefix proxy vs L0"
```

---

## Out of scope (later plans)

- **L2 Lore Ratchet** (append-only lorebook), **L3** (compaction + episodic memory + retrieval + segment-diff corrections) — separate spec sections, separate plans.
- **Orthogonal knobs** — Anthropic breakpoint optimizer, 1-hour TTL, pre-warm (the `cache.ttl` / `cache.prewarm` / `cache.breakpoint_optimizer` fields are reserved here but unused).
- **Persisted PromptState** — the metrics + frozen snapshot are in-memory/per-build for now; L3 moves them into a per-chat blob.
- **Opus-4.8 `role:"system"` tail** — the state block is a plain system message here; routing it as a mid-conversation system message is a provider-realization refinement.
- **A settings UI control** for `cache.level` — set via the settings store for A/B testing in this plan.

## Self-Review

- **Spec coverage (design §10 harness, §6.1 L1, §5 ladder L0/L1, L1a/L1b sub-experiment):** Tasks 1–5 build the harness (settings dial, proxy, usage capture, accumulation, wiring); Tasks 6–8 build L1 (frozen vars, tail block, buildPrompt + generation wiring); Task 9 proves L1a vs L1b vs L0. L2/L3/knobs explicitly deferred.
- **Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every step shows full code or an exact before/after edit.
- **Type consistency:** `Usage`, `TurnStat`, `CacheReport` defined in Task 2 and consumed unchanged in Task 4; `frozenVarsFor`/`buildStateBlock` defined in Task 6 and consumed in Tasks 7–8; `UsageCallback` defined in Task 3 and consumed in Task 5; `BuildPromptArgs` fields (`cacheLevel`/`l1Mode`/`frozenVars`) defined in Task 7 and supplied in Task 8.
- **Level-0 invariance:** Tasks 5/7/8 are gated on `cacheLevel >= 1`; existing `promptBuilder`/`generation` tests are the regression guard (Tasks 5, 8, 9 run the full suite).
