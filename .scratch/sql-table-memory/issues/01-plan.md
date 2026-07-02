# Plan for issue 01 — Remove the episodic-memory engine

Status: approved-for-implementation
Issue: [01-remove-episodic-memory-engine.md](01-remove-episodic-memory-engine.md)
Inventory verified 2026-07-02 on branch `claude/interesting-banach-1ccfdb` (84a5552) by grep over `src/`, `test/`, `docs/`.

## Scope decision (KEEP vs DELETE)

**KEEP — generic prompt-tail plumbing (future reuse by table memory):**
- `prompt.assemble`'s `block` input port and `prompt.preset`'s `memory` input port (unwired = empty block; that contract already exists).
- `assemblePrompt`'s memory-block parameter and `promptBuilder.ts` `memoryBlock` handling (~167, ~632-638). These are producer-agnostic Text injection points. Only the *producers* die.

**DELETE — everything that produces/stores/recalls memories:**

### Main services (delete whole files)
- `src/main/services/memoryStore.ts`
- `src/main/services/compactionService.ts`
- `src/main/services/retrievalService.ts`
- `src/main/services/embeddingService.ts`
- `src/main/services/memoryEvents.ts`
- `src/main/services/generation/memoryRecall.ts`
- `src/main/ipc/memoryIpc.ts` (+ its registration in `src/main/ipc/index.ts`; channels are raw `ipcMain.handle` strings `memory-list/update/delete/add` — nothing in `src/shared` to touch, verified no `memory` hits in shared)

### Nodes
- Delete `src/main/services/nodes/builtin/memoryNodes.ts` (memory.gate/extract/write/query).
- In `generationNodes.ts`: remove `memoryRecallNode` (memory.recall) and `memoryCompact` (memory.compact) + their imports (`recallMemory`, `compactMemory`).
- `builtin/index.ts`: remove the six registrations + imports.
- `defaultGraph.ts`: remove nodes `recall`, `gate`, `extract`, `memwrite`, `log-extract`, `log-write` and all their edges; `assemble`'s `block` input goes unwired; update the doc description string. Result: ctx → assemble → sample → parse → apply → writeFloor.

### Generation pipeline
- `generation/persistFloor.ts`: remove `compactMemory` + the `maybeCompact` import (keep `persistFloor` itself untouched).
- Check for any other `compactMemory` callers (generate parity paths) and remove.

### Chat/DB layer
- `chatService.ts`: remove `MemoryState`, `getMemoryState`, `setMemoryState`, and the rewind-safety block (~288-296) + the `deleteFromTurn`/`rewindCompactionPointer` import from memoryStore.
- `db.ts`: remove the `memory_entries` CREATE TABLE + `idx_mem_chat_coll` index from SCHEMA; remove the `memory_state` addColumnIfMissing migration (~166) and the `embedding` addColumnIfMissing (~170); ADD a migration `DROP TABLE IF EXISTS memory_entries;` (follow the existing `DROP TABLE IF EXISTS episodic_memory;` precedent at ~129 — keep that line too). Existing DBs keep a stale unused `chats.memory_state` column; that's deliberate (SQLite column drops aren't worth it; no reader remains) — note it in a comment next to the episodic_memory drop.

### Settings model
- `types/models.ts`: remove `MemoryCollection` interface (~47-…) and the `memory` block from `Settings` (~205-224).
- `settingsService.ts`: remove memory defaults (~160-223 portion), `mergeCollections` (~229-…), and the memory merge in the stored-settings merge (~292-296, ~356). Stored settings JSON with a leftover `memory` key is simply ignored by the merge — verify that's true after the edit.

### Renderer
- Delete `components/MemoryView.tsx` and `components/MemoryPanel.tsx`.
- `components/workspace/Panel.tsx`: remove the `memory: 'view.memory'` view registration (~17) and any switch/case rendering MemoryView; check for a view-picker list elsewhere (grep `'memory'` in renderer) and remove the entry.
- `components/SettingsModal.tsx`: remove the `memory` section (Section union ~12, rail item ~45, panel branch ~58-60, `MemoryPanel` import).
- `stores/settingsStore.ts`: remove memory-related state/actions.
- i18n `locales/en.ts` + `locales/zh.ts`: remove ALL now-orphaned keys (`settings.memory`, `view.memory`, MemoryPanel/MemoryView keys). Both files in the same commit.

### Example workflow
- `docs/workflows/decomposed-default.rptflow`: remove the `recall` node (line ~29) + the gate/extract/memwrite/log-extract/log-write chain (~71-…) and their edges; fix the description text. The example must load and validate against the shrunken catalog.

### Tests
- Delete: `test/memory/` (compaction, compactionService, embeddingService, memoryStore, retrieval, selectMemories), `test/workflow/memoryNodes.test.ts`.
- Update deliberately (same commit as the code they pin): `test/nodeCatalog.test.ts`, `test/workflow/defaultGraph.test.ts`, `test/workflow/editorModel.test.ts`, `test/generation/generateParity.test.ts` / `.abort` / `generateResolve` (they reference recall/compaction stages), `test/chatWriteShapes.test.ts` + `test/chatWriteService.test.ts` (memory_state), `test/promptBuilder.test.ts` (KEEP memoryBlock cases — that plumbing stays), `test/workflow/promptPreset.test.ts` (KEEP memory-port cases), `test/workflow/builtinNodes.pre.test.ts` / `.terminal` (remove recall/compact node cases only), `test/nodeStateService.test.ts`, `test/thRuntimeShapes.test.ts`, `test/workflow/extractorNodes.test.ts` (check what the hits are; only touch memory-engine references).

### Docs
- `docs/episodic-memory-design.md`: prepend a superseded banner in the Status header ("Superseded 2026-07-02 by the SQL-table memory overhaul — see `.scratch/sql-table-memory/PRD.md`; engine removed from the codebase"), leave the body (point-in-time policy).
- `docs/sdk/README.md`: remove/adjust memory-node references.
- Leave `docs/superpowers/plans|specs/*` and `docs/prompt-cache-optimization-design.md` untouched (point-in-time snapshots).
- `workflowEvents.ts` + `chatEvents.ts`: fix comments that cite the memoryEvents pattern (reword, don't reference a deleted file).

## Behavior notes for the implementer
- Saved user workflow docs referencing removed node types must degrade via the EXISTING unknown-node-type validation path — verify what `validate.ts`/the editor do with an unknown type and confirm it's a user-visible validation error, not a crash. Do not build new migration UX.
- `memory.enabled` was always default-off and the store was never populated in live use — no data migration.
- Do NOT touch `shared/thRuntime`, transports, combat/duel, or anything outside the inventory above. One concern per commit is ideal (services+nodes+graph / settings+db+chat / renderer+i18n / tests+docs), but a single coherent commit is acceptable.

## Verification gate
`npm run typecheck && npm run check:deps && npm run test` all green, plus a final repo-wide grep proving no references remain to: `memoryStore|compactionService|retrievalService|embeddingService|memoryRecall|memoryEvents|MemoryCollection|memory_entries|memory\.(recall|compact|gate|extract|write|query)` (excluding docs snapshots and `.scratch/`).
