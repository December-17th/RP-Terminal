# Grep-based Agentic Notes Memory — Design & Plan

**Status:** Design (pre-implementation) — opt-in prototype, behind a flag + a closed pack gate.
**Date:** 2026-07-10
**Reuses:** `agent.llm` side-LLM core (`runLlmCall`, `agentNodes.ts`), `recentTranscript`
(`memoryCore.ts`), `extractTagAll` (`parseNodes.ts`), the `prompt.assemble` `block` lane → tail
(`generationNodes.ts` → `promptBuilder.ts`), the per-chat file-store pattern (`tableDbService.ts`), and
the opt-in fragment pack model (`tableMemoryPack.ts`).
**Related:** [episodic-memory-design.md](episodic-memory-design.md) (the removed embeddings engine),
[.scratch/sql-table-memory/PRD.md](../.scratch/sql-table-memory/PRD.md) (the live SQL-table memory),
[mvu-support-design.md](mvu-support-design.md), [agentic-mode-design.md](agentic-mode-design.md).

---

## Context

**How memory recall works today.** RP Terminal has **no RAG** — zero embeddings/vectors/FTS in the live
source (an embeddings "episodic memory" engine was built and **removed 2026-07-02**, never shipped;
[episodic-memory-design.md](episodic-memory-design.md)). Current recall is entirely **lexical keyword
activation**:
- **SQL-table memory** ("Memory Manager"): a side-LLM maintainer periodically writes rows into per-chat
  sandbox SQLite tables; at prompt time `table.export` projects rows → lorebook entries → the world-info
  matcher `matchAcross` (`lorebookService.ts:129`, case-insensitive **substring** `String.includes`,
  `entryQualifies:93-105`) → concatenated onto lorebook matches via `prompt.assemble`'s `entries` port
  (`generationNodes.ts:71-93`) → injected as a tail system block.
- **Lorebook/world-info**: the same `matchAcross` scan over the last ~3 turns.
- **MVU** (`stat_data`) is a separate deterministic **numeric** channel.

So recall is already grep-ish, just **passive and shallow**: substring-only, last-3-turns, curated rows,
no query understanding, no ranking beyond `insertion_order`.

**The idea.** A **grep-based agentic memory recall** — explicitly *not* RAG — that works like reading
code: a pre-turn sub-agent formulates queries, greps a memory corpus, reads the matched sections, and
injects the relevant slices. Decisions:
1. **Corpus = an append-only NOTES FILE per chat** (human-readable/editable markdown prose the maintainer grows).
2. **Recall = an AGENTIC pre-turn sub-agent** (a side LLM call — the model cannot tool-call mid-generation).
3. **Ship as an OPT-IN pack behind a flag**, alongside (not replacing) the current table memory.

**Intended outcome:** memory that reaches beyond the 3-turn scan and beyond curated rows, with real
query understanding, while staying disjoint from MVU numbers and cheap enough to run per turn.

## Two hard constraints (verified — they shape everything)

- **The workflow engine is a strict DAG.** `topoOrder` throws `GraphCycleError` on any cycle
  (`src/shared/workflow/graph.ts:12-41`; the engine run is `topoOrder(doc).filter(...)`). ⟹ a multi-round
  grep loop **cannot be graph edges** — it must be a `for`-loop **inside one node's `run()`**.
- **No model tool-calling.** No provider request in `apiService.ts` sends `tools`/`function_call`. ⟹ recall
  is a **separate side LLM call**, exactly how `agent.llm` already makes one.

## Approach

An opt-in **notes-memory pack** with two new nodes over a per-chat markdown notes file, reusing the
existing side-LLM, transcript, tag-parse, and prompt-assembly machinery:

- **`memory.recall`** (pre-turn): reads the notes file → builds a cheap **TOC** of section headings →
  one side LLM call (`runLlmCall`, `stream:false`) that emits `<Query>` tags given the recent transcript +
  TOC → greps the sections → returns a **Text `block`**. Single-shot-with-TOC by default; an internal
  optional 2nd refine round (config `rounds`, default 1) stays inside the node (DAG constraint).
- **`notes.maintain`** (post-turn, cadence-gated): reads recent transcript + current notes → side LLM call
  emits `<MemoryNote section="..." mode="append|replace">…</MemoryNote>` → merged into the file by heading.

