# Memory System — Design & Plan

**Status:** Design (pre-implementation; actively brainstorming — shape for review)
**Date:** 2026-06-26
**Revised:** 2026-06-26 — generalized from a single episodic table into a **customizable multi-collection memory engine** (events + character progression + locations + relationships + card-defined kinds) with an optional **vector storage mode**. Episodic "events" is now one collection among several.
**Extends:** the **L3** tier sketched in [prompt-cache-optimization-design.md](prompt-cache-optimization-design.md) §6.3–6.4 (compaction → episodic memory → retrieval).
**Reuses:** reserved `episodic_memory` table (folds into `memory_entries`), `api_presets` (utility + embedding connections), `matchAcross` (keyword recall), `fitToBudget` (drop boundary), MVU `stat_data` (numeric current-state channel).
**Related:** [agentic-mode-design.md](agentic-mode-design.md), [mvu-support-design.md](mvu-support-design.md), [world-card-design.md](world-card-design.md).

---

## 1. Goal and scope

**Goal.** Give a chat session memory that outlives the verbatim context window. As old turns fall out of the window, fold what mattered into compact, structured, retrievable records; before each turn, pull back the records relevant to what the player is doing now and inject them, so the model keeps continuity over hundreds–thousands of exchanges.

**The shape (player's mental model).** "It remembers what mattered — who people became, where things stand, what I set in motion — and brings it up when it's relevant, without me re-explaining."

**The one scoping insight that shapes everything (specific to this app).** This codebase already has a *current-state* memory: MVU `stat_data` (relationships, inventory, flags, 好感度…) is tracked deterministically every turn ([generationService.ts:333](src/main/services/generationService.ts)) and the model already sees correct current state. **Memory must NOT duplicate `stat_data`'s numbers.** Its job is what MVU does *not* capture: *narrative* — what happened and why, who a character is becoming, the current state of a place, dialogue commitments, emotional beats, unresolved threads. MVU holds "好感度 = 60"; memory holds "she finally admitted why she left, on the bridge in the rain; you promised to find her brother." Disjoint by *level* (numbers vs. narrative), so the two never fight or double-store.

**Design principles (this revision).**
- **Customizable first.** Memory is a registry of **collections**, not a fixed schema. Built-ins ship as defaults; users tune them and cards/worlds declare their own (§5).
- **More than "what happened."** Distinct collections capture event history *and* character progression, locations, relationships, and emergent canon — because they have genuinely different write/retrieval semantics (§5.1).
- **Vector mode is first-class but optional.** Keyword recall is the zero-cost default; vector / hybrid recall is a per-collection upgrade backed by a user embedding API and an in-DB vector store (§6, §8).

**The floor (must hold).**
- Never block or slow a player turn on memory work — extraction is off the hot path; retrieval is cheap.
- Fail-open: if extraction fails, the turns stay verbatim and we retry; we never silently lose context.
- All recalled memory is **ephemeral tail** content (re-selected each turn), never folded into the cached frontier (§5.4).

**Non-goal.** Replacing verbatim history while it still fits the window (stays lossless). Bundled local ML / embeddings (optional, user-API-based only — repo stance).

---

## 2. Current status (audit)

| Piece | State |
| --- | --- |
| `episodic_memory` table | **Reserved, empty, unused** — declared at [db.ts:84](src/main/services/db.ts), never read or written anywhere in the tree. Folds into the new `memory_entries` (§6); no data migration. |
| Writer / reader services | **Do not exist** (`compactionService.ts`, `retrievalService.ts`). |
| `memory` settings block | **Does not exist** — `Settings` ([models.ts:41](src/main/types/models.ts)) has `cache`, no `memory`. The cache design's reserved field names are doc-only. |
| Utility / embedding connections | **Plumbing exists** — `settings.api_presets[]` ([models.ts:15](src/main/types/models.ts)) already supports multiple named connections; the summarizer/embedder ride on it. |
| Keyword matcher | **Exists & reusable** — `matchAcross` ([lorebookService.ts:129](src/main/services/lorebookService.ts)) qualifies entries against scan text; same machinery ranks stream memories. |
| Drop boundary | **Exists** — `fitToBudget` ([promptBuilder.ts:43](src/main/services/promptBuilder.ts)) drops oldest convo messages to fit `max_context_tokens`; compaction hooks the turns it's about to drop. |
| Vector store | **Not present** — no `sqlite-vec` / vector table yet; better-sqlite3 is already the DB engine, so it slots in (§6). |

**Conclusion: the slot is carved out, nothing fills it.** This doc fills it — broadened to the multi-collection engine.

---

## 3. What already exists (and is reused)

- **`api_presets` (utility + embedding models).** Extraction/summarization and optional LLM-select call a user-chosen cheap/fast preset; vector mode calls a user-chosen embedding preset. Both ride the existing multi-connection support; fall back / disable gracefully when unset.
- **`matchAcross` keyword qualifier.** Stream memories carry `keywords`; the default recall runs the same qualify-against-scan-text pass as lorebook entries — **zero extra API call per turn.**
- **`fitToBudget` drop boundary.** The natural compaction trigger: the turns it's about to trim are exactly the turns to extract from, so memory and verbatim history stay disjoint.
- **Per-mode tuning (`ModeConfig`).** Recall breadth can vary per FSM mode (Explore wide, Dialogue tight, Combat minimal), mirroring `scan_depth` ([settingsService.ts:98](src/main/services/settingsService.ts)).
- **Card bundle extension point.** Cards already carry `extensions.rp_terminal.*` bundles (combat, agent, MVU schema); custom memory collections ride the same mechanism (§5.3).
- **MVU `stat_data`.** The deterministic numeric channel; memory complements it with narrative (§1).

---

## 4. The selection-cost decision (keep recall cheap by default)

The original instinct is a **selector call every turn**: send the catalogue of descriptions to an LLM, it returns which memories to load, *then* fire the main call. That adds a full round-trip's latency + cost to **every turn, forever** — the most expensive option.

**Recommendation: ranking mode is per-collection config; default to the free one.**

| Ranking mode | How it selects | Per-turn cost |
| --- | --- | --- |
| `always` | include entity records whose entity is in scope (no ranking) | 0 calls |
| `keyword` *(stream default)* | `matchAcross` over `keywords` + recency/salience tie-break | **0 calls** |
| `vector` | KNN over `memory_vec` vs. an embedding of the scan text | 1 cheap embed call |
| `hybrid` | reciprocal-rank fusion of keyword + vector + salience | 1 cheap embed call |
| `llm` | utility model picks from the catalogue of `summary` lines | 1 cheap utility call |

Build `keyword`/`always` first; `vector`/`hybrid`/`llm` drop in behind the per-collection setting. The catalogue→pick idea becomes opt-in `llm` — available, not a per-turn tax. If `llm` is enabled, re-run selection only every *K* turns / on scene change, not every turn (§11.I).

---

## 5. Core model: a memory engine with configurable collections

The system is **not** a single episodic table — it's a **memory engine** running a set of **collections**. "What happened" (events) is just the first; character progression, locations, relationships, emergent world-facts, and **card/world-defined custom kinds** are others. Collections are **declarative config** (global defaults + per-card/world overrides + per-session toggles), each independently enabled, extracted, stored, and retrieved. That is what "highly customizable" means concretely — and it matches how the rest of the app already works (presets, regex scopes, MVU schemas, card bundles are all declarative).

### 5.1 Two collection shapes (they differ in *write semantics* — the crux)

| Shape | Write | Cardinality | Retrieval | Built-in examples |
| --- | --- | --- | --- | --- |
| **Stream** | append | many rows, time-ordered | by **relevance** (keyword/vector/hybrid) + recency/salience | `events`, `facts` |
| **Entity** | **upsert** keyed by entity | **one evolving record per entity** | **always-included when the entity is in scope** | `characters`, `locations`, `relationships` |

This distinction is the direct answer to *"not only what happened, but character progression and location."* Those are **entity collections**: you don't want a character's 30 past mentions retrieved by keyword — you want their *one current, consolidated sheet* whenever they're on stage. A sheet **evolves in place** (skills learned, goals shifting, secrets revealed, relationship arc) rather than accumulating duplicate rows — a living document, not a log. Events stay a **stream**: many discrete rows pulled by relevance.

> Entity collections overlap MVU `stat_data` conceptually but stay disjoint by *level*: MVU holds the **numbers** (好感度 = 60, HP, counts); the `characters` collection holds the **narrative** development (why the number moved, who she's becoming). Deterministic state vs. prose the model reads for color and continuity.

### 5.2 Built-in collections (all toggleable / tunable)

- `events` *(stream)* — the original episodic memory; "what happened."
- `characters` *(entity)* — per-character progression: arc, goals, revealed secrets, skills, voice.
- `locations` *(entity)* — per-place current state + notable history ("the tavern, now burned after the duel").
- `relationships` *(entity, keyed by pair)* — the evolving dynamic between two characters.
- `facts` *(stream)* — emergent canon established in play (optionally promotable into the session lorebook — §11.L).

### 5.3 Custom collections (the customization surface)

A card/world declares its own collections under `extensions.rp_terminal.memory`, each with its own extractor prompt, shape, and retrieval policy — e.g. 命定之诗 could define `命运_threads` (stream, always-surface open ones) or `faction_standing` (entity keyed by faction). The engine treats built-in and custom collections identically; built-ins are just the defaults shipped in settings. **Per-collection config (the registry entry):**

```ts
interface MemoryCollection {
  id: string                 // 'events' | 'characters' | <custom>
  shape: 'stream' | 'entity'
  enabled: boolean
  entityKey?: string         // entity shape: what identifies the record (e.g. 'character name')
  write: {
    trigger: 'checkpoint' | 'every_turn' | 'on_change'
    prompt: string           // extractor instructions — the main customization knob
    maxItemsPerCheckpoint?: number
  }
  retrieval: {
    mode: 'always' | 'keyword' | 'vector' | 'hybrid' | 'llm'
    count: number            // slots for this collection
    tokenBudget: number      // tail budget slice
  }
  inject: { label: string }  // tail block heading, e.g. "Characters present"
}
```

### 5.4 Writer / store / reader (generalized)

```
        player turn N                          between turns / async
  ┌───────────────────────┐            ┌─────────────────────────────────────┐
  │ generate()            │            │ compactionService (writer)          │
  │  scan ─► retrieval     │◄ inject ─┐ │  per-collection extractors, ideally │
  │  buildPrompt(...)     │          │ │  ONE structured utility call →       │
  │  main call (tail)     │          │ │  {events:[…], characters:{…}, …}     │
  └───────────────────────┘          │ │  append stream / upsert entity rows │
                                      │ │  (+ embed if vector mode on)         │
        ┌─────────────────────────────┴┐└──────────────────┬──────────────────┘
        │ retrievalService (reader)     │                   │
        │  compose tail from ALL enabled│        ┌──────────▼───────────┐
        │  collections per their policy:│  read  │ memory_entries +      │
        │   • always-include entities   │◄───────┤ memory_vec (vec0)     │
        │     in scope                  │        │  (one SQLite file)    │
        │   • relevance-rank streams     │        └──────────────────────┘
        │  → labelled TAIL blocks       │
        └───────────────────────────────┘
```

- **Writer:** at a checkpoint, run each enabled collection's extractor. Prefer **one structured utility call** returning deltas for all collections at once — far cheaper than N calls. Append stream items; **upsert** entity items by `entityKey` (merge into the existing sheet). If a collection is in vector/hybrid mode, embed the new/updated `summary` and upsert `memory_vec` here too — all still off the hot path.
- **Reader:** compose the tail from every enabled collection by its policy — *always-include* the entity records whose entity is in scope this turn (characters present, current location), *relevance-rank* the stream collections (§8) — each under its own token-budget slice, each as its own labelled block.

**Frontier vs. tail (non-negotiable for the cache work).** All recalled memory — stream and entity alike — is re-selected each turn and goes in the **ephemeral tail**, after the prompt-cache breakpoint, alongside live state and the new user action; **never** the cached frontier (system/card/lore), which would invalidate the cache every turn. Same rule the cache design applies to live state ([prompt-cache-optimization-design.md:88](prompt-cache-optimization-design.md)).

---

## 6. Storage schema

One **generic store** partitioned by `collection` gives the "multiple tables" feel without rigid per-type columns; type-specific structure lives in a JSON `payload`. (Literal separate tables per collection are the alternative — §13 — but the generic store wins for user/card-defined collections.)

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  collection    TEXT NOT NULL,         -- 'events'|'characters'|'locations'|<custom> — the "table"
  entity_key    TEXT,                  -- entity shape: the upsert key; NULL for stream rows
  summary       TEXT NOT NULL,         -- short catalogue line (ranked / injected)
  payload       TEXT,                  -- JSON: type-specific structured body (sheet fields, history…)
  keywords      TEXT,                  -- keyword recall
  entities      TEXT,                  -- entities mentioned (cross-collection entity index)
  salience      REAL DEFAULT 1,        -- importance 0–1; decays unless reinforced
  pinned        INTEGER DEFAULT 0,     -- user/card "always include"
  turn_start    INTEGER,               -- provenance (enables rewind-safety, §11.M)
  turn_end      INTEGER,
  superseded_by TEXT,                  -- contradiction handling
  embed_model   TEXT,                  -- which embedding model produced the vector (dim-change guard)
  updated_at    TEXT,
  created_at    TEXT,
  UNIQUE(chat_id, collection, entity_key)   -- entity upsert; stream rows (entity_key NULL) never collide*
);
CREATE INDEX IF NOT EXISTS idx_mem_chat_coll ON memory_entries(chat_id, collection);
```

\* SQLite treats `NULL`s as distinct in a `UNIQUE` constraint, so unlimited stream rows coexist while entity rows upsert on `(chat, collection, entity_key)` — both write semantics from §5.1, in one table.

**Vector mode (optional)** uses a companion [`sqlite-vec`](https://github.com/asg017/sqlite-vec) virtual table in the *same* better-sqlite3 file — no server, no new infrastructure:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[768]            -- dim depends on the embedding model
);
```

**Migration.** The reserved `episodic_memory` table is empty in every existing DB, so drop/rename it cleanly and treat its role as the `events` collection. New columns on a fresh table need no `addColumnIfMissing` dance; only if we keep the old name do we migrate columns idempotently ([db.ts:105](src/main/services/db.ts)).

---

## 7. Write path — `compactionService.ts`

**Trigger** (`generate()` schedules it after persisting the floor, or a background tick):
- **Primary:** history tokens exceed a configured share of `max_context_tokens` (`memory.checkpoint_tokens`).
- **Fallback:** every *N* turns (`memory.checkpoint_turns`).
- Optional: on FSM mode/scene transition (agentic). Entity collections in `on_change` mode can also write when MVU signals a relevant state change.

**Action (one structured call).** Take the oldest floors `fitToBudget` is about to drop, send them to the utility preset with an extraction prompt that returns **deltas for every enabled collection at once** — `{ events:[…], characters:{name→update}, locations:{…}, <custom>:… }`. Append stream items; **upsert** entity items by `entity_key` (merge, don't duplicate). One cheap call covers all collections; those floors are then safe to drop from the verbatim window. Exactly the boundary `fitToBudget` computes, so memory and verbatim history never overlap.

**Off the hot path.** Run after the turn completes (player is reading / typing) or on an idle tick — never inside the player's request. The extractor prompt is told MVU numbers are tracked separately (don't restate them) and, per collection, what to capture. Vector embeddings (if enabled) are computed here too.

**Fail-safe.** If the utility call fails, leave the turns verbatim and retry next checkpoint. Generation is never blocked or failed by memory work. Logged (like lorebook reach) so the user sees "compaction deferred."

**Files.** new `compactionService.ts`; `db.ts` (`memory_entries` + optional `memory_vec`); `chatService.ts` (checkpoint bookkeeping — last-compacted floor, counters); `generationService.ts` (invoke scheduler post-turn); optional `sqlite-vec` load in the DB bootstrap.

---

## 8. Read path — `retrievalService.ts`

**When.** Inside `generate()`, before `buildPrompt`, after `buildScanText` ([generationService.ts:149](src/main/services/generationService.ts)).

**Compose across collections.** Walk every enabled collection and gather its contribution per its `retrieval.mode`, each under its own token-budget slice and labelled block:

- **Entity collections (`always`)** — include records whose entity is **in scope this turn** (characters present, current location from `stat_data`/scene, the active pair for relationships). Scope membership decides; no ranking.
- **Stream collections (`keyword`/`vector`/`hybrid`/`llm`)** — rank and take the top *N*, but **reserve slots** so recall feels intentional, not random:
  1. **Pinned** (always).
  2. **Open threads** (unresolved `facts`/custom rows) — the Chekhov's gun set up 50 turns ago.
  3. **Most-recent** 1–2 (continuity across the compaction seam).
  4. Remaining slots by the collection's ranking mode.

**Ranking modes (per collection).**
- `keyword` — `matchAcross`-style qualify against scan text; 0 extra calls.
- `vector` — embed scan text once, KNN over `memory_vec` (cosine), filtered to this chat+collection.
- `hybrid` — fuse keyword + vector + salience/recency by **reciprocal-rank fusion** (rank-based, so component scores need no calibration). Best quality; the recommended default once an embedding preset is configured.
- `llm` — utility model picks from the catalogue (cost-controlled, §11.I).

**Scan text.** Reuse `buildScanText` (player action + last AI response + recent floors) + current scene/location, so recall is grounded in *where* the player is, not just their latest sentence.

**Inject** each collection's block into the **ephemeral tail** (§5.4), within `memory.max_tokens` total so memory never crowds out verbatim history. Budget contention resolves in a fixed order: pinned → always-include entities → open threads → ranked streams.

**Observability.** Log retrieved memories per collection each turn (mirroring "lorebook: N matched", [generationService.ts:178](src/main/services/generationService.ts)) — "why did it forget X?" must be debuggable.

**Files.** new `retrievalService.ts` (composition + ranking modes); `generationService.ts`/`promptBuilder.ts` (tail injection point); `settingsService.ts` (registry).

---

## 9. Settings — the `memory` block

Add to `Settings` ([models.ts:41](src/main/types/models.ts)) + defaults ([settingsService.ts](src/main/services/settingsService.ts)). The collection registry is the customization surface (§5.3):

```ts
memory: {
  enabled: boolean                  // master switch; off = today's behavior
  collections: MemoryCollection[]   // the registry — built-ins shipped as defaults, user-editable
  max_tokens: number                // total tail budget across all collections
  checkpoint_turns: number          // fallback write trigger
  checkpoint_tokens: number         // primary write trigger (share of context window)
  utility_api_preset_id: string     // cheap model for extraction / llm-select ('' = active connection)
  embedding_api_preset_id: string   // vector/hybrid modes ('' = disabled → fall back to keyword)
}
```

Card/world overrides merge their `extensions.rp_terminal.memory` collections over the defaults at session start. Per-mode recall breadth can later extend `ModeConfig`, mirroring `scan_depth`.

---

## 10. Build order

Each rung is independently shippable and testable.

1. **Schema + settings + registry.** `memory_entries`, the `memory` block (default `enabled:false`), built-in collections defined but off. No behavior change. Unblocks everything.
2. **Reader — `events` only.** `retrievalService` for the stream `events` collection, `keyword` ranking + slot logic + tail injection, tested on **seeded** rows. Verifies placement (tail, not frontier) without the writer.
3. **Writer — `events`, turn-count trigger.** `compactionService`, structured call (single collection first), append, fail-safe. Loop closes end-to-end.
4. **Entity collections.** Add `characters` + `locations` (upsert + always-include composition). This is the "character progression / location" milestone.
5. **Token-threshold trigger + quality pass.** Wire to `fitToBudget`; add salience/decay, reserved slots, supersede, observability.
6. **Vector mode.** `sqlite-vec` table + embedding preset + `vector`/`hybrid` ranking (and re-embed-on-model-change guard).
7. **Customization surface.** Card-defined custom collections (`extensions.rp_terminal.memory`) + the user-facing memory panel (§11.F).

**Coupling decision (§13).** Can ship *independent of* the prompt-cache L3 work (inject into history at cache level 0) or as the memory half of L3. Recommend **independent** first — smaller surface, useful immediately, and it already respects tail-placement so it composes with the cache work later.

---

## 11. Improvements & forward ideas (the running brainstorm)

Leverage-ordered for *this* app. Several are now **core** (folded into §5); the rest are fast-follows, flagged so the baseline stays small.

**A. Typed collections, not one prose blob → now core (§5).** The shape/`kind` split *is* the collection model; retrieval weights kinds (always-surface open threads + in-scope entities; relevance-rank events).

**B. Salience + decay (the Generative-Agents model).** Extractor rates importance 0–1; stream ranking = `α·recency + β·salience + γ·relevance` (Stanford "memory stream"). Salience decays unless a memory is re-retrieved (reinforcement), so big moments stay reachable and trivia fades. Cheap, large quality jump.

**C. Entity index → now core (§5).** Entity collections + the `entities` column let recall pull "everything about Y" directly when Y is on stage — usually beats keyword-matching the player's raw text.

**D. Contradiction / supersede.** On upsert, if a new record overlaps an existing one, set the old row's `superseded_by` and prefer the latest at retrieval — no stale "X is alive" after X died. Entity collections get this for free (they upsert in place); stream collections need the explicit pointer.

**E. Hierarchical consolidation (bounds cost at scale).** Periodically roll many low-salience stream rows into one higher-level summary ("Act 1"), a pyramid. Keeps the catalogue + token cost bounded no matter the session length. Entity sheets self-consolidate (they're upserts), so this mainly serves `events`/`facts`.

**F. Data-management UI — view / edit / query what's remembered (ELEVATED — top of the remaining work, §17).** More than a passive list: a first-class workspace surface (the panel-workspace already supports custom views) to **browse by collection**, **inspect & edit** any record's fields, **pin** (always-include), and **delete** (kill a continuity error) — plus a **filter/query console** ("what do we know about X?") and a "why was this recalled?" readout beside each turn's injected set. This is the feature that makes memory *trustworthy and debuggable*: RP players care intensely about continuity, and being able to *see and correct* the store is what earns their trust. Backed by the already-reserved `pinned` column (§6) and the existing `memoryStore` read/write/delete ops; pairs naturally with entity collections (§5.2), whose sheets are the records most worth hand-editing. **No longer a fast-follow — it is the headline next deliverable.**

**G. Manual "remember this" + card-authored extractor prompts.** Player flags a moment as permanent; card/world authors write the per-collection extractor prompts for their setting (命定之诗 knows 命运 threads + 好感度 beats matter). Rides the card bundle system.

**H. Don't restate `stat_data` (cost discipline).** Active rule in every extractor prompt: skip numbers MVU tracks; spend the budget on narrative/causal/emotional content. Halves redundant volume.

**I. `llm`-select cost control.** Cache the selection; re-pick only every *K* turns / on scene change. The catalogue is a near-stable prefix — prompt-cacheable on the utility model.

**J. Vector quality knobs.** Embed `summary` (+ optionally key `payload` fields). Store `embed_model`; on model/dim change, flag rows stale and re-embed lazily. Cache the per-turn query embedding across swipes/regens (same scan text). Zero-config: no embedding preset → `vector`/`hybrid` silently degrade to `keyword`.

**K. Evaluation hook.** Log retrieved memories per turn; longer-term, a light "was it used?" signal (did the response reference the recalled entities?) to tune counts/modes. Surfacing the retrieved set in Logs is the cheap 80%.

**L. Emergent `facts` → session lorebook promotion.** A high-salience, durable `facts` row can promote into the **append-only session lorebook** (the L2 lore ratchet in the cache design) — turning play-established canon into first-class, always-on world info. Closes the loop between memory (emergent) and lore (authored).

**M. Rewind-safety (correctness — justifies the provenance columns).** `regenerate`/`generateSwipe` truncate floors ([generationService.ts:528](src/main/services/generationService.ts)). Memory written from truncated floors would desync. Because compaction only fires on *old* floors already past the window, a normal re-roll of the latest turn can't touch compacted memory — but a rewind *past a checkpoint* must invalidate rows with `turn_start ≥ rewind point`. `turn_start`/`turn_end` make that a one-line `DELETE`.

**N. Per-collection model routing (optional).** Cheap model for `events`; a slightly stronger one for `characters`/`relationships` where nuance matters. Just another `utility_api_preset_id` per collection — the registry already allows it.

**O. Validated, self-correcting structured writes.** For entity collections (and any structured `payload`), validate the model's fill against a per-collection schema (reuse the MVU **Zod** path, `mvuZod.ts`) instead of lenient parsing; on a validation failure, **inject the error back into the writer prompt and retry** within the off-hot-path loop. The schema is the contract, so structured memory stays well-formed even when the model drifts. Stream `events` can stay lenient — a malformed summary just defers (§7).

**P. Query-based / conditional injection.** Beyond the single static recalled block, let cards/world templates pull **specific** memories by predicate — entity, collection, recency, tag — through the existing EJS/template + lorebook-conditional machinery. E.g. surface "open threads involving X" only when X is in scope, or a character's sheet only when present. Turns memory from a flat block into an **addressable store** an author can target — the read-side analogue of the card-authored extractor prompts (G).

**Q. Entity aliasing / name resolution.** An alias map per chat (`name → canonical_id`) so entity collections survive name drift ("the tavern" → "The Rusty Anchor"; nicknames; titles): the extractor proposes aliases on write, the reader resolves through them for in-scope detection. Concretizes the §14 T1 decision — the make-or-break for character/location continuity.

**R. Plot / objective tracking.** A first-class collection (or light subsystem) for **open objectives/quests and their lifecycle** — created, advanced, and closed by the model, always surfaced while open — beyond the loose `thread` kind (A). Gives the model an explicit, inspectable "what's unresolved and what's the next beat," rather than hoping a thread memory resurfaces. Composes with the FSM/agentic mode and the data-management UI (an editable quest list).

**S. Seed memory from documents (import).** Import a backstory / lore / prior-transcript file, chunk it, and pre-populate `events` + entity collections (with a snapshot so the import is reversible). Lets a session **start with established memory** instead of cold — for continuing a story, onboarding a complex world, or migrating in existing notes.

---

## 12. Fidelity & correctness

- **Two distinct properties.** *Within-window fidelity* is lossless (verbatim history, unchanged). *Reach beyond the window* is lossy-but-unbounded (extracted memory). Extraction fidelity is governed by checkpoint cadence — a tunable, not a silent default.
- **Placement honesty.** Recalled memory appears in the tail, labelled ("Characters present", "Earlier events"), not spliced into the prose where it originally happened — the same signed-off tradeoff the cache design makes for live state.
- **Determinism where it matters.** MVU stays the deterministic numeric channel; memory is advisory narrative context layered on top, never the source of truth for numbers.
- **Rewind consistency.** Provenance (`turn_start`/`turn_end`) keeps memory consistent with the floor timeline across re-roll/swipe/rewind (§11.M).

---

## 13. Open decisions (need your call)

1. **Physical storage:** one generic `memory_entries` store partitioned by `collection` *(recommended — flexible for custom collections)*, or literal separate tables per built-in collection *(rigid columns, harder to extend)*?
2. **Vector backend:** in-DB `sqlite-vec` *(recommended — same file, no infra)*, plain `embedding BLOB` + brute-force cosine *(simplest, fine to a few thousand rows)*, or an external vector DB *(overkill for a desktop app)*?
3. **Which built-in collections ship in v1?** Recommend `events` + `characters` + `locations`; defer `relationships`/`facts` + custom collections to fast-follows.
4. **One structured extraction call vs. per-collection calls.** Recommend one structured call (cost) — accept slightly coarser per-collection prompts. Revisit if quality suffers.
5. **Entity-key canonicalization (the real hard problem).** Entity collections need stable keys, but names drift ("the tavern" vs "The Rusty Anchor"; nicknames; titles). How strict in v1 — exact-match keys (simplest, some duplication), an alias map, or an LLM-resolved canonical name at extraction time?
6. **Custom card-defined collections — v1 or later?** (Recommend later; ship built-ins first.)
7. **User-editable memory panel — early (trust) or later?** Cheap given the workspace system; tends to be the feature RP users notice most.
8. **Ship independent of the prompt-cache L3 work, or bundled?** (Recommend independent — §10.)

> Detailed write-ups of the thorniest of these are in §14; **all are deferred** — none block the core (§15).

---

## 14. Recorded design threads

_Captured 2026-06-26 from brainstorming. T1/T2 **RESOLVED 2026-06-26** (owner) — see below; they now drive the entity-collections build._

**T1 — Entity identity / canonicalization (gates entity collections). ✅ RESOLVED: LLM-resolved canonical entity + alias map.** RP names drift ("the tavern" → "The Rusty Anchor"; nicknames; titles; pre-name introductions). **Chosen:** the structured extraction call (already made) returns, per entity, a **canonical name + aliases**; the writer reconciles it against existing records (entity_key or any stored alias, case-insensitive) to pick the upsert key, creating a new record only when nothing matches. The reader builds a `name → entity_key` alias map from the stored records for in-scope detection. _(Rejected: exact-match keys — fragments badly; alias-map-only — weak on brand-new names.)_

**T2 — Entity-sheet update strategy (gates entity collections). ✅ RESOLVED: structured deltas + periodic consolidation.** **Chosen:** each entity record's `payload` holds a consolidated `fields` map + an append-only `log` of dated changes + `aliases`; an update merges the new fields, appends a log note, and refreshes the one-line `summary`. Cheap per update, auditable, never forgets — and the change log is legible in the Memory UI. Periodic LLM consolidation (reuses §11.E) compacts the log when it grows. _(Rejected: full-sheet LLM rewrite every update — re-spends tokens, can drift/forget.)_

**T3 — "In scope" detection for always-include (gates entity collections).** Always-include only works if "who/where is present this turn" is cheap to answer. Candidates: entities named in the last 1–2 floors, current location from `stat_data`/scene, active speakers. _Lean: entities in the recent scan window + current-location var; free if extraction already tags `entities`._

**T4 — Vector backend & when it's worth it (gates vector mode).** (a) **`sqlite-vec`** `vec0` table — same file, but a per-platform native loadable extension shipped with the Electron build; (b) **`embedding BLOB` + brute-force cosine in JS** — simplest, fine to a few thousand rows (one chat rarely exceeds that). For RP, **hybrid (keyword + vector, RRF) > pure vector** — pure semantic drifts; keyword anchors to the proper nouns the player typed. _Lean: brute-force-in-JS for v1 (sqlite-vec only if a chat's memory ever gets large); hybrid as the quality default once an embedding preset exists._

**T5 — Customizable ≠ usable (UX principle, adopted).** A fully-configurable registry can become an unflyable cockpit. _Principle:_ ship excellent pre-tuned built-in defaults; keep the registry editable but behind an "advanced" surface; let card authors override per-world. Customizability = progressive disclosure, not a wall of knobs on first run.

---

## 15. Core scope (implemented first) → plan

> **BUILT 2026-06-26** on branch `feat/memory-system` (P0–P4). The core below is end-to-end and behind a default-off flag; see [plans/2026-06-26-memory-core.md](superpowers/plans/2026-06-26-memory-core.md) for the as-built status. Everything in §5.2 / §6 vector / §8 vector·hybrid·llm / §11 / §14 remains deferred.

The first implementation is the **engine skeleton + the `events` stream collection only**, behind a default-off flag, injecting into the tail. The generic store (§6) + collection registry (§5.3) are built up front so entity collections, vector, and the rest plug in later **without rearchitecting** — but only `events` + keyword recall + a turn-count checkpoint ship in the core. Detailed phased plan: **[plans/2026-06-26-memory-core.md](superpowers/plans/2026-06-26-memory-core.md)**.

**Out of the core (deferred):** entity collections (§5.2 — `characters`/`locations`/`relationships`), vector / hybrid / llm ranking (§6, §8), salience + decay, consolidation, supersede, custom card-defined collections, the memory panel (§11), per-mode recall breadth, the token-threshold trigger, and every thread in §14.

---

## 16. Interaction with the prompt-cache optimization system

Memory and the prompt-cache system ([prompt-cache-optimization-design.md](prompt-cache-optimization-design.md)) are meant to run **at the same time** — memory *is* the "L3" memory half of that design. This section reconciles the two against the code **as built** (L1 Frozen Core ships; L2/L3 are designed).

### 16.1 The tail is shared — memory inherits cache-correct placement for free

At `cache.level ≥ 1`, live MVU state is already relocated to a tail block inserted as a **`system` message just before the final user action** (`buildStateBlock`, [cacheLayers.ts:46](src/main/services/cacheLayers.ts); inserted at [promptBuilder.ts:496](src/main/services/promptBuilder.ts)). On Anthropic, `streamAnthropic` ([apiService.ts:277](src/main/services/apiService.ts)) hoists only the *leading* system run into the top-level `system` param, **demotes** a mid-conversation system message to `user`, and **same-role-merges** consecutive turns — so the state block folds into the final user turn and lands in the volatile tail. The cache breakpoint at `merged.length - 2` ([apiService.ts:317](src/main/services/apiService.ts)) therefore lands on the **last history message** (the true stable boundary), not on the volatile block.

**Consequence:** insert the recalled-memory block the **exact same way** as `buildStateBlock` — a `system` message at `messages.length - 1`. It demotes + merges into the same volatile tail, past the breakpoint, never touching the cached prefix. **Memory needs no new cache machinery; it rides the state-block convention.** The tail co-tenants merge together:

```
[ … assistant(last history) ] │ [ state + recalled-memory + user action ]
└──── cached prefix ──────────┘↑ breakpoint #2 (merged.length-2)
```

> Correctness depends on the demote+merge. If memory used a different role or were placed before history, it could land *at* `merged.length - 2` and poison breakpoint #2. **Rule: memory uses the same role + insertion point as the state block.** Non-Anthropic providers inherit whatever ordering `orderForProvider` already gives the state block.

### 16.2 Compaction is ONE shared checkpoint, not two timers (the main coordination)

Memory's **writer** evicts old verbatim turns once summarized — which **shortens the history prefix and invalidates the provider cache** from the eviction point. The cache design's core discipline (§4) is to **concentrate every cache-invalidating change into infrequent scheduled checkpoints**, append-only between them. And it **already lists "fold the oldest verbatim turns → `episodic_memory`" as a checkpoint action** (§6.3), beside lore eviction, corrections-flush, and probability re-roll.

**So the cache design's `compactionService` and this doc's `compactionService` are the same service** (the name collision is deliberate convergence). Memory contributes the *summarize-into-memory* step of a shared checkpoint that also (later) evicts stale lore, flushes corrections, and re-rolls probability lore — then does exactly one cache-write of the rebuilt frontier.

Reconciliation with the core plan (which uses its own `checkpoint_turns` timer):
- **`cache.level === 0` (core ships here):** no provider cache to invalidate → memory's independent turn-count checkpoint is fine as-is.
- **`cache.level ≥ 1`:** the checkpoint **must be unified** — one scheduler fires memory summarization *and* the cache rebuild together, so eviction rides the cache's cadence instead of a second timer that would silently invalidate the cache off-beat.

### 16.3 `fitToBudget` per-turn trimming vs. checkpoint eviction

`fitToBudget` ([promptBuilder.ts:43](src/main/services/promptBuilder.ts)) drops the oldest turns **every turn** when over budget — at `cache.level ≥ 1` that is a per-turn cache invalidation. The cache design says at L3 this drop-oldest is **superseded by** summarize-oldest at the next checkpoint (§6.3). Memory's **`keep_recent` window + checkpoint eviction** *is* that model: the verbatim window stays byte-stable between checkpoints (append-only), eviction batched at the checkpoint. **Synergy, not conflict.** When memory runs with caching, checkpoint eviction replaces per-turn `fitToBudget` trimming; at level 0, `fitToBudget` stays as today.

### 16.4 What must be single-sourced when both are on

- **Checkpoint cadence.** One trigger (token-share primary, turn-count fallback) consumed by both memory and the cache rebuild. The `cache` block has no checkpoint fields today ([models.ts:134](src/main/types/models.ts) — only `level`/`l1_mode`/`ttl`/`prewarm`/`breakpoint_optimizer`); memory adds `checkpoint_turns`/`checkpoint_tokens`. On integration these become **the** checkpoint config, not a memory-private copy.
- **Tail ordering.** A fixed order for tail co-tenants — `[state][recalled-memory][corrections][user action]` — so the assembled tail is deterministic as more blocks land.
- **Breakpoint placement.** A second volatile tail block raises the stakes of the reserved `breakpoint_optimizer` (cache design §10): mark breakpoint #2 at the explicit stable boundary (last history message) rather than trusting `merged.length - 2` to land right after demote+merge. The position heuristic holds for one tail block; it is fragile for several.

### 16.5 Cost framing (net effect of running both)

Memory **trades cached tokens for uncached ones**: it shrinks the (cacheable) verbatim history by evicting old turns, but adds a (never-cacheable) recalled-memory block to the tail every turn. Net win when *recalled tokens ≪ evicted verbatim tokens* — a few summaries standing in for many dropped turns. The writer's utility-model calls go to a separate connection, so they never touch the main provider cache. The meter ([promptCacheMetrics.ts](src/main/services/promptCacheMetrics.ts)) already attributes `cache_read`/`cache_creation`/`input`, so the tradeoff is measurable per turn.

### 16.6 Summary matrix

| `cache.level` | `memory.enabled` | Behavior |
| --- | --- | --- |
| 0 | off | today's path (control) |
| 0 | on | memory injects into the history tail; no cache concerns — **core-plan target** |
| ≥1 | off | Frozen Core as built; no memory |
| ≥1 | on | **unified checkpoint** (§16.2) + shared tail (§16.1) + checkpoint eviction (§16.3) — the full L3 target |

---

## 17. Remaining work (prioritized)

The core (§15) ships the `events` stream collection end-to-end. Remaining work, in build order — the **data-management UI is now the headline next deliverable**, ahead of new engine capability, because a memory system the user can't see or correct doesn't earn trust.

1. **Data-management UI (TOP PRIORITY — §11.F).** A first-class workspace surface to browse memories by collection, inspect/edit/pin/delete records, query the store ("what do we know about X?"), and see *why* each turn recalled what it did. Builds only on the already-shipped `memoryStore` ops + the `pinned` column; needs no engine changes, and it's what makes everything below trustworthy and debuggable. **Build this next.**
2. **Entity collections (§5.2) — `characters` / `locations` / `relationships`.** The "more than what happened" half: upsert-keyed, always-in-scope records. The functional headline after the UI. **Gated by the deferred decisions T1 (entity identity/aliasing, §11.Q) and T2 (sheet-update strategy) — resolve those first (§14).**
3. **Validated, self-correcting structured writes (§11.O).** Schema-validate entity fills (reuse `mvuZod.ts`) with error-injection retry — keeps structured memory well-formed. Pairs with (2).
4. **Quality pass:** salience + decay (§11.B), token-threshold checkpoint trigger (§7), contradiction/supersede (§11.D), and enforcing the global `memory.max_tokens` cap across collections.
5. **Query-based / conditional injection (§11.P).** Make memory an addressable store cards/templates can target by predicate, not one flat block.
6. **Scale / optional:** vector + hybrid retrieval (§6, §8 — gated by the T4 backend decision), hierarchical consolidation (§11.E), custom card-defined collections (§5.3), plot/objective tracking (§11.R), document import/seeding (§11.S), `llm`-select (§4).
7. **Hardening:** wrap append + pointer advance in one transaction (no duplicate on partial failure), utility-call timeout, and a per-collection schema-migration story as structured payloads evolve.

**Decisions that gate the above (still open — §13/§14):** entity identity/aliasing (T1) and sheet-update strategy (T2) gate #2–#3; vector backend (T4) gates the vector half of #6; ship-independent-vs-bundled-with-cache-L3 gates the §16 integration work.
