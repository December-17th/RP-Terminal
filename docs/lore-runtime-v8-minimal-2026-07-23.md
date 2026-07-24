# RP Terminal Lore Runtime V8 — Minimal Design

**Date:** 2026-07-23
**Status:** Accepted design; supersedes the V7 design and the V7 sanity-check review as the
implementation plan. V7 remains the requirements / future-ideas record (see the deferred appendix).
**Owner decisions codified here (grilling session 2026-07-23):**
1. Regenerate and swipe **Resample** by default: they replay the stored prompt and draw only a new
   model response — no lore re-selection, no memory recall, no build-time EJS. Deterministic
   probability is therefore unnecessary and is dropped.
2. Resample is gated by a per-chat **Assembly Epoch**: if anything assembly-relevant was edited
   since the floor was generated, regenerate falls back to today's full reassembly (fresh lore
   selection, fresh probability rolls — accepted nondeterminism).
3. **No per-floor lore state.** No activation ledger, no compact lore snapshot, no revision hashes.
   The stored floor `request` is the complete record of what the model saw.
4. Timed semantics (sticky / cooldown / delay) and groups are **deferred until a concrete card
   fixture demands them** — they are not part of this design's contract.
5. The `injection_trigger` deviation under Resample is **accepted** (see WP-G1).
6. Context pins are configured by the **card author only** (`pin_paths` in the card's
   `rp_terminal` extension).

## Goals

- **Retrieval accuracy:** keyed entries fire when the *state* is relevant, not only when the last
  few messages happen to mention the keyword (context pins), and ST regex keys actually match
  (today they are treated as literal strings and silently never fire).
- **Fidelity:** imported lorebooks round-trip their source identity and metadata instead of being
  lossily flattened.
- **Cache:** regenerate/swipe on an unedited chat become byte-identical prompt replays — a
  guaranteed provider-cache prefix hit and zero assembly cost. No lore reordering, banding, or scheduling; placement
  stability (already deterministic via `insertion_order` sort) is the only cache lever the lore
  system owns. Everything further belongs to the parked WS-2 cache project.

## Non-goals

Everything in the deferred appendix, plus: no new subsystems, no new persistence, no scoring or
discovery, no changes to entry placement/ordering, no changes to the EJS evaluation model (the
existing render-once-per-assembly + template-write journal is already correct and stays untouched).

## Architecture (unchanged spine, three insertions)

```text
IMPORT                       normalizeLorebookData: NOW preserves id + extensions   [WP-L1]
  |
ACTIVE LOREBOOKS             unchanged (chat-selected ids, default = character book)
  |
SCAN CONTEXT                 buildScanText(floors, action, depth) + PIN BLOCK       [WP-L3]
  |
MATCH                        matchAcross: + regex keys in entryQualifies            [WP-L2]
  |                          (recursion, probability roll, exclusions: unchanged)
SELECTED ENTRIES             unchanged (insertion_order sort, partitionLore)
  |
PROMPT BUILDER               unchanged (renderLoreEntry once per entry, graceful EJS)
  |
TEMPLATE-WRITE JOURNAL       unchanged ('template' ops, replay applies pre-fold)
  |
FLOOR COMMIT                 unchanged (request + variables + template ops)

REGENERATE / SWIPE           Assembly Epoch current → Resample (stored request +    [WP-G1]
                             template ops; sample only); stale → full reassembly
```

## Work packages

One module per PR, in this order. WP-L1..L3 are lore-module PRs; WP-G1 is a generation-module PR
and is independent of the other three.

### WP-L1 — Import fidelity (behavior-neutral)

`normalizeLorebookData` (`src/main/services/lorebookService.ts:184`) currently maps ~13 fields and
discards everything else (`uid`, `extensions`, timed fields, group fields, most positions).

- Add optional `id: z.string()` to `LorebookEntrySchema` (`src/main/types/character.ts:9`).
  On import: use the source `uid`/`id` when present, else mint a UUID once. Existing saved
  lorebooks without ids get ids minted lazily on next save (schema default keeps them parseable).
  Minting happens in the **main-process save path** (`saveLorebookById`), the single authority —
  the renderer editor creates id-less entries (`emptyEntry()` in `lorebookStore.ts`) and must not
  mint its own. Editor round-trip is verified safe: `updateEntry` patch-merges over the existing
  entry object and `save` sends the whole lorebook, so preserved fields survive UI edits; both
  `id` and `extra` are schema fields, so `LorebookSchema.parse` on save keeps them.
- Map the source entry's `extensions` object into the existing opaque `extra` bag
  (`character.ts:30`), merged with (not replacing) any runtime-tagged keys. Unmapped scalar fields
  the normalizer does not understand (`sticky`, `cooldown`, `delay`, `group`, `position`,
  `useGroupScoring`, …) go under `extra['st_source']` verbatim, so a future timed/groups WP — and
  lorebook re-export — can read them without a re-import.
