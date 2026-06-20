# World Card + One-Click Setup — Design (Track S)

Status: **Draft — design-doc-first, no code yet.** High priority. Defines the **World
Card**: an evolution of the character card into an ST-compatible *superset* that bundles
everything a world needs — scripts, regex, lorebooks, presets, plugins, a custom agent
config, custom UI, and combat — so importing one card is a **one-click setup**. Pairs
with the Track S "global/session/world scoping" item; together they make installing and
running a world a single action.

---

## 1. Purpose & scope

Today a card carries prose + an embedded lorebook + (under `rp_terminal`) scripts/UI.
Everything else a polished world needs — its regex, its preset, its plugins, its agent
prompts, its combat rules — must be installed by hand, and the importer actively
**throws most of it away** (it keeps only known fields + `extensions.rp_terminal`). The
World Card makes a card the *single distributable unit* for a complete experience.

### Goals

- **One-click import**: dropping in a World Card installs **everything it bundles** —
  scripts, regex, lorebook(s), presets, plugins, agent config, UI, combat — into the
  right stores, with one confirm.
- **Backward-compatible both ways**: a World Card *is* a valid SillyTavern
  `chara_card_v3` (ST reads the prose/lorebook/regex and ignores our namespace); and we
  still import plain ST v2/v3 cards unchanged (no `rp_terminal` → behaves as today).
- **Expandable + forward-compatible**: a versioned, additive bundle namespace with room
  for agent prompts, presets, combat, recommended settings, and future slots — and a
  **lossless** importer that preserves unknown keys instead of dropping them.

### Non-goals (this track)

- A new card **spec** string. World Cards stay `spec: 'chara_card_v3'` so ST still reads
  them; "World-ness" lives entirely in `extensions.rp_terminal` (+ standard ST keys).
- A hosted marketplace / auto-update.
- Replacing the plugin or MVU systems — the World Card *bundles* and *routes* to them.

---

## 2. Naming

