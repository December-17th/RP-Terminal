# Memory System — Core Implementation Plan (2026-06-26)

**Design / spec:** [docs/episodic-memory-design.md](../../episodic-memory-design.md) (core scope: §15)

> **STATUS (2026-06-26): NOT STARTED.** This plan covers only the **core** — the memory-engine
> skeleton + the single `events` stream collection, end-to-end, behind a default-off flag, injecting
> into the prompt tail. The generic store + collection registry are built up front so entity
> collections, vector mode, and the rest (design §5.2, §6, §8, §11, §14) plug in later **without
> rearchitecting** — but none of those ship in the core. Decisions in design §13/§14 are **deferred**
> and do not block any phase here.

**Goal:** A chat session that remembers what mattered after old turns leave the verbatim window.
As floors age out, a background **writer** summarizes them into `events` rows; before each turn a
cheap **reader** pulls the relevant rows by keyword and injects them into the **ephemeral tail**.
Disabled by default (zero behavior change); when enabled, never blocks or slows a player turn.

**Architecture (the skeleton everything later plugs into):**

- **One generic store, `memory_entries`** (design §6), partitioned by `collection` (+ JSON `payload`,
  nullable `entity_key`). The core only writes/reads the `events` collection, but the columns for
  entity collections, salience, pinning, provenance, and supersede exist from day one — no second
  migration. The optional `memory_vec` vector table is **not** created in the core.
- **A collection registry** in settings (`memory.collections: MemoryCollection[]`, design §5.3). The
  core ships exactly one built-in entry — `events` (shape `stream`, ranking `keyword`) — but the
  reader/writer dispatch through the registry, so adding `characters`/`locations` later is "register a
  collection," not "rewrite the services."
- **`memoryStore.ts`** — thin CRUD over `memory_entries` (append / query / delete-from-turn / count).
- **`compactionService.ts` (writer)** — turn-count checkpoint; summarizes the oldest *not-yet-compacted*
  floors that sit **outside** a `keep_recent` verbatim window (so memory and verbatim history never
  overlap); one utility-model call returns structured `events` rows; append with provenance; **off the
  hot path, fail-open.**
- **`retrievalService.ts` (reader)** — `keyword` ranking over `events` with reserved slots
  (pinned / most-recent) under a token budget; returns a labelled block + the chosen rows (for logging).
- **`generate()` wiring** ([generationService.ts:100](../../../src/main/services/generationService.ts)):
  reader runs **before** `buildPrompt`, its block is placed in the **tail** (before the final user
  action); writer is scheduled **after** `appendFloor` (line 380), after the response is already
  returned to the renderer.

**Tech Stack:** TypeScript (strict), Vitest (`test/`), electron-vite, Zustand, better-sqlite3.

## Global constraints

- Prettier: **no semicolons, single quotes, 2-space indent, printWidth 100, no trailing commas**.
- **Tail-placement invariant:** the memory block is appended in the ephemeral tail (before the final
  user action), **never** inside the system/card/lore frontier — same rule the cache design applies to
  live state ([prompt-cache-optimization-design.md:88](../../prompt-cache-optimization-design.md)).
- **Never duplicate MVU `stat_data` numbers** — the extractor prompt captures narrative only (design §1).
- **Fail-open & off the hot path:** memory work runs after the response is delivered; any failure
  leaves verbatim history intact and is logged, never thrown into `generate()`.
- **Flag-off = byte-identical behavior.** With `memory.enabled === false`, `generate()` takes exactly
  today's path (no reader block, no writer call).
- New user-facing strings route through `t()` and land in **both** `locales/en.ts` + `locales/zh.ts`.
- Run `npm run typecheck`, `npm test`, `npm run build` before each phase's commit; no new lint errors.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Design review — verified against the code

1. **Reserved table is safe to replace.** `episodic_memory` ([db.ts:84](../../../src/main/services/db.ts))
   is never read or written anywhere in the tree, so the core drops it and adds `memory_entries` in the
   `SCHEMA` block (all `CREATE TABLE IF NOT EXISTS`; `addColumnIfMissing`, [db.ts:105](../../../src/main/services/db.ts),
   covers any column added to an existing DB later). No data migration.
