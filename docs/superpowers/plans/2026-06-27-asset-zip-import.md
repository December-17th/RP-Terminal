# Asset-Zip Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a zip of images into a world's `lorebooks/<lorebookId>.assets/` folder — both as an optional step during character-card import and via an "Import assets" button in the Asset Manager.

**Architecture:** One shared, validated extraction core (`importAssetsZip` in `worldAssetService.ts`) that reuses the World Assets naming convention (`parseAssetFilename` + a new `categoryForType` helper), with two thin entry points (the card-import dialog handler, and an Asset Manager button + IPC). Builds on the World Assets layer already on this branch.

**Tech Stack:** TypeScript, Electron (main/preload/React renderer), `adm-zip` (already a dependency), Vitest. No new dependencies.

## Global Constraints

- **Test runner:** `npm run test` (= `vitest run`). Tests live flat in `test/`, importing from `../src/...`.
- **No new dependencies.** `adm-zip` is already present (`import AdmZip from 'adm-zip'`, types via `@types/adm-zip`).
- **Zip contract:** the zip mirrors `.assets/` — entries must be `<category>/<file>` exactly one level deep, `<category>` ∈ `character`/`location`. A file's basename must `parseAssetFilename` AND its parsed type must belong to that category (`头像`/`立绘`→character, `背景`/`全景`→location). Everything else is skipped with a reason; benign noise (`__MACOSX/`, dotfiles, `_index.json`) is skipped silently.
- **Conflict policy:** overwrite existing files.
- **Safety:** reject any destination escaping the world's `.assets` root.
- **Scope:** every import targets exactly one world (`lorebookId`). Entry A → the new card's world; Entry B → the current world's primary lorebook id.
- **i18n:** route user-facing strings through `t()`; add keys to BOTH `src/renderer/src/i18n/locales/en.ts` and `zh.ts`.
- Repo style: 2-space indent, no semicolons.

## File Structure

**Modified — shared core:**
- `src/shared/worldAssets/types.ts` — add `categoryForType(type): AssetCategory` + `TYPES_BY_CATEGORY`.
- `src/main/services/worldAssetService.ts` — add `ImportAssetsResult` + `importAssetsZip(...)`.

**Modified — card-import entry (A):**
- `src/main/services/characterService.ts` — `importCharacterFromFile(profileId, filePath, assetZipPath?)` + `ImportSummary.assetsImported`.
- `src/main/ipc/characterIpc.ts` — optional asset-zip prompt in the import handler.

**Modified — Asset Manager entry (B):**
- `src/main/ipc/worldAssetIpc.ts` — `asset-import-zip-dialog` handler.
- `src/preload/index.ts` — `assetImportZipDialog` on `window.api`.
- `src/renderer/src/stores/assetStore.ts` — `importZip` action.
- `src/renderer/src/components/AssetManagerPanel.tsx` — Import-assets button + result toast.
- `src/renderer/src/i18n/locales/en.ts` + `zh.ts` — `assets.import*` keys.

**Created — tests:**
- `test/worldAssetCategory.test.ts`, `test/worldAssetImportZip.test.ts`.

---

### Task 1: `categoryForType` helper

**Files:**
- Modify: `src/shared/worldAssets/types.ts`
- Test: `test/worldAssetCategory.test.ts`

**Interfaces:**
- Consumes: `AssetType`, `AssetCategory`, `ASSET_TYPES` from `./types`.
- Produces: `categoryForType(type: AssetType): AssetCategory`, `TYPES_BY_CATEGORY: Record<AssetCategory, AssetType[]>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetCategory.test.ts
import { describe, it, expect } from 'vitest'
import { categoryForType, TYPES_BY_CATEGORY } from '../src/shared/worldAssets/types'

describe('categoryForType', () => {
  it('maps character types', () => {
    expect(categoryForType('头像')).toBe('character')
    expect(categoryForType('立绘')).toBe('character')
  })
  it('maps location types', () => {
    expect(categoryForType('背景')).toBe('location')
    expect(categoryForType('全景')).toBe('location')
  })
  it('TYPES_BY_CATEGORY lists each category\'s types', () => {
    expect(TYPES_BY_CATEGORY.character).toEqual(['头像', '立绘'])
    expect(TYPES_BY_CATEGORY.location).toEqual(['背景', '全景'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetCategory`
