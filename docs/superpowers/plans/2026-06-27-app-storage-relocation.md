# App Storage Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app's data root from `%APPDATA%` to a folder in the installation directory by default (`rp-terminal-data`), with an `RPT_DATA_DIR` override, a user-selectable location in Settings (via a pointer file), and a one-time copy of existing data from `%APPDATA%`.

**Architecture:** `getAppDir()` is the single chokepoint. Split it into a pure `resolveDataBase` (precedence: env → pointer → platform default) plus a thin memoized `getAppDir`, backed by a `locationPointer` module (a tiny JSON at the fixed `userData` anchor). A startup copy-once migration and a Settings IPC group + UI complete it.

**Tech Stack:** TypeScript, Electron (main/preload/React renderer), Vitest. Node built-ins (`fs.cpSync`). Dev-vs-packaged detection via `app.isPackaged` (no `@electron-toolkit/utils` import in `storageService`). No new dependencies.

## Global Constraints

- **Test runner:** `npm run test` (= `vitest run`). Tests flat in `test/`, importing from `../src/...`.
- **No new dependencies.**
- **Resolution precedence:** `RPT_DATA_DIR` env (verbatim) → pointer file `dataDir` (verbatim) → `(!app.isPackaged) ? process.cwd() : path.dirname(app.getPath('exe'))` + `/rp-terminal-data`. Data-dir name = `rp-terminal-data`.
- **Pointer file:** `path.join(app.getPath('userData'), 'rpt-location.json')` → `{ dataDir: string }`.
- **First-run copy-once:** only when resolution used the platform default (no env, no pointer); copy `userData/rp-terminal-data` → target if target has no `rpterminal.db` and legacy exists; keep legacy as backup; non-fatal.
- **Settings change = point only:** writing a new location does not move/copy data; it requires a restart.
- **Test isolation:** the vitest config sets `RPT_DATA_DIR` to an OS temp dir so the dev `cwd` branch never writes into the repo.
- **i18n:** route user-facing strings through `t()`; add keys to BOTH `en.ts` and `zh.ts`.
- Repo style: 2-space indent, no semicolons.

## File Structure

**Modified:**
- `src/main/services/storageService.ts` — `DATA_DIR_NAME`, `resolveDataBase` (pure), rewritten memoized `getAppDir`, `copyLegacyDataDirIfNeeded`.
- `src/main/index.ts` — call the copy-once before `migrateIfNeeded()`; (IPC group registered via `registerIpc`).
- `src/main/ipc/index.ts` — register `storageIpc`.
- `src/preload/index.ts` — storage `window.api` methods.
- `vitest.config.ts` — set `RPT_DATA_DIR` test env.
- `.gitignore` — `/rp-terminal-data/`.
- `src/renderer/src/components/SettingsPanel.tsx` — render the storage section.
- `src/renderer/src/i18n/locales/en.ts` + `zh.ts` — `settings.storage.*` keys.

**Created:**
- `src/main/services/locationPointer.ts`, `src/main/ipc/storageIpc.ts`, `src/renderer/src/components/StorageSettings.tsx`.
- Tests: `test/resolveDataBase.test.ts`, `test/locationPointer.test.ts`, `test/legacyDataCopy.test.ts`.

---

### Task 1: `resolveDataBase` (pure)

**Files:**
- Modify: `src/main/services/storageService.ts`
- Test: `test/resolveDataBase.test.ts`

**Interfaces:**
- Produces: `DATA_DIR_NAME = 'rp-terminal-data'`; `resolveDataBase(opts: { override?: string; pointer?: string; isDev: boolean; cwd: string; exeDir: string }): { dir: string; appendName: boolean }`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/resolveDataBase.test.ts
import { describe, it, expect } from 'vitest'
import { resolveDataBase, DATA_DIR_NAME } from '../src/main/services/storageService'

const def = { isDev: true, cwd: '/repo', exeDir: '/app' }