**Cache-correct injection (load-bearing):** wire `recall.block → prompt.assemble.block`. That `block`
becomes `memoryBlock` (`generationNodes.ts:90-91` passes `inputs.block` as `assemblePrompt`'s 3rd arg →
`assemble.ts`), inserted as a `system` message at `messages.length - 1` (`promptBuilder.ts:637-640`) — the
**volatile tail**, past the prefix-cache breakpoint. **Do NOT use the `entries` lane** for recall output:
synthesized lorebook entries default to top-of-prompt (cached prefix) and would invalidate the provider
cache every turn. (The removed episodic design reached the same rule: all recalled memory is ephemeral
tail, [episodic-memory-design.md](episodic-memory-design.md) §5.4/§16.1.)

## New files + reused primitives

**New — pure (in `src/shared/`, no fs/electron; satisfies the `shared-not-to-main` depcruise rule):**
- `src/shared/memory/notesGrep.ts` — the grep engine (a real regex/word-boundary matcher, unlike the
  substring `matchAcross`): `parseNotesSections(notes)` (split on `##` headings, capture an optional
  `<!-- keywords: … -->` line + body), `grepSections(sections, query, opts)` (regex/word-boundary/case,
  whole-section-on-heading-or-keyword hit, `grep -C` context on body-only hits, bad regex → literal, never
  throws — mirrors `parseNodes.ts:59-66`), `formatHits(hits, {maxSections,maxChars})`, and
  `mergeNotes(existing, edits)` (upsert a section by case-insensitive heading; append/replace).

**New — main process:**
- `src/main/services/notesMemoryService.ts` — per-chat file store modeled on `tableDbService.ts`:
  `notesFilePath = profiles/<id>/chat-notes/<chatId>.md`, `readNotes`/`writeNotes`/`removeNotes`
  (idempotent). Wire `removeNotes` into `chatService.deleteChat` beside `removeSandbox` (`chatService.ts:348`).
  Add a `writeTextSyncAtomic` to `storageService.ts` (only `writeJsonSyncAtomic` exists today).
- `src/main/services/nodes/builtin/notesMemoryNodes.ts` — the `memory.recall` and `notes.maintain` nodes
  (+ a small tag-with-attributes extractor for `<MemoryNote section= mode=>`). Register both in
  `nodes/builtin/index.ts` `builtinRegistry`.
- `src/main/services/nodes/builtin/notesMemoryPack.ts` — the opt-in fragment pack modeled on
  `tableMemoryPack.ts`: `recall` attached at the `context-ready` branch → `recall.gen`, rejoined at
  `prompt-assembly` on the **`block`** lane; the maintainer group at `turn-committed`. Re-add its builder to
  `BUILTIN_PACKS` (currently `[]` at `tableMemoryPack.ts:273`) so it seeds **with the gate CLOSED** (opt-in
  via the existing Agents activation flow, `agentPackService.ts`).
- `src/main/ipc/notesMemoryIpc.ts` — `chat-notes-get`/`chat-notes-set`; register in the ipc index; expose
  `notesGet`/`notesSet` in `src/preload/index.ts`.

**Reused (do not reimplement) — file:line:**
- Side-LLM call: `runLlmCall`/`buildLlmCallConfig`/`presetParamsWithTemperature`/`llmCallConfigSchema`
  (`generationNodes.ts:130-206`); the whole node shape from `agent.llm` (`agentNodes.ts:197-282`).
- Transcript: `recentTranscript` (`memoryCore.ts:39-58`). Tag parse: `extractTagAll` (`parseNodes.ts:34-41`).
- Query-node shape: `tool.lorebookSearch` (`toolNodes.ts:97-133`). Injection seam + tail:
  `prompt.assemble` (`generationNodes.ts:71-93`) → `promptBuilder.ts:637-640`.
- Maintainer fold pattern: `memory.maintain` (`memoryNodes.ts:124-176`), `MAINTAINER_RULES`
  (`tableMaintenance.ts`). Per-chat file lifecycle: `tableDbService.ts`.

**Setting flag** (`settings.notesMemory`, belt-and-suspenders master switch): `{ enabled:false,
maxSections:6, rounds:1, api_preset_id:'' }` in `getDefaultSettings`/`normalize`/`Settings`
(`settingsService.ts`, `models.ts`). Both nodes **no-op when `enabled===false`**, so flag-off (or gate
closed) = byte-identical to today. Also no-op when the notes file is empty (no wasted side call).