"Character card" → **World Card** (the UI's left-nav already says **World**). Internally
the Zod type can stay `RPTerminalCard` (or alias to `WorldCard`); the user-facing term
and docs become "World Card". No format break — a World Card is a chara_card_v3 whose
`extensions.rp_terminal` block is populated.

---

## 3. The format — `extensions.rp_terminal` as the bundle manifest

ST ignores unknown `extensions.*`, so our entire superset rides there (plus the standard
ST `extensions.regex_scripts`, which ST *also* applies). Slots:

```jsonc
extensions.rp_terminal = {
  "world_card": "1.0",            // marks a World Card + bundle version (absent = plain card)
  "meta": { "author": "...", "version": "...", "homepage": "..." },

  // — already implemented —
  "scripts": [{ "name": "...", "code": "..." }],   // card scripts (sandboxed iframe)   ✅ P1
  "data_schema": "...",                             // MVU Zod schema source            ✅ R4
  "state_schema": { "defaults": { } },              // native stat_data defaults         ✅ R2
  "ui_layout": [ /* WidgetDef */ ], "css": "...", "theme": {}, "assets": {}, // custom UI ✅ B1/R3
  "game_rules": {},

  // — new bundle slots (Track S) —
  "regex": [ /* ST regex script objects */ ],       // bundled regex (or read extensions.regex_scripts)
  "lorebooks": [ { "name": "...", "entries": [] } ], // extra books beyond character_book
  "presets": [ { "name": "...", "parameters": {}, "prompts": [] } ], // bundled chat-completion presets
  "plugins": [ { "manifest": {}, "files": { } } ],   // bundled plugin packages (or asset refs)
  "agent": {                                          // custom agent config
    "modes": { "explore": { }, "combat": { } },        // card-defined FSM modes (Track S todo)
    "prompts": { "system": "...", "combat": "..." }     // per-mode / agent system prompts (Track S todo)
  },
  "combat": { "script": "...", "rules": {} },          // sandboxed combat resolver (Phase I)
  "recommended_settings": { "max_context_tokens": 32000 } // optional auto-tune on load (Phase L)
}
```

The manifest is **declarative + additive**: unknown slots are preserved on import (§5) and
ignored at runtime until supported, so older clients and future cards interoperate.

### Where regex lives (ST-compat detail)

Prefer the standard **`extensions.regex_scripts`** (so ST applies the same regex) as the
canonical source; also accept `rp_terminal.regex`. On import, extract from either into the
profile regex store. The example `4.2.1.png` bundles regex this way today — and the current
importer drops it.

---

## 4. Backward compatibility (both directions)

- **Reading ST cards** — no `rp_terminal` (or no `world_card`) → import behaves exactly as
  now (prose + `character_book`); the new slots are simply empty.
- **A World Card opened in SillyTavern** — ST reads name/description/`character_book`/
  `regex_scripts`, ignores `rp_terminal` → the world degrades to a normal character (prose
  + lore + regex still work; the engine extras are dormant). True superset, no fork.
- **Spec unchanged** (`chara_card_v3`) so existing ST tooling round-trips it.

---

## 5. One-click import (the keystone)

Rework `importCharacterFromFile` from "whitelist + drop" to **lossless extract + route**:

1. **Preserve the full card** — keep *all* `extensions.*` (not just `rp_terminal`), so ST
   keys and future slots survive a round-trip. (Fixes today's data loss.)
2. **Detect the bundle** — `rp_terminal.world_card` present (or any non-empty slot) ⇒ run
   the one-click installer; otherwise plain-card import.
3. **Extract + route each slot to its store:**
   | Slot | Destination | Notes |
   | --- | --- | --- |
   | `character_book` / `lorebooks[]` | lorebook library | id = characterId for the own book; others get ids |
   | `regex_scripts` / `regex[]` | profile regex dir | the piece dropped today |
   | `presets[]` | preset files | skip-if-name-exists or suffix |
   | `plugins[]` | `plugins/<id>/` + grant prompt | reuse the plugin host/permission model |
   | `scripts` / `data_schema` / `ui_layout` / `combat` / `agent` | stay on the card | run from `rp_terminal` |
4. **One confirm** — a summary dialog ("This world bundles: 3 scripts, 12 lore entries, 2
   regex, 1 preset, 1 plugin (needs: generate). Install all?") with per-item opt-out.
5. **Dedup / conflict** — content-hash or name match → skip/replace/keep-both; never
   silently clobber an existing artifact.
6. **Scope assignment** — installed artifacts default to **world** scope (§6), bound to this
   card, so they light up when the card is in play and don't pollute other worlds.

Export is the inverse (§7).

---

## 6. Global / Session / World scoping (the paired Track S item)

A unified scope every shareable artifact (**lorebook, regex, scripts, plugins**) carries:

- **global** — active across all of a profile's sessions (e.g. a personal QoL regex).
- **world** — bound to a specific card; active whenever that world is loaded (where most
  bundled artifacts land).
- **session** — a single chat (today's per-chat lorebook selection generalizes to this).

Model: a `scope` + `owner` on each artifact (a `world` scope's owner = a character id; a
`session` scope's owner = a chat id). Generation resolves the **active set** = global ⊕
world(active card) ⊕ session(active chat). Replaces today's ad-hoc rules (regex + standalone
plugins are profile-wide; card scripts world-scoped; lorebooks per-session-selectable) with
one model + a scope selector in each manager. This is the bigger architectural change — it
adds a scope dimension to the regex/preset/plugin stores (lorebook already has the per-chat
seam via `chats.lorebook_ids`) — so it lands as its own phase, with one-click import targeting
`world` by default in the meantime.

---

## 7. Export / packing (World Card out)

"Export World" gathers the card + its **world-scoped** artifacts (lorebooks, regex, presets,
plugins, scripts, agent, UI) into the `rp_terminal` manifest and writes:

- **JSON** (chara_card_v3) — portable, diffable.
- **PNG cartridge** (§8) — the shareable single file, avatar + embedded bundle.

Round-trip invariant: export → import reproduces the same active world.

---

## 8. PNG cartridge (Phase L overlap)

Binary/larger bundles (UI assets, plugin files, big lorebooks) outgrow a base64 `tEXt`
chunk. Two layers:

- **Inline** — small text bundles in the `chara`/`ccv3` base64 JSON (today's path); extend
  the parser to handle **compressed `iTXt`** (currently unsupported — `stPngParser` bails).
- **Appended ZIP** — a ZIP after the PNG `IEND` (the Phase L cartridge): manifest +
  `assets/` + bundled lorebooks/plugins/scripts. Reuse `adm-zip` (already a dep for plugin
  `.zip` install). Import unpacks it; export packs it.

Until then, the inline JSON manifest covers scripts/regex/lorebook/preset/agent (all text).

---

## 9. Phased plan

| Phase | Deliverable | Reuses |
| --- | --- | --- |
| **S0** (this doc) | World Card format + manifest slots + one-click import + scope model. | — |
| **S1 — Lossless import + regex** | Stop dropping extensions; extract bundled `regex_scripts`/`regex` into the regex store on import; the install-summary confirm. **Bundled regex from `4.2.1.png` finally works.** | importer, regex service |
| **S2 — Scope model** | `scope` (global/world/session) + `owner` on regex/preset/plugin (lorebook has the seam); generation resolves the active set; scope selector per manager. | `chats.lorebook_ids` pattern |
| **S3 — Bundle slots** | `presets[]`, `plugins[]`, `lorebooks[]`, `agent` (modes + prompts), `combat`, `recommended_settings` — extract/route on import; run at generation. | preset/plugin/lorebook services, Phase H/I |
| **S4 — Export / packing** | "Export World" → JSON manifest of the card + its world-scoped artifacts; round-trip. | S1–S3 |
| **S5 — PNG cartridge** | Compressed-`iTXt` read + appended-ZIP cartridge import/export (Phase L). | `adm-zip`, `stPngParser` |

**S1 is the recommended first slice** — small, immediately fixes the data loss, and makes
the existing `4.2.1.png` regex import work end-to-end. S2 (scoping) is the larger structural
change and the dependency that makes S3's bundle routing land in the right place.

---

## 10. Decisions / open questions

1. **No new spec string** — World Cards stay `chara_card_v3`; `rp_terminal.world_card` marks
   the bundle. ✅ Resolved (preserves ST compat).
2. **Bundled artifacts default to `world` scope** on import. ✅ Resolved (§5/§6).
3. **Regex canonical source = ST `extensions.regex_scripts`** (ST-compatible), `rp_terminal.regex`
   accepted too. ✅ Resolved (§3).
4. _Open:_ scope storage — a `scope`/`owner` column per store vs. a single `artifact_scopes`
   table. (Lean per-store columns, for parity with `chats.lorebook_ids`.)
5. _Open:_ conflict policy on re-import — skip / replace / keep-both default? (Lean keep-both
   with a content-hash dedup so re-importing the same world is idempotent.)
6. _Open:_ do bundled **plugins** auto-enable, or install-disabled pending the normal grant
   prompt? (Lean install-disabled + prompt — untrusted-code safety.)

---

## 11. Licensing / safety

- Bundled **plugins/scripts/combat** are untrusted third-party code → install through the
  existing **permission + sandbox** model (iframe for UI, quickjs worker for combat/schema);
  bundled plugins install **disabled** until the user grants them. No change to the
  clean-room stance (no js-slash-runner code; MVU/ST formats are parsed, not vendored).
- One-click import must be **transparent** (the confirm lists exactly what installs, esp.
  sensitive plugin permissions) — never silently install code or clobber existing artifacts.

---

## 12. What we already have (so this is incremental)

- **Card import + PNG/JSON parsing** (`importCharacterFromFile`, `stPngParser`) — extend,
  don't rebuild (make it lossless + routing).
- **Stores for every slot** — lorebook library, regex dir, preset files, plugin host
  (`plugins/<id>/` + grants), card scripts (`rp_terminal.scripts`), MVU schema (R4).
- **`adm-zip`** — already used for plugin `.zip` install → the cartridge ZIP layer.
- **Per-chat lorebook selection** (`chats.lorebook_ids`) — the seam the scope model generalizes.
- **Permission + sandbox model** — for safely installing bundled untrusted code.
- **The `rp_terminal` extension namespace** — already the home for scripts/UI/schema; Track S
  fills in the remaining slots.

The genuinely new work: the **lossless extract-and-route importer**, the **scope model**, the
**bundle slots** (presets/plugins/agent/combat), **export/packing**, and the **PNG cartridge**.