describe('resolveDataBase', () => {
  it('uses RPT_DATA_DIR override verbatim (no name appended)', () => {
    expect(resolveDataBase({ ...def, override: '/custom' })).toEqual({ dir: '/custom', appendName: false })
  })
  it('uses the pointer verbatim when no override', () => {
    expect(resolveDataBase({ ...def, pointer: '/picked' })).toEqual({ dir: '/picked', appendName: false })
  })
  it('override beats pointer', () => {
    expect(resolveDataBase({ ...def, override: '/o', pointer: '/p' }).dir).toBe('/o')
  })
  it('default in dev = cwd, append name', () => {
    expect(resolveDataBase({ isDev: true, cwd: '/repo', exeDir: '/app' })).toEqual({ dir: '/repo', appendName: true })
  })
  it('default packaged = exeDir, append name', () => {
    expect(resolveDataBase({ isDev: false, cwd: '/repo', exeDir: '/app' })).toEqual({ dir: '/app', appendName: true })
  })
  it('exposes the data dir name', () => {
    expect(DATA_DIR_NAME).toBe('rp-terminal-data')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- resolveDataBase`
Expected: FAIL — `resolveDataBase`/`DATA_DIR_NAME` not exported.

- [ ] **Step 3: Implement in `storageService.ts`**

Add near the top (after the imports, before `getAppDir`):

```typescript
export const DATA_DIR_NAME = 'rp-terminal-data'

/** Resolve the data-root base. Precedence: explicit override → saved pointer → platform default.
 *  override/pointer are used verbatim (the chosen folder IS the data dir); the default appends
 *  DATA_DIR_NAME. Pure — the electron/env reads live in getAppDir. */
export function resolveDataBase(opts: {
  override?: string
  pointer?: string
  isDev: boolean
  cwd: string
  exeDir: string
}): { dir: string; appendName: boolean } {
  if (opts.override) return { dir: opts.override, appendName: false }
  if (opts.pointer) return { dir: opts.pointer, appendName: false }
  return { dir: opts.isDev ? opts.cwd : opts.exeDir, appendName: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- resolveDataBase`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/storageService.ts test/resolveDataBase.test.ts
git commit -m "feat(storage): pure resolveDataBase + DATA_DIR_NAME"
```

---

### Task 2: `locationPointer` module

**Files:**
- Create: `src/main/services/locationPointer.ts`
- Test: `test/locationPointer.test.ts`

**Interfaces:**
- Consumes: `app` (`electron`, stubbed in tests — `app.getPath('userData')` → `/tmp/rpt-test`).
- Produces: `pointerPath(): string`; `readLocationPointer(): { dataDir: string } | null`; `writeLocationPointer(dataDir: string | null): void`. No internal cache (reads reflect current file state).

- [ ] **Step 1: Write the failing test**

```typescript
// test/locationPointer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { pointerPath, readLocationPointer, writeLocationPointer } from '../src/main/services/locationPointer'

beforeEach(() => writeLocationPointer(null))
afterEach(() => writeLocationPointer(null))

describe('locationPointer', () => {
  it('returns null when no pointer file exists', () => {
    expect(readLocationPointer()).toBeNull()
  })
  it('round-trips a dataDir', () => {
    writeLocationPointer('/some/dir')
    expect(readLocationPointer()).toEqual({ dataDir: '/some/dir' })
  })
  it('clears the pointer when written null', () => {
    writeLocationPointer('/x')
    writeLocationPointer(null)
    expect(readLocationPointer()).toBeNull()
  })
  it('tolerates a corrupt file → null', () => {
    fs.writeFileSync(pointerPath(), 'not json')
    expect(readLocationPointer()).toBeNull()
  })
  it('ignores a file missing dataDir → null', () => {
    fs.writeFileSync(pointerPath(), JSON.stringify({ other: 1 }))
    expect(readLocationPointer()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- locationPointer`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
// src/main/services/locationPointer.ts
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

interface LocationPointer {
  dataDir: string
}

/** Fixed, always-known, writable anchor — NOT inside the relocatable data dir (that would be circular). */
export const pointerPath = (): string => path.join(app.getPath('userData'), 'rpt-location.json')

/** The saved data-dir choice, or null if unset / unreadable / malformed. No cache (reads are rare:
 *  getAppDir memoizes its result, so this is read ~once per session). */
export function readLocationPointer(): LocationPointer | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pointerPath(), 'utf-8'))
    return parsed && typeof parsed.dataDir === 'string' && parsed.dataDir
      ? { dataDir: parsed.dataDir }
      : null
  } catch {
    return null
  }
}

/** Write (or, with null, remove) the pointer. Takes effect on next launch (getAppDir is read once). */
export function writeLocationPointer(dataDir: string | null): void {
  const p = pointerPath()
  if (dataDir) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ dataDir }, null, 2), 'utf-8')
  } else if (fs.existsSync(p)) {
    fs.unlinkSync(p)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- locationPointer`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/locationPointer.ts test/locationPointer.test.ts
git commit -m "feat(storage): location pointer module"
```

---

### Task 3: Rewrite `getAppDir` + test isolation + gitignore

**Files:**
- Modify: `src/main/services/storageService.ts`
- Modify: `vitest.config.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `resolveDataBase`/`DATA_DIR_NAME` (Task 1), `readLocationPointer` (Task 2), `app` (`electron`, already imported in storageService).
- Produces: a memoized `getAppDir()` whose base now follows the precedence rules.
- **Dev detection:** use `!app.isPackaged` (NOT `is` from `@electron-toolkit/utils`). That package is not currently loaded under the vitest electron mock; importing it into `storageService` — which nearly every main test loads — risks breaking the suite. `app` is already imported and stubbed. (In tests the `RPT_DATA_DIR` override branch returns before dev detection is even used.)

This task changes where EVERY path resolves, so its gate is the **full** suite + typecheck staying green. The vitest-config change MUST land in the same commit (otherwise the dev `cwd` branch pollutes the repo during tests).

- [ ] **Step 1: Set the test-env data dir in `vitest.config.ts`**

Add `import os from 'os'` and `import { join } from 'path'` at the top, and an `env` block under `test` (alongside the existing `alias`):

```typescript
    env: {
      // Pin the data root to a temp dir so the dev (process.cwd()) branch of getAppDir never
      // writes into the repo during tests. Tests that mock getAppDir are unaffected.
      RPT_DATA_DIR: join(os.tmpdir(), 'rpt-vitest-data')
    },
```

- [ ] **Step 2: Add `.gitignore` entry**

Append to `.gitignore`:

```
# App data folder created next to the app in dev (storage relocation)
/rp-terminal-data/
```

- [ ] **Step 3: Rewrite `getAppDir`**

In `src/main/services/storageService.ts`, add ONE new import at the top (do NOT import `@electron-toolkit/utils` — see the Interfaces note; `app` and `path` are already imported):

```typescript
import { readLocationPointer } from './locationPointer'
```

Replace the existing `getAppDir` body with the memoized resolver (dev detection via `!app.isPackaged`):

```typescript
let cachedAppDir: string | null = null

// The data root: RPT_DATA_DIR → saved pointer → platform default (dev=cwd / packaged=exe dir) +
// DATA_DIR_NAME. Memoized — the location cannot change without an app restart.
export const getAppDir = (): string => {
  if (cachedAppDir) return cachedAppDir
  const { dir, appendName } = resolveDataBase({
    override: process.env.RPT_DATA_DIR,
    pointer: readLocationPointer()?.dataDir,
    isDev: !app.isPackaged, // true in `electron-vite dev`, false in a packaged build
    cwd: process.cwd(),
    exeDir: path.dirname(app.getPath('exe'))
  })
  cachedAppDir = appendName ? path.join(dir, DATA_DIR_NAME) : dir
  return cachedAppDir
}
```

(Keep `ensureDir`, `readJsonSync`, etc. unchanged. The old `app.getPath('userData')` line in `getAppDir` is fully replaced.)

- [ ] **Step 4: Run the FULL suite + typecheck**

Run: `npm run test`
Expected: all green — every test that uses the real `getAppDir` now resolves under the temp `RPT_DATA_DIR`; the World Assets tests (which mock `getAppDir`) are unaffected.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/storageService.ts vitest.config.ts .gitignore
git commit -m "feat(storage): relocate getAppDir to install folder (env/pointer/default) + test isolation"
```

---

### Task 4: First-run copy-once migration

**Files:**
- Modify: `src/main/services/storageService.ts`
- Modify: `src/main/index.ts`
- Test: `test/legacyDataCopy.test.ts`

**Interfaces:**
- Consumes: `readLocationPointer` (Task 2), `getAppDir` (Task 3) — in the `main/index.ts` caller only.
- Produces: `copyLegacyDataDirIfNeeded(opts: { legacyDir: string; targetDir: string; usingDefault: boolean }): boolean` (returns true iff it copied).

- [ ] **Step 1: Write the failing test**

```typescript
// test/legacyDataCopy.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { copyLegacyDataDirIfNeeded } from '../src/main/services/storageService'

let root: string
const seed = (dir: string, withDb = true): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'profiles.json'), '[]')
  if (withDb) fs.writeFileSync(path.join(dir, 'rpterminal.db'), 'db')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-legacy-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('copyLegacyDataDirIfNeeded', () => {
  it('copies legacy → target when target is absent and we use the default', () => {
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    seed(legacy)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: legacy, targetDir: target, usingDefault: true })).toBe(true)
    expect(fs.existsSync(path.join(target, 'rpterminal.db'))).toBe(true)
    expect(fs.existsSync(path.join(legacy, 'rpterminal.db'))).toBe(true) // legacy kept as backup
  })
  it('does nothing when target already has the DB', () => {
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    seed(legacy)
    seed(target)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: legacy, targetDir: target, usingDefault: true })).toBe(false)
  })
  it('does nothing when not using the default (pointer/override active)', () => {
    const legacy = path.join(root, 'legacy')
    seed(legacy)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: legacy, targetDir: path.join(root, 't'), usingDefault: false })).toBe(false)
  })
  it('does nothing when legacy is absent', () => {
    expect(copyLegacyDataDirIfNeeded({ legacyDir: path.join(root, 'nope'), targetDir: path.join(root, 't'), usingDefault: true })).toBe(false)
  })
  it('does nothing when legacy === target', () => {
    const d = path.join(root, 'same')
    seed(d, false)
    expect(copyLegacyDataDirIfNeeded({ legacyDir: d, targetDir: d, usingDefault: true })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- legacyDataCopy`
Expected: FAIL — `copyLegacyDataDirIfNeeded` not exported.

- [ ] **Step 3: Implement in `storageService.ts`**

Append:

```typescript
/** One-time copy of the legacy %APPDATA% data dir into the new location, on first run only.
 *  Runs only when getAppDir used the platform default (no env/pointer), the target has no DB yet,
 *  and the legacy dir exists. Leaves the legacy copy intact as a backup. Returns true iff it copied. */
export function copyLegacyDataDirIfNeeded(opts: {
  legacyDir: string
  targetDir: string
  usingDefault: boolean
}): boolean {
  const { legacyDir, targetDir, usingDefault } = opts
  if (!usingDefault) return false
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return false
  if (fs.existsSync(path.join(targetDir, 'rpterminal.db'))) return false
  if (!fs.existsSync(legacyDir)) return false
  fs.cpSync(legacyDir, targetDir, { recursive: true, errorOnExist: false })
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- legacyDataCopy`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into startup (before `migrateIfNeeded`)**

In `src/main/index.ts`, add imports near the other service imports:

```typescript
import { join } from 'path' // already imported — reuse it
import * as storageService from './services/storageService'
import { readLocationPointer } from './services/locationPointer'
```

(`join` and `app` are already imported; add only the two service imports.)

Then, at the very start of the `app.whenReady().then(() => { ... })` body — **before** `migrationService.migrateIfNeeded()` (which opens the DB) — insert:

```typescript
  // Relocation: on first run with the default location, copy existing %APPDATA% data over (kept as backup).
  try {
    const usingDefault = !process.env.RPT_DATA_DIR && !readLocationPointer()?.dataDir
    storageService.copyLegacyDataDirIfNeeded({
      legacyDir: join(app.getPath('userData'), 'rp-terminal-data'),
      targetDir: storageService.getAppDir(),
      usingDefault
    })
  } catch (err: any) {
    logService.log('error', 'Legacy data-dir copy failed', err?.message || String(err))
  }
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/storageService.ts src/main/index.ts test/legacyDataCopy.test.ts
git commit -m "feat(storage): copy-once %APPDATA% migration on first run"
```

---

### Task 5: Storage IPC + preload

**Files:**
- Create: `src/main/ipc/storageIpc.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `getAppDir` (Task 3), `readLocationPointer`/`writeLocationPointer` (Task 2).
- Produces (renderer-facing `window.api`): `getDataLocation()` → `{ path, pointer, envOverride }`; `setDataLocationDialog()` → `string | null`; `openDataLocation()`; `resetDataLocation()`; `restartApp()`.

IPC/dialog wiring — gate is typecheck + full suite green (no new unit test; consistent with other dialog IPC groups).

- [ ] **Step 1: Create the IPC module**

```typescript
// src/main/ipc/storageIpc.ts
import { IpcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { getAppDir } from '../services/storageService'
import { readLocationPointer, writeLocationPointer } from '../services/locationPointer'

export const registerStorageIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-data-location', () => ({
    path: getAppDir(),
    pointer: readLocationPointer()?.dataDir ?? null,
    envOverride: process.env.RPT_DATA_DIR ?? null
  }))

  ipcMain.handle('set-data-location-dialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const pick = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || !pick.filePaths[0]) return null
    writeLocationPointer(pick.filePaths[0])
    return pick.filePaths[0]
  })

  ipcMain.handle('open-data-location', () => shell.openPath(getAppDir()))

  ipcMain.handle('reset-data-location', () => {
    writeLocationPointer(null)
    return true
  })

  ipcMain.handle('restart-app', () => {
    app.relaunch()
    app.exit(0)
  })
}
```

- [ ] **Step 2: Register the group**

In `src/main/ipc/index.ts`, add the import + the call inside `registerIpc`:

```typescript
import { registerStorageIpc } from './storageIpc'
// ... inside registerIpc(ipcMain):
  registerStorageIpc(ipcMain)