Expected: FAIL — `categoryForType`/`TYPES_BY_CATEGORY` not exported.

- [ ] **Step 3: Implement in `types.ts`**

Append to `src/shared/worldAssets/types.ts`:

```typescript
/** Which category each asset type belongs to (头像/立绘 → character, 背景/全景 → location). */
export const TYPES_BY_CATEGORY: Record<AssetCategory, AssetType[]> = {
  character: ['头像', '立绘'],
  location: ['背景', '全景']
}

export function categoryForType(type: AssetType): AssetCategory {
  return TYPES_BY_CATEGORY.location.includes(type) ? 'location' : 'character'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- worldAssetCategory`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/worldAssets/types.ts test/worldAssetCategory.test.ts
git commit -m "feat(world-assets): categoryForType helper"
```

---

### Task 2: `importAssetsZip` core

**Files:**
- Modify: `src/main/services/worldAssetService.ts`
- Test: `test/worldAssetImportZip.test.ts`

**Interfaces:**
- Consumes: `parseAssetFilename` (`../../shared/worldAssets/filename`), `categoryForType` + `ASSET_CATEGORIES` + `AssetCategory` (`../../shared/worldAssets/types`), and the existing module-internal `worldAssetsRoot`, `assetsDir`, `invalidateWorldAssets`; `ensureDir` (`./storageService`); `AdmZip` (`adm-zip`).
- Produces:
  - `interface ImportAssetsResult { imported: number; skipped: number; byCategory: Record<string, number>; skippedReasons: string[] }`
  - `importAssetsZip(profileId: string, lorebookId: string, zipPath: string): ImportAssetsResult`

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetImportZip.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'

let tmp: string
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})
import * as svc from '../src/main/services/worldAssetService'

const charDir = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'character')
const locDir = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'location')

const makeZip = (entries: Array<[string, string]>): string => {
  const zip = new AdmZip()
  for (const [name, body] of entries) zip.addFile(name, Buffer.from(body))
  const p = path.join(tmp, `assets-${Math.random().toString(36).slice(2)}.zip`)
  zip.writeZip(p)
  return p
}

beforeEach(() => {
  svc.clearAssetCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-zip-'))
})
afterEach(() => {
  svc.clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('importAssetsZip', () => {
  it('extracts valid category/file entries and counts them', () => {
    const zip = makeZip([
      ['character/爱莎_头像.jpg', 'A'],
      ['location/王城_背景.png', 'B']
    ])
    const r = svc.importAssetsZip('p1', 'w1', zip)
    expect(r.imported).toBe(2)
    expect(r.byCategory).toEqual({ character: 1, location: 1 })
    expect(fs.readFileSync(path.join(charDir('w1'), '爱莎_头像.jpg'), 'utf-8')).toBe('A')
    expect(fs.readFileSync(path.join(locDir('w1'), '王城_背景.png'), 'utf-8')).toBe('B')
  })

  it('skips loose, non-convention, wrong-category, and traversal entries with reasons', () => {
    const zip = makeZip([
      ['character/爱莎_头像.jpg', 'A'],
      ['loose.jpg', 'x'], // outside a category folder
      ['character/readme.txt', 'x'], // unrecognized name
      ['character/王城_背景.jpg', 'x'], // wrong category for type
      ['../evil.png', 'x'] // traversal → not a known category
    ])
    const r = svc.importAssetsZip('p1', 'w1', zip)
    expect(r.imported).toBe(1)
    expect(r.skipped).toBe(4)
    expect(r.skippedReasons.join(' ')).toMatch(/outside category folder/)
    expect(r.skippedReasons.join(' ')).toMatch(/unrecognized name/)
    expect(r.skippedReasons.join(' ')).toMatch(/wrong category for type/)
    // nothing escaped the assets root
    expect(fs.existsSync(path.join(tmp, 'evil.png'))).toBe(false)
  })

  it('skips __MACOSX and dotfiles silently (not counted as user errors)', () => {
    const zip = makeZip([
      ['character/爱莎_头像.jpg', 'A'],
      ['__MACOSX/character/._爱莎_头像.jpg', 'junk'],
      ['character/.DS_Store', 'junk']
    ])
    const r = svc.importAssetsZip('p1', 'w1', zip)
    expect(r.imported).toBe(1)
    expect(r.skipped).toBe(0)
  })

  it('overwrites an existing file', () => {
    svc.importAssetsZip('p1', 'w1', makeZip([['character/爱莎_头像.jpg', 'OLD']]))
    svc.importAssetsZip('p1', 'w1', makeZip([['character/爱莎_头像.jpg', 'NEW']]))
    expect(fs.readFileSync(path.join(charDir('w1'), '爱莎_头像.jpg'), 'utf-8')).toBe('NEW')
  })

  it('reports an invalid zip without throwing', () => {
    const bad = path.join(tmp, 'not-a.zip')
    fs.writeFileSync(bad, 'not a zip')
    const r = svc.importAssetsZip('p1', 'w1', bad)
    expect(r.imported).toBe(0)
    expect(r.skippedReasons.join(' ')).toMatch(/invalid|unreadable/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetImportZip`
