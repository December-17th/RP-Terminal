# Token Meter + Cache-Hit History — Design

> **Status:** Design approved (brainstorm). Next step: implementation plan (writing-plans).
> **Date:** 2026-06-22.
> **Siblings:** builds directly on `docs/prompt-cache-optimization-design.md` and
> `docs/prompt-cache-harness-l1-plan.md` (the L0 measurement harness + L1 Frozen Core, already shipped).

## 1. Goal

Give the app a **token + cache-hit meter** with two surfaces and durable per-turn history:

1. A **live floating overlay** (draggable, toggleable, persisted position) showing the latest turn's tokens
   and cache hit, plus running averages — for glancing during play.
2. A **history / diagnostics workspace view** with a per-turn table and hand-drawn charts, plus CSV/JSON
   export — for after-the-fact analysis.

Both surfaces are **configurable** (the user picks which fields/columns show), **all per-turn data is
recorded**, and an **optional cost ($)** layer appears once the user enters per-model prices.

The existing harness already computes the two core numbers every turn (`promptCacheMetrics.ts`): the
deterministic **stable-prefix proxy** (the "estimated" cache hit, computable from the assembled prompt) and
the provider's **real usage** (`normalizeUsage`). This feature persists, aggregates, surfaces, and graphs them.

### Non-goals (v1)

