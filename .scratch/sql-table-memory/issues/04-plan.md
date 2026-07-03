# Plan for issue 04 — Prompt projection: `table.export`

Status: approved-for-implementation
Issue: [04-prompt-projection-table-export.md](04-prompt-projection-table-export.md)
Grounding (verified 2026-07-02, head c555cf9): `types/character.ts:8-33` (`LorebookEntry`: `keys`, `constant`, `insertion_order`, `insertion_depth` — null = top World Info block, numeric = depth-spliced system message; `prevent_recursion`; `comment`), `generation/assemble.ts:78-106` (`matchWorldInfo` → `matchAcross(lorebooks, scanText, rng, maxRecursion)`), `assemble.ts:116+` (`assemblePrompt(ctx, matchedEntries, memoryBlock, overrides)` — **matchedEntries is already a parameter, so appending extra entries needs NO assemble.ts change**), `promptBuilder.ts:322-323` (top vs depth partition on `insertion_depth`), `presetNodes.ts` (worldInfo override → `matched = []`), `tableDbService.readAllTables` (columns = SQL names when the sandbox exists; ROWS ARE POSITIONAL in DDL order, which mirrors `template.headers` order).

## Design (locked)

Synthesize REAL `LorebookEntry` objects from table data per each table's `exportConfig`, qualify them with the REAL matcher (`matchAcross`), and feed them into the existing assemble machinery through a new optional `entries` input port on `prompt.assemble` / `prompt.preset` that concatenates onto `matchedEntries`. Unwired port = empty concat = byte-identical parity (the issue's hard AC).

### Placement mapping (document in docs/sdk — this is the compat contract)
- `at_depth_as_system` → `insertion_depth = depth`, `insertion_order = order` (rides the existing depth-splice).
- `before_character_definition` / `after_character_definition` → `insertion_depth = null` (top World Info block), `insertion_order = order`. Our lorebook model has no char-def anchor; the top block is the closest anchor — an APPROXIMATION, documented as such.
- Only `entryPlacement` / `extraIndexPlacement` are honored in v1; the `fixed*` placements are imported-and-ignored (documented).

## Modules

### 1. `src/main/services/tableExportService.ts` — pure synthesis (unit-tested against the poem fixture)

