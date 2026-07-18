# Agentic Mode — Design (Track 3)

Status: **Partially superseded by ADR 0019 and the Agent Runtime design (2026-07-18).**
The shipped manual Explore/Dialogue/Combat FSM remains current implementation. The unshipped
model-called tool-loop, provider-tool transport, and `sub_generate` design are superseded; preserve
the historical body below.
This is the refreshed Phase D design doc that opens Track 3 (the "Agentic foundation").
It defines the contract for four roadmap phases that share three foundations:

- **Phase H** — manual FSM modes (Explore / Dialogue / Combat). _Keystone._
- **Phase D (D1)** — the tool/action loop: the model takes actions mid-turn.
- **Phase I** — deterministic combat math in a worker sandbox; LLM is flavor-only.
- **Phase J** — protected/unprotected lore + a backend mutation gatekeeper.
- **Phase D (D2)** — state-schema + widget authoring UI.

It is design-doc-first on purpose: the **action schema**, the **FSM transition
semantics**, the **sandbox message contract**, and the **gatekeeper rules** are hard
to change once cards and saved sessions depend on them.

---

## 1. Purpose & scope

Turn RP Terminal from a one-shot chat turn into a small **agent loop** with
**deterministic, sandboxed game mechanics** — without sacrificing the Phase G
prompt-cache discipline or the "keyword lorebook is primary" stance.

### Goals

- The model can **request actions mid-turn** (roll dice, read/write state, query
  lore, resolve combat, mutate unprotected lore) and continue with the results.
- **Deterministic mechanics** — combat/RNG runs in a sandbox with seeded RNG, so
  results are reproducible, testable, and cache-safe. The LLM narrates flavor; it
  does not invent numbers.
- **Manual mode switching** (Explore / Dialogue / Combat) tunes generation and is the
  checkpoint at which lore re-matches and deferred injections flush.
- **Portable + reversible** — everything degrades gracefully to the existing
  single-shot text turn on providers/cards that don't opt in.

### Non-goals (this track)

- **Auto-routing of modes.** Auto-routing is the future `agentic` Agent Mode (a cheap-API
  intent classifier picks the scene); `manual` is the baseline and ships first.
- **Local ML / embeddings.** RAG is Phase K (Track 4), strictly additive and opt-in.
- **A full STScript/agent DSL.** Tools are a fixed registry + card-declared + (later)
  plugin-contributed; not a general scripting language.
- **100% provider tool-calling coverage.** Many OpenAI-compatible proxies this app
  targets don't support `tools`; the **tag transport** (§4) is the portable baseline.

---

## 2. Core principles (the throughline invariants)

Every phase below is constrained by these. They are the reason the design hangs
together rather than five independent features.

1. **Cache discipline — new content lands at L4 or changes only on transition.**
   Tool results, combat event blocks, and flushed lore all append at the _bottom_
   (L4) of the prompt, or change only at a mode transition. The cached L1–L3 prefix
   must stay byte-stable across turns within a mode (Phase G). Violating this regresses
   caching — it is the single constraint that touches every phase. See §11.
2. **Determinism.** All RNG (combat, lore `probability`, action resolution) is
   **seeded**, mirroring the injectable `rng` already used in
   [`matchAcross`](../src/main/services/lorebookService.ts). Reproducible + unit-testable.
3. **Sandbox by construction.** Untrusted author code (combat scripts) runs in
   **quickjs-in-a-worker**, never node `vm` (already rejected for templates). No
   ambient `process`/`require`/`fetch`/FS.
4. **Validate every model-supplied input with Zod** before any tool acts. The model
   is treated as an untrusted caller — tool inputs are parsed/clamped, not trusted.
5. **Clean-room re: js-slash-runner.** Any tool/slash surface is written from public
   behavior only; no source is copied (AGPL; license undecided). Mirrors §9 of the
   [plugin design](plugin-system-design.md).

---

## 3. The FSM (Phase H) — the keystone

The whole FSM is gated by a three-way **Agent Mode** setting (`settings.agent.mode`,
**default `off`**):

- **off** — classic: the scene switcher is greyed out, no per-mode tuning, world-info
  re-matched **every turn** (ST-style dynamic keyword lore — the familiar baseline).
- **manual** — the switcher is live; the user picks Explore/Dialogue/Combat by hand; the
  per-mode behavior below applies (tuning + L2 cache-on-transition).