- Export (`exportLorebookToFile`) keeps emitting our native shape; the preserved fields ride along.

**Non-goals:** no migration framework, no revision hash, no behavior change to matching — the
characterization tests on the matcher must pass untouched.

### WP-L2 — Regex keys

`entryQualifies` (`lorebookService.ts:93`) does literal `includes()` only. ST supports
`/pattern/flags` keys and the Chinese card ecosystem uses them heavily.

- Behavioral contract (verified against the ST checkout's world-info matching, 2026-07-23 —
  clean-room: match behavior, never port code): a key is a regex when it is slash-delimited
  `/pattern/flags`, internal `/` escaped, flags optional and drawn from JS `RegExp`'s
  `g i m s u y`. A regex key tests the **untransformed** scan text — its own flags govern case;
  `case_sensitive` does not apply to it. A key that looks slash-delimited but fails to compile
  falls back to plaintext matching (ST behavior).
- Known deviation, recorded not built: ST also has a `matchWholeWords` option (word-boundary
  matching for plaintext keys). RPT behaves as `matchWholeWords: off` (plain substring), which is
  what CJK cards need; record in `docs/compat-comparison.md` alongside this WP.
- Cache compiled regexes per match call (a `Map` in `matchAcross` scope), not globally — no new
  state.
- Applies identically to primary and secondary keys, and to recursion passes (same function).

**Fixtures:** regex primary key match/non-match, regex + `selective` secondary, invalid-regex
fallback, case-flag behavior, recursion pass with a regex key.

### WP-L3 — Context pins

The accuracy win: append configured **current variable values** to the scan text so state-relevant
entries fire even when recent messages stop naming them.

