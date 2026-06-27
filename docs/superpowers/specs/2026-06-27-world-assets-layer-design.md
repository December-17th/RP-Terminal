# World Assets — a per-world image asset layer (design)

Status: **Design approved (2026-06-27).** First of a two-spec arc. This spec covers the
**asset layer**; the **relationship web + BG3-style party portraits** UI that consumes it is the
next spec (see "Next phase" below).

## Context & motivation

Brainstormed as an extension/mod for the **命定之诗** character card. The card is run inside the
RP Terminal app and already ships rich UIs (the remote `状态栏` React app, the inline Vue
`角色查看器`, the combat sheet, and per-character dialogue-美化 regexes). The chosen direction is a
**new visualization: a relationship web of `关系列表` companions with Baldur's-Gate-3-style party
portraits.**

Sourcing those portraits surfaced a deeper need. The card already has real portrait art, but it is
**scattered per-character inside the dialogue-美化 regexes** (external `catbox.moe` / `bmp.ovh` URLs)
and **mood-keyed** (`data-mood` swaps the image by emotional state). There is no central
`name → portrait` registry in the MVU stat_data. Rather than hardcode another portrait set, the owner
chose to give the **app** a first-class, per-world image asset system that any card UI can resolve
against by naming convention.

To keep the first spec small, the broader "store each lorebook entry as its own file in category
folders" ambition is **deferred**. This spec adds only the **image asset layer** on top of today's
lorebook storage (entries untouched). See "Performance" for why the deferred file-per-entry work does
not threaten the 1000+-files concern, and why the asset layer sidesteps it entirely.

### Scope (locked via Q&A, 2026-06-27)

- **Asset layer first**, smallest viable bite. File-per-entry storage = separate, deferred ambition.
- Assets are **per-world / per-lorebook** scoped. A chat selects active lorebooks; a card's embedded
  lorebook already uses `id == characterId`, so a lorebook is effectively "a world."
- **Mood-aware from the start** — the convention and resolver support optional mood variants, wired to
  the card's existing per-message mood signal.
- Deliverable / visible result = an app-native **Asset Manager** view (browse, validate, open folder).
- This spec does **not** build the relationship web and does **not** change lorebook *entry* storage.

## Current state (what we build on)

- Lorebooks are **already file-based**: `profiles/<profileId>/lorebooks/<id>.json` holding
  `{ name, entries: [...] }` ([lorebookService.ts](../../../src/main/services/lorebookService.ts)). A
  card's embedded lorebook is stored under `id == characterId`.
- Presets / lorebooks / regex were briefly in SQLite during early Phase F and were **deliberately
  moved back out to JSON files** ([db.ts](../../../src/main/services/db.ts): *"presets, lorebooks,
  regex are intentionally NOT stored here"*). SQLite holds relational/indexy tables only (profiles,
  chats, floors, rpg_entities, episodic_memory).
- Lorebook matching (`matchAcross`) loads a whole lorebook into memory and scans every entry's keys
  each turn.
- The app already registers privileged custom protocols
  ([main/index.ts](../../../src/main/index.ts)); the WCV card surface allows `img-src *`
  ([wcvManager.ts](../../../src/main/services/wcvManager.ts)); the **inline-iframe CSP is
  restrictive** — `img-src data: blob:` only ([bridgeShim.ts](../../../src/renderer/src/plugin/bridgeShim.ts)).
- The card emits **per-character mood** already: the 美化 regex reads a `mood="…"` attribute per
  dialogue block (default `smile`), and the preset emits a structured `[情绪]:` field per character.
  This is the mood signal we reuse.

## Architecture

Five units, each independently testable:

1. **On-disk layout + naming convention** (a documented contract, no code).
2. **Filename parser** — `filename → { name, type, mood?, ext }` (pure).
3. **Resolver** — `{ lorebookIds[], category, name, type, mood? } → path | null` (pure, reads the index).
4. **Index + watcher** — scans the asset dirs into a per-world manifest; refreshes on a debounced
   directory watch.
5. **Serving** — a privileged `rptasset://` protocol (path-sandboxed) + the inline-iframe CSP
   allow-list change + a shared `currentMoodFor` mood-extraction helper.

