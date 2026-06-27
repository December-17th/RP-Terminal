# Optional asset-zip import (design)

Status: **Design approved (2026-06-27).** Extends the World Assets layer
([2026-06-27-world-assets-layer-design.md](2026-06-27-world-assets-layer-design.md), built on branch
`claude/interesting-cray-2c4161`). This feature lets a user import a zip of images into a world's
`lorebooks/<lorebookId>.assets/` folder, through two entry points sharing one validated extraction core.

## Context & motivation

The World Assets layer resolves a world's portraits from `lorebooks/<lorebookId>.assets/<category>/`
files named by the convention `<name>_<type>[_<mood>].<ext>`. Today those files are added by hand (drop
into the folder via the Asset Manager's **Open folder** button). This feature adds a faster path:
**import a zip** — both as an optional step when importing a character card (so a world + its art arrive
together), and as a button in the Asset Manager (to add art to an existing world).

`adm-zip` is already a dependency (`pluginHostService` uses `new AdmZip(zip).extractAllTo(...)`). The
character-import flow already creates the world: `importCharacterFromFile` parses the card, makes
`newId = randomUUID()`, and saves the card + embedded lorebook under that id — so the new world's assets
belong at `lorebooks/<newId>.assets/`.

### Scope (locked via Q&A, 2026-06-27)

- The zip **mirrors the `.assets/` layout**: top-level `character/` and/or `location/` folders.
- **Two entry points**, one shared core: (A) an optional zip prompt during card import; (B) an **Import
  assets** button in the Asset Manager.
- On a filename conflict, **overwrite** (re-importing updated art updates it).
- The card-import trigger is a **separate "Add asset zip?" prompt** after the card is chosen.
- Reuses the World Assets convention (`parseAssetFilename`) and paths (`assetsDir`,
  `invalidateWorldAssets`). Builds on the World Assets branch.

## Architecture

### 1. Shared core — `importAssetsZip` (in `worldAssetService.ts`)

`importAssetsZip(profileId, lorebookId, zipPath) → ImportAssetsResult` where
`ImportAssetsResult = { imported: number; skipped: number; byCategory: Record<AssetCategory, number>; skippedReasons: string[] }`.

For each entry in the zip (via `adm-zip` `getEntries()`):

- **Shape filter:** accept only `<category>/<file>` where `<category>` ∈ `ASSET_CATEGORIES`
  (`character`, `location`), exactly one level deep. Skip: entries loose at the root, nested deeper than
  one level, directories, dotfiles, `_index.json`, `.thumbs/…`, and `__MACOSX/…`.
- **Filename validation:** the basename must `parseAssetFilename(...)` successfully **and** the parsed
  `type` must belong to that folder's category — via a new shared helper
  `categoryForType(type): AssetCategory` (`头像`/`立绘`→`character`, `背景`/`全景`→`location`). A
  mismatch (e.g. a `背景` under `character/`) is skipped with a reason — it would never resolve as a
  character asset anyway.
- **Zip-slip safety:** normalize the destination path and confirm it stays within the world's `.assets`
  root (reject `..`/absolute), mirroring `resolveProtocolPath`. The `<category>/<file>` whitelist already
  blocks traversal; this is defense-in-depth.
- **Write:** extract each valid entry's bytes to `assetsDir(profileId, lorebookId, category)`,
  **overwriting** an existing file of the same name.
- **Invalidate:** after writing, call `invalidateWorldAssets(profileId, lorebookId)` so the next index
  read reflects the new files.
- **Return:** the counts + a per-skip reason list (`"outside category folder: x.jpg"`,
  `"unrecognized name: readme.txt"`, `"wrong category for type: character/王城_背景.jpg"`, …) so callers
  can surface what was and wasn't imported — nothing is silently dropped.

### 2. Entry point A — card import

The `import-character-dialog` IPC handler, after the existing bundle-confirm, shows one optional prompt:
**"Import assets from a zip? [Choose…] [Skip]"** (a `.zip` `dialog.showOpenDialog`). The chosen path
(or null) is passed to `importCharacterFromFile(profileId, filePath, assetZipPath?)`. After creating
`newId` and saving the card/lorebook, if `assetZipPath` is set it calls
`importAssetsZip(profileId, newId, assetZipPath)` and folds the result into `ImportSummary` (new
`assetsImported: number` field, shown in the install toast). The asset zip is **non-fatal**: if it fails
or is invalid, the card import still succeeds (the failure is logged + reflected as `assetsImported: 0`).

### 3. Entry point B — Asset Manager

Next to the existing **Open folder** button, add an **Import assets** button. It calls a new IPC
`asset-import-zip-dialog(profileId, lorebookId)` → a `.zip` `showOpenDialog` → `importAssetsZip` →
returns the `ImportAssetsResult`. The panel then shows a toast (e.g. *"Imported 6, skipped 2"*) and calls
the store's `refresh` so coverage updates. New i18n keys (`assets.import`, `assets.importResult`, …) in
**both** `en.ts` and `zh.ts`.

## Data flow

```
zip file ──importAssetsZip(profileId, lorebookId, zip)──▶ for each entry:
  <category>/<file> ?           no → skip (+reason)
        │ yes
  parseAssetFilename(file) + categoryForType == folder ?   no → skip (+reason)
        │ yes
  dest within .assets root ?    no → skip (+reason)
        │ yes
  write bytes → assetsDir(profileId, lorebookId, category)/file  (overwrite)
        ▼
  invalidateWorldAssets(profileId, lorebookId) → { imported, skipped, byCategory, skippedReasons }
```

Card import: `import-character-dialog` → optional zip prompt → `importCharacterFromFile(..., assetZipPath)`
→ `importAssetsZip(newId)` → `summary.assetsImported`.
Asset Manager: **Import assets** → `asset-import-zip-dialog` → `importAssetsZip` → toast + `refresh`.

## Error handling & edge cases

- **Corrupt / non-zip file** → `adm-zip` throws; caught and reported as an invalid-zip result
  (`imported: 0`, a skip reason). No crash; card import (entry A) still succeeds.
- **Empty zip / no valid entries** → `imported: 0` with a clear reason; the toast says so.
- **Zip-slip** (`../`, absolute, drive-relative) → rejected by the path check; counted as skipped.
- **Wrong-category / non-convention files** → skipped with reasons (kept out of `.assets` so it stays
  resolvable + clean).
- **`__MACOSX/`, dotfiles, `_index.json`, `.thumbs`** → skipped silently (not counted as user errors).
- **Conflict** → overwrite (update semantics); the count reflects files written.

## Testing

- **Unit — `importAssetsZip`** with `adm-zip`-built fixture zips into a temp `getAppDir` (the existing
  `worldAssetService.test.ts` pattern — mocked `getAppDir`, `clearAssetCache` in setup/teardown): a valid
  `character/爱莎_头像.jpg` + `location/王城_背景.png` land on disk and are counted; a zip-slip
  `../evil.png`, a root-loose `x.jpg`, a non-convention `character/readme.txt`, a wrong-category
  `character/王城_背景.jpg`, and a `__MACOSX/…` entry are each skipped (assert counts + on-disk result +
  that no file escaped the root). Overwrite verified (import twice, newer bytes win).
- **Unit — `categoryForType`**: each type maps to its category.
- **Integration** — the dialog/IPC wiring (entry A prompt, entry B IPC) is untested, consistent with the
  existing import-dialog handler.

## Decisions (resolved)

- Zip layout = **mirror `.assets/`** (top-level category folders). ✔
- Two entry points (card import + Asset Manager), one shared core. ✔
- Conflict = **overwrite**. ✔
- Card-import trigger = **separate optional prompt** after the card is chosen. ✔
- Files are validated against the convention + category even though folders are honored (a non-resolvable
  file is useless in `.assets`, so it's skipped). ✔

## Related

- [2026-06-27-world-assets-layer-design.md](2026-06-27-world-assets-layer-design.md) — the layer this
  extends (resolver, `parseAssetFilename`, `assetsDir`, `invalidateWorldAssets`, the Asset Manager).
- Built alongside [2026-06-27-app-storage-relocation-design.md](2026-06-27-app-storage-relocation-design.md)
  (independent; both on the World Assets branch).