- **Config surface (one, not three):** `pin_paths: string[]` under the card's
  `data.extensions.rp_terminal` block (schema addition in `character.ts`), listing paths into the
  floor variables (e.g. `stat_data.location`, `stat_data.party`). A path resolving to a scalar
  contributes its string value; a short array contributes each element; objects and long arrays
  are skipped (log a dev-diagnostic, don't guess).
- **Canonical block format** (delimited, so pin text can't be confused with conversation prose and
  the bytes are stable for a given state):
  `\n[PINS] location: 王都 | party: 艾莉亚, 尤兹\n` — one line, fixed order = config order,
  fixed separators. The block is **appended to scan text only** — it never enters the prompt.
- **Seam:** build the block in `buildGenContext` (`genContext.ts:79`) from `workingVars` (the
  latest-floor seed, already in hand) and append it to the `buildScanText(...)` result. The
  matcher, recursion, and `entryQualifies` need no changes — pins are just more scan text.
- Pinned values participate in the first (non-recursive) pass and recursion exactly like
  conversation text. Retrieved memory stays out of scan input (already true: scan text is built
  before memory recall runs — `classicTurn.ts` stage 1 vs stage 2).

**Known risk, accepted:** a pin value containing a common word can false-trigger an unrelated
entry. Mitigation is authorial (choose keys sensibly) — no stop-lists or weighting in v1.

**Fixtures:** pinned scalar fires a keyed entry absent from conversation; pin + `selective`
secondary; empty/missing path contributes nothing; pin block bytes are stable across two builds
with identical state.

### WP-G1 — Resample: regenerate/swipe replay the stored prompt

Today `regenerate` and `generateSwipe` (`src/main/services/generationService.ts:264,288`) cut the
last floor and re-run the full `generate()` pipeline — fresh recall, fresh lore rolls, fresh EJS.
New behavior: **when the floor's Assembly Epoch is current, replay the stored request; only the
sample is new.** When it is not current, fall back to today's full reassembly, unchanged.

**Assembly Epoch (the edit flag):**
- One persisted **per-chat** counter (chats table column). Each floor stores the epoch it was
  assembled under (new nullable floors column, `addColumnIfMissing` pattern). Resample requires
  exact match; `NULL` (legacy floor) is stale — this subsumes the "no stored request" fallback.
- Bumps are deliberately coarse — a false positive only costs a normal reassembly, which is
  always correct. Bump the chat's epoch on:
  - a User Variable Edit or transcript mutation (edit/cut/swipe-switch) touching any floor
    **strictly below the latest** (the latest floor's own response/swipes/variables do not feed
    its own prompt — they die with the cut on regenerate, as today);
  - the chat's lorebook selection, FSM mode, or VN-mode changing;
  - a save to any lorebook the chat references (including the character's embedded book for
    chats on the default selection), a save to the chat's card, or any preset save/switch
    (active preset is profile-global → bump all chats).
- The existing in-memory `transcriptEpoch` (`floorService.ts:32`) is NOT the backbone — it
  resets on app restart; the Assembly Epoch is persisted.

- **Before the cut**, read from the target floor: (a) its stored `request` (the final
  `sendMessages`, persisted at `persistFloor.ts:53`), and (b) its `'template'`-source journal ops.
  Both die with the cut (`FloorState.deleteFromFloor` removes `floor_operations` and the floor in
  one transaction — `FloorState.ts:893`), so capture order is mandatory.
- Then cut, seed `workingVars` from the new last floor, **apply the captured template ops** to
  `workingVars` (mirroring live pre-fold order), call `sampleMainCall` with the stored
  `sendMessages` and **sampling params recomputed from the active preset** (params are not stored
  with the floor; recomputing them is desired — the player can raise temperature and re-roll
  without changing a byte of the prompt), then parse / fold / persist exactly as the live path,
  passing the captured ops through the existing `templateWrites` argument of `persistFloor` so
  they are re-journaled against the replacement floor.
- Stages skipped entirely on Resample: memory recall, context trim, table export, lore match,
  prompt assembly. Regenerate becomes the cheapest operation in the app and a guaranteed
  cache-prefix hit.
- The two-signal abort contract, swipe bookkeeping (`normalizeSwipes` append + restore-on-empty),
  and the yuzu director stage (response-dependent) are unchanged on both paths.
- **Documented compat deviation (owner-accepted):** ST preset blocks gated via
  `injection_trigger: ['regenerate'|'swipe']` (`src/main/types/preset.ts:68`) cannot fire under
  Resample — the stored prompt predates the trigger. They still fire whenever the epoch forces a
  reassembly (that path passes `generationType='regenerate'` as today). Record both halves in
  `docs/compat-comparison.md` in the same PR.
- Execution record: on Resample keep the target floor's existing record (assembly is unchanged);
  do not stamp a new one. Emit a dev-diagnostic line stating which path (resample vs reassembly)
  a regenerate took and why.

**Fixtures:** clean-epoch regenerate reuses stored bytes (assert provider payload === stored
request); template ops survive Resample (old floor's `'template'` ops re-journaled on the new
floor and Forward Replay of the regenerated chat matches live state); swipe preserves prior
alternates; abort-with-empty restores the original floor; `NULL`-epoch (legacy) floor falls back
to full reassembly; an edit below the latest floor bumps the epoch and forces reassembly; an
edit to the latest floor's own response does NOT bump; swipe-switching on the latest floor does
NOT bump (browse-then-swipe-again stays a Resample); a lorebook save referenced by the chat
bumps; edited-then-resent action goes through the full path (it is a new turn, not a regenerate).

## Normative requirements retained (from V7, still binding)

- The app stays generic: no card-specific lore logic.
- Standard lorebooks work without conversion; import is non-destructive (WP-L1 strengthens this).
- Compatibility matching runs before any future enhancement and is never trimmed by a lore budget.
- Retrieval never executes EJS; each selected EJS entry evaluates once per assembly attempt in
  existing traversal order; empty-render entries keep their variable effects.
- Template effects land before the model fold and are journaled (already true; WP-G1 extends the
  guarantee across regenerate).
- One pinned edge to fixture now: recursion feeds **raw** entry content — including unrendered EJS
  source — as scan text (`lorebookService.ts:158`). Write a characterization fixture for whatever
  the current behavior selects, so future EJS-aware changes are deliberate.

## Deferred appendix (V7 ideas — need a concrete card, fixture, or profiling data first)

Timed semantics (sticky/cooldown/delay — note: with no per-floor lore state, a future
implementation must either introduce that state *then* or derive counts from stored floor
requests); group semantics; native package archives / sidecars / manifests / migrations;
historical package snapshots; behavior-lane runtime; scene epochs; revision hashes; lexical
discovery (BM25/n-grams/typo/embeddings); discovery budgets and hysteresis; Catalog Librarian
Agent; derived reference graph; containment inference; weighted topology / navigation; scene
packs and cache banding; effect-aware EJS render caches; native content views / inheritance;
persistent incremental indexing.

## Grounding

Verified against, at design time: `src/main/services/lorebookService.ts` (matcher, normalizer,
recursion), `src/main/services/generation/genContext.ts` (scan text, workingVars seed, parked
cache), `src/main/services/promptBuilder.ts` (renderLoreEntry, partitionLore, placement),
`src/main/services/generation/classicTurn.ts` + `assemble.ts` (write capture bracket),
`src/main/services/generation/persistFloor.ts` (stored request, template-op journaling),
`src/main/services/agentRuntime/floorState/FloorState.ts` (pre-fold template replay,
cut-deletes-ops), `src/main/services/generationService.ts` (regenerate/swipe funnel),
`src/main/types/preset.ts` (injection_trigger), `src/main/types/character.ts` (schemas).