2. **Checkpoint bookkeeping mirrors `cached_world_info`.** A per-chat JSON column is the established
   pattern (`getCachedWorldInfo`/`setCachedWorldInfo`, [chatService.ts:110](../../../src/main/services/chatService.ts)).
   Add a `memory_state` column on `chats` (`{ last_compacted_floor: number }`) with the same
   get/set shape.
3. **Tail injection seam exists.** `buildPrompt` pushes the final user action last
   ([promptBuilder.ts:146](../../../src/main/services/promptBuilder.ts)) and depth injections insert at
   `messages.length - 1` ([:462](../../../src/main/services/promptBuilder.ts), [:499](../../../src/main/services/promptBuilder.ts)).
   The memory block rides the same seam — either a new `memoryBlock?: string` arg placed just before the
   final user action, or a depth-0 injection. Prefer the explicit arg (clearer, testable).
4. **Utility call has a template.** `generateRaw` ([generationService.ts:472](../../../src/main/services/generationService.ts))
   already builds a minimal message array + uses the active preset + the abort-controller map. The
   writer needs the same but routed to `memory.utility_api_preset_id` (falling back to the active
   connection when unset) — factor a small `utilityComplete(profileId, { system, user, maxTokens })`
   that resolves the preset → `streamProvider` ([apiService.ts](../../../src/main/services/apiService.ts)),
   non-streaming. Reuse, don't fork `generate()`.
5. **Overlap avoidance is index-based.** Compact only floors with
   `index < floor_count - keep_recent` and `index > last_compacted_floor`. The still-verbatim recent
   floors remain in history as today; memory only holds what's already aged out. Token-threshold
   trigger (design §7) is deferred — turn-count is enough for the core.
6. **Registry dispatch keeps the core small but future-proof.** Reader/writer iterate
   `settings.memory.collections.filter(c => c.enabled)`; in the core that's just `events`. Entity-shape
   branches (`always`-include, upsert) are written as `// deferred — see design §5.2` stubs, not
   implemented.

---

## Phase 0 (P0) — Schema, types, settings (behavior-neutral)

**Files:** `db.ts`, `types/models.ts`, `settingsService.ts`.

- **`db.ts`** — drop `episodic_memory`; add `memory_entries` (design §6 full schema) +
  `idx_mem_chat_coll`. Add `memory_state TEXT` column to `chats` (via `addColumnIfMissing`).
- **`models.ts`** — `MemoryCollection` interface (design §5.3) + the `memory` block on `Settings`
  (design §9): `enabled`, `collections`, `max_tokens`, `checkpoint_turns`, `checkpoint_tokens`
  (reserved/unused in core), `utility_api_preset_id`, `embedding_api_preset_id` (reserved).
- **`settingsService.ts`** — defaults: `memory.enabled = false`; `collections = [EVENTS]` where
  `EVENTS = { id:'events', shape:'stream', enabled:true, write:{trigger:'checkpoint', prompt:<default>},
  retrieval:{mode:'keyword', count:5, tokenBudget:600}, inject:{label:'Relevant earlier events'} }`;
  `checkpoint_turns = 6`; `max_tokens = 600`; preset ids `''`. Merge-defaults so existing profiles gain
  the block without wiping settings (existing `getSettings` defaulting pattern).

**Done when:** typecheck + build green; app runs unchanged (flag off); a fresh DB has `memory_entries`.

---

## Phase 1 (P1) — `memoryStore.ts` (CRUD)

**Files (new):** `src/main/services/memoryStore.ts`; `test/memory/memoryStore.test.ts`.

- `appendEntries(profileId, chatId, collection, rows)` — insert (id = uuid, timestamps).
- `getEntries(profileId, chatId, collection)` — all rows for a collection, newest first.
- `deleteFromTurn(profileId, chatId, fromFloor)` — `DELETE … WHERE turn_start >= ?` (rewind-safety,
  design §11.M).
- `countEntries(profileId, chatId, collection)`.
- **Tests:** round-trip append/get; `deleteFromTurn` removes only `turn_start >= n`; collection
  isolation; NULL `entity_key` rows coexist (the `UNIQUE` NULL-distinct behavior, design §6).

---

## Phase 2 (P2) — `retrievalService.ts` (reader) + tail wiring

**Files (new):** `retrievalService.ts`; `test/memory/retrieval.test.ts`. **Edit:** `promptBuilder.ts`
(accept `memoryBlock`), `generationService.ts` (call reader, pass block).