```

- [ ] **Step 3: Expose on `window.api`**

In `src/preload/index.ts`, add to the `api` object:

```typescript
  // Storage location (app-global; pointer file, not per-profile settings)
  getDataLocation: () => ipcRenderer.invoke('get-data-location'),
  setDataLocationDialog: () => ipcRenderer.invoke('set-data-location-dialog'),
  openDataLocation: () => ipcRenderer.invoke('open-data-location'),
  resetDataLocation: () => ipcRenderer.invoke('reset-data-location'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/storageIpc.ts src/main/ipc/index.ts src/preload/index.ts
git commit -m "feat(storage): IPC + preload for data-location get/set/open/reset/restart"
```

---

### Task 6: Settings — Storage location UI

**Files:**
- Create: `src/renderer/src/components/StorageSettings.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/i18n/locales/en.ts` + `zh.ts`

**Interfaces:**
- Consumes: `window.api.getDataLocation/setDataLocationDialog/openDataLocation/resetDataLocation/restartApp` (Task 5).
- Produces: a `<StorageSettings/>` section rendered in `SettingsPanel`.

UI wiring — gate is typecheck + full suite green + the manual note.

- [ ] **Step 1: Add i18n keys (BOTH locales)**

`en.ts`:

```typescript
  'settings.storage.title': 'Storage location',
  'settings.storage.current': 'Current data folder',
  'settings.storage.change': 'Change…',
  'settings.storage.open': 'Open',
  'settings.storage.reset': 'Reset to default',
  'settings.storage.restartHint': 'Restart required to apply the new location.',
  'settings.storage.restartNow': 'Restart now',
  'settings.storage.pending': 'Will use after restart: {{path}}',
```

`zh.ts`:

```typescript
  'settings.storage.title': '存储位置',
  'settings.storage.current': '当前数据文件夹',
  'settings.storage.change': '更改…',
  'settings.storage.open': '打开',
  'settings.storage.reset': '恢复默认',
  'settings.storage.restartHint': '需要重启应用以应用新的位置。',
  'settings.storage.restartNow': '立即重启',
  'settings.storage.pending': '重启后将使用：{{path}}',
```

- [ ] **Step 2: Create the component**

```tsx
// src/renderer/src/components/StorageSettings.tsx
import { useEffect, useState } from 'react'
import { useT } from '../i18n'

export function StorageSettings(): React.ReactElement {
  const t = useT()
  const [current, setCurrent] = useState<string>('')
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getDataLocation().then((loc) => setCurrent(loc?.path ?? ''))
  }, [])

  const change = async (): Promise<void> => {
    const picked = await window.api.setDataLocationDialog()
    if (picked) setPending(picked)
  }
  const reset = async (): Promise<void> => {
    await window.api.resetDataLocation()
    setPending(t('settings.storage.reset'))
  }

  return (
    <details className="settings-section" style={{ marginTop: 20 }}>
      <summary>{t('settings.storage.title')}</summary>
      <div className="settings-section-body">
        <label className="field-label">{t('settings.storage.current')}</label>
        <div style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--rpt-text-secondary)' }}>
          {current}
        </div>
        <div className="preset-actions" style={{ marginTop: 8 }}>
          <button onClick={change}>{t('settings.storage.change')}</button>
          <button onClick={() => void window.api.openDataLocation()}>
            {t('settings.storage.open')}
          </button>
          <button onClick={reset}>{t('settings.storage.reset')}</button>
        </div>
        {pending && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: '0.8em', color: 'var(--rpt-text-secondary)' }}>
              {t('settings.storage.pending', { path: pending })}
            </div>
            <div style={{ fontSize: '0.8em', marginTop: 2 }}>{t('settings.storage.restartHint')}</div>
            <button style={{ marginTop: 6 }} onClick={() => void window.api.restartApp()}>
              {t('settings.storage.restartNow')}
            </button>
          </div>
        )}
      </div>
    </details>
  )
}
```

- [ ] **Step 3: Render it in `SettingsPanel`**

In `src/renderer/src/components/SettingsPanel.tsx`, add the import:

```typescript
import { StorageSettings } from './StorageSettings'
```

and render it just before the Plugins `<details>` section (near the end of the `panel-body`):

```tsx
        <StorageSettings />
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all green.