- Cross-chat / global aggregates (per-active-chat only).
- Per-swipe metric history (the floor's metric tracks the active/last-generated swipe).
- Live-streaming output-token counter (output settles once per completed turn).
- A charting dependency (charts are hand-rolled inline SVG).
- Pre-send prediction of the _next_ prompt's cache hit (the proxy on each completed turn is the "estimate").

## 2. Architecture overview

```
generationService.generate()                      (main)
  ├─ assembles `messages` (ChatMessage[])         ← already happens
  ├─ streams reply, captures rawUsage             ← already happens
  ├─ buildFloorMetrics({messages, prevMessages,   ← NEW pure fn
  │     usage, …, prevCumulative}) → FloorMetrics
  └─ appendFloor({ …, request: messages, metrics })← metrics persisted on the floor row
            │
chatIpc ───┼─ event.sender.send('metrics-turn', { chatId, metrics })   ← NEW live push
            │
renderer ──┤
  ├─ usageStore  ← metrics-turn event + seed from active chat's latest floor.metrics
  ├─ UsageOverlay (App root, gated by settings.ui.usage_meter.enabled)
  └─ UsageView   (workspace view 'usage') ← derives series from chatStore floors
        └─ costFor(usage, rates)  ← pure src/shared fn, rates from settings.pricing
```

**Source of truth = the floors themselves.** Metrics ride on the floor row alongside `request`. The renderer
already loads floors into `chatStore`, so history/graphs derive from `floors.map(f => f.metrics)` with no new
read IPC, and truncation-safety is automatic (deleted floors are simply absent). The `metrics-turn` event is
only an instant-update optimization for the overlay.

## 3. Data model

### 3.1 Types (extend `src/main/services/promptCacheMetrics.ts`)

`Usage` already exists: `{ cacheRead, cacheWrite, input, output }`.

```ts
/** One generated turn's own metrics. */
export interface TurnMetric {
  ts: string // ISO timestamp (passed in; not generated inside the pure fn)
  provider: string
  model: string
  cacheLevel: number // settings.cache.level at send time
  l1Mode: 'partition' | 'diff'
  promptTokens: number // estimated total prompt tokens sent (sum of estimateTokens)
  proxyTokens: number // stable-prefix proxy tokens vs the previous turn
  proxyPct: number // proxyTokens / promptTokens * 100   (the "estimated" cache hit)
  outputTokens: number // usage.output if present, else estimateTokens(responseText)
  usage: Usage | null // provider's real usage, or null
}

/** Running tally over all generated floors up to and including this one. */
export interface CumulativeMetric {
  turns: number // generated turns counted
  usageTurns: number // of those, how many reported real usage
  totalPromptTokens: number
  totalProxyTokens: number
  totalOutputTokens: number
  usage: Usage | null // element-wise sum over usage turns (null if usageTurns === 0)
  avgPromptTokens: number // totalPromptTokens / turns
  avgOutputTokens: number // totalOutputTokens / turns
  avgProxyPct: number // mean proxyPct over ALL turns
  avgCacheHitPct: number // mean real cacheHitPct over USAGE turns (0 if none)
}

/** Persisted on each generated floor (floors.metrics). */
export interface FloorMetrics {
  turn: TurnMetric
  cumulative: CumulativeMetric
}
```

### 3.2 Derived quantities

- **Real per-turn cache hit:** `cacheHitPct(usage) = cacheRead / (cacheRead + cacheWrite + input) * 100`
  (fraction of input tokens served from cache). Defined only when `usage` is present.
- **Cost is NOT stored** — derived on read (§7) so editing a price re-prices history retroactively.

### 3.3 Why cumulative is denormalized

Each floor carries the running tally so it is a **self-contained graph point**. The only delete operation,
`deleteFloorAndSubsequent` (truncate-from-N), leaves floors `0..N-1` with already-correct cumulatives — **no
recompute, no cascade**. This is the explicit reason for storing cumulative per floor rather than recomputing
from a global accumulator.

## 4. Main-side compute & persistence

### 4.1 `buildFloorMetrics` (pure — new, in `promptCacheMetrics.ts`)

```ts
export const buildFloorMetrics = (args: {
  messages: ChatMessage[]
  prevMessages: ChatMessage[] | null     // previous floor's stored `request`
  usage: Usage | null
  provider: string
  model: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  ts: string
  responseText: string                   // for the output-token fallback
  prevCumulative: CumulativeMetric | null
}): FloorMetrics
```

- `proxy = stablePrefixTokens(prevMessages ?? [], messages)` (reuses the existing pure fn).
- `promptTokens = sum(estimateTokens(m.content))`.
- `outputTokens = usage?.output ?? estimateTokens(responseText)`.
- **Running means** (no extra fields needed): with `c = prevCumulative`,
  - `turns = c.turns + 1`
  - `avgProxyPct = (c.avgProxyPct * c.turns + turn.proxyPct) / turns`
  - if `usage`: `usageTurns = c.usageTurns + 1`,
    `avgCacheHitPct = (c.avgCacheHitPct * c.usageTurns + cacheHitPct(usage)) / usageTurns`
    else `usageTurns`/`avgCacheHitPct` carry over unchanged.
  - usage sums are element-wise and null-safe.
- First floor (`prevCumulative === null`): `proxyPct = 0`, `turns = 1`, averages = this turn's values.

### 4.2 Persistence (mirror the `request` column exactly)

- `src/main/services/db.ts`: `addColumnIfMissing(db, 'floors', 'metrics', 'metrics TEXT')`.
- `src/types/chat.ts` `FloorFile`: add `metrics?: FloorMetrics`.
- `src/main/services/floorService.ts`:
  - `FloorRow`: add `metrics: string | null`.
  - `rowToFloor`: `metrics: r.metrics ? safeJson(r.metrics, undefined) : undefined`.
  - `saveFloor` INSERT: add `metrics` to the column list, the `VALUES` placeholders, and the `ON CONFLICT …
SET` clause; bind `floor.metrics ? JSON.stringify(floor.metrics) : null`.

### 4.3 Wiring `generationService.generate`

The previous generated floor is already in hand as `lastFloor = floors[floors.length - 1]`.

- After a successful stream, compute:
  ```ts
  const metrics = buildFloorMetrics({
    messages,
    prevMessages: lastFloor?.request ?? null,
    usage: normalizeUsage(settings.api.provider, rawUsage),
    provider: settings.api.provider,
    model: settings.api.model, // whatever id is sent
    cacheLevel,
    l1Mode,
    ts: new Date().toISOString(),
    responseText: cleaned,
    prevCumulative: lastFloor?.metrics?.cumulative ?? null
  })
  ```
- Attach `metrics` to the `FloorFile` built at the end of `generate` (next to `request: messages`) before
  `appendFloor`. `generate` already returns the floor, so `metrics` rides along.
- Keep the one-line log, now sourced from `metrics.turn`:
  `cache — stable prefix {proxyTokens}/{promptTokens} ({proxyPct}%) · live read … / write …`.

### 4.4 Retire the in-memory accumulator

`cacheMetricsService.ts` (`byChat` Map, `recordTurn`, `getReport`, `resetChat`) is superseded by floor-derived
cumulative. Remove it and its imports/calls in `generationService` (including the `resetChat` calls on
regenerate/truncate — no longer needed, since the new latest floor's cumulative is correct by construction).
Its test `test/cacheMetricsService.test.ts` is replaced by `buildFloorMetrics` tests.

### 4.5 Backfill + recompute (new `src/main/services/usageMetricsService.ts`)

- `backfillProxyMetrics(profileId, chatId)` — walk floors in order; for any floor missing `metrics` but with a
  stored `request`, recompute the **deterministic proxy + cumulative** chaining from the prior floor (passing
  `usage: null`, since real provider usage is unavailable retroactively); `saveFloor` each. Exposed over IPC
  (`backfill-usage-metrics`) for the Usage view's "Backfill proxy" button. Forward-only by default: existing
  chats show "no data" until backfilled.
- `recomputeCumulativeFrom(profileId, chatId, fromFloor)` — replay cumulative forward over survivors. **Not
  needed by any current operation** (the only delete is truncate-from-N), included defensively and reused by
  the backfill walk. Flagged optional.

### 4.6 Live event

In `chatIpc`, after `generate`/`regenerate`/`swipe` resolve, emit
`event.sender.send('metrics-turn', { chatId, metrics: floor.metrics })` (mirrors the existing
`generation-delta` channel). Preload exposes `onMetricsTurn(cb)` like the delta listener.

## 5. Live overlay

### 5.1 Settings (`settings.ui`, snake_case to match existing keys)

```js
usage_meter: {
  enabled: false,                  // canonical toggle (like show_fps)
  x: null, y: null,                // persisted drag position (px from top-left; null = default corner)
  collapsed: false,                // collapsed to a tiny chip
  fields: ['proxyPct', 'cacheHitPct', 'promptTokens', 'avgCacheHitPct']  // which rows show
}
```

Added to `getDefaultSettings()` and merged in `normalize()` (same pattern as `cache`/`workspace`).

### 5.2 `usageStore.ts` (zustand, renderer)

Holds `latest: FloorMetrics | null` for the active chat. Filled by (a) the `metrics-turn` event → set latest;
(b) chat switch → seed from the active chat's latest floor `.metrics` (already in `chatStore`). Subscribes to
the event only while the overlay is enabled.

### 5.3 `UsageOverlay.tsx`

Mounted at App root: `{settings?.ui?.usage_meter?.enabled && <UsageOverlay/>}` — costs nothing when off,
exactly like `FpsOverlay`. Features:

- **Draggable** via pointer handlers; on drag-end, debounce-persist `{x, y}` into `settings.ui.usage_meter`
  through `settingsStore` (the workspace's debounce-persist idiom).
- **Gear → field checklist** of available fields (toggles `fields`); persisted.
- **Collapsible** to a chip (`est% · tok`) and back; `collapsed` persisted.
- One-click hide (✕) flips `enabled` off.
- Renders the selected subset of `usageStore.latest`, grouped **This turn** / **Session**, with cache numbers
  labelled **est** (proxy) vs **actual** (provider). `$` rows appear only when `settings.pricing` has a rate
  for `turn.model` (cost via §7).

### 5.4 Toggle

A switch in the Settings panel next to "Show FPS" sets `usage_meter.enabled`.

## 6. History workspace view

`'usage'` registered in `src/renderer/src/components/workspace/viewRegistry.tsx` (+ `VIEW_OPTIONS`) so "Usage"
is droppable into any workspace panel slot. `UsageView.tsx` derives the series for the active chat from
`chatStore` floors: `floors.map(f => f.metrics).filter(Boolean)`; recomputes on floor change. Three stacked parts:

1. **Summary header** — from the latest floor's `cumulative`: turns, avg cache-hit % (actual) and avg est %
   (proxy), avg prompt tokens, totals (read/write/in/out), and est session `$` (only if priced).
2. **Chart** (`TurnChart.tsx`, hand-rolled inline SVG) — per-turn cache % across turns with two series, **est
   (proxy)** vs **actual**; a second toggleable chart for prompt-tokens (or `$`) per turn. No charting dep.
3. **Per-turn table** — one row per floor: `#`, prompt tok, est %, actual %, read, write, output tok, `$`
   (if priced). Scrollable; clicking a row scrolls the chat to that floor (small nice-to-have).

**Configurable** via a gear (same idiom as the overlay): which columns + which charts show, persisted in
`settings.ui.usage_view` (`{ columns: string[], charts: string[] }`; defaulted + normalized like the others).

**Logging / export:** the per-floor SQLite history _is_ the durable log; the existing one-line `logService`
summary per turn stays. The view adds **Export (CSV / JSON)** for the active chat's series, and a **Backfill
proxy** button calling `backfill-usage-metrics` (then refreshing floors).

## 7. Pricing / cost

### 7.1 Settings (`settings.pricing`, new top-level section)

```js
pricing: {
  // keyed by exact model id; rates are $ per 1,000,000 tokens. Empty by default ⇒ tokens-only.
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
}
```

Defaulted to `{}` in `getDefaultSettings()` and merged in `normalize()`.

### 7.2 `costFor` (pure — new `src/shared/usageCost.ts`)

```ts
export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

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

Lives in `src/shared` (imports nothing from main/renderer). Both overlay and view call it with
`floor.metrics.turn.usage` + the rate row from `settingsStore`. Because cost is derived from stored token
fields + current settings, **editing a price re-prices all history instantly** with no migration.

### 7.3 Honesty rule

`$` requires the provider's **real** usage (to weight cache-read vs fresh input). When `usage` is null
(provider sent none, or a backfilled old turn), cost shows **"—"**, never a guess. Tokens still display.
Session `$` sums only the turns that have a cost.

### 7.4 Editor

A small table in the Settings panel — rows = model ids, columns = input / output / cacheRead / cacheWrite
($/1M) — add/edit/remove, prefilling a row for the currently-selected API model id. USD assumed (a currency
label is a trivial later add).

## 8. Files

**New:**

- `src/shared/usageCost.ts` (+ `test/usageCost.test.ts`)
- `src/main/services/usageMetricsService.ts` (backfill + recompute; + `test/usageMetricsService.test.ts`)
- `src/renderer/src/stores/usageStore.ts`
- `src/renderer/src/components/UsageOverlay.tsx`
- `src/renderer/src/components/UsageView.tsx`
- `src/renderer/src/components/TurnChart.tsx`
- IPC: `src/main/ipc/usageIpc.ts` (backfill handler) — or fold into existing chat IPC

**Modified:**

- `src/main/services/promptCacheMetrics.ts` (`TurnMetric`/`CumulativeMetric`/`FloorMetrics`, `buildFloorMetrics`)
- `src/main/services/db.ts` (`metrics` column migration)
- `src/main/services/floorService.ts` + `src/types/chat.ts` (`metrics` (de)serialize + `FloorFile` field)
- `src/main/services/generationService.ts` (compute + attach + log; drop `cacheMetricsService`/`resetChat`)
- `src/main/ipc/chatIpc.ts` (`metrics-turn` event)
- `src/main/services/settingsService.ts` + `src/main/types/models.ts` (`ui.usage_meter`, `ui.usage_view`, `pricing`)
- `src/preload/index.ts` (+ d.ts) (`onMetricsTurn`, backfill invoke)
- `src/renderer/src/App.tsx` (mount overlay)
- `src/renderer/src/components/workspace/viewRegistry.tsx` (+ `VIEW_OPTIONS`) (register `usage`)
- `src/renderer/src/components/SettingsPanel.tsx` (overlay toggle + pricing editor)

**Removed:**

- `src/main/services/cacheMetricsService.ts` + `test/cacheMetricsService.test.ts` (superseded by floor-derived cumulative)

## 9. Testing

### 9.1 Pure unit tests (Vitest, `test/*.test.ts`)

- **`buildFloorMetrics`:** first floor (null prev) → proxy 0, `turns 1`, averages = turn values; second turn
  with a stable prefix → proxy > 0, cumulative aggregates, running means correct; `usage` null vs present →
  `usageTurns` and `avgCacheHitPct` only advance on usage turns; `cacheHitPct = cacheRead/(cacheRead+cacheWrite+input)`;
  `outputTokens` fallback (provider `output` vs `estimateTokens`).
- **`costFor`:** cache-weighted math with rates; null when rates missing or `usage` null; precision.
- **`backfillProxyMetrics` / `recomputeCumulativeFrom`:** truncate-from-N leaves `0..N-1` untouched; backfill
  recomputes deterministic proxy across a chain of `request`-bearing floors with `usage` staying null.
- **`floors.metrics` round-trip:** the new TEXT column (de)serializes like `request`/`swipes`.

### 9.2 Regression gate

`npm run typecheck && npm test`. Assert metrics are computed **from** the already-assembled `messages`
(post-hoc), so **level-0 / baseline prompt output stays byte-identical** — metrics never alter what is sent.

### 9.3 Manual verification (renderer has no component-test harness)

1. Settings → toggle the overlay on → it appears; drag it → position persists across an app restart.
2. Gear → toggle fields → the displayed rows change and persist; collapse/expand persists.
3. Run 2–3 turns → overlay + Usage view update; the est-vs-actual chart draws; the table fills.
4. Enter a price for the active model → `$` appears retroactively across history; clear it → back to tokens-only.
5. Export CSV and JSON from the Usage view; open and sanity-check.
6. Open an old chat (pre-feature) → "no data"; click **Backfill proxy** → est % fills, actual stays "—".
7. Truncate the chat to an earlier floor → earlier floors' numbers/graph are unchanged.

## 10. Open questions / future work

- Cross-chat global aggregate dashboard (needs scanning all chats).
- Per-swipe metric history.
- Live-streaming output-token counter (deferred; small).
- Currency label / non-USD.
- Pre-send estimate of the next prompt's cache hit.