- `renderRow(headers, row)` → `header: value` lines (one per column, in order; null/'' cells rendered as empty). Exported + tested — this is the `$1` for `splitByRow` entries.
- `renderWholeTable(headers, rows)` → header line then one ` | `-joined line per row (deterministic, documented).
- `renderIndexLine(indexColumns, headers, row)` → `col: value` pairs joined with ` | ` for the configured index columns.
- `applyTemplate(wrapper, body)` → wrapper with `$1` replaced (empty wrapper = body as-is).
- `columnIndex(headers, displayName)` — the display-name → positional-index map (rows are positional in `headers` order; SQL column names are NOT used here).
- `synthesizeEntries(template, reads: TableRead[]): LorebookEntry[]` — per enabled-`exportConfig` table:
  - `splitByRow: true` → one entry per data row: `content` = applyTemplate(injectionTemplate, renderRow(...)), `comment` = `entryName#<rowIndex>`, `constant` = (entryType === 'constant'), `keys` = for keyword entries, the CELL VALUES of the `keywords` config columns (comma-separated DISPLAY names) PLUS the cell values of index columns whose mode is `'both'` (trimmed, empties dropped, de-duped); placement per the mapping above; `prevent_recursion: true`.
  - `splitByRow: false` → one entry for the whole table (same key rule applied over ALL rows' cell values for keyword entries).
  - Index entry (when `extraIndexEnabled`) → ALWAYS-ON (`constant: true`): `content` = applyTemplate(extraIndexInjectionTemplate, one renderIndexLine per row joined by newline — empty body when no rows, per the issue AC "empty tables inject nothing except an index entry if configured"), `comment` = extraIndexEntryName, placement from `extraIndexPlacement`.
  - Tables with `exportConfig.enabled: false` contribute NOTHING (not even an index).
  - Zero data rows → no row entries (only the index case above).
- Pure: takes template + reads, no I/O.

### 2. `table.export` node (add to `nodes/builtin/tableNodes.ts`, register in `builtin/index.ts`)

- inputs: `gen: Context`, `when: Signal`; outputs: `entries: Any` (qualified LorebookEntry[]), `block: Text` (the top-block rendering of the qualified null-depth entries, `renderLoreEntry`-equivalent join — for composed prompts that want text), `error: Error`.
- config (zod): `tables?: string` (comma-separated sqlNames narrowing which tables project; unset = all), `max_rows?: number` (int 1..500, per-table cap on projected data rows, newest-last rows kept — protects the prompt; unset = all rows).
- run: no template assigned → `{ outputs: { entries: [], block: '' } }` (SILENT — export is a read; a chat without table memory simply projects nothing; unlike table.apply this is not an error). Read rows via `tableDbService.readAllTables`, synthesize, then QUALIFY: build a temp `Lorebook` (`{ name: 'table-export', entries }`) and run `matchAcross([book], gen.scanText, Math.random, gen.maxRecursion)` — constant entries always survive, keyword entries only on a scan hit: the REAL matching path, satisfying the AC. Output the qualified list.
- Do NOT auto-inject anywhere: projection reaches the prompt only through wiring.

### 3. `entries` input port on the two composers

- `generationNodes.promptAssemble`: new optional input `{ name: 'entries', type: 'Any' }`; run: `const extra = Array.isArray(inputs.entries) ? inputs.entries : []`, then `assemblePrompt(gen, [...matched, ...extra], block)`. No assemble.ts signature change.
- `presetNodes.promptPreset`: same port; with a wired `worldInfo` override the scan is still skipped (`matched = []`) but wired `entries` are STILL appended (they're explicit author intent) — document in the node comment.
- Parity: unwired port → identical arrays → the existing byte-parity suite (`test/generation/generateParity*.test.ts`) must stay green untouched.

## Tests

- `tableExportService` against the REAL fixture's configs (`test/fixtures/chatsheets-poem-of-destiny-5.9.json` via the parser):
  - 重要角色表: splitByRow row entries; keys from 姓名 + 角色间关系 cells PLUS 'both'-mode index columns; wrapper `<角色最新信息>` applied; index entry from 姓名/所在位置/角色间关系 with `extraIndexInjectionTemplate`; `entryPlacement` after_character_definition → top block (null depth, order 680).
  - 纪要表: keyword entry keys from 编码索引 cells; index constant; `at_depth_as_system` depth 999 → insertion_depth 999/order 10000.
  - 主角信息: `enabled: false` → zero entries.
  - 伏笔表/约定表: constant entries (no keys needed), depth 1003 mapping.
  - Empty rows → only index entries (empty body); disabled → nothing; max_rows cap keeps the LAST N rows.
- Qualification: a small direct test that `matchAcross` over synthesized entries keeps constants and keyword-matches against scan text (reuse existing matchAcross test patterns).
- Node run(): no-template silent empty; tables filter; block contains only null-depth qualified entries' content.
- Composer ports: promptAssemble/promptPreset with `entries` wired appends (assert via the returned sendMessages containing the entry content at the right region on a minimal gen fixture — mirror `test/workflow/promptPreset.test.ts` style); UNWIRED parity = existing generateParity suite must pass unmodified.

## Docs
`docs/sdk/table-templates.md`: "Prompt projection (issue 04)" section — the placement mapping table (incl. the before/after→top-block approximation and ignored `fixed*`), the row/index rendering formats, the key-derivation rule (keywords columns + 'both' index columns), and the wiring recipe (table.export → prompt.assemble `entries`). README mapping row.

## Out of scope
No gate/read/query nodes, no example workflow (05), no default-graph changes (the default graph does NOT auto-wire table.export in this issue — 05's example workflow demonstrates the wiring), no view changes.

## Verification gate
`npm run typecheck && npm run check:deps && npm run test`; generateParity tests UNTOUCHED and green.