- `selectMemories(profileId, chatId, scanText, settings) → { block: string; rows: MemoryRow[] }`:
  for the `events` collection — keyword-qualify rows against `scanText` (factor the qualifier shared
  with `matchAcross`, or a simple token-overlap pass for the core), then fill `retrieval.count` slots:
  **pinned → most-recent 1–2 → keyword-ranked**, trimmed to `retrieval.tokenBudget`. Format the block:
  `"[<label>]\n- <summary>\n- <summary>"`. Empty rows → empty block.
- **Wire** into `generate()` right after `buildScanText` ([generationService.ts:149](../../../src/main/services/generationService.ts)),
  guarded by `settings.memory.enabled`. Pass `block` into `buildPrompt` as `memoryBlock`; `buildPrompt`
  pushes it as a `system` (or `user`) message **immediately before the final user action**
  ([promptBuilder.ts:146](../../../src/main/services/promptBuilder.ts)).
- **Log** `memory: N event(s) recalled` (mirror the lorebook reach line, [:178](../../../src/main/services/generationService.ts)).
- **Tests:** ranking + slot reservation (pinned/recent always present); token-budget trim;
  `enabled:false` → empty block + no array change; **tail placement** (block index is `> last system/
  lore message` and `=== finalUserIndex - 1`).

---

## Phase 3 (P3) — `compactionService.ts` (writer), turn-count trigger

**Files (new):** `compactionService.ts`; `test/memory/compaction.test.ts`. **Edit:**
`generationService.ts` (schedule post-turn), `chatService.ts` (`getMemoryState`/`setMemoryState`),
a `utilityComplete` helper (per design-review #4).

- `maybeCompact(profileId, chatId)` — called after `appendFloor` ([generationService.ts:380](../../../src/main/services/generationService.ts)),
  **after** the floor is returned (don't await it on the response path; `void` it / microtask).
  - Compute the compaction range: floors with `index > last_compacted_floor` and
    `index < floor_count - keep_recent`. If fewer than `checkpoint_turns`, return (nothing to do).
  - Build the extraction prompt for `events` (the collection's `write.prompt` + the floors' text);
    call `utilityComplete`. **Contract:** model returns JSON
    `{ "memories": [ { "summary": string, "keywords": string[], "salience": number } ] }`.
  - Parse defensively. On success: `appendEntries` with `turn_start`/`turn_end` = range bounds; advance
    `last_compacted_floor` via `setMemoryState`. On parse/HTTP failure: **leave everything, log
    "compaction deferred", retry next turn** (do not advance the pointer).
- `utilityComplete(profileId, { system, user, maxTokens })` — resolve `memory.utility_api_preset_id`
  → `ApiPreset` (fallback active), `streamProvider` non-streaming, return text.
- **Tests:** range selection (respects `keep_recent` + pointer); good-JSON → rows appended + pointer
  advanced; bad-JSON → no rows, pointer unchanged (fail-open); idempotence (second call with no new
  aged-out floors is a no-op). Mock `utilityComplete`.

---

## Phase 4 (P4) — Settings toggle, observability, end-to-end

**Files:** renderer settings panel + `locales/en.ts`/`zh.ts`; minor `generationService.ts` logs.

- Minimal settings UI: enable toggle, utility-preset picker, `recall_count`, `checkpoint_turns`. Route
  every string through `t()` in **both** locales.
- Confirm both log lines (recall + compaction) land in the Logs panel.
- **Manual end-to-end** (computer-use can't drive the dev Electron app — see
  [rpt-manual-testing-workflow]): enable memory, run a long-enough session to cross `keep_recent +
  checkpoint_turns`, confirm rows appear and a later turn recalls them; give the owner explicit click +
  log-capture steps.
- Update design-doc §15 status + this STATUS blockquote.

---

## Deferred (explicitly NOT the core)

Entity collections (`characters`/`locations`/`relationships`, design §5.2) and their threads
(§14 T1–T3); vector / hybrid / `llm` ranking + `memory_vec` (§6, §8, §14 T4); salience **decay**,
hierarchical consolidation, supersede, "remember this", emergent-facts→lore promotion (§11 B/E/D/G/L);
custom card-defined collections (§5.3); the user-facing memory **panel** (§11 F); per-mode recall
breadth; the **token-threshold** checkpoint trigger (turn-count only in core). Each lands behind the
already-built registry/store, not by reworking the core.
