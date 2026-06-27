# Prompt-Cache Optimization — Design

> **DECISION (2026-06-26, WS-2): the cache-optimization system is STASHED (low priority).** Owner call: park
> it for later review. Concretely:
>
> - **A three-way `cache.mode` selector exists but is GREYED OUT, pinned + defaulting to `baseline`.**
>   - **`baseline` (default, pinned):** **NO optimization at all — not even provider-side prompt caching.**
>     The Anthropic `cache_control` breakpoints are omitted ([apiService `buildAnthropicCacheLayout`](../src/main/services/apiService.ts)).
>     A clean **reference control** for measuring any future optimization against. (OpenAI's auto prefix
>     cache is transparent and can't be disabled client-side; "baseline" disables everything we control.)
>   - **`provider`:** provider prefix caching as-is (Anthropic `cache_control` on), no app-side layering.
>   - **`frozen`:** the L1 "Frozen Core" app-side layering (`cacheLayers.ts` + the `frontierTemplate`/
>     `buildStateBlock` fork in `promptBuilder`) — **experimental/dormant, unvalidated**, reachable only via
>     this (currently unselectable) mode.
> - **The Frozen-Core options are kept (not deleted) for later review.** It has **never been validated**
>   against real provider cache behavior — the meter's "stable prefix %" is a _proxy_ (byte-prefix stability),
>   NOT a measured cache-hit rate. The app already records real provider cache tokens per floor, so a future
>   A/B (baseline vs provider vs frozen, comparing `cacheRead`) needs no new plumbing.
> - **To revisit:** un-grey the selector ([SettingsPanel.tsx](../src/renderer/src/components/SettingsPanel.tsx)),
>   then either validate `frozen` (keep if it beats `provider`) or delete the `partition`/`diff` dual-mode +
>   the `buildPrompt` fork (review WS-2, option B). See
>   [structural-cleanup-log-2026-06-26.md](structural-cleanup-log-2026-06-26.md) Stage 16.

**Status:** Design (shape approved) — **STASHED 2026-06-26; default `baseline` (no caching). See the note above.**
**Date:** 2026-06-22
**Extends:** Phase G (four-layer cache assembly) and Phase H (per-mode lore freeze).
**Supersedes:** the deferred "aggressive segment-diff cache stabilization" sketch in `ROADMAP.md` (§590–603).
**Related:** [agentic-mode-design.md](agentic-mode-design.md), [mvu-support-design.md](mvu-support-design.md), [st-prompt-template-plan.md](st-prompt-template-plan.md).

---

## 1. Goal and the floor

**Goal.** Maximize provider prompt-cache hit across long roleplay sessions — hundreds to
thousands of exchanges — with sophisticated MVU / 命定之诗-style cards, **without changing how
those cards behave for the player.**

**The floor (must hold at every level of the design):**

- **MVU variable tracking stays acceptable.** Emitted state still folds into `floor.variables`
  exactly as today (rpt-event / `<UpdateVariable>` → `mvuParser` → variables), the model still
  sees the **correct current state every turn**, and the right-panel widgets are unaffected.
- **Memory persistence stays acceptable.** Nothing the model needs is silently dropped. Older
  context is preserved — verbatim while it fits the window, summarized and retrievable once it
  does not.

**Non-goal (explicitly out of scope, forward-compatible).** Moving MVU variable _computation_
from the AI to deterministic sandboxed scripts. This design governs _where_ `stat_data` sits in
the prompt, not _how_ it is produced, so a later script-driven update engine drops in unchanged.

---

## 2. Why complex cards miss the cache today

Provider prompt caching is a **strict prefix match**: any byte change anywhere in the prefix
invalidates the cache for everything after it (render order `tools → system → messages`). The
existing Phase G assembly is ordered for this (stable head → volatile tail), but four things
re-write the supposedly-stable head every turn on a heavy MVU card:

1. **Build-time EJS over mutable state (the dominant killer).** `promptBuilder.buildPrompt`
   renders the character description, examples, post-history, **and every matched lorebook
   entry** through the quickjs engine with `template.vars` set to the _previous floor's_
   `stat_data` (`promptBuilder.ts` `makeRender` / `render`; fed from
   `generationService.ts`). An entry containing `<%= getvar('stat_data.主角.好感度') %>`
   renders to **different bytes whenever state changes** — i.e. nearly every turn — so L1 and L2
   mutate and `cache_read` collapses to ~0 over the whole prefix.
2. **Per-turn re-matching with probability rolls.** In classic mode `matchAcross` re-scans every
   turn and `rollPasses` uses `Math.random` (`lorebookService.ts`), so even identical scan text
   can yield a different matched set / order → L2 bytes change. (Phase H freezes the _set_ per
   mode but not the _rendered content_ — problem 1 still applies.)
3. **Depth injections demoted to user turns (Anthropic).** Depth-positioned lore/persona are
   spliced into history and, in `streamAnthropic`, demoted to `user` turns and merged
   (`apiService.ts`), so volatile content lands _inside_ the cached region.
4. **Position-based breakpoint.** `streamAnthropic` always marks `merged.length - 2`, the message
   before the final user turn — chosen by position, not by where the prompt is actually stable.

The lever, therefore, is to **separate genuinely-static authored content from state-dependent
content, keep the static part byte-identical, and move the volatile part past the cache
breakpoint** — while still showing the model correct current state.

---

## 3. What already exists (and is reused)

- **Phase G — four-layer assembly** (`promptBuilder.ts`): `L1` system + char description +
  examples → `L2` world info → `L3` rolling history → `L4` volatile user action (always last).
  `estimateTokens`, `fitToBudget`, `buildScanText`, `applyDepthInjections`,
  `collectRenderMarkers` all stay.
- **Phase H — per-mode lore freeze** (`chatService.ts` `CachedWorldInfo` + `cached_world_info`
  column; consumed in `generationService.ts`): a matched set cached on the chat and reused within
  a mode. This generalizes into the lorebook ratchet (§6.2).
- **Anthropic cache_control** (`apiService.ts` `streamAnthropic`): two breakpoints (system block;
  `merged.length-2`) and `usage` logging of `cache_read` / `cache_creation` / `input`. This
  generalizes into the provider realization (§7) and the live A/B metric (§10).
- **Reserved storage**: the `episodic_memory` table is already declared in `db.ts` for §6.3.
- **Secondary-API pattern**: api-presets (`settingsService.ts`) already support multiple named
  connections; the summarizer / retriever ride on a "utility" connection (§8).

---

## 4. Core model: a ratcheting frontier, an ephemeral tail, and compaction checkpoints

The whole design follows from one reframing. Caching is a prefix match, so **the only cache-safe
place to add anything is at the end of the byte-stable prefix.** The prompt is therefore not four
static layers but a **frontier** — the end of the cached prefix — that _ratchets forward_ by
append-only growth, with everything genuinely per-turn living _beyond_ it.

```
[ system + card ][ lore: l1 l2 l3 … ][ verbatim turns: r1 r2 r3 … ] │ state · recalled-memories · corrections · NEW action
└────────────────── FRONTIER (byte-stable, cached, ratchets right) ──────────┘ └──── EPHEMERAL TAIL (re-sent every turn, never cached) ────┘
                                                              ↑ cache breakpoint
```

**Two rules:**

- **Durable content appends at the frontier** (advancing it): newly-triggered lore, and each
  turn's user+assistant pair once settled. Written once, cache-read forever after.
- **Ephemeral content lives past the frontier** (re-sent fresh each turn, never poisoning the
  cache): this turn's `stat_data` snapshot, the recalled memories, any segment-diff corrections,
  and the pending user action.

The dividing line: **lore ratchets (triggered once → durable); episodic memory floats
(re-selected each turn → ephemeral).** This is the precise answer to "L3 or L4": durable lore
stays in the frontier; recalled memory must be in the tail.

**Compaction checkpoint.** A frontier that only grows eventually exhausts the context window. So
**every cache-invalidating change is concentrated into infrequent, scheduled compaction
checkpoints.** Between checkpoints: pure append-only ratcheting (maximum cache hit). At a
checkpoint (fired by a token threshold, every ~N turns, or a mode transition) the frontier is
rebuilt **once** — one honest cache-write, amortized over the next interval — and all expensive
bookkeeping happens together:

- fold the oldest verbatim turns into a summary → `episodic_memory`;
- evict stale lore (the eviction the ratchet cannot do per-turn without breaking append-only);
- flush accumulated segment-diff corrections into a fresh, correct render of system/card/lore;
- re-roll probability lore and re-freeze the decisions.

**How the prior ideas map onto this one mechanic:**

| Idea                      | Role in the model                                                  |
| ------------------------- | ------------------------------------------------------------------ |
| Cache-stable assembly     | the frontier/ratchet discipline + breakpoint placement             |
| Append-only lorebook      | the lore half of the ratchet                                       |
| Episodic compression      | what compaction does to history                                    |
| Memory retrieval (RAG)    | what fills the ephemeral tail each turn                            |
| Segment-diff + correction | how unavoidable mid-frontier drift is deferred between checkpoints |

---

## 5. The level ladder (the A/B dial)

The simpler measures are **strict prefixes of the full system** — each is the next one minus its
top layer — so A/B testing is a feature flag (`settings.cache.level`), and every level is
shippable value plus a rung toward the full design.

| Level                   | Adds over previous                                     | Byte-stable prefix                        | History                 | MVU state via                  | Memory persistence      | Complexity | Holds to ~        |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------- | ----------------------- | ------------------------------ | ----------------------- | ---------- | ----------------- |
| **L0** baseline (today) | Phase G + 2 bp + Phase H                               | system only (poisoned by in-place EJS)    | full verbatim           | rendered in place (volatile)   | full prompt             | —          | control           |
| **L1** Frozen Core      | freeze L1/L2 _rendering_; relocate live state to tail  | system + card + examples                  | full verbatim           | one tail "current state" block | full prompt             | low        | tens–low hundreds |
| **L2** Lore Ratchet     | append-only lore; roll-once-freeze                     | system + card + **lore**                  | full verbatim           | tail                           | full prompt             | medium     | hundreds          |
| **L3** Full             | compaction + episodic memory + retrieval + corrections | system + card + lore + summarized history | summary + recent window | tail                           | `episodic_memory` table | high       | thousands         |

`settings.cache.level` (0–3) selects the level, per profile or per chat. Because levels are
supersets, switching is a config change, not a rebuild of the codebase.

**Sub-experiment inside L1 (the original A/B you flagged).** Two implementations of the same
frozen-core level:

- **L1a (partition)** — statically detect state-dependent EJS, render the frontier with a frozen
  context, relocate live state to the tail. No stale value ever sits in the prefix.
- **L1b (diff / correct)** — render live as today, but keep the _old_ bytes in place and emit a
  _correction_ in the tail. No template understanding required, but the prefix carries an aging
  stale value until the next checkpoint.

L1a vs L1b answers: _is static partitioning worth the complexity, or does a runtime byte-diff get
most of the win?_

---

## 6. Subsystem specs

### 6.1 Frozen-context rendering + state relocation (L1)

**Change.** `promptBuilder` renders frontier content (char description, examples, post-history,
top-level lore) with a **frozen template context** — session constants only (`userName`,
`charName`, `characterId`, etc.), **no mutable `vars`/`stat_data`** — so the rendered bytes are
identical every turn. The current state is emitted **once**, as a single consolidated block in
the ephemeral tail.

**Fidelity (hybrid; the approved default).**

- _Known continuous state_ (`stat_data`) — rendered as a neutral placeholder where the author
  embedded it (e.g. `好感度: <see current state>`), with the live numbers carried only in the
  tail block, from turn 0. No contradiction, no aging, fixed-size correction.
- _Unpredictable occasional change_ (a lore entry / regex result that shifts now and then) — falls
  to the L1b diff/correction path (§6.5).

Detecting "state-dependent": an EJS fragment is treated as volatile if its compiled body reads
mutable scope (`getvar`/`getMessageVar`/`variables`/`stat_data`, vs. session-constant reads). The
template engine (`shared/templateEngine.ts`) already isolates these accessors, so classification
is a static check over the compiled template, not a regex over source.

**State block contents.** The current `stat_data` (and any message-scoped vars the card surfaces),
serialized compactly. Placed in the tail; on Opus 4.8 it may ride as a `role:"system"`
mid-conversation message (§7). Folding into `floor.variables` is unchanged — the floor is still
the source of truth for widgets.

**Files.** `promptBuilder.ts` (`makeRender`/`render` gain a frozen variant + a tail emitter);
`generationService.ts` (pass a frozen context for the frontier, keep the live context for the
tail); `templateService.ts` / `shared/templateEngine.ts` (expose the volatility classification).

### 6.2 Lorebook ratchet (L2)

**Change.** Lorebook entries become **append-only** per chat. Once an entry is triggered it is
appended at the frontier and **never reordered or removed** until a compaction checkpoint;
probability is **rolled once and frozen** at first inclusion. New triggers append after the
existing stable prefix (your `p1 l1 r1 p2 [l2]` shape), not back beside earlier entries.

**State.** The accumulated lore set is persisted per chat — entry ids, the frozen rendered bytes,
and the roll decisions — extending `CachedWorldInfo` into the broader `PromptState` blob (§8).
Matching still uses `matchAcross`, but its output is _unioned into_ the accumulator rather than
_replacing_ it. Depth-injected lore that is inherently positional/volatile is **not** ratcheted;
it goes to the tail.

**Bounding.** Pure accumulation is bounded only at checkpoints (§6.3), where stale entries
(untriggered for a long window) are evicted in the single allowed rebuild.

**Files.** `lorebookService.ts` (a union/accumulate entry alongside `matchAcross`);
`promptBuilder.ts` (emit the accumulated set in trigger order, frozen-rendered);
`chatService.ts` (persist the accumulator).

### 6.3 Compaction checkpoint + episodic memory (L3)

**Trigger.** Token-threshold primary (frontier exceeds a configured share of the model's context
window), turn-count fallback (every N turns), plus mode/scene transitions when agentic mode is on.
At L3, `fitToBudget`'s drop-oldest is superseded by "summarize-oldest at the next checkpoint"; at
L0–L2 `fitToBudget` still trims verbatim history as today.

**Action (one rebuild).** Summarize the oldest verbatim turns with the utility model into one or
more `episodic_memory` rows; drop those turns from the verbatim window; evict stale lore; flush
corrections into a fresh frontier render; re-roll + re-freeze probability lore. Exactly one
cache-write of the rebuilt frontier, amortized over the next interval.

**`episodic_memory` schema** (table already reserved in `db.ts`):
`id`, `chat_id`, `turn_start`, `turn_end`, `summary` (text), `keywords` (text, for keyword
recall), `embedding` (nullable blob, for optional vector recall), `salience` (real),
`created_at`. FK to `chats`, indexed by `chat_id`.

**Summarizer.** Runs at checkpoints only, off the hot path (may run in the background between
turns); calls the utility API connection (§8). Fail-safe: if summarization fails, the turns stay
verbatim and the checkpoint is retried later — never block generation.

**Files.** new `compactionService.ts`; `db.ts` (finalize `episodic_memory`); `chatService.ts`
(window + checkpoint bookkeeping); `generationService.ts` (invoke the scheduler).

### 6.4 Memory retrieval (L3)

**Change.** Before the main call, select **Y** relevant memories and inject them into the
**ephemeral tail** (never the frontier). Default selection: **keyword + recency** over
`episodic_memory`, reusing the existing lorebook matcher (zero extra API call per turn). Optional
upgrades behind a setting: an LLM-pick (utility model chooses from memory descriptions) or vector
search over `embedding` (user-configured embedding API). Matches the repo stance — keyword
primary, RAG optional, user-API-based, no local ML.

**Files.** `retrievalService.ts` (selection strategies); `promptBuilder.ts` (tail injection
point); `settingsService.ts` (strategy + Y).

### 6.5 Segment diff + corrections (L1b and L3)

**Change.** Persist the previous turn's assembled prompt **segmented by origin** (each lore entry,
card field, preset block, history turn). Each turn, diff segment-by-segment. For a changed
frontier segment, the optimizer chooses, by cost, between:

