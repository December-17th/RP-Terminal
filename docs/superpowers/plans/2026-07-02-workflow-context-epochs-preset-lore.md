# Plan: context epochs + preset/lorebook workflow nodes (世界推进/剧情推进 enablers)

**Date:** 2026-07-02 · **Owner direction:** features like 世界推进 (world advancement) and 剧情推进
(plot planning) are WORKFLOWS assembled from components. They make their own LLM calls with their
own preset + their own lorebook subsets, and 世界推进 writes floor variables MID-TURN that the main
call must then see. · **Executor:** Opus subagent (medium effort) · **Reviewer:** controller.

**Branch:** work on `claude/workflow-decomposed-default` (current checkout, PR #39 base).
**Do not commit** — leave everything in the working tree for the controller's final review.

## Why (the architectural problem)

`input.context` snapshots floors + variables ONCE (`buildGenContext`,
src/main/services/generation/genContext.ts:19 — pure reads, no cache bookkeeping mutated). A branch
that writes floor variables mid-turn (vars.save / mvu.set) is invisible to every later node: the
main prompt reads stale vars AND `apply.state` folds the STALE `workingVars` onto the new floor,
overwriting the branch's writes. This is the recorded "mvu.set pre-phase writes get shadowed" trap.
Fix = context becomes re-acquirable mid-graph (context epochs), plus the component nodes the two
features need (per-call preset skeleton, per-call lorebook subsets).

## Tasks — implement in THIS order, each with its tests before moving on

### 1. `context.refresh` node + ordering outputs on the write nodes

- New node in src/main/services/nodes/builtin/generationNodes.ts (or contextNodes.ts — pick the
  file whose imports it needs; it calls `buildGenContext` exactly like `inputContext` at
  generationNodes.ts:22):
  - type `context.refresh`, title `Refresh Context`.
  - inputs: `gen: Context` (provenance/ordering from the ORIGINAL ctx — value ignored),
    `after: Any` (ordering-not-data edge from the write branch; value ignored — precedent:
    memory.compact's `floor` input, generationNodes.ts:217).
  - outputs: `gen: Context` — a FRESH `buildGenContext(ctx.profileId!, ctx.chatId!, ctx.userAction!)`.
  - **`after` MUST be `Any`, NOT `Signal`**: portCompatible (shared/workflow/types.ts:69) forbids
    non-Signal→Signal anyway, and the engine's prune rules (workflowEngine.ts runNodes) mean a
    dead `after` edge (branch gated off this turn) must NOT skip the refresh — with `Any`, the
    live `gen` edge keeps the node running (allDead requires EVERY incoming edge dead). Put this
    reasoning in the node's doc comment.
- `vars.save` (src/main/services/nodes/builtin/varsNodes.ts) and `mvu.set`
  (src/main/services/nodes/builtin/mvuNodes.ts) currently have NO output ports (mvuNodes.ts:35)
  so nothing can sequence after them. Add to BOTH: output `{ name: 'done', type: 'Any' }`,
  returned as `outputs: { done: true }` on every path that completed the write; the early-return
  no-value path in mvu.set (mvuNodes.ts:40) returns `outputs: {}` (nothing written — the dead
  edge is CORRECT there). Additive; neither node is in the default graph.
- Tests (new test/workflow/contextRefresh.test.ts + extend existing vars/mvu tests):
  - refresh returns a fresh bundle: mock the services genContext reads (or spy on a re-read),
    assert a vars.save-then-refresh sequence yields a gen whose workingVars contain the write
    while the ORIGINAL gen object is unchanged.
  - vars.save/mvu.set emit done on success; mvu.set's no-value path emits nothing.
  - engine-level: a small runWorkflow graph where the write branch is signal-gated OFF —
    refresh still runs (its gen edge alive), downstream receives the refreshed gen.

### 2. `Lore` port type + lorebook selection nodes

- Add `'Lore'` to PORT_TYPES (src/shared/workflow/types.ts:4). Editor: portTypeClass switch
  (src/renderer/src/components/workflow/FlowCanvas.tsx:49) gains `case 'Lore'`; add a
  `.rpt-port-lore` color to src/renderer/src/components/workflow/workflowEditor.css following the
  existing per-type classes (pick an unused hue, tokens/derived like its siblings). Value shape on
  the wire: `Lorebook[]` (src/main/types/character.ts).
- New file src/main/services/nodes/builtin/lorebookNodes.ts (move `toolLorebookSearch` there ONLY
  if it avoids duplication — otherwise leave it in toolNodes.ts and share helpers):
  - **`lorebook.select`** — inputs `gen: Context`, `when: Signal`; output `books: Lore`. Config:
    `books?: string` (comma-separated name filter, same contains-matching semantics as
    tool.lorebookSearch's book_filter, toolNodes.ts:111), `entries?: string` (comma-separated
    case-insensitive substrings matched against entry `comment` — an entry matching ANY term is
    kept; empty = all entries), `exclude_entries?: string` (same syntax, applied after — the
    世界推进 "not 战斗规则" case). Output = filtered DEEP-COPIED books (never mutate
    gen.lorebooks; entries arrays filtered per config). Empty config = all session books, copied.
  - **`lorebook.entries`** — deterministic fetch, NO keyword scan. Inputs `gen: Context`,
    `books: Lore` (optional — unwired falls back to gen.lorebooks), `when: Signal`. Outputs
    `block: Text` (entry contents joined `\n\n`, RAW — same no-EJS-render convention as
    tool.lorebookSearch), `entries: Any` (array of `{ comment, content }`). Config:
    `filter?: string` (comment substrings, as above), `constant_only?: boolean` (default false;
    true keeps only `constant` entries), `max_chars?: number` (0/unset = uncapped, cap the BLOCK).
    Skips `enabled === false` entries always.
- **`tool.lorebookSearch`** gains: optional input `books: Lore` (wired → use instead of
  gen.lorebooks, BEFORE the config book_filter applies) and a second output
  `entries: Any` (array of `{ comment, content }` for the same entries the block contains) — both
  additive.
- Tests (test/workflow/lorebookNodes.test.ts): select filters books + entries + exclude;
  deep-copy (mutating output doesn't touch gen); entries node constant_only/filter/max_chars/raw
  content; unwired books fallback; search honors a wired books input and still applies config
  filters; search's entries output matches its block.

### 3. `prompt.preset` composer (the big one — read this section twice)

The assemble node with its ingredients exposed as ports; unwired port = today's default
computation, so parity is structural.

- **Refactor, don't fork:** extend `assemblePrompt` (src/main/services/generation/assemble.ts:98)
  with an optional 4th param `overrides?: { preset?: Preset; history?: ChatMessage[];
  worldInfo?: string; action?: string }`, and `BuildPromptArgs`
  (src/main/services/promptBuilder.ts:139) with `historyOverride?: ChatMessage[]` and
  `worldInfoOverride?: string`. **With no overrides every code path must be byte-identical —
  test/generation/generateParity*.test.ts are the gate and MUST NOT be touched.**
  - `preset` override: assemblePrompt uses it in place of `ctx.preset` EVERYWHERE it reads the
    preset (buildPrompt args, template `data.presetName/presetPrompts` at assemble.ts:185-190,
    and the params computation at assemble.ts:223-229).
  - `worldInfo` override: assemblePrompt passes `matchedEntries: []` (skip the scan) and buildPrompt
    uses `args.worldInfoOverride ?? <computed worldInfo string>` for the world_info marker + safety
    net (promptBuilder.ts:479,499-502,536-538). Document: the override replaces ONLY the top-level
    World Info block; depth-positioned + marker entries exist only on the internal-scan path.
  - `history` override: the chat_history marker (promptBuilder.ts:504-510) and the no-marker
    safety net (547-551) use the provided messages VERBATIM (no regex/macro passes — they arrive
    pre-processed from context.history etc.), each tagged with `markHistory` so fitToBudget still
    trims them, then append the pending action (`actionOverride ?? args.userAction`, when
    non-empty) as the final user message (macro-expanded via `macroOnly`, same as today's last
    turn). The L4-last invariant (action is the final message) must hold on both paths.
  - `action` override: flows as `userAction` into buildPrompt's args on the override path (it
    affects buildHistory/L4 placement; do NOT touch gen.scanText — lore matching already happened
    or was overridden).
- **The node** (new file src/main/services/nodes/builtin/presetNodes.ts):
  - type `prompt.preset`, title `Preset Prompt`.
  - inputs: `gen: Context`, `history: Messages`, `worldInfo: Text`, `memory: Text`,
    `action: Text`, `when: Signal`. outputs: `sendMessages: Messages`, `params: Any`.
  - config: `preset_id?: string` — resolved via `getPresetById(profileId, id)`
    (src/main/services/presetService.ts:103); missing id → class-B NodeRunFailure code
    `bad-preset` (fail loud, not silent fallback).
  - run(): `matched = (worldInfo wired) ? [] : matchWorldInfo(gen)` then
    `assemblePrompt(gen, matched, memory ?? '', overrides)` mapping wired ports to overrides.
    Unwired memory = `''` (same as default graph's unwired recall? NO — default graph wires
    recall. `''` matches assemble's behavior for an empty block).
- Tests (test/workflow/promptPreset.test.ts): no-ports-wired ≡ prompt.assemble's outputs on the
  same gen (compare sendMessages + params deep-equal); preset_id switches skeleton + params;
  history override lands verbatim + tagged + action appended last; worldInfo override replaces
  the block and skips the scan (spy matchAcross not called); bad preset_id → `bad-preset`.
  AND: the full parity suite stays green untouched.

### 4. `api_preset_id` on `llm.sample`

- configSchema (generationNodes.ts:97) gains `api_preset_id: z.string().optional()`. In run(),
  when set, swap the connection BEFORE `callModelResilient`: reuse resilientCall's `withPreset`
  (src/main/services/generation/resilientCall.ts:121 — currently module-private; EXPORT it) to
  produce the substituted GenContext; unknown id → class-B NodeRunFailure code `bad-preset`.
  Note in the doc comment: rpm_limit/max_concurrent ride the substituted connection (withPreset
  copies them), and `fallback_preset_id` still applies on top for failures.
- Tests: llm.sample with api_preset_id calls the provider with the substituted settings (mock
  callModelResilient or the layer under it and assert the api block); unknown id fails B/bad-preset.

### 5. `messages.trim`

- New node (messageNodes.ts): type `messages.trim`, title `Trim Messages`. Inputs `gen: Context`,
  `messages: Messages`; output `messages: Messages`. Config `budget_tokens?: number` (0/unset →
  `gen.settings.generation?.max_context_tokens || 200000`, same default as assemble.ts:196).
  run() = `fitToBudget(messages, budget)` (promptBuilder.ts:55 — exported). Doc comment: hand-built
  arrays lack the HISTORY_TAG, so trimming uses fitToBudget's legacy fallback (keeps the leading
  system prefix, drops oldest from the first non-system message) — messages that came from
  prompt.preset's history path ARE tagged. Log dropped count via `log('info', …)` when > 0.
- Tests: over-budget hand-built array drops oldest non-system first, keeps last turn; under-budget
  passes through unchanged (same reference or deep-equal).

### 6. i18n + catalog (both locales, every new surface)

- en.ts + zh.ts (src/renderer/src/i18n/locales/): `workflowEditor.nodeTitle.*`,
  `workflowEditor.nodeDesc.*` for context.refresh / lorebook.select / lorebook.entries /
  prompt.preset / messages.trim; `workflowEditor.portDesc.<type>.<port>` for every NEW port
  (including vars.save/mvu.set `done`, lorebookSearch `books`/`entries`); update the
  nodeDesc for llm.sample (api_preset_id) and tool.lorebookSearch (books/entries) in BOTH locales.
  zh terminology: 预设 = preset, 世界书 = lorebook, follow the file's existing phrasing.
- The catalog/list-node-types path derives from the registry automatically — just register all new
  nodes in src/main/services/nodes/builtin/index.ts.

## Constraints (violating any fails review)

- **Parity is law:** test/generation/generateParity*.test.ts and every other characterization test
  stay green UNTOUCHED. `assemblePrompt`/`buildPrompt` with no overrides must be byte-identical.
- No engine changes (workflowEngine.ts). No new deps. No eslint-disable. Only ADD tests.
- Every user-facing string via t() keys in BOTH en.ts and zh.ts.
- PowerShell mangles UTF-8 on file edits (recorded pitfall) — use Edit/Write tools only.
- Verify at the END of EVERY numbered task: `npm run typecheck && npm run check:deps && npm run test`
  (full suite). Report exact counts in the final report.
- Do not commit. Do not touch docs/workflows/decomposed-default.rptflow (updating the example to
  use the new nodes is a follow-up, not this change).

## Out of scope

- 世界推进/剧情推进 example sub-graph docs (authored after the owner iterates on these nodes).
- Vars-as-wire-data override ports on template nodes (the finer-grained alternative to refresh).
- EJS rendering inside lorebook.entries/select output (raw-content convention, matches search).
- Any UI beyond the auto-rendered config forms + port colors.