Expected: FAIL — `importAssetsZip` not exported.

- [ ] **Step 3: Implement in `worldAssetService.ts`**

Add the import at the top (with the other imports):

```typescript
import AdmZip from 'adm-zip'
import { categoryForType } from '../../shared/worldAssets/types'
```

(`ensureDir` is already imported from `./storageService`; `ASSET_CATEGORIES`, `AssetCategory` are already imported from the types module; `parseAssetFilename`, `worldAssetsRoot`, `assetsDir`, `invalidateWorldAssets` already exist in this file. If any named import is missing, add it to the existing import line rather than duplicating.)

Append:

```typescript
export interface ImportAssetsResult {
  imported: number
  skipped: number
  byCategory: Record<string, number>
  skippedReasons: string[]
}

/** Extract a `.assets`-mirroring zip into one world's asset folders. Only `<category>/<file>`
 *  entries whose basename parses to the convention AND whose type matches the category are written
 *  (overwriting); everything else is skipped with a reason. Benign noise is skipped silently. Safe
 *  against path traversal. Invalidates the world's asset cache when anything was written. */
export function importAssetsZip(
  profileId: string,
  lorebookId: string,
  zipPath: string
): ImportAssetsResult {
  const result: ImportAssetsResult = { imported: 0, skipped: 0, byCategory: {}, skippedReasons: [] }
  let entries: AdmZip.IZipEntry[]
  try {
    entries = new AdmZip(zipPath).getEntries()
  } catch {
    result.skipped++
    result.skippedReasons.push('invalid or unreadable zip')
    return result
  }
  const base = path.resolve(worldAssetsRoot(profileId, lorebookId)) + path.sep
  const skip = (reason: string): void => {
    result.skipped++
    result.skippedReasons.push(reason)
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    const parts = name.split('/').filter(Boolean)
    // Benign archive noise — skip silently (not a user error).
    if (parts[0] === '__MACOSX' || parts.some((p) => p.startsWith('.')) || parts.includes('_index.json'))
      continue
    if (parts.length !== 2) {
      skip(`outside category folder: ${name}`)
      continue
    }
    const [category, file] = parts
    if (!(ASSET_CATEGORIES as readonly string[]).includes(category)) {
      skip(`unknown category: ${name}`)
      continue
    }
    const parsed = parseAssetFilename(file)
    if (!parsed) {
      skip(`unrecognized name: ${name}`)
      continue
    }
    if (categoryForType(parsed.type) !== category) {
      skip(`wrong category for type: ${name}`)
      continue
    }
    const destDir = assetsDir(profileId, lorebookId, category as AssetCategory)
    const dest = path.resolve(destDir, file)
    if (!dest.startsWith(base)) {
      skip(`unsafe path: ${name}`)
      continue
    }
    try {
      ensureDir(destDir)
      fs.writeFileSync(dest, entry.getData())
      result.imported++
      result.byCategory[category] = (result.byCategory[category] ?? 0) + 1
    } catch {
      skip(`write failed: ${name}`)
    }
  }
  if (result.imported > 0) invalidateWorldAssets(profileId, lorebookId)
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- worldAssetImportZip`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/worldAssetService.ts test/worldAssetImportZip.test.ts
git commit -m "feat(world-assets): importAssetsZip extraction core"
```

---

### Task 3: Card-import entry point (A)

**Files:**
- Modify: `src/main/services/characterService.ts`
- Modify: `src/main/ipc/characterIpc.ts`

**Interfaces:**
- Consumes: `importAssetsZip` (Task 2).
- Produces: `importCharacterFromFile(profileId, filePath, assetZipPath?: string): ImportResult | null`; `ImportSummary.assetsImported: number`.

This task is dialog/DB/fs wiring (the same untested category as the existing import handler). Its gate is typecheck + the full suite staying green + the manual check below — no new unit test (the extraction logic it calls is fully covered by Task 2).

- [ ] **Step 1: Add `assetsImported` to `ImportSummary`**

In `src/main/services/characterService.ts`, in the `ImportSummary` interface add the field (after `pluginsSkipped`):

```typescript
  /** Images extracted from an optional asset zip supplied at import time. */
  assetsImported: number
