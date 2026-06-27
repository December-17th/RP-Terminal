# World Assets Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give RP Terminal a per-world image-asset system so card UIs can resolve a character's portrait by name + type + mood, surfaced through an app-native Asset Manager view.

**Architecture:** Pure, TDD-able core in `src/shared/worldAssets/` (filename parser, resolver, mood helper, coverage). A main-process `worldAssetService` scans per-world asset folders into an in-memory index, validates paths, and serves images over a privileged `rptasset://` protocol. A renderer Asset Manager panel lists coverage and opens the folder. No new dependencies.

**Tech Stack:** TypeScript, Electron (main / preload / React renderer), Zustand stores, Vitest. Node built-ins only (`fs`, `path`) — no `chokidar`, no image-processing libs.

## Global Constraints

- **Test runner:** `npm run test` (= `vitest run`). Tests live flat in `test/`, importing from `../src/...` (e.g. `test/worldAssetFilename.test.ts`).
- **No new dependencies.** Use Node `fs`/`path`. The watcher uses built-in `fs.watch`; thumbnail *generation* is out of scope (renderer lazy-loads + CSS-sizes full images instead).
- **i18n:** every user-facing string goes through `t()`; add each new key to BOTH `src/renderer/src/i18n/locales/en.ts` and `src/renderer/src/i18n/locales/zh.ts`.
- **On-disk layout:** `profiles/<profileId>/lorebooks/<lorebookId>.assets/<category>/<file>`; the per-world index is `_index.json` inside that `.assets` dir; thumbnails dir `.thumbs/` is reserved (skipped by the scanner).
- **Naming convention:** `<name>_<type>[_<mood>].<ext>`. Types: `头像` `立绘` (character), `背景` `全景` (location). Extensions: `png jpg jpeg webp gif` (case-insensitive). Trim whitespace around every segment + the extension.
- **Resolver precedence:** `name_type_mood` → `name_type` (base) → `null`; unknown/absent mood falls back to base; multiple active lorebooks are tried in order.
- **Serving protocol:** `rptasset://<profileId>/<lorebookId>/<category>/<file>`, path-sandboxed to the world's `.assets` root (reject `..`/escapes), read-only.
- **CSP:** add `rptasset:` to the inline-iframe `img-src` allow-list in `bridgeShim.ts`. (The WCV surface already allows `img-src *`.)
- **Purity boundary:** the asset layer treats mood as an *input*; `currentMoodFor` (mood extraction from message text) is a separate pure helper.

## File Structure

**Created — shared pure core (`src/shared/worldAssets/`):**
- `types.ts` — `AssetCategory`, `AssetType`, `AssetExt`, `ParsedAssetName`, `AssetIndex` (+ nested types), `ResolveInput`/`ResolvedAsset`, `CharacterCoverage`. One responsibility: shared type vocabulary + constant lists.
- `filename.ts` — `parseAssetFilename`, `buildAssetFilename`. Pure filename ⇄ struct.
- `mood.ts` — `normalizeMood`, `currentMoodFor`. Pure mood normalization + extraction.
- `resolve.ts` — `resolveAsset`. Pure precedence resolution over indexes.
- `coverage.ts` — `rosterFromStatData`, `computeCoverage`. Pure roster + coverage computation.

**Created — main process:**
- `src/main/services/worldAssetService.ts` — fs-bound: `assetsDir`, `buildIndex`, `getIndex` (cache + refresh + `fs.watch` invalidation), `resolveAssetFile` (→ absolute path, validated), `listCoverage`, `openAssetsFolder`.
- `src/main/services/worldAssetProtocol.ts` — `registerAssetProtocol()` (handler for `rptasset://`).
- `src/main/ipc/worldAssetIpc.ts` — IPC handlers.

**Created — renderer:**
- `src/renderer/src/stores/assetStore.ts` — Zustand store for the Asset Manager.
- `src/renderer/src/components/AssetManagerPanel.tsx` — the panel UI.

**Modified:**
- `src/main/index.ts` — register the `rptasset` scheme privileged + call `registerAssetProtocol()`.
- `src/main/ipc/index.ts` — register the world-asset IPC group.
- `src/renderer/src/plugin/bridgeShim.ts` — add `rptasset:` to `img-src`.
- `src/preload/index.ts` — expose the asset `window.api` methods.
- `src/renderer/src/components/panelTabs.ts` — add `'assets'` tab key.
- `src/renderer/src/components/TopNav.tsx` — add the Assets tab button.
- `src/renderer/src/components/PanelRouter.tsx` — route `'assets'` → `AssetManagerPanel`.
- `src/renderer/src/i18n/locales/en.ts` + `zh.ts` — add `nav.assets` + `assets.*` keys.

---

### Task 1: Shared types + filename parser

**Files:**
- Create: `src/shared/worldAssets/types.ts`
- Create: `src/shared/worldAssets/filename.ts`
- Test: `test/worldAssetFilename.test.ts`