- [ ] **Step 5: Manual verification note (record in the report)**

Document: with `npm run dev`, open Settings → App → expand **Storage location**; confirm it shows the current folder, **Open** reveals it, **Change…** lets you pick a folder and shows the pending path + restart hint, and **Restart now** relaunches. (No automated coverage — IPC/dialog/UI wiring.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/StorageSettings.tsx src/renderer/src/components/SettingsPanel.tsx src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts
git commit -m "feat(storage): Storage-location section in Settings"
```

---

## Self-review notes

- Spec coverage: resolution precedence (Task 1 + Task 3); pointer file (Task 2); copy-once migration (Task 4); Settings picker = point-only + restart (Tasks 5–6); test isolation + gitignore (Task 3). All spec sections mapped.
- The dev `cwd` test-pollution risk is closed in the same commit as the `getAppDir` rewrite (Task 3, vitest `RPT_DATA_DIR`).
- IPC/UI wiring (Tasks 5–6) is not unit-tested, consistent with other dialog IPC groups; each carries a typecheck + full-suite gate, and Task 6 a manual-verification note.
- `i18n` interpolation `t(key, { path })` matches existing `t(key, params)` usage.
- `getAppDir` is memoized so the per-session location is stable (a Settings change applies on restart), and the pointer read happens ~once.