```

And in `summarizeCardBundle`'s returned object, add `assetsImported: 0` (it's populated only when a zip is supplied).

- [ ] **Step 2: Import the asset service**

At the top of `characterService.ts`, add:

```typescript
import { importAssetsZip } from './worldAssetService'
```

- [ ] **Step 3: Thread `assetZipPath` through `importCharacterFromFile`**

Change the signature and, after the avatar copy (near the end, before building `summary`), extract the zip into the new world. Replace the signature line:

```typescript
export const importCharacterFromFile = (
  profileId: string,
  filePath: string,
  assetZipPath?: string
): ImportResult | null => {
```

Then, immediately before `const summary = summarizeCardBundle(parsed)`, insert:

```typescript
    let assetsImported = 0
    if (assetZipPath) {
      try {
        assetsImported = importAssetsZip(profileId, newId, assetZipPath).imported
      } catch (e) {
        log('error', 'Asset zip import failed (card import continues):', e)
      }
    }
```

And after the existing `summary.lorebooks = lorebooks` line, add:

```typescript
    summary.assetsImported = assetsImported
```

- [ ] **Step 4: Offer the optional zip prompt in the IPC handler**

In `src/main/ipc/characterIpc.ts`, in the `import-character-dialog` handler, replace the final `return characterService.importCharacterFromFile(profileId, filePath)` with a prompt + threaded path:

```typescript
    // Optional: also import a zip of world assets (portraits/backgrounds) into the new world.
    let assetZipPath: string | undefined
    const addAssets = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Choose zip…', 'Skip'],
      defaultId: 1,
      cancelId: 1,
      message: 'Import assets?',
      detail: 'Optionally pick a .zip of images (character/ and location/ folders) to import with this world.'
    })
    if (addAssets.response === 0) {
      const pick = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Asset Zip', extensions: ['zip'] }]
      })
      if (!pick.canceled && pick.filePaths[0]) assetZipPath = pick.filePaths[0]
    }
    return characterService.importCharacterFromFile(profileId, filePath, assetZipPath)
```

(`win` and `dialog` are already in scope in that handler.)

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all green (the existing suite + the new world-asset tests).

- [ ] **Step 6: Manual verification note (record in the report, do not skip)**

Document in the task report: with `npm run dev`, import a card and at the "Import assets?" prompt choose a zip containing `character/<name>_头像.jpg`; confirm the install toast reports the asset count and the files land in `lorebooks/<newId>.assets/character/`. (No automated coverage — dialog/DB wiring.)

- [ ] **Step 7: Commit**

```bash
git add src/main/services/characterService.ts src/main/ipc/characterIpc.ts
git commit -m "feat(world-assets): optional asset-zip on character import"
```

---

### Task 4: Asset Manager entry point (B)

**Files:**
- Modify: `src/main/ipc/worldAssetIpc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/stores/assetStore.ts`
- Modify: `src/renderer/src/components/AssetManagerPanel.tsx`
- Modify: `src/renderer/src/i18n/locales/en.ts` + `zh.ts`

**Interfaces:**
- Consumes: `importAssetsZip` (Task 2), `ImportAssetsResult` (Task 2), `lorebookIdsForWorld` (existing in `assetStore.ts`).
- Produces: IPC `asset-import-zip-dialog`; `window.api.assetImportZipDialog(profileId, lorebookId)`; `useAssetStore().importZip(profileId, lorebookIds, roster)`.

UI/IPC wiring — gate is typecheck + full suite green + the manual check. No new unit test (the core is covered by Task 2).

- [ ] **Step 1: Add the IPC handler**

In `src/main/ipc/worldAssetIpc.ts`, add `BrowserWindow, dialog` to the `electron` import, import the service result type if needed, and register inside `registerWorldAssetIpc`:

```typescript
  ipcMain.handle(
    'asset-import-zip-dialog',
    async (event, profileId: string, lorebookId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const pick = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Asset Zip', extensions: ['zip'] }]
      })
      if (pick.canceled || !pick.filePaths[0]) return null
      return svc.importAssetsZip(profileId, lorebookId, pick.filePaths[0])
    }
  )