**Interfaces:**
- Produces: `parseAssetFilename(filename: string): ParsedAssetName | null`, `buildAssetFilename(p: ParsedAssetName): string`, and the type vocabulary in `types.ts` (`AssetCategory`, `AssetType`, `ASSET_TYPES`, `AssetExt`, `ASSET_EXTS`, `ParsedAssetName`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetFilename.test.ts
import { describe, it, expect } from 'vitest'
import { parseAssetFilename, buildAssetFilename } from '../src/shared/worldAssets/filename'

describe('parseAssetFilename', () => {
  it('parses base avatar', () => {
    expect(parseAssetFilename('爱莎_头像.jpg')).toEqual({
      name: '爱莎', type: '头像', mood: undefined, ext: 'jpg'
    })
  })
  it('parses a mood variant', () => {
    expect(parseAssetFilename('爱莎_头像_愤怒.png')).toEqual({
      name: '爱莎', type: '头像', mood: '愤怒', ext: 'png'
    })
  })
  it('trims stray whitespace and lowercases the extension', () => {
    expect(parseAssetFilename('爱莎_立绘 .JPG ')).toEqual({
      name: '爱莎', type: '立绘', mood: undefined, ext: 'jpg'
    })
  })
  it('keeps underscores that belong to the name (anchors on the type token)', () => {
    expect(parseAssetFilename('赛博_坦克_立绘.webp')).toEqual({
      name: '赛博_坦克', type: '立绘', mood: undefined, ext: 'webp'
    })
  })
  it('normalizes jpeg and accepts location types', () => {
    expect(parseAssetFilename('王城_背景.jpeg')).toEqual({
      name: '王城', type: '背景', mood: undefined, ext: 'jpeg'
    })
  })
  it('returns null when no known type token is present', () => {
    expect(parseAssetFilename('爱莎_随手图.png')).toBeNull()
  })
  it('returns null for an unsupported extension', () => {
    expect(parseAssetFilename('爱莎_头像.bmp')).toBeNull()
  })
  it('round-trips through buildAssetFilename', () => {
    const p = { name: '爱莎', type: '头像' as const, mood: '愤怒', ext: 'png' as const }
    expect(parseAssetFilename(buildAssetFilename(p))).toEqual({ ...p, mood: '愤怒' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetFilename`
Expected: FAIL — cannot find module `../src/shared/worldAssets/filename`.

- [ ] **Step 3: Write the types**

```typescript
// src/shared/worldAssets/types.ts
export type AssetCategory = 'character' | 'location'
export const ASSET_CATEGORIES: AssetCategory[] = ['character', 'location']

export type AssetType = '头像' | '立绘' | '背景' | '全景'
/** Ordered so the parser matches the longest/most-specific token deterministically. */
export const ASSET_TYPES: AssetType[] = ['头像', '立绘', '背景', '全景']

export const ASSET_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export type AssetExt = (typeof ASSET_EXTS)[number]

export interface ParsedAssetName {
  name: string
  type: AssetType
  mood?: string
  ext: AssetExt
}

/** One asset-type's files for a character: an optional base + any mood variants. */
export interface AssetTypeEntry {
  base?: string // filename of the no-mood variant
  moods: Record<string, string> // mood token -> filename
}
export type AssetNameEntry = Partial<Record<AssetType, AssetTypeEntry>>
export type AssetCategoryIndex = Record<string, AssetNameEntry> // name -> entry
export type AssetIndex = Record<string, AssetCategoryIndex> // category -> name -> ...
```

- [ ] **Step 4: Write the parser**

```typescript
// src/shared/worldAssets/filename.ts
import { ASSET_TYPES, ASSET_EXTS, AssetExt, AssetType, ParsedAssetName } from './types'

/** Parse `<name>_<type>[_<mood>].<ext>`. Anchors on the known type token so names may
 *  themselves contain underscores. Returns null if no type token or unknown extension. */
export function parseAssetFilename(filename: string): ParsedAssetName | null {
  const trimmed = filename.trim()
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = trimmed.slice(dot + 1).trim().toLowerCase()
  if (!(ASSET_EXTS as readonly string[]).includes(ext)) return null

  const stem = trimmed.slice(0, dot)
  const segments = stem.split('_').map((s) => s.trim()).filter((s) => s.length > 0)
  // Find the type token, scanning from the right so a trailing mood doesn't shadow it.
  let typeIdx = -1
  let type: AssetType | null = null
  for (let i = segments.length - 1; i >= 0; i--) {
    if ((ASSET_TYPES as string[]).includes(segments[i])) {
      typeIdx = i
      type = segments[i] as AssetType
      break
    }
  }
  if (typeIdx <= 0 || !type) return null // need at least one name segment before the type

  const name = segments.slice(0, typeIdx).join('_')
  const moodSegs = segments.slice(typeIdx + 1)
  const mood = moodSegs.length ? moodSegs.join('_') : undefined
  return { name, type, mood, ext: ext as AssetExt }
}

/** Inverse of parseAssetFilename (used by tests + future tooling). */
export function buildAssetFilename(p: ParsedAssetName): string {
  const core = p.mood ? `${p.name}_${p.type}_${p.mood}` : `${p.name}_${p.type}`
  return `${core}.${p.ext}`
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- worldAssetFilename`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/worldAssets/types.ts src/shared/worldAssets/filename.ts test/worldAssetFilename.test.ts
git commit -m "feat(world-assets): filename parser + shared types"
```

---

### Task 2: Mood helper

**Files:**
- Create: `src/shared/worldAssets/mood.ts`
- Test: `test/worldAssetMood.test.ts`

**Interfaces:**
- Produces: `normalizeMood(s: string): string`, `currentMoodFor(name: string, text: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetMood.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeMood, currentMoodFor } from '../src/shared/worldAssets/mood'

describe('normalizeMood', () => {
  it('trims, lowercases ascii, and maps a synonym to its canonical token', () => {
    expect(normalizeMood('  Smile ')).toBe('微笑')
    expect(normalizeMood('微笑')).toBe('微笑')
    expect(normalizeMood('愤怒')).toBe('愤怒')
  })
})

describe('currentMoodFor', () => {
  it('reads a mood="..." attribute', () => {
    const text = '<dialogue name="爱莎" mood="愤怒">你来晚了。</dialogue>'
    expect(currentMoodFor('爱莎', text)).toBe('愤怒')
  })
  it('reads a [情绪]: structured field', () => {
    const text = '角色：爱莎\n[情绪]: 喜悦\n正文……'
    expect(currentMoodFor('爱莎', text)).toBe('喜悦')
  })
  it('reads a 情绪：fullwidth-colon field', () => {
    expect(currentMoodFor('爱莎', '情绪：悲伤')).toBe('悲伤')
  })
  it('returns the LAST mood when several appear (most recent wins)', () => {
    expect(currentMoodFor('爱莎', 'mood="微笑" ... mood="愤怒"')).toBe('愤怒')
  })
  it('returns undefined when no mood is present', () => {
    expect(currentMoodFor('爱莎', '只是一段普通的旁白。')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetMood`
Expected: FAIL — cannot find module `../src/shared/worldAssets/mood`.

- [ ] **Step 3: Write the helper**

```typescript
// src/shared/worldAssets/mood.ts

/** Minimal synonym table: ascii / loose tokens → the canonical Chinese mood used in filenames.
 *  Unknown moods pass through (trimmed, ascii-lowercased) and simply fall back to base if no file. */
const MOOD_ALIASES: Record<string, string> = {
  smile: '微笑', happy: '喜悦', joy: '喜悦', '笑': '微笑',
  angry: '愤怒', sad: '悲伤', neutral: '平静'
}

export function normalizeMood(s: string): string {
  const t = s.trim().toLowerCase()
  return MOOD_ALIASES[t] ?? s.trim()
}

/** Extract a character's current mood from a message. v1 is message-scoped (the last mood emitted
 *  in the text), reusing the card's existing `mood="..."` attribute and `[情绪]:` / `情绪:` fields.
 *  `name` is accepted for forward-compat (name-scoped lookup is a later refinement). */
export function currentMoodFor(_name: string, text: string): string | undefined {
  let last: string | undefined
  const attr = /\bmood\s*=\s*["']([^"']+)["']/g
  const field = /(?:\[\s*情绪\s*\]|情绪)\s*[：:]\s*([^\s，。;；\n]+)/g
  for (const re of [attr, field]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) last = m[1].trim()
  }
  return last && last.length ? last : undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- worldAssetMood`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/worldAssets/mood.ts test/worldAssetMood.test.ts
git commit -m "feat(world-assets): mood normalization + currentMoodFor helper"
```

---

### Task 3: Resolver

**Files:**
- Create: `src/shared/worldAssets/resolve.ts`
- Test: `test/worldAssetResolve.test.ts`

**Interfaces:**
- Consumes: `AssetIndex`, `AssetCategory`, `AssetType` from `./types`; `normalizeMood` from `./mood`.
- Produces:
  - `interface ResolveInput { indexes: AssetIndex[]; category: AssetCategory; name: string; type: AssetType; mood?: string }`
  - `interface ResolvedAsset { indexPos: number; filename: string; usedMood: string | null }`
  - `resolveAsset(input: ResolveInput): ResolvedAsset | null`

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetResolve.test.ts
import { describe, it, expect } from 'vitest'
import { resolveAsset } from '../src/shared/worldAssets/resolve'
import { AssetIndex } from '../src/shared/worldAssets/types'

const idx = (entry: AssetIndex['character']): AssetIndex => ({ character: entry })

describe('resolveAsset', () => {
  const withMood: AssetIndex = idx({
    爱莎: { 头像: { base: '爱莎_头像.jpg', moods: { 愤怒: '爱莎_头像_愤怒.png' } } }
  })

  it('prefers the mood variant when the mood matches', () => {
    expect(resolveAsset({ indexes: [withMood], category: 'character', name: '爱莎', type: '头像', mood: '愤怒' }))
      .toEqual({ indexPos: 0, filename: '爱莎_头像_愤怒.png', usedMood: '愤怒' })
  })
  it('falls back to base when the mood has no variant', () => {
    expect(resolveAsset({ indexes: [withMood], category: 'character', name: '爱莎', type: '头像', mood: '困惑' }))
      .toEqual({ indexPos: 0, filename: '爱莎_头像.jpg', usedMood: null })
  })
  it('uses base when no mood is requested', () => {
    expect(resolveAsset({ indexes: [withMood], category: 'character', name: '爱莎', type: '头像' }))
      .toEqual({ indexPos: 0, filename: '爱莎_头像.jpg', usedMood: null })
  })
  it('matches a mood through normalization (smile -> 微笑)', () => {
    const i = idx({ 爱莎: { 头像: { moods: { 微笑: '爱莎_头像_微笑.jpg' } } } })
    expect(resolveAsset({ indexes: [i], category: 'character', name: '爱莎', type: '头像', mood: 'smile' }))
      .toEqual({ indexPos: 0, filename: '爱莎_头像_微笑.jpg', usedMood: '微笑' })
  })
  it('returns null when nothing matches', () => {
    expect(resolveAsset({ indexes: [withMood], category: 'character', name: '无名', type: '头像' })).toBeNull()
  })
  it('tries indexes in order; the first match wins', () => {
    const a: AssetIndex = idx({ 爱莎: { 立绘: { base: 'a.png', moods: {} } } })
    const b: AssetIndex = idx({ 爱莎: { 立绘: { base: 'b.png', moods: {} } } })
    expect(resolveAsset({ indexes: [a, b], category: 'character', name: '爱莎', type: '立绘' }))
      .toEqual({ indexPos: 0, filename: 'a.png', usedMood: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetResolve`
Expected: FAIL — cannot find module `../src/shared/worldAssets/resolve`.

- [ ] **Step 3: Write the resolver**

```typescript
// src/shared/worldAssets/resolve.ts
import { AssetCategory, AssetIndex, AssetType } from './types'
import { normalizeMood } from './mood'

export interface ResolveInput {
  indexes: AssetIndex[]
  category: AssetCategory
  name: string
  type: AssetType
  mood?: string
}
export interface ResolvedAsset {
  indexPos: number
  filename: string
  usedMood: string | null
}

export function resolveAsset(input: ResolveInput): ResolvedAsset | null {
  const { indexes, category, name, type, mood } = input
  for (let pos = 0; pos < indexes.length; pos++) {
    const entry = indexes[pos]?.[category]?.[name]?.[type]
    if (!entry) continue
    if (mood) {
      const want = normalizeMood(mood)
      for (const [key, filename] of Object.entries(entry.moods)) {
        if (normalizeMood(key) === want) return { indexPos: pos, filename, usedMood: key }
      }
    }
    if (entry.base) return { indexPos: pos, filename: entry.base, usedMood: null }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- worldAssetResolve`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/worldAssets/resolve.ts test/worldAssetResolve.test.ts
git commit -m "feat(world-assets): precedence resolver (mood -> base -> null)"
```

---

### Task 4: Coverage + roster

**Files:**
- Create: `src/shared/worldAssets/coverage.ts`
- Test: `test/worldAssetCoverage.test.ts`

**Interfaces:**
- Consumes: `AssetCategoryIndex` from `./types`.
- Produces:
  - `interface CharacterCoverage { name: string; hasAvatar: boolean; hasStandee: boolean; moodVariants: number; inRoster: boolean }`
  - `rosterFromStatData(statData: unknown): string[]`
  - `computeCoverage(index: AssetCategoryIndex | undefined, rosterNames: string[]): CharacterCoverage[]`

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetCoverage.test.ts
import { describe, it, expect } from 'vitest'
import { rosterFromStatData, computeCoverage } from '../src/shared/worldAssets/coverage'
import { AssetCategoryIndex } from '../src/shared/worldAssets/types'

describe('rosterFromStatData', () => {
  it('collects 关系列表 keys + the 主角 name', () => {
    const sd = { 主角: { 姓名: '旅人' }, 关系列表: { 爱莎: { 在场: true }, 凯尔: { 在场: false } } }
    expect(rosterFromStatData(sd).sort()).toEqual(['凯尔', '旅人', '爱莎'])
  })
  it('tolerates missing / malformed stat_data', () => {
    expect(rosterFromStatData(undefined)).toEqual([])
    expect(rosterFromStatData({})).toEqual([])
  })
})

describe('computeCoverage', () => {
  const index: AssetCategoryIndex = {
    爱莎: { 头像: { base: 'a.jpg', moods: { 愤怒: 'x.png', 微笑: 'y.png' } }, 立绘: { moods: {} } }
  }
  it('reports avatar/standee/mood-variant coverage and roster membership', () => {
    const rows = computeCoverage(index, ['爱莎', '旅人'])
    const aelia = rows.find((r) => r.name === '爱莎')!
    expect(aelia).toEqual({ name: '爱莎', hasAvatar: true, hasStandee: false, moodVariants: 2, inRoster: true })
    // A roster character with no art still appears, flagged as missing.
    const traveler = rows.find((r) => r.name === '旅人')!
    expect(traveler).toEqual({ name: '旅人', hasAvatar: false, hasStandee: false, moodVariants: 0, inRoster: true })
  })
  it('includes folder-only names (art present, not in roster)', () => {
    const rows = computeCoverage(index, [])
    expect(rows.find((r) => r.name === '爱莎')!.inRoster).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetCoverage`
Expected: FAIL — cannot find module `../src/shared/worldAssets/coverage`.

- [ ] **Step 3: Write the module**

```typescript
// src/shared/worldAssets/coverage.ts
import { AssetCategoryIndex } from './types'

export interface CharacterCoverage {
  name: string
  hasAvatar: boolean // 头像 base present
  hasStandee: boolean // 立绘 base present
  moodVariants: number // total mood variant files across types
  inRoster: boolean
}

/** Names known to the live world: the 主角 + every 关系列表 key. Tolerant of missing fields. */
export function rosterFromStatData(statData: unknown): string[] {
  const names = new Set<string>()
  const sd = statData as Record<string, any> | undefined
  if (sd && typeof sd === 'object') {
    const hero = sd['主角']
    const heroName = hero && typeof hero === 'object' ? hero['姓名'] || hero['名称'] : undefined
    if (typeof heroName === 'string' && heroName.trim()) names.add(heroName.trim())
    const rel = sd['关系列表']
    if (rel && typeof rel === 'object') for (const k of Object.keys(rel)) names.add(k)
  }
  return [...names]
}

const moodCount = (e?: { moods: Record<string, string> }): number =>
  e ? Object.keys(e.moods).length : 0

/** Union of folder-discovered names and roster names → per-character coverage rows. */
export function computeCoverage(
  index: AssetCategoryIndex | undefined,
  rosterNames: string[]
): CharacterCoverage[] {
  const idx = index ?? {}
  const names = new Set<string>([...Object.keys(idx), ...rosterNames])
  const roster = new Set(rosterNames)
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const entry = idx[name]
      return {
        name,
        hasAvatar: !!entry?.['头像']?.base,
        hasStandee: !!entry?.['立绘']?.base,
        moodVariants: moodCount(entry?.['头像']) + moodCount(entry?.['立绘']),
        inRoster: roster.has(name)
      }
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- worldAssetCoverage`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/worldAssets/coverage.ts test/worldAssetCoverage.test.ts
git commit -m "feat(world-assets): roster + coverage computation"
```

---

### Task 5: Main-process asset service (index + path validation)

**Files:**
- Create: `src/main/services/worldAssetService.ts`
- Test: `test/worldAssetService.test.ts`

**Interfaces:**
- Consumes: `getAppDir`, `ensureDir`, `listFilesSync`, `listDirectoriesSync` from `./storageService`; `parseAssetFilename` (Task 1); `resolveAsset`/`ResolvedAsset` (Task 3); `computeCoverage`/`CharacterCoverage` (Task 4); `AssetIndex`, `ASSET_CATEGORIES`, `AssetCategory`, `AssetType` (Task 1).
- Produces:
  - `assetsDir(profileId: string, lorebookId: string, category: AssetCategory): string`
  - `buildIndex(dir: string): AssetIndex` (pure-ish; scans a `.assets` dir)
  - `getIndex(profileId: string, lorebookId: string, opts?: { refresh?: boolean }): AssetIndex`
  - `clearAssetCache(): void` (closes watchers + clears the cache — production invalidation + test isolation)
  - `resolveAssetFile(profileId: string, lorebookIds: string[], category: AssetCategory, name: string, type: AssetType, mood?: string): { lorebookId: string; absPath: string; usedMood: string | null } | null`
  - `resolveProtocolPath(profileId: string, lorebookId: string, category: string, file: string): string | null` (validated absolute path, or null if it escapes the root / missing)
  - `listCoverage(profileId: string, lorebookIds: string[], category: AssetCategory, rosterNames: string[]): CharacterCoverage[]`
  - `openAssetsFolder(profileId: string, lorebookId: string, category: AssetCategory): void`

- [ ] **Step 1: Write the failing test**

```typescript
// test/worldAssetService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
// Point the service's app dir at a temp dir by mocking storageService.getAppDir.
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import * as svc from '../src/main/services/worldAssetService'

const charDir = (lb: string) =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'character')
const write = (lb: string, file: string) => {
  const d = charDir(lb)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, file), 'img-bytes')
}

beforeEach(() => {
  svc.clearAssetCache() // module-level cache/watchers persist across tests — reset for isolation
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-assets-'))
})
afterEach(() => {
  svc.clearAssetCache() // close watchers BEFORE rmSync so Windows can delete the watched dir
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildIndex / getIndex', () => {
  it('indexes base + mood variants and skips _index.json and .thumbs', () => {
    write('w1', '爱莎_头像.jpg')
    write('w1', '爱莎_头像_愤怒.png')
    write('w1', '爱莎_立绘.webp')
    fs.writeFileSync(path.join(charDir('w1'), '_index.json'), '{}')
    fs.mkdirSync(path.join(charDir('w1'), '.thumbs'), { recursive: true })
    const idx = svc.getIndex('p1', 'w1', { refresh: true })
    expect(idx.character['爱莎']['头像']).toEqual({
      base: '爱莎_头像.jpg', moods: { 愤怒: '爱莎_头像_愤怒.png' }
    })
    expect(idx.character['爱莎']['立绘'].base).toBe('爱莎_立绘.webp')
  })
})

describe('resolveProtocolPath', () => {
  it('returns the absolute file path for a valid asset', () => {
    write('w1', '爱莎_头像.jpg')
    const p = svc.resolveProtocolPath('p1', 'w1', 'character', '爱莎_头像.jpg')
    expect(p).toBe(path.join(charDir('w1'), '爱莎_头像.jpg'))
  })
  it('rejects path traversal', () => {
    write('w1', '爱莎_头像.jpg')
    expect(svc.resolveProtocolPath('p1', 'w1', 'character', '..%2f..%2fsecret')).toBeNull()
    expect(svc.resolveProtocolPath('p1', 'w1', 'character', '../../../etc/passwd')).toBeNull()
  })
  it('returns null for a missing file', () => {
    expect(svc.resolveProtocolPath('p1', 'w1', 'character', '无.jpg')).toBeNull()
  })
})

describe('resolveAssetFile', () => {
  it('resolves across lorebook ids in order and reports the matched id', () => {
    write('w2', '爱莎_立绘.png')
    const r = svc.resolveAssetFile('p1', ['w1', 'w2'], 'character', '爱莎', '立绘')
    expect(r?.lorebookId).toBe('w2')
    expect(r?.absPath).toBe(path.join(charDir('w2'), '爱莎_立绘.png'))
  })
})

describe('listCoverage', () => {
  it('merges folder names with the roster', () => {
    write('w1', '爱莎_头像.jpg')
    const rows = svc.listCoverage('p1', ['w1'], 'character', ['爱莎', '旅人'])
    expect(rows.map((r) => r.name).sort()).toEqual(['旅人', '爱莎'])
    expect(rows.find((r) => r.name === '旅人')!.hasAvatar).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetService`
Expected: FAIL — cannot find module `../src/main/services/worldAssetService`.

- [ ] **Step 3: Write the service**

```typescript
// src/main/services/worldAssetService.ts
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { getAppDir, ensureDir, listFilesSync } from './storageService'
import { log } from './logService'
import { parseAssetFilename } from '../../shared/worldAssets/filename'
import { resolveAsset } from '../../shared/worldAssets/resolve'
import { computeCoverage, CharacterCoverage } from '../../shared/worldAssets/coverage'
import { AssetCategory, AssetIndex, AssetType, ASSET_CATEGORIES } from '../../shared/worldAssets/types'

/** `<appDir>/profiles/<profileId>/lorebooks/<lorebookId>.assets` */
const worldAssetsRoot = (profileId: string, lorebookId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'lorebooks', `${lorebookId}.assets`)

export const assetsDir = (profileId: string, lorebookId: string, category: AssetCategory): string =>
  path.join(worldAssetsRoot(profileId, lorebookId), category)

/** Scan a `<lorebookId>.assets` dir into an AssetIndex. Skips `_index.json` + `.thumbs`. */
export function buildIndex(rootDir: string): AssetIndex {
  const index: AssetIndex = {}
  for (const category of ASSET_CATEGORIES) {
    const dir = path.join(rootDir, category)
    const names: AssetIndex[string] = {}
    for (const file of listFilesSync(dir)) {
      if (file === '_index.json' || file.startsWith('.')) continue
      const parsed = parseAssetFilename(file)
      if (!parsed) continue
      const entry = (names[parsed.name] ??= {})
      const typeEntry = (entry[parsed.type] ??= { moods: {} })
      if (parsed.mood) typeEntry.moods[parsed.mood] = file
      else typeEntry.base = file
    }
    if (Object.keys(names).length) index[category] = names
  }
  return index
}

// Cache keyed by `${profileId}/${lorebookId}`; invalidated on refresh or fs.watch event.
const cache = new Map<string, AssetIndex>()
const watchers = new Map<string, fs.FSWatcher>()
const cacheKey = (p: string, l: string): string => `${p}/${l}`

/** Persist the manifest next to the assets (best-effort; portability + a future fast path). */
const writeManifest = (root: string, index: AssetIndex): void => {
  try {
    ensureDir(root)
    fs.writeFileSync(path.join(root, '_index.json'), JSON.stringify(index, null, 2), 'utf-8')
  } catch (e) {
    log('error', '[world-assets] manifest write failed', e)
  }
}

export function getIndex(
  profileId: string,
  lorebookId: string,
  opts?: { refresh?: boolean }
): AssetIndex {
  const key = cacheKey(profileId, lorebookId)
  if (!opts?.refresh && cache.has(key)) return cache.get(key)!
  const root = worldAssetsRoot(profileId, lorebookId)
  const index = buildIndex(root)
  cache.set(key, index)
  // Only persist when there's art — don't create an empty `.assets` dir just to write `{}`.
  if (Object.keys(index).length) writeManifest(root, index)
  // Best-effort live invalidation. fs.watch is built-in; failures are non-fatal (manual refresh
  // remains the reliable path). One watcher per world, recursive where supported (Windows/macOS).
  if (!watchers.has(key) && fs.existsSync(root)) {
    try {
      const w = fs.watch(root, { recursive: true }, () => cache.delete(key))
      watchers.set(key, w)
    } catch {
      /* recursive watch unsupported here — rely on refresh */
    }
  }
  return index
}

/** Reset the in-memory index cache and close all watchers. Call when a lorebook is deleted
 *  (production invalidation) and in test setup/teardown (the Maps are module-level). */
export function clearAssetCache(): void {
  for (const w of watchers.values()) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  watchers.clear()
  cache.clear()
}

/** Map a protocol request to a validated absolute path inside the world's assets root. */
export function resolveProtocolPath(
  profileId: string,
  lorebookId: string,
  category: string,
  file: string
): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(file)
  } catch {
    return null
  }
  const root = worldAssetsRoot(profileId, lorebookId)
  const abs = path.resolve(root, category, decoded)
  const base = path.resolve(root) + path.sep
  if (!abs.startsWith(base)) return null // escaped the assets root
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return abs
}

export function resolveAssetFile(
  profileId: string,
  lorebookIds: string[],
  category: AssetCategory,
  name: string,
  type: AssetType,
  mood?: string
): { lorebookId: string; absPath: string; usedMood: string | null } | null {
  const indexes = lorebookIds.map((id) => getIndex(profileId, id))
  const hit = resolveAsset({ indexes, category, name, type, mood })
  if (!hit) return null
  const lorebookId = lorebookIds[hit.indexPos]
  return {
    lorebookId,
    absPath: path.join(assetsDir(profileId, lorebookId, category), hit.filename),
    usedMood: hit.usedMood
  }
}

export function listCoverage(
  profileId: string,
  lorebookIds: string[],
  category: AssetCategory,
  rosterNames: string[]
): CharacterCoverage[] {
  // Merge the per-lorebook category indexes (earlier ids win on name collisions).
  const merged: AssetIndex[string] = {}
  for (const id of [...lorebookIds].reverse()) {
    const cat = getIndex(profileId, id)[category]
    if (cat) Object.assign(merged, cat)
  }
  return computeCoverage(merged, rosterNames)
}

export function openAssetsFolder(
  profileId: string,
  lorebookId: string,
  category: AssetCategory
): void {
  const dir = assetsDir(profileId, lorebookId, category)
  ensureDir(dir)
  void shell.openPath(dir)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- worldAssetService`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/worldAssetService.ts test/worldAssetService.test.ts
git commit -m "feat(world-assets): main-process index + path-validated resolver service"
```

---

### Task 6: `rptasset://` protocol + inline-iframe CSP

**Files:**
- Create: `src/renderer/src/plugin/csp.ts` (the CSP builder, extracted)
- Create: `src/main/services/worldAssetProtocol.ts`
- Modify: `src/main/index.ts` (register scheme privileged + handler)
- Modify: `src/renderer/src/plugin/bridgeShim.ts:31-45` (import `buildCsp` from `./csp`, drop the local copy)
- Test: `test/worldAssetCsp.test.ts`

**Interfaces:**
- Consumes: `resolveProtocolPath` (Task 5).
- Produces: `buildCsp(allowRemote: boolean): string` (now in `./csp`, emitting `rptasset:` under `img-src`); `ASSET_SCHEME` constant (`'rptasset'`); `registerAssetProtocol(): void`.

- [ ] **Step 1: Write the failing test**

The CSP builder is currently a private const inside `bridgeShim.ts` (which imports five shim modules). Extract it into its own `csp.ts` so the test imports just the pure function, then assert it.

```typescript
// test/worldAssetCsp.test.ts
import { describe, it, expect } from 'vitest'
import { buildCsp } from '../src/renderer/src/plugin/csp'

describe('inline-iframe CSP', () => {
  it('allows rptasset: images in the locked (no-remote) policy', () => {
    const csp = buildCsp(false)
    expect(csp).toMatch(/img-src[^;]*\brptasset:/)
  })
  it('still allows rptasset: when remote is enabled', () => {
    expect(buildCsp(true)).toMatch(/img-src[^;]*\brptasset:/)
  })
  it('keeps the locked default-src none / connect-src none policy', () => {
    expect(buildCsp(false)).toContain("default-src 'none'")
    expect(buildCsp(false)).toContain("connect-src 'none'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetCsp`
Expected: FAIL — cannot find module `../src/renderer/src/plugin/csp`.

- [ ] **Step 3: Extract `csp.ts` (with `rptasset:`) and re-point `bridgeShim`**

Create the new module with the CSP logic moved verbatim from `bridgeShim.ts`, adding `rptasset:` to `img-src`:

```typescript
// src/renderer/src/plugin/csp.ts
/**
 * Content-Security-Policy for the card-script iframe document.
 *  • Locked (default): `connect-src 'none'` + no `allow-same-origin` = "no network".
 *  • Remote-enabled (per-card `remoteScripts` grant): adds `https:` to script/connect/etc.
 *  • `rptasset:` is always allowed under img-src so local per-world portraits load (World Assets).
 */
export const buildCsp = (allowRemote: boolean): string => {
  const s = allowRemote ? ' https:' : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' data: blob:${s}`,
    `style-src 'unsafe-inline'${s}`,
    `img-src data: blob: rptasset:${s}`,
    `font-src data:${s}`,
    `connect-src ${allowRemote ? 'https:' : "'none'"}`,
    "form-action 'none'"
  ].join('; ')
}
```

Then in `src/renderer/src/plugin/bridgeShim.ts`, delete the local `const buildCsp = …` definition (lines ~31-45) and import it instead. Add near the other imports:

```typescript
import { buildCsp } from './csp'
```

`sandboxHead` already calls `buildCsp(allowRemote)`, so no other change is needed there.

- [ ] **Step 4: Write the protocol module**

```typescript
// src/main/services/worldAssetProtocol.ts
import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { resolveProtocolPath } from './worldAssetService'
import { log } from './logService'

export const ASSET_SCHEME = 'rptasset'

/** Serve rptasset://<profileId>/<lorebookId>/<category>/<file> from the validated on-disk path.
 *  Read-only; path traversal is rejected by resolveProtocolPath. Call after app `ready`. */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (req) => {
    try {
      const url = new URL(req.url)
      const profileId = url.hostname
      const segs = url.pathname.replace(/^\/+/, '').split('/')
      const [lorebookId, category, ...rest] = segs
      const file = rest.join('/')
      if (!profileId || !lorebookId || !category || !file) return new Response('Bad Request', { status: 400 })
      const abs = resolveProtocolPath(profileId, lorebookId, category, file)
      if (!abs) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(abs).toString())
    } catch (e) {
      log('error', '[world-assets] protocol error', e)
      return new Response('Error', { status: 500 })
    }
  })
}
```

- [ ] **Step 5: Register the scheme + handler in `main/index.ts`**

Add the scheme to the existing `registerSchemesAsPrivileged` array (alongside `CARD_SCHEME`):

```typescript
import * as worldAssetProtocol from './services/worldAssetProtocol'

protocol.registerSchemesAsPrivileged([
  {
    scheme: wcvManager.CARD_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true }
  },
  {
    scheme: worldAssetProtocol.ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])
```

Then call `worldAssetProtocol.registerAssetProtocol()` once after `app.whenReady()` (next to where `registerIpc(ipcMain)` is called). Locate that call site:

Run: `git grep -n "registerIpc(ipcMain)" src/main/index.ts`

Add `worldAssetProtocol.registerAssetProtocol()` immediately after it.

- [ ] **Step 6: Run the CSP test + full suite + typecheck**

Run: `npm run test -- worldAssetCsp`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/plugin/csp.ts src/main/services/worldAssetProtocol.ts src/main/index.ts src/renderer/src/plugin/bridgeShim.ts test/worldAssetCsp.test.ts
git commit -m "feat(world-assets): rptasset:// protocol + inline-iframe CSP allow"
```

---

### Task 7: IPC + preload API

**Files:**
- Create: `src/main/ipc/worldAssetIpc.ts`
- Modify: `src/main/ipc/index.ts` (register the group)
- Modify: `src/preload/index.ts` (expose methods on `window.api`)
- Test: `test/worldAssetIpc.test.ts`

**Interfaces:**
- Consumes: `worldAssetService` (Task 5), `ASSET_SCHEME` (Task 6).
- Produces (renderer-facing `window.api`):
  - `assetCoverage(profileId, lorebookIds: string[], category, rosterNames: string[]): Promise<CharacterCoverage[]>`
  - `assetUrl(profileId, lorebookIds: string[], category, name, type, mood?): Promise<string | null>` (an `rptasset://` URL or null)
  - `assetRefresh(profileId, lorebookIds: string[]): Promise<void>`
  - `assetOpenFolder(profileId, lorebookId, category): Promise<void>`

- [ ] **Step 1: Write the failing test**

The URL-building is the one piece worth testing in isolation; extract it into the IPC module as a pure exported helper and test that.

```typescript
// test/worldAssetIpc.test.ts
import { describe, it, expect } from 'vitest'
import { assetUrlFor } from '../src/main/ipc/worldAssetIpc'

describe('assetUrlFor', () => {
  it('builds an rptasset:// URL with encoded CJK segments', () => {
    const url = assetUrlFor('p1', 'w1', 'character', '爱莎_头像_愤怒.png')
    expect(url).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像_愤怒.png')}`
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- worldAssetIpc`
Expected: FAIL — cannot find module `../src/main/ipc/worldAssetIpc`.

- [ ] **Step 3: Write the IPC module**

```typescript
// src/main/ipc/worldAssetIpc.ts
import { IpcMain } from 'electron'
import * as svc from '../services/worldAssetService'
import { ASSET_SCHEME } from '../services/worldAssetProtocol'
import { AssetCategory, AssetType } from '../../shared/worldAssets/types'

/** rptasset://<profileId>/<lorebookId>/<category>/<encoded file> */
export function assetUrlFor(
  profileId: string,
  lorebookId: string,
  category: string,
  file: string
): string {
  return `${ASSET_SCHEME}://${profileId}/${lorebookId}/${category}/${encodeURIComponent(file)}`
}

export const registerWorldAssetIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    'asset-coverage',
    (_e, profileId: string, lorebookIds: string[], category: AssetCategory, roster: string[]) =>
      svc.listCoverage(profileId, lorebookIds, category, roster)
  )
  ipcMain.handle(
    'asset-url',
    (
      _e,
      profileId: string,
      lorebookIds: string[],
      category: AssetCategory,
      name: string,
      type: AssetType,
      mood?: string
    ) => {
      const hit = svc.resolveAssetFile(profileId, lorebookIds, category, name, type, mood)
      if (!hit) return null
      const file = hit.absPath.split(/[\\/]/).pop() as string
      return assetUrlFor(profileId, hit.lorebookId, category, file)
    }
  )
  ipcMain.handle('asset-refresh', (_e, profileId: string, lorebookIds: string[]) => {
    for (const id of lorebookIds) svc.getIndex(profileId, id, { refresh: true })
  })
  ipcMain.handle(
    'asset-open-folder',
    (_e, profileId: string, lorebookId: string, category: AssetCategory) =>
      svc.openAssetsFolder(profileId, lorebookId, category)
  )
}
```

- [ ] **Step 4: Register the group in `src/main/ipc/index.ts`**

Add the import + call inside `registerIpc`:

```typescript
import { registerWorldAssetIpc } from './worldAssetIpc'
// ... inside registerIpc(ipcMain):
  registerWorldAssetIpc(ipcMain)
```

- [ ] **Step 5: Expose on `window.api` in `src/preload/index.ts`**

Add these to the `api` object (after the lorebook block):

```typescript
  // World Assets (per-world image asset layer)
  assetCoverage: (profileId: string, lorebookIds: string[], category: string, roster: string[]) =>
    ipcRenderer.invoke('asset-coverage', profileId, lorebookIds, category, roster),
  assetUrl: (
    profileId: string,
    lorebookIds: string[],
    category: string,
    name: string,
    type: string,
    mood?: string
  ) => ipcRenderer.invoke('asset-url', profileId, lorebookIds, category, name, type, mood),
  assetRefresh: (profileId: string, lorebookIds: string[]) =>
    ipcRenderer.invoke('asset-refresh', profileId, lorebookIds),
  assetOpenFolder: (profileId: string, lorebookId: string, category: string) =>
    ipcRenderer.invoke('asset-open-folder', profileId, lorebookId, category),
```

- [ ] **Step 6: Run the test + typecheck**

Run: `npm run test -- worldAssetIpc`
Expected: PASS (1 test).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/worldAssetIpc.ts src/main/ipc/index.ts src/preload/index.ts test/worldAssetIpc.test.ts
git commit -m "feat(world-assets): IPC + preload API for coverage/url/refresh/open-folder"
```

---

### Task 8: Asset Manager panel + nav wiring + i18n

**Files:**
- Create: `src/renderer/src/stores/assetStore.ts`
- Create: `src/renderer/src/components/AssetManagerPanel.tsx`
- Modify: `src/renderer/src/components/panelTabs.ts` (add `'assets'`)
- Modify: `src/renderer/src/components/TopNav.tsx` (add the tab button)
- Modify: `src/renderer/src/components/PanelRouter.tsx` (route `'assets'`)
- Modify: `src/renderer/src/i18n/locales/en.ts` + `zh.ts` (add keys)
- Test: `test/assetStoreNav.test.ts`

**Interfaces:**
- Consumes: `window.api.assetCoverage/assetUrl/assetRefresh/assetOpenFolder` (Task 7); `rosterFromStatData` (Task 4); `CharacterCoverage` (Task 4).
- Produces: the `'assets'` `PanelTab`; `useAssetStore` with `{ rows: CharacterCoverage[]; load(profileId, lorebookIds, roster): Promise<void> }`; `lorebookIdsForWorld(activeCharacterId, sessionIds): string[]` (pure, exported from `assetStore.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/assetStoreNav.test.ts
import { describe, it, expect } from 'vitest'
import { lorebookIdsForWorld } from '../src/renderer/src/stores/assetStore'

describe('lorebookIdsForWorld', () => {
  it('uses the session lorebook ids when present', () => {
    expect(lorebookIdsForWorld('charA', ['lbX', 'lbY'])).toEqual(['lbX', 'lbY'])
  })
  it('falls back to the character id when there are no session ids', () => {
    expect(lorebookIdsForWorld('charA', null)).toEqual(['charA'])
    expect(lorebookIdsForWorld('charA', [])).toEqual(['charA'])
  })
  it('returns empty when there is no world at all', () => {
    expect(lorebookIdsForWorld(null, null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- assetStoreNav`
Expected: FAIL — cannot find module `../src/renderer/src/stores/assetStore`.

- [ ] **Step 3: Write the store**

```typescript
// src/renderer/src/stores/assetStore.ts
import { create } from 'zustand'
import type { CharacterCoverage } from '../../../shared/worldAssets/coverage'

/** The active world's lorebook ids: the chat's session ids, else the character's own book. */
export function lorebookIdsForWorld(
  activeCharacterId: string | null,
  sessionIds: string[] | null
): string[] {
  if (sessionIds && sessionIds.length) return sessionIds
  return activeCharacterId ? [activeCharacterId] : []
}

interface AssetState {
  rows: CharacterCoverage[]
  loading: boolean
  load: (profileId: string, lorebookIds: string[], roster: string[]) => Promise<void>
  refresh: (profileId: string, lorebookIds: string[], roster: string[]) => Promise<void>
}

export const useAssetStore = create<AssetState>((set) => ({
  rows: [],
  loading: false,
  load: async (profileId, lorebookIds, roster) => {
    if (!lorebookIds.length) {
      set({ rows: [] })
      return
    }
    set({ loading: true })
    const rows = await window.api.assetCoverage(profileId, lorebookIds, 'character', roster)
    set({ rows, loading: false })
  },
  refresh: async (profileId, lorebookIds, roster) => {
    await window.api.assetRefresh(profileId, lorebookIds)
    await useAssetStore.getState().load(profileId, lorebookIds, roster)
  }
}))
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `npm run test -- assetStoreNav`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the `'assets'` tab key**

In `src/renderer/src/components/panelTabs.ts`, add `'assets'` to the union:

```typescript
export type PanelTab =
  | 'world'
  | 'sessions'
  | 'persona'
  | 'preset'
  | 'lorebook'
  | 'assets'
  | 'scripts'
  | 'regex'
  | 'api'
  | 'settings'
  | 'logs'
```

- [ ] **Step 6: Add i18n keys (BOTH locales)**

In `src/renderer/src/i18n/locales/en.ts`, after `'nav.lorebook'`:

```typescript
  'nav.assets': 'Assets',
  'assets.heading': 'World Assets',
  'assets.selectWorld': 'Select a World first.',
  'assets.openFolder': 'Open folder',
  'assets.refresh': 'Refresh',
  'assets.avatar': 'Avatar',
  'assets.standee': 'Standee',
  'assets.moods': 'Moods',
  'assets.missing': 'No art',
  'assets.notInWorld': 'Art only (not in world)',
  'assets.empty': 'No characters or assets yet. Drop images into the character folder.',
  'assets.hint': 'Files: <name>_头像.jpg / <name>_立绘.jpg (+ optional _mood).',
```

In `src/renderer/src/i18n/locales/zh.ts`, after `'nav.lorebook'`:

```typescript
  'nav.assets': '素材',
  'assets.heading': '世界素材',
  'assets.selectWorld': '请先选择一个世界。',
  'assets.openFolder': '打开文件夹',
  'assets.refresh': '刷新',
  'assets.avatar': '头像',
  'assets.standee': '立绘',
  'assets.moods': '情绪',
  'assets.missing': '缺图',
  'assets.notInWorld': '仅素材（不在世界中）',
  'assets.empty': '暂无角色或素材。请将图片放入 character 文件夹。',
  'assets.hint': '文件名：<名字>_头像.jpg / <名字>_立绘.jpg（可加 _情绪）。',
```

- [ ] **Step 7: Add the TopNav tab button**

In `src/renderer/src/components/TopNav.tsx`, add the Assets tab next to `lorebook` (also disabled without a world):

```typescript
        {tab('lorebook', t('nav.lorebook'), !hasCharacter)}
        {tab('assets', t('nav.assets'), !hasCharacter)}
```

- [ ] **Step 8: Write the Asset Manager panel**

```tsx
// src/renderer/src/components/AssetManagerPanel.tsx
import { useEffect } from 'react'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useLorebookStore } from '../stores/lorebookStore'
import { useAssetStore, lorebookIdsForWorld } from '../stores/assetStore'
import { rosterFromStatData } from '../../../shared/worldAssets/coverage'
import { useT } from '../i18n'

export function AssetManagerPanel({ profileId }: { profileId: string }): React.ReactElement {
  const t = useT()
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const sessionIds = useLorebookStore((s) => s.sessionIds)
  const floors = useChatStore((s) => s.floors)
  const rows = useAssetStore((s) => s.rows)
  const load = useAssetStore((s) => s.load)
  const refresh = useAssetStore((s) => s.refresh)

  const lorebookIds = lorebookIdsForWorld(activeCharacter?.id ?? null, sessionIds)
  const primaryId = lorebookIds[0]
  const statData = floors.length ? floors[floors.length - 1]?.variables?.stat_data : undefined
  const roster = rosterFromStatData(statData)

  useEffect(() => {
    void load(profileId, lorebookIds, roster)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, lorebookIds.join(','), roster.join(',')])

  if (!activeCharacter) {
    return (
      <div className="panel">
        <div className="panel-header"><h3>{t('assets.heading')}</h3></div>
        <div className="panel-body">
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('assets.selectWorld')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h3 style={{ flex: 1 }}>{t('assets.heading')}</h3>
        <button onClick={() => void refresh(profileId, lorebookIds, roster)}>{t('assets.refresh')}</button>
        {primaryId && (
          <button onClick={() => void window.api.assetOpenFolder(profileId, primaryId, 'character')}>
            {t('assets.openFolder')}
          </button>
        )}
      </div>
      <div className="panel-body">
        <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 8 }}>{t('assets.hint')}</div>
        {rows.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('assets.empty')}</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.map((r) => (
              <li
                key={r.name}
                style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #2a2a3a' }}
              >
                <Thumb
                  profileId={profileId}
                  lorebookIds={lorebookIds}
                  name={r.name}
                  has={r.hasAvatar}
                />
                <span style={{ flex: 1 }}>{r.name}</span>
                <Chip ok={r.hasAvatar} label={t('assets.avatar')} />
                <Chip ok={r.hasStandee} label={t('assets.standee')} />
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  {t('assets.moods')}: {r.moodVariants}
                </span>
                {!r.inRoster && (
                  <span style={{ fontSize: 11, opacity: 0.5 }}>{t('assets.notInWorld')}</span>
                )}
                {r.inRoster && !r.hasAvatar && !r.hasStandee && (
                  <span style={{ fontSize: 11, color: '#e0a0a0' }}>{t('assets.missing')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Chip({ ok, label }: { ok: boolean; label: string }): React.ReactElement {
  return (
    <span
      style={{
        fontSize: 11, padding: '1px 6px', borderRadius: 6,
        background: ok ? '#23402a' : '#3a2a2a', color: ok ? '#9fe0b0' : '#e0a0a0'
      }}
    >
      {label} {ok ? '✓' : '✗'}
    </span>
  )
}

function Thumb({
  profileId,
  lorebookIds,
  name,
  has
}: {
  profileId: string
  lorebookIds: string[]
  name: string
  has: boolean
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (has) {
      void window.api
        .assetUrl(profileId, lorebookIds, 'character', name, '头像')
        .then((u) => { if (live) setUrl(u) })
    } else {
      setUrl(null)
    }
    return () => { live = false }
  }, [profileId, lorebookIds.join(','), name, has])

  const box: React.CSSProperties = {
    width: 36, height: 36, borderRadius: 6, objectFit: 'cover',
    background: '#2a2a3a', flex: '0 0 auto'
  }
  return url ? (
    <img src={url} alt={name} loading="lazy" style={box} />
  ) : (
    <div style={{ ...box, display: 'grid', placeItems: 'center', fontSize: 14, opacity: 0.6 }}>
      {name.slice(0, 1)}
    </div>
  )
}
```

Add the missing React import at the top:

```tsx
import { useEffect, useState } from 'react'
```

- [ ] **Step 9: Route `'assets'` in PanelRouter**

In `src/renderer/src/components/PanelRouter.tsx`, add the import and a `case`:

```tsx
import { AssetManagerPanel } from './AssetManagerPanel'
// ... inside switch (panel):
    case 'assets':
      return <AssetManagerPanel profileId={profileId} />
```

- [ ] **Step 10: Typecheck + full test suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all tests PASS (including the new world-asset suites).

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/stores/assetStore.ts src/renderer/src/components/AssetManagerPanel.tsx src/renderer/src/components/panelTabs.ts src/renderer/src/components/TopNav.tsx src/renderer/src/components/PanelRouter.tsx src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts test/assetStoreNav.test.ts
git commit -m "feat(world-assets): Asset Manager panel + nav + i18n"
```

---

## Manual verification (after Task 8)

The automated suite covers the pure core, path validation, and CSP. The end-to-end visual check is manual (the app drives an Electron window):

1. `npm run dev`, open a world (the 命定之诗 card), open a chat so a roster exists.
2. Click the **Assets** tab → **Open folder** → drop `爱莎_头像.jpg` (and optionally `爱莎_头像_愤怒.png`, `爱莎_立绘.webp`) into the opened `character/` folder.
3. Click **Refresh** → 爱莎's row shows the thumbnail + Avatar ✓ / Standee ✓ chips + mood count.
4. Confirm a roster character with no files shows the **No art** flag, and a file with no roster match shows **Art only (not in world)**.

## Notes / deviations from the spec (deliberate, within plan latitude)

- **Watcher:** uses Node's built-in `fs.watch` (recursive) for best-effort cache invalidation instead of `chokidar` (not a dependency). Manual **Refresh** is the reliable path and is what the tests exercise.
- **Thumbnails:** v1 serves full images over `rptasset://` and renders them lazy-loaded + CSS-sized (36px in the Manager). Actual thumbnail *generation* (`.thumbs/`) needs an image-processing dep and is deferred; the dir name is reserved and skipped by the scanner.
- **WCV partition:** the `rptasset://` handler is registered on the default session (covers the Asset Manager + the inline-iframe card surface). If a `persist:wcv-cards` card later needs assets, register the same handler on that session — out of scope here.
- **Malformed filenames:** files with no recognizable type token are silently skipped by the scanner (never throw). Surfacing them as an explicit "unrecognized file" warning in the Asset Manager (spec §6) is deferred to a Manager-polish pass; the spec's "never crash" guarantee holds.

## Next phase (separate plan)

Spec 2 — the **relationship web + BG3 party portraits** — consumes `window.api.assetUrl` + `currentMoodFor` + `rosterFromStatData` built here. Not part of this plan.