- **agentic** — like manual, plus an intent classifier **auto-routes** the mode each turn.
  The auto-router is not built yet (it's the future agentic capability — §1 non-goals);
  `agentic` behaves like `manual` until it lands.

This split is deliberate: it keeps fully-dynamic lore as the default and confines the
"stable L2 within a mode" trade-off (new keywords don't fire until a transition) to users
who opt into the FSM.

When agentic, a session is always in exactly one **mode**. The mode is a small enum,
switched manually from the chat header, and it does three things:

| Mode         | Tunes                                                                   | Lorebook scan        |
| ------------ | ----------------------------------------------------------------------- | -------------------- |
| **Explore**  | wide retrieval, higher output ceiling (descriptive narration)           | broad (`scan_depth`) |
| **Dialogue** | tighter output, character-voice emphasis                                | medium               |
| **Combat**   | terse output; mechanics resolved by the worker, LLM narrates the result | narrow / pinned      |

What each mode actually changes is **data-driven** (a `mode → config` map: output
token ceiling, scan depth/breadth, optional per-mode system addendum). The map lives
in settings with card `game_rules` able to override per-card.

### Transition = the cache/injection checkpoint

This is _why_ H is the keystone. Today [`promptBuilder`](../src/main/services/promptBuilder.ts)
re-runs `matchAcross` **every turn**, so L2 (world info) is never byte-stable and the
Phase-G L2 cache goal is unmet. With an FSM:

- **L2 is matched on transition and cached on the chat**, reused across turns _within_
  a mode until the next transition. Stable L2 → the cacheable prefix grows from L1 to
  L1+L2 (closes the Phase G "hold L2 stable" gap).
- **Deferred injections flush on transition** — lore the model mutated (Phase J) and
  any queued world-info changes are folded into the prompt _at_ the transition, never
  mid-conversation, so the within-mode prefix never moves.

### Storage & UI

- New `mode` column on `chats` (idempotent `addColumnIfMissing`, same pattern as
  `lorebook_ids` in [`db.ts`](../src/main/services/db.ts)); default `'explore'`.
- A cached-L2 blob (`cached_world_info`, **implemented**) + a reserved `pending_lore`
  column per chat (drain lands in Phase J) so they survive reload. Stored as plain
  `chats` columns, for parity with `lorebook_ids`.
- UI: a 3-button mode switcher in the chat header. Auto-route stays **off**.

---

## 4. Action transport — the central fork (resolve this first)

How does the model request an action? Two transports, and the recommendation is to
support **both behind one executor**.

| Transport                      | Pros                                                               | Cons                                                           |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| **A. Tags** (`<rpt-action …>`) | works on _every_ endpoint; plain text → cache-clean; parser exists | model must emit well-formed tags; weaker structure             |
| **B. Function-calling**        | structured, validated, provider-native                             | per-provider rebuild of `streamProvider`; many proxies lack it |

**Decision: the executor is transport-agnostic.** Ship the **tag transport first**
(it reuses [`contentParser`](../src/main/parsers/contentParser.ts) +
[`applyEvent`](../src/main/services/generationService.ts) and works everywhere), then
layer function-calling (§6) in as an opt-in upgrade for providers that support it.
This **decouples Phases I and J from the heavy provider work** — combat and lore
mutation ship on tags, and true tool-calling becomes a later, isolated enhancement.

### Action schema (one shape, both transports)

```jsonc
// Tag form (baseline):
//   <rpt-action tool="roll_dice" id="a1">{ "sides": 20, "count": 1 }</rpt-action>
// Function-call form (upgrade) maps 1:1 onto the same internal record:
{
  "id": "a1", // correlates the request with its result
  "tool": "roll_dice", // registry key
  "input": { "sides": 20, "count": 1 }
}
// Result injected back at L4:
//   <rpt-result id="a1">{ "rolls": [14], "total": 14 }</rpt-result>
```

`<rpt-event>` (the existing state-mutation tag) stays as-is — it is a _fire-and-forget_
state write folded into `floor.variables`. `<rpt-action>` is a _request that produces
a result the model sees_. Both are parsed in `contentParser`.

---

## 5. The action loop & tool registry (D1)

### The loop

`generate()` today is single-shot: build → stream → parse → fold → persist
([generationService.ts](../src/main/services/generationService.ts)). It becomes:

```
build prompt ─▶ call model ─▶ any actions?
                                  │ yes                         │ no
                                  ▼                             ▼
                        execute (validate → run → result)   final text
                                  │                             │
                        append <rpt-result> at L4               ▼
                                  └────────▶ call model    parse → fold state → persist floor
```

- **Iteration cap** (e.g. 5 hops/turn) + abort wiring through the existing
  `activeControllers` map. Each hop is logged (tool, input, result, tokens).
- **Cache-safe:** each hop only _appends_ results at L4, so L1–L3 stay byte-stable.

### Tool registry

Tools are named functions in main, each with a Zod input schema. Built-in v1 set:

| Tool             | Permission tier | Backed by                                                   |
| ---------------- | --------------- | ----------------------------------------------------------- |
| `roll_dice`      | safe            | seeded RNG                                                  |
| `get_state`      | safe            | `floor.variables` (read)                                    |
| `set_state`      | safe            | `floor.variables` (bounded write; same fold as `rpt-event`) |
| `query_lorebook` | safe            | read-only `matchAcross`                                     |
| `combat_action`  | gated           | worker sandbox (§7, Phase I)                                |
| `update_lore`    | sensitive       | gatekeeper (§8, Phase J)                                    |
| `sub_generate`   | sensitive       | a nested provider call (cost/recursion-capped)              |

Tools may also be **card-declared** (`extensions.rp_terminal.game_rules` / a new
`tools` field) and later **plugin-contributed** (`rpt.tools.register`, fitting the
existing `rpt.v1` extension pattern). The set offered to the model is filtered by mode
(e.g. `combat_action` only in Combat) and by grant — reusing the plugin permission-prompt
pattern for sensitive tools.

---

## 6. Provider function-calling transport (D1 upgrade)

The portable tag path works everywhere; this is the structured upgrade, flagged as the
**riskiest engineering** because tool-calls interleave with streaming differently per
provider. Gate it behind a per-API-preset "supports tools" flag.

- **Anthropic** — send `tools: [{ name, description, input_schema }]`. The assistant
  response contains `tool_use` content blocks; reply with a user message carrying
  `tool_result` blocks (matched by `tool_use_id`); loop while `stop_reason === 'tool_use'`.
  Streaming: `tool_use` arrives as `content_block_start` then `input_json_delta`
  fragments, accumulated and parsed at `content_block_stop`.
- **OpenAI-compatible** — send `tools: [{ type: 'function', function: {…} }]`. The
  assistant message carries `tool_calls`; reply with `role: 'tool'` messages keyed by
  `tool_call_id`. Streaming: `tool_calls[i].function.arguments` arrives as fragments
  keyed by index and must be reassembled.

Because [`streamProvider`](../src/main/services/apiService.ts) only surfaces text
today, the pragmatic first cut is a **separate non-streamed `callProviderWithTools`**
for tool hops (stream only the final, text-only completion for display). Cache breakpoints
(Phase G) sit on the tools+system block and the last pre-turn message exactly as now.

---

## 7. Worker-sandbox harness (cross-cutting — build once, reused by I + K)

A long-lived `worker_threads` worker that loads **quickjs once** and resolves
deterministic logic off the main thread. Reuses the compile/bridge pattern from
[`templateService.ts`](../src/main/services/templateService.ts) but off-thread and
separate from the template path (don't disturb it).

```jsonc
// host → worker
{ "script": "<author combat script>", "entityState": { … }, "action": { … }, "seed": 12345 }
// worker → host
{ "newState": { … }, "events": [ { "text": "Goblin takes 7 damage", "delta": {…} } ], "log": [ … ] }
```

- **Seeded RNG** in, new state + event list out → deterministic, cache-safe, testable.
- **Hard timeout + kill** on runaway scripts; the harness owns the lifecycle.
- Phase K later reuses this worker for vector math (`sqlite-vec`), hence "build once."

---

## 8. Combat engine (Phase I)

Combat mode + the `combat_action` tool, backed by the worker harness.

- **Entities** live in the existing `rpg_entities` table (per chat; HP/stats/status) —
  already stubbed in [`db.ts`](../src/main/services/db.ts), unused until now.
- **A combat turn:** model (in Combat mode) requests `combat_action` → the worker
  resolves deterministic math against entity state (seeded) → returns an **event block**
  → generationService injects it at **L4** (`[Combat] Goblin −7 · HP 5/12`) and persists
  the new entity state. The LLM then narrates flavor only — it never authors the numbers.
- The card supplies the combat script via `extensions.rp_terminal.scripts` /
  `game_rules`; it runs only in the worker sandbox.

This is the "append-only injection" the roadmap calls for: mechanics are facts injected
at the bottom; the cached prefix is untouched.

---

## 9. Protected lore + mutation gatekeeper (Phase J)

- Add **`protected: boolean`** to
  [`LorebookEntrySchema`](../src/main/types/character.ts). Protected = immutable canon;
  unprotected = the model may propose changes.
- **`update_lore` tool (gatekeeper):** the model requests a change → the backend
  validates (unprotected entries only, Zod-checked, size/field-bounded) → applies it to
  a **chat-scoped lore overlay**, _not_ the shared library file (preserving the portable
  artifact). The overlay is merged over the base book at match time.
- **Deferred injection:** a mutation does **not** rewrite the prompt mid-conversation
  (that would break the within-mode cache). It is queued (`pending_lore`, §3) and folded
  in at the **next mode transition** — closing the loop with Phase H.

---

## 10. State-schema + widget editor (D2)

Authoring UI over the already-schema'd `extensions.rp_terminal.state_schema` +
`ui_layout` ([`RPTerminalExt`](../src/main/types/character.ts)). The renderer already
_renders_ widgets (`LayoutRenderer` / `WidgetRegistry`); this adds the _authoring_ side:

- **State-schema editor** — define the state tree (keys, types, defaults) that
  `<rpt-event>`/`set_state` mutate and that widgets bind to.
- **Widget editor** — bind a `WidgetDef` (`type` / `path` / `config`) to a state path,
  with a live preview against `floor.variables`.

Renderer-heavy, lowest engine risk — it **trails** the rest of the track.

---

## 11. Cache discipline detail (Phase G interplay)

The L1–L4 layering already documented in `promptBuilder` is the budget every phase
spends against:

```
L1 static core    — system + char description + examples         (stable per session)
L2 semi-static    — world info / lore   ── agentic: stable PER MODE, re-matched on transition;
                                            classic: re-matched every turn (dynamic lore)
L3 rolling history— prior turns + tool hops (append-only)         (byte-stable prefix)
L4 volatile       — new user action, <rpt-result>, [Combat] block (always last, 0% cache)
```

Phase-by-phase obligations:

- **H** makes L2 stable within a mode (the win) and flushes deferred changes _at_ the
  boundary.
- **D1** appends tool results at L4 only — the loop never edits L1–L3.
- **I** injects combat events at L4.
- **J** queues lore changes and applies them only at an H transition.

`applyDepthInjections` and the existing L4-last invariant in `promptBuilder` already
give the insertion machinery; the new work is _when_ (transition vs. every turn) and
_where_ (L4 vs. depth), not _how to splice_.

---

## 12. Data-model changes (summary)

| Where                 | Change                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `chats` table         | `mode TEXT` (default `explore`); cached-L2 blob + `pending_lore` queue per chat                                |
| `rpg_entities` table  | now used (combat entities); no schema change needed                                                            |
| `LorebookEntrySchema` | `protected: boolean` (default `false`)                                                                         |
| `contentParser`       | parse `<rpt-action>` (+ keep `<rpt-event>`); emit a result for each                                            |
| Settings              | `agent.mode` (off / manual / agentic); `mode → config` map (per-mode output ceiling / scan breadth / addendum) |
| API preset            | `supports_tools` flag (gates the §6 function-calling transport)                                                |
| Card `rp_terminal`    | optional `tools` declaration; combat script in `scripts`/`game_rules`                                          |

No migration drops data; all additions are idempotent forward-migrations.

---

## 13. Phased implementation plan

| Phase                        | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                 | Reuses                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **T3.0** (this doc)          | The contract: action schema, FSM semantics, sandbox message shape, gatekeeper rules, cache obligations.                                                                                                                                                                                                                                                                                                     | plugin-design doc style                  |
| **T3.1 — Phase H** ✅        | inc.1: `mode` column + accessors, 3-button switcher, `mode → config` tuning, `resolveModeConfig`, mode-capped `max_tokens`. inc.2: **L2 matched-on-transition, cached per chat** (`cached_world_info`; reused within a mode; invalidated on transition / book-selection change / lore edit via `clearWorldInfoCacheForProfile`). `pending_lore` **column reserved**; its drain + producers land in Phase J. | `db` migration pattern, `matchAcross`    |
| **T3.2 — Worker harness**    | `worker_threads` + quickjs, seeded-RNG message contract, timeout/kill. Unit-tested in isolation.                                                                                                                                                                                                                                                                                                            | `templateService` quickjs pattern        |
| **T3.3 — D1 action loop**    | `<rpt-action>`/`<rpt-result>` in `contentParser`; transport-agnostic executor + tool registry (`roll_dice`/`get_state`/`set_state`/`query_lorebook`); the loop in `generate()` with cap + abort + logging.                                                                                                                                                                                                  | `contentParser`, `applyEvent`, abort map |
| **T3.4 — Phase I**           | `combat_action` → worker; `rpg_entities` read/write; L4 event-block injection; flavor-only narration. Card combat script.                                                                                                                                                                                                                                                                                   | T3.2 harness, T3.3 loop                  |
| **T3.5 — Phase J**           | `protected` flag; `update_lore` gatekeeper → chat overlay; deferred injection flushed at H transition.                                                                                                                                                                                                                                                                                                      | T3.1 queue, T3.3 loop                    |
| **T3.6 — D1 tool transport** | Provider function-calling (Anthropic `tool_use` ↔ OpenAI `tool_calls`) behind `supports_tools`; tag path stays the fallback.                                                                                                                                                                                                                                                                                | `apiService`, Phase G cache breakpoints  |
| **T3.7 — D2**                | State-schema + widget authoring UI with live preview.                                                                                                                                                                                                                                                                                                                                                       | `LayoutRenderer`/`WidgetRegistry`        |

**T3.1 (Phase H) is the recommended first slice** — smallest, lowest-risk, unblocks the
caching + deferred-injection model the rest depends on, and is independently useful.
The heavy provider tool transport (T3.6) is deliberately last, with the tag path
carrying I and J in the meantime.

---

## 14. Decisions / open questions

1. **Hybrid transport, tags first.** ✅ Resolved — §4. Decouples I/J from provider work.
2. **Mode set = Explore / Dialogue / Combat**, manual switch, data-driven tuning,
   auto-route off. ✅ Resolved — locked vNext decision.
3. **Lore mutations go to a chat-scoped overlay, never the shared library file.**
   ✅ Resolved — preserves the portable artifact (§9).
4. **Deferred injection fires at mode transition** (not on a timer, not immediately).
   ✅ Resolved — preserves within-mode cache (§3, §9, §11).
5. **Combat math in `worker_threads` quickjs**, seeded RNG, separate from the template
   VM. ✅ Resolved — §7.
6. _Open:_ Should `sub_generate` be in v1 or deferred? (Recursion/cost risk — lean
   defer until the loop + caps are proven.)
7. **Persist cached-L2 + `pending_lore` as plain `chats` columns** (`cached_world_info`,
   `pending_lore`), for parity with `lorebook_ids`. ✅ Resolved — implemented in T3.1 inc.2.
   _Note:_ stable-within-a-mode means new keywords raised mid-mode don't pull new lore
   until the next transition (by design); lore _edits_ clear the cache profile-wide so
   authoring stays responsive.
8. _Open:_ Per-mode preset vs. per-mode param override on one preset. (Lean override —
   avoids preset sprawl.)

---

## 15. What we already have (so this is incremental, not a rewrite)

- **L1–L4 cache layering + `applyDepthInjections`** in `promptBuilder` — the insertion
  machinery and the L4-last invariant already exist.
- **`rpg_entities` + `episodic_memory` tables** — stubbed in `db.ts`, waiting for I/K.
- **quickjs WASM sandbox** (`templateService`) — the pattern the worker harness reuses.
- **`<rpt-event>` parse + `applyEvent` state fold** — the baseline the action channel
  extends.
- **Injectable seeded `rng`** in lorebook matching — the determinism discipline to extend.
- **Permission-prompt pattern** (plugin grants) — reused for sensitive tools.
- **Abort/streaming/IPC plumbing** — the turn orchestration the loop wraps.

The genuinely new work is the **FSM + transition checkpoint**, the **action
schema/executor/loop**, the **worker harness**, the **gatekeeper + lore overlay**, and
(last) the **provider tool transport**.