```

Update the top import to: `import { IpcMain, BrowserWindow, dialog } from 'electron'`.

- [ ] **Step 2: Expose on `window.api`**

In `src/preload/index.ts`, after the other `asset*` methods:

```typescript
  assetImportZipDialog: (profileId: string, lorebookId: string) =>
    ipcRenderer.invoke('asset-import-zip-dialog', profileId, lorebookId),
```

- [ ] **Step 3: Add the store action**

In `src/renderer/src/stores/assetStore.ts`, add to the `AssetState` interface:

```typescript
  importZip: (
    profileId: string,
    lorebookIds: string[],
    roster: string[]
  ) => Promise<{ imported: number; skipped: number } | null>
```

And in the store implementation (after `refresh`):

```typescript
  importZip: async (profileId, lorebookIds, roster) => {
    const target = lorebookIds[0]
    if (!target) return null
    const res = await window.api.assetImportZipDialog(profileId, target)
    if (res) await useAssetStore.getState().load(profileId, lorebookIds, roster)
    return res
  }
```

- [ ] **Step 4: Add the button + toast in the panel**

In `src/renderer/src/components/AssetManagerPanel.tsx`, add the toast-store import at the top:

```typescript
import { useToastStore } from '../stores/toastStore'
```

Add `importZip` near the other store selectors:

```typescript
  const importZip = useAssetStore((s) => s.importZip)
```

The toast store's API is `useToastStore.getState().push(msg: string)` (a plain string — see `src/renderer/src/stores/toastStore.ts`). Add the button before the Open-folder button in the header:

```tsx
        <button
          onClick={async () => {
            const res = await importZip(profileId, lorebookIds, roster)
            if (res)
              useToastStore
                .getState()
                .push(t('assets.importResult', { imported: res.imported, skipped: res.skipped }))
          }}
        >
          {t('assets.import')}
        </button>
```

- [ ] **Step 5: Add i18n keys (BOTH locales)**

`en.ts`:

```typescript
  'assets.import': 'Import assets',
  'assets.importResult': 'Imported {{imported}}, skipped {{skipped}}',
```

`zh.ts`:

```typescript
  'assets.import': '导入素材',
  'assets.importResult': '已导入 {{imported}}，跳过 {{skipped}}',
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all green.

- [ ] **Step 7: Manual verification note (record in the report)**

Document: with `npm run dev`, open a world → Assets tab → **Import assets** → pick a zip with `character/<name>_头像.jpg`; confirm the toast shows the counts and the portrait appears after the auto-refresh.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc/worldAssetIpc.ts src/preload/index.ts src/renderer/src/stores/assetStore.ts src/renderer/src/components/AssetManagerPanel.tsx src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts
git commit -m "feat(world-assets): Import-assets button in the Asset Manager"
```

---

## Self-review notes

- Spec coverage: `importAssetsZip` core + validation/safety (Task 2); `categoryForType` (Task 1); entry A card-import (Task 3); entry B Asset Manager (Task 4); overwrite + invalidate + skip-reasons (Task 2 tests). All spec sections mapped.
- The dialog/IPC/DB wiring (Tasks 3–4) is intentionally not unit-tested, matching the existing import-dialog handler; each carries a manual-verification note and a typecheck + full-suite gate.
- Toast store API confirmed: `useToastStore.getState().push(msg: string)` (plain string), wired verbatim in Task 4.
- `i18n` interpolation: `t('key', { imported, skipped })` follows the existing `t(key, params)` usage in the codebase (e.g. `prefs.addPriceRow`).