- **send-new** — emit fresh bytes (voids the cache from that segment down); or
- **keep-old + correct** — emit the cached bytes in place and append a correction in the tail.

Because the cached prefix is contiguous, the decision reduces to **one cut point**: how far the
frozen prefix extends before switching to send-new. Walk the cut outward, accumulating cached
tokens, until the per-turn correction cost of swallowing the next changed segment exceeds the
cache-read it preserves (a position-weighted comparison — a change near the top is worth freezing
because it would void the entire lorebook below it; a change in the last entry is not).
Corrections accumulate only until the next checkpoint, which flushes them.

**Files.** new `promptDiff.ts` (segmentation + diff + cut-point cost model); `promptBuilder.ts`
(emit keep-old + tail corrections); `PromptState` (persist last segmentation).

---

## 7. Provider realization

The frontier discipline is provider-neutral. `promptBuilder` emits a neutral **PromptPlan**
(ordered durable segments + frontier marker + ephemeral tail + cache-point hints); each provider
serializer in `apiService.ts` realizes the cache points:

- **Anthropic** — `cache_control` at the frontier plus a few fixed interior points (end of
  system; end of turn-1 lore) for resilience; **≤4 breakpoints** total. **1-hour TTL on
  system/lore** (they rewrite only at checkpoints, and human turns routinely pause >5 min and
  evaporate the default cache); 5-min TTL is fine on the history breakpoint. On **Opus 4.8** the
  tail's state/corrections may be sent as `role:"system"` mid-conversation messages — cache-safe
  _and_ the non-spoofable operator channel — instead of demoting them to `user` turns (replacing
  the current demotion in `streamAnthropic`).