**UI (minimal):** a "Notes" tab in `src/renderer/src/components/memory/MemoryManagerView.tsx` — a textarea
bound to `chat-notes-get/-set` with explicit Save/Reset. All strings via `t()` with `notes.*` keys in
**both** `en.ts` + `zh.ts` (the i18n-parity test requires both).

## Node/agent contracts

- `memory.recall`: inputs `gen:Context`, `when:Signal`; outputs `block:Text`, `entries:Any`, `error:Error`;
  config extends `llmCallConfigSchema` with `messages?`, `temperature?`, `lastNFloors?`(6), `maxSections?`,
  `maxChars?`, `rounds?`(1). Model emits `<Query>…</Query>` tags.
- `notes.maintain`: input `when:Signal`; outputs `report:Text`, `error:Error`; cadence-gated via the existing
  `trigger.cadence → control.mode → …when` chain (as `defaultMemoryTemplate.ts` gates the table maintainer).
  Model emits `<MemoryNote section="…" mode="append|replace">…</MemoryNote>`.

## Build order

1. Pure `notesGrep.ts` (grep + parse + merge) + tests — green in isolation.
2. `notesMemoryService.ts` + `writeTextSyncAtomic`; wire `removeNotes` into `deleteChat`.
3. `settings.notesMemory` flag.
4. `memory.recall` node + register + node test (mock `runLlmCall`).
5. `notes.maintain` node (+ MemoryNote extractor) + register + test.
6. `notesMemoryPack.ts` (recall on the `block` lane; maintainer at turn-committed) + re-add to `BUILTIN_PACKS`
   + a pack-parity test (gate closed ⇒ effective doc deep-equals the narrator).
7. IPC + preload + Notes tab + `notes.*` i18n.

## Verification

- Gate: `npm run typecheck && npm run check:deps && npm run test`.
- Pure tests (repo convention — vitest node env, extract pure modules): `test/notesGrep.test.ts`
  (sections/regex/word-boundary/whole-section/context/bad-regex-as-literal/caps), `test/notesMerge.test.ts`
  (append vs replace vs create, case-insensitive heading), `test/notesMemoryPackParity.test.ts` (gate-closed
  = byte-identical, mirroring `test/workflow/tableMemoryPackEquivalence.test.ts`), and node-level tests with a
  mocked `runLlmCall` (recall no-op on empty notes; happy path parses `<Query>` → non-empty `block`;
  maintainer applies `<MemoryNote>` via mocked `writeNotes`).
- End-to-end (manual, via the app): bind no table template, open the notes-pack gate, hand-write a 3-section
  notes file, run a turn, and confirm (a) the recall side call appears in the run trace, (b) the recalled
  section text lands in the **tail** system block of the stored `request` log — not the cached prefix, and
  (c) after N floors the maintainer appended a `<MemoryNote>` to the file.

## Risks / deferred (prototype scope)

- **Per-turn side-call latency/cost — top risk.** `memory.recall` runs synchronously **pre-turn on the
  player's critical path** (unlike the post-turn table maintainer). Mitigations built in: no-op on empty
  notes, single-shot-with-TOC (1 call, default), a cheap `api_preset_id`; expose an optional **cadence**
  (recall every K turns / on scene change) as the main cost lever. Do not default `rounds:2`.
- **Notes-file growth.** The maintainer must **upsert by heading** (`mergeNotes`), not blind-append; a
  consolidation pass + size cap are deferred.
- **Rewind/history — deferred.** Notes have no op-log; a rewind past a maintained point leaves stale prose
  (human-editable file mitigates for v0). A later increment can gate the maintainer to floors already below
  the trim pointer for rewind-safety.
- **Disjointness.** Three separate stores (notes `.md` vs `table-dbs/*.sqlite` vs floor `stat_data`); the
  maintainer prompt must say "narrative/prose only — do not restate MVU numbers or duplicate the SQL tables"
  (the [episodic-memory-design.md](episodic-memory-design.md) §11.H discipline). Running notes-memory *and*
  table-memory together is additive but may double-summarize the same floors — surface as a "pick your memory
  system" note, not a hard block.