Plus the deliverable consumer: **6. Asset Manager view** (app-native).

### 1. On-disk layout & naming convention

Assets live per-world, in a sibling directory to the lorebook JSON (the `.json` file is untouched):

```
profiles/<profileId>/lorebooks/
├── <lorebookId>.json                 ← unchanged
└── <lorebookId>.assets/
    ├── character/
    │   ├── 爱莎_头像.jpg               ← base avatar
    │   ├── 爱莎_头像_愤怒.png          ← mood variant
    │   └── 爱莎_立绘.webp              ← standee
    ├── location/                      ← same mechanism (plumbed now, art later)
    └── .thumbs/                       ← cached 128px thumbnails
```

Convention: **`<name>_<type>[_<mood>].<ext>`**

- `<name>` — entity name, exact + trimmed; matches a character/companion (`主角` / `关系列表` key) or a
  location name.
- `<type>` — `头像` (avatar/face) | `立绘` (standee/full body). Locations: `背景` | `全景` (design-for).
- `<mood>` — optional emotional-state token (open vocabulary: 愤怒, 喜悦, 微笑, …). Omit for the base.
- `<ext>` — `png | jpg | jpeg | webp | gif`, case-insensitive.

Normalization: trim whitespace around every segment and the extension (handles a stray
`爱莎_立绘 .jpg `); lowercase the extension. `_` is the field separator.

### 2. Filename parser (pure)

`parseAssetFilename(filename) → { name, type, mood?, ext } | null`.

Algorithm: strip + lowercase the extension; **anchor on the known `type` token** (search the
`_`-separated segments for `头像`/`立绘`/`背景`/`全景`). Everything before the type token = `name`
(re-joined, preserving any `_` inside a name); everything after = `mood` (optional). A filename with no
recognizable type token returns `null` (the index flags it as "unrecognized" for the Asset Manager).
This anchoring makes CJK names containing `_` unambiguous.

### 3. Resolver (pure, testable core)

`resolveAsset({ lorebookIds, category, name, type, mood? }) → relPath | null`, reading the per-world
index (never stats disk per call).

- **Precedence:** `name_type_mood` → `name_type` (base) → `null`.
- **Across active lorebooks:** match in `lorebookIds` order; first hit wins.
- **Mood matching:** normalize the requested mood (trim, then a small built-in synonym table, e.g.
  `笑/微笑/smile` family); match against available `_<mood>` variants; **any unknown or absent mood
  falls back to the base image.** The card's default mood is `smile`, so an empty signal yields the base.
- A `null` result is a normal outcome (no art yet) — the caller renders a stylized placeholder, never a
  broken image.

### 4. Index & watcher (the performance answer)

A small per-world **`_index.json` manifest** inside `<lorebookId>.assets/`:
`name → type → { "base" | <mood> : relPath }`, plus each file's `mtime`. Chosen over a SQLite
`world_assets` table so a world's assets stay **self-contained and portable** (they travel with the
lorebook on export) and to match the file-based ethos; the per-world set is small.

Built / refreshed on: app start (for active worlds), Asset Manager open, and a **debounced directory
watch** (chokidar on the ~2 category dirs — watch directories, not the individual files — re-index only
what changed). Images are **lazy-loaded**; thumbnails (~128px) are decoded on demand and cached under
`.thumbs/`.

**Why 1000+ files is a non-issue here:** the asset layer never reads entry files or eagerly decodes
images. The index is tiny, matching is in-memory, the protocol streams a single file on demand, and the
watch is directory-level. The original 1000-files worry only applies to the *deferred* file-per-entry
work, and even there the same index + lazy-load pattern (the SQLite-metadata + file-content split the
app already uses) keeps it fast; that is out of scope for this spec.

### 5. Serving images to UIs

- **Protocol:** register `rptasset://<profileId>/<lorebookId>/<category>/<file>`, handled in main →
  resolve to the on-disk path, **validate it stays within the world's assets root** (reject `..` /
  absolute escapes), stream the bytes. Read-only.
- **CSP:** add `rptasset:` to the inline-iframe `img-src`
  ([bridgeShim.ts](../../../src/renderer/src/plugin/bridgeShim.ts)). The WCV surface already allows
  `img-src *`. App-native views use the protocol directly.
