# App storage relocation + choosable location (design)

Status: **Design approved (2026-06-27).** Moves the app's data root from `%APPDATA%` (electron
`userData`) to a folder in the installation directory by default, adds a user-selectable storage
location in Settings, and copies existing data over on first run. Independent of the asset-zip feature;
both land on branch `claude/interesting-cray-2c4161`.

## Context & motivation

Every persisted artifact derives from one function, `getAppDir()`
([storageService.ts:7](../../../src/main/services/storageService.ts)) — the SQLite DB
(`getAppDir()/rpterminal.db`), `profiles/`, `lorebooks/` (+ `.assets/`), `regex/`, `scripts/`,
`presets/`, `plugins/`, `avatars/`, etc. Today it returns `app.getPath('userData')/rp-terminal-data`.
The goal is a **portable-style** layout: data lives next to the app (in dev, in the repo; in a packaged
build, next to the executable), with the user able to **choose** a different location from Settings.

## Scope (locked via Q&A, 2026-06-27)

- **Default location:** dev → `process.cwd()`; packaged → `path.dirname(app.getPath('exe'))`; data dir
  name **`rp-terminal-data`**.
- **`RPT_DATA_DIR` env override** (used verbatim) — escape hatch for power users / tests.
- **Choosable in Settings:** a Storage-location control writes a **pointer file** and prompts a restart.
- **First-run migration:** **copy once** from the legacy `%APPDATA%` data dir, keeping it as a backup.
- **Settings change = point only:** writing a new location does **not** move/copy existing data — the app
  uses whatever is at the new location on next launch.
- Add the data folder to `.gitignore`.

## Current state (what we build on)

- `getAppDir()` is the single chokepoint; `getDb()` opens `path.join(getAppDir(), 'rpterminal.db')`
  ([db.ts:110](../../../src/main/services/db.ts)); all services join paths under `getAppDir()`.
- `is` from `@electron-toolkit/utils` is already used in `main/index.ts` (`is.dev`).
- Vitest aliases `electron` to a stub (`test/mocks/electron.ts`: `app.getPath()` → `/tmp/rpt-test`).
  Several main-service tests call the **real** `getAppDir`.
- `migrationService` already runs a startup migration (legacy `profiles.json`); the new copy-once hook
  fits alongside it.

## Architecture

### 1. Resolution — pure `resolveDataBase` + thin `getAppDir`

Split for testability (the electron/env reads stay in the thin wrapper; the precedence logic is pure):

```ts
export const DATA_DIR_NAME = 'rp-terminal-data'

/** Precedence: explicit override → saved pointer → platform default. Pure. */
export function resolveDataBase(opts: {
  override?: string        // RPT_DATA_DIR
  pointer?: string         // dataDir from the pointer file
  isDev: boolean
  cwd: string
  exeDir: string
}): { dir: string; appendName: boolean } {
  if (opts.override) return { dir: opts.override, appendName: false } // used verbatim
  if (opts.pointer)  return { dir: opts.pointer,  appendName: false } // used verbatim
  return { dir: opts.isDev ? opts.cwd : opts.exeDir, appendName: true }
}

export const getAppDir = (): string => {
  const { dir, appendName } = resolveDataBase({
    override: process.env.RPT_DATA_DIR,
    pointer: readLocationPointer()?.dataDir,
    isDev: is.dev,
    cwd: process.cwd(),
    exeDir: path.dirname(app.getPath('exe'))
  })
  return appendName ? path.join(dir, DATA_DIR_NAME) : dir
}
```

Note: env/pointer values are used **verbatim** as the full data dir (no `rp-terminal-data` suffix), so a
user pointing at an existing folder gets exactly that folder. The default appends the name. `getAppDir`
stays cheap (the pointer read is a tiny JSON file; cache it in-process after first read).

### 2. Location pointer (bootstrap)

The chosen location cannot live inside the relocatable data dir (circular), so it is a small pointer file
at the one always-known, writable anchor: `path.join(app.getPath('userData'), 'rpt-location.json')` →
`{ dataDir: string }`. A tiny `locationPointer` module: `readLocationPointer()` (parse, tolerate
missing/corrupt → null) and `writeLocationPointer(dataDir)`. The in-process cache is invalidated on
write (though a restart is what actually applies a change).

### 3. First-run copy-once migration

At startup, **before** `getDb()` or any service touches the new dir (alongside the existing
`migrationService` call in `main/index.ts`):