- **OpenAI-compatible** — no markers; the append-only frontier _is_ what automatic prefix caching
  rewards. Keep the existing last-user-message-to-end fix. **Do not change tools or model
  mid-session** (either invalidates the entire cache).
- **Gemini** — implicit prefix caching is free; optional explicit `cachedContents` over the frozen
  core (with TTL) is a later add.

**Mechanical constraints to honor:** keep the ephemeral tail and per-turn durable appends to **few
content blocks** (concatenate, don't fragment) — each breakpoint only looks back **20 content
blocks** to find the prior cache entry. Minimum cacheable prefix is model-dependent (Opus 4096
tokens; Sonnet 4.6 / Fable 2048) — the frontier easily clears this for these cards, but a tiny
turn-1 lore set may not cache until it grows.

**Files.** `apiService.ts` (consume PromptPlan; per-provider cache-point realization, TTL,
Opus-4.8 system messages); `promptBuilder.ts` (emit PromptPlan).

---

## 8. Data model and components

- **PromptPlan** (new, `shared/`) — provider-neutral output of `promptBuilder`: ordered durable
  segments (each tagged origin + frozen/volatile), the frontier marker, the ephemeral tail, and
  cache-point hints. Consumed by every provider serializer and by the A/B harness.
- **PromptState** (new, persisted per chat) — extends `cached_world_info` into the full
  ratchet/checkpoint state: frozen frontier render, accumulated lore (ids + bytes + roll
  decisions), current episodic summary pointer, verbatim window bounds, accumulated corrections,
  last segmentation (for the diff), checkpoint counters. Stored as a JSON blob on `chats`.
- **`episodic_memory`** — schema in §6.3.
- **`compactionService`** (new) — checkpoint scheduler + summarizer driver.
- **`retrievalService`** (new) — memory selection strategies.
- **`promptDiff`** (new) — segmentation, diff, cut-point cost model.
- **Utility API connection** — a named api-preset (cheap fast model) used by the summarizer and
  optional LLM-retriever; reuses `settingsService` api-presets. Embedding API (optional) likewise.
- **Settings** (`settingsService.ts`, `types/models.ts`): `cache.level` (0–3); `cache.l1_mode`
  (`partition` | `diff`); `cache.ttl` (`5m` | `1h`); `cache.prewarm` (bool);
  `cache.breakpoint_optimizer` (bool); `cache.checkpoint_tokens` / `cache.checkpoint_turns`;
  `memory.retrieval` (`keyword` | `llm` | `vector`), `memory.recall_count` (Y);
  `memory.utility_api_preset_id`, `memory.embedding_api_preset_id`.

---

## 9. Orthogonal knobs (layer onto any level)

- **Breakpoint optimizer** — replace the fixed `merged.length-2` breakpoint with `promptDiff`'s
  true stable boundary, placing the ≤4 Anthropic breakpoints there. Zero fidelity cost; also the
  measurement engine everything else needs.
- **TTL + pre-warm** — 1-hour TTL on the frozen tiers + optional `max_tokens:0` pre-warm at chat
  open (`shared/prompt-caching.md` semantics). Trivial and independent.

---

## 10. Measurement and the A/B harness (build first)

- **Segmentation + diff** (`promptDiff`) — shared by L1b, the breakpoint optimizer, and the
  metric.
- **Stable-prefix proxy (deterministic, free)** — count prefix tokens byte-identical to the
  previous turn. This is the theoretical cache-read ceiling and exactly what the levels move, so
  an existing chat's floors can be **replayed offline** through each level and ranked on identical
  inputs without re-rolling the dice.
- **Live confirmation** — promote the existing `usage` logging (`cache_read_input_tokens`,
  `cache_creation_input_tokens`, `input_tokens`) into a **per-session cache-efficiency report**
  (hit ratio, tokens, est. cost). Gemini's `cachedContentTokenCount` already logs.
- **Control surface** — `settings.cache.level` + the orthogonal toggles, switchable per chat, so
  two chats (or two replays) can run different levels side by side.

---

## 11. Fidelity and correctness

- **The signed-off tradeoff.** Live state and recalled memory move out of their authored
  positions into the ephemeral tail. The model always sees correct _current_ state — just not
  embedded in the prose where the author wrote it. This is the precise point where fidelity bends
  for cache hit. L1a renders a neutral placeholder in place (no stale value); L1b leaves an aging
  stale value with a tail correction; the L1a/L1b A/B measures whether the placeholder is worth
  the static analysis.
- **Acceptable MVU tracking** = the model receives correct current `stat_data` every turn and
  widgets render from `floor.variables`. Preserved at every level ≥ L1; the only change is
  placement (tail vs in-prose).
- **Memory persistence** = two distinct properties. _Within-window fidelity_ is highest at L0–L2
  (full verbatim, lossless). _Reach beyond the window_ exists only at L3, where durable
  `episodic_memory` + recall keep older context available after verbatim turns would otherwise be
  dropped. So L0–L2 are lossless until the window fills and then must trim; L3 is lossy-but-
  unbounded. Summarization fidelity is governed by checkpoint cadence — a tunable, not a silent
  default.
- **Determinism.** Probability lore is rolled once and frozen (and re-rolled only at checkpoints),
  removing the per-turn `Math.random` nondeterminism that currently churns L2.

---

## 12. Build order (each rung ships)

1. **Harness** — `promptDiff` segmentation + stable-prefix proxy + per-session report + the
   `cache.level` switch. (Needed to measure anything; safe, no behavior change.)
2. **L1 Frozen Core** — frozen-context render + state relocation, with the **L1a vs L1b**
   sub-experiment. Highest leverage, lowest effort.
3. **L2 Lore Ratchet** — append-only lore + roll-once-freeze.
4. **L3 Full** — compaction checkpoints + `episodic_memory` (6.3) first, then retrieval (6.4) and
   segment-diff corrections (6.5).

Each level is gated behind `cache.level`, so partial progress is always shippable and always A/B-able.

---

## 13. Open decisions (starting leans; tune during planning / with the harness)

- **Checkpoint cadence** — lean: trigger when the frontier reaches ~50% of the model's context
  window, with a turn-count fallback of ~20 turns, whichever comes first. Confirm against the
  harness on real transcripts.
- **Recall count Y / strategy** — lean: start `Y = 3–5` with the keyword+recency default; expose
  LLM-pick and vector as opt-in upgrades.
- **`PromptState` storage** — lean: JSON blob on `chats`, per the project's "Zod owns blob shape"
  convention (a dedicated table only if it outgrows that).
- **L1 classification** — lean: memoize the frozen/volatile split per card version (cards rarely
  change mid-session), recomputed on card edit.