- **Mood helper:** a shared `currentMoodFor(name, messageText) → mood | undefined` that parses the
  card's existing `mood="…"` / `[情绪]:` signal for a character. The asset layer stays pure (mood is an
  input); this helper produces it for the Asset Manager preview and the spec-2 web.

### 6. Asset Manager view (app-native — the deliverable)

A new view that, for the current world, lists each character with:

- coverage chips: `头像` ✓/✗, `立绘` ✓/✗, *N* mood variants, each with a thumbnail;
- a **missing-art** flag;
- an **Open folder** button (opens `<lorebookId>.assets/character/` in the OS file manager);
- a mood-preview toggle to eyeball variant swapping (uses `currentMoodFor` over a sample / manual pick).

It doubles as ingestion: the user drops files into the folder → the watcher re-indexes → the view
updates. A drag-drop-into-the-view importer is a nice-to-have, deferred.

**Roster source:** folder-discovered names **unioned with** the live MVU roster (`主角` + `在场`
`关系列表`) when a chat context is available — so the view shows both "art present with no known
character" and "known character missing art." With no chat context, it lists folder-discovered names
only (missing-art flags require a roster).

## Data flow

```
files on disk ──scan──▶ _index.json (per world)
                              │
   message text ──currentMoodFor(name)──▶ mood
                              ▼
   consumer ──resolveAsset(lorebookIds,category,name,type,mood)──▶ relPath | null
                              │                                         │
                       (null) ▼                                  rptasset:// URL
                  stylized placeholder                                  ▼
                                                            <img> in Asset Manager / spec-2 web
```

## Error handling & edge cases

- **Missing asset** → resolver returns `null` → UI renders a stylized placeholder (initial/emblem). The
  web never shows a broken image. (The earlier "generated avatar" idea is exactly this null-fallback.)
- **Malformed filename** (no recognizable type token) → surfaced in the Asset Manager as a warning;
  never throws.
- **Path traversal / out-of-root** request on `rptasset://` → rejected.
- **Animated** gif/webp → served as-is (animate in `<img>`); thumbnails are a static first frame.
- **Name mismatch** (MVU name ≠ filename) → exact-trim match for v1; an alias/override map is deferred.

## Testing

- **Unit:** filename parser (trailing space, mood variant, multi-`_` name, ext case, unrecognized);
  resolver precedence (`mood → base → null`) + multi-lorebook order; mood normalization / synonym /
  fallback; `currentMoodFor` against sample card messages (`mood="…"` and `[情绪]:`).
- **Integration:** build the index from a temp asset tree (incl. `.thumbs` skip, mtime); `rptasset://`
  handler streams correct bytes and **rejects traversal**; Asset Manager coverage computation
  (present / missing / variant counts) against a fixture world + a fixture MVU roster.

## Decisions (resolved open points)

- **(a) Asset Manager roster** — folder-discovered names **∪** live MVU roster (`主角` + 在场
  `关系列表`), so the view can flag "known character, no art." ✔
- **(b) Index storage** — per-world `_index.json` manifest (not a SQLite table). ✔
- **(c) Location category** — plumb `location/` now via the same code path; art comes later. ✔
- **(d) Name aliasing** — exact-trim match for v1; alias/override map deferred. ✔

## Next phase (spec 2, not built here)

**Relationship web + BG3-style party portraits** — a visualization of `关系列表` companions:
`主角` at center, 在场 companions as portrait nodes (radial first; inter-companion mesh links are a
later option), affinity-weighted edges from `好感度`, mood-aware portraits via this asset layer, click a
node to expand a character's vitals/status/gear. Delivery surface (card-side regex vs app-native panel)
is decided in that spec. It depends on this spec's resolver, `rptasset://` protocol, and `currentMoodFor`
helper.

## Related

- `docs/combat-poem-of-destiny-expansion.md` (on branch `feat/poem-combat-extension`, not merged to
  this branch) — the prior card-extension arc; same card, same "app SDK as the contract, card consumes
  it" framing.
- The 命定之诗 card material (gitignored, local): `example sillytarvern character card, presets,
  extensions and scripts/命定之诗/`.