```
usingDefault = !process.env.RPT_DATA_DIR && !readLocationPointer()?.dataDir
legacy = path.join(app.getPath('userData'), 'rp-terminal-data')   // the previous default
target = getAppDir()
if usingDefault AND target has no rpterminal.db AND legacy exists AND legacy != target:
    fs.cpSync(legacy, target, { recursive: true, errorOnExist: false })   // legacy kept as backup
```

Runs **only when `getAppDir` resolved to the platform default** (no `RPT_DATA_DIR`, no pointer) — a user
who has explicitly chosen a location is never auto-populated from `%APPDATA%`, consistent with the locked
"settings change = point only, don't touch data" decision. Idempotent (skips once `target` has the DB)
and **non-fatal** (a copy failure is logged; the app continues against an empty target). Only this
first-run path copies data; the Settings change does not.

### 4. Settings — choose location

A **Storage** section in the Settings UI (`SettingsModal`) showing the current resolved `getAppDir()`
path, with:
- **Change…** → native folder picker (new IPC `set-data-location-dialog`) → `writeLocationPointer(chosen)`
  → a "Restart required to apply" message (optionally a **Restart now** button via `app.relaunch()` +
  `app.exit(0)`). Per the locked decision, it **does not** move or copy data.
- **Open** → reveal the current data dir (new IPC, `shell.openPath(getAppDir())`).
- (Optional) **Reset to default** → clears the pointer (`writeLocationPointer(null)`), restart to apply.

These are **app-global**, not per-profile — the location is the root that *contains* the profiles, so the
controls go through new IPC against the pointer module, NOT the per-profile settings table. New IPC group
`storageIpc`: `get-data-location` (returns the resolved path + whether a pointer/override is active),
`set-data-location-dialog`, `open-data-location`, `reset-data-location`. Exposed on `window.api`. New
i18n keys (`settings.storage.*`) in **both** locale files.

### 5. Test isolation (required)

Because the dev branch resolves to `process.cwd()`, the **test suite must not write into the repo**. The
vitest config sets `process.env.RPT_DATA_DIR` to an OS temp dir, so `getAppDir()` resolves there for
every test that uses the real function. Tests that mock `getAppDir` (e.g. `worldAssetService.test.ts`)
are unaffected. (Without this, `getAppDir()` under vitest would resolve to the repo root and pollute it.)

### 6. `.gitignore`

Add `/rp-terminal-data/` so the dev data folder created at the repo root is never committed.

## Error handling & edge cases

- **Non-writable install dir** (e.g. packaged into `Program Files`) → writes fail. Documented caveat;
  the user picks a writable location in Settings or sets `RPT_DATA_DIR`. (No silent fallback — keeping
  "everything in one place" predictable; the failure surfaces as a normal write error.)
- **Corrupt / missing pointer file** → `readLocationPointer` returns null → falls through to the default.
- **Pointer points at a non-existent dir** → it's created on first write (`ensureDir`), like any data dir.
- **Copy-once failure** → logged, non-fatal; the app runs against an empty new dir.
- **Concurrent first runs** → not a concern (single-instance desktop app).

## Testing

- **Unit — `resolveDataBase`** (pure): override wins over pointer wins over default; default appends
  `rp-terminal-data` and picks `cwd` vs `exeDir` by `isDev`; override/pointer are used verbatim.
- **Unit — `locationPointer`**: write then read round-trips `{ dataDir }`; missing/corrupt file → null.
- **Unit — copy-once migration** with temp dirs: legacy present + target missing DB → copies the tree
  (and leaves legacy intact); target already has the DB → no copy; legacy absent → no-op.
- The Settings IPC/dialog + the actual restart are integration (untested), like other dialog handlers.

## Decisions (resolved)

- Default = dev `cwd` / packaged `exeDir`, name `rp-terminal-data`; `RPT_DATA_DIR` overrides. ✔
- First-run = **copy once from `%APPDATA%`, keep as backup**. ✔
- Settings location pointer at `userData/rpt-location.json`; change = **point only, restart, don't touch
  data**. ✔
- Test suite pinned to a temp `RPT_DATA_DIR` so the dev `cwd` branch can't pollute the repo. ✔

## Related

- Independent of [2026-06-27-asset-zip-import-design.md](2026-06-27-asset-zip-import-design.md); both on
  branch `claude/interesting-cray-2c4161`. The relocation changes only the *base* of every path, so the
  World Assets paths (`lorebooks/<id>.assets/…`) move with it transparently.
