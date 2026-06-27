# 命定之诗 Party-Avatar Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A left-docked, BG3-style party-avatar panel for the 命定之诗 card — shipped as card content (a WCV panel regex), backed by two generic app/SDK deltas (auto-dock a card-declared left panel; let WCV cards resolve World Assets portraits).

**Architecture:** Two reusable app deltas — **Δ2** (register `rptasset://` on the WCV session + an `rpt.assetUrl` bridge) and **Δ1** (a card-declared `left_panel` auto-injected into the workspace layout) — then the **命定之诗 card content** (the avatar-panel HTML/regex + a card patch). Pure helpers are TDD'd; protocol/IPC/renderer wiring and the bespoke panel HTML are manual-verify, mirroring the combat-expansion + existing card-UI patterns.

**Tech Stack:** TypeScript, Electron (main/preload/React renderer), Vitest. No new dependencies. Consumes the shipped World Assets layer.

## Global Constraints

- **Test runner:** `npm run test` (= `vitest run`); tests flat in `test/` importing `../src/...`. Also gate with `npm run typecheck` and `npm run check:deps` (module-boundary). Lint warnings (not errors) are tolerated.
- **No new dependencies.**
- **Card content** (panel HTML + patch) lives under `docs/sdk/examples/` (tracked) and is applied to the **gitignored** card at `example sillytarvern character card, presets, extensions and scripts/命定之诗/` — same convention as `patch-poem-card.cjs` / `poem-combat-sheet.html`.
- **Party** = `主角` + every `关系列表[name]` with `在场 === true`.
- **Vital bars are a UI shell** — rendered, NOT data-bound (MVU has no 生命/法力/体力 for companions; no vital-data code this pass).
- **Portraits** via World Assets, mood-aware: `头像` for the strip, `立绘` for the overlay.
- Repo style: 2-space indent, no semicolons.

## File Structure

**Δ2 — WCV World-Assets access:**
- Modify `src/main/services/worldAssetProtocol.ts` — extract a reusable request handler + a pure `parseAssetUrl`.
- Modify `src/main/services/wcvManager.ts` — register `rptasset://` on the `persist:wcv-cards` session.
- Modify `src/main/services/worldAssetService.ts` — add `assetUrlForWorld(...)` (resolve → `rptasset://` URL).
- Modify `src/main/ipc/wcvIpc.ts` — add the `wcv-host-asset-url` handler.
- Modify `src/preload/wcvHost.ts` — add `rpt.assetUrl(...)`.

**Δ1 — auto-dock a card-declared left panel:**
- Modify `src/shared/workspaceLayout.ts` — `injectLeftPanel` + `hasPanelView` pure helpers.
- Modify `src/main/types/character.ts` — `rp_terminal.left_panel` field.
- Modify `src/renderer/src/stores/workspaceStore.ts` (+ a small App hook) — inject when the active card declares it.

**Card content (命定之诗 expansion):**
- Create `docs/sdk/examples/poem-party-panel.html` + `docs/sdk/examples/poem-party-panel.regex.json`.
- Create `docs/sdk/examples/patch-poem-party-panel.cjs`.

**Docs:** Modify `docs/sdk/` (document `left_panel` + `rpt.assetUrl`).

**Tests:** `test/assetUrlParse.test.ts`, `test/assetUrlForWorld.test.ts`, `test/injectLeftPanel.test.ts`.

---

### Task 1: Δ2a — serve `rptasset://` on the WCV session

**Files:**
- Modify: `src/main/services/worldAssetProtocol.ts`
- Modify: `src/main/services/wcvManager.ts`
- Test: `test/assetUrlParse.test.ts`

**Interfaces:**
- Consumes: `resolveProtocolPath` (worldAssetService).
- Produces: `parseAssetUrl(rawUrl: string): { profileId: string; lorebookId: string; category: string; file: string } | null`; `serveAssetRequest(req: { url: string }): Response`; `ASSET_SCHEME`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/assetUrlParse.test.ts
import { describe, it, expect } from 'vitest'
import { parseAssetUrl } from '../src/main/services/worldAssetProtocol'

describe('parseAssetUrl', () => {
  it('parses host=profileId + lorebookId/category/file', () => {
    expect(parseAssetUrl('rptasset://p1/w1/character/' + encodeURIComponent('爱莎_头像.jpg'))).toEqual({
      profileId: 'p1', lorebookId: 'w1', category: 'character', file: encodeURIComponent('爱莎_头像.jpg')
    })
  })
  it('returns null on a missing segment', () => {
    expect(parseAssetUrl('rptasset://p1/w1')).toBeNull()
  })
  it('returns null on an unparseable url', () => {
    expect(parseAssetUrl('not a url')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- assetUrlParse`
Expected: FAIL — `parseAssetUrl` not exported.

- [ ] **Step 3: Refactor `worldAssetProtocol.ts` to expose `parseAssetUrl` + `serveAssetRequest`**

Replace the body of the existing `protocol.handle(ASSET_SCHEME, …)` registration so the parsing + serving are reusable functions, and the registration just calls `serveAssetRequest`:

```typescript
import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { resolveProtocolPath } from './worldAssetService'
import { log } from './logService'

export const ASSET_SCHEME = 'rptasset'

/** Parse rptasset://<profileId>/<lorebookId>/<category>/<file> (file may stay percent-encoded). */
export function parseAssetUrl(
  rawUrl: string
): { profileId: string; lorebookId: string; category: string; file: string } | null {
  try {
    const url = new URL(rawUrl)
    const profileId = url.hostname
    const segs = url.pathname.replace(/^\/+/, '').split('/')
    const [lorebookId, category, ...rest] = segs
    const file = rest.join('/')
    if (!profileId || !lorebookId || !category || !file) return null
    return { profileId, lorebookId, category, file }
  } catch {
    return null
  }
}

/** Resolve + stream an rptasset request, or a 4xx/5xx Response. Read-only; traversal rejected in
 *  resolveProtocolPath. Used by BOTH the default-session and WCV-session registrations. */
export function serveAssetRequest(req: { url: string }): Response {
  try {
    const parsed = parseAssetUrl(req.url)
    if (!parsed) return new Response('Bad Request', { status: 400 })
    const abs = resolveProtocolPath(parsed.profileId, parsed.lorebookId, parsed.category, parsed.file)
    if (!abs) return new Response('Not Found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  } catch (e) {
    log('error', '[world-assets] protocol error', e)
    return new Response('Error', { status: 500 })
  }
}

/** Serve rptasset:// on the DEFAULT session (Asset Manager + inline-iframe card surface). Call after ready. */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (req) => serveAssetRequest(req))
}
```

- [ ] **Step 4: Run the parse test**

Run: `npm run test -- assetUrlParse`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the protocol on the WCV partition session**

In `src/main/services/wcvManager.ts`, import the handler and register it inside `ensureSession()` next to the existing `ses.protocol.handle(CARD_SCHEME, …)`:

```typescript
import { serveAssetRequest, ASSET_SCHEME } from './worldAssetProtocol'
// ... inside ensureSession(), after the CARD_SCHEME handler:
  ses.protocol.handle(ASSET_SCHEME, (req) => serveAssetRequest(req))
```

(`rptasset` is already registered privileged globally in `main/index.ts`, so it's valid on this session; the WCV `CARD_CSP` already allows `img-src *`.)

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck` → no errors. Run: `npm run test` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/worldAssetProtocol.ts src/main/services/wcvManager.ts test/assetUrlParse.test.ts
git commit -m "feat(world-assets): serve rptasset:// on the WCV card session"
```

---

### Task 2: Δ2b — `rpt.assetUrl` bridge

**Files:**
- Modify: `src/main/services/worldAssetService.ts`
- Modify: `src/main/ipc/wcvIpc.ts`
- Modify: `src/preload/wcvHost.ts`
- Test: `test/assetUrlForWorld.test.ts`

**Interfaces:**
- Consumes: `resolveAssetFile` + `assetUrlFor`-style URL building; `wcvManager.contextFor`, `chatService.getChatLorebookIds`.
- Produces: `assetUrlForWorld(profileId: string, lorebookIds: string[], name: string, type: AssetType, mood?: string): string | null` (an `rptasset://` URL or null); IPC `wcv-host-asset-url`; `rpt.assetUrl(name, type, mood?) => Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/assetUrlForWorld.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})
import * as svc from '../src/main/services/worldAssetService'

const charDir = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'character')
const write = (lb: string, file: string): void => {
  fs.mkdirSync(charDir(lb), { recursive: true })
  fs.writeFileSync(path.join(charDir(lb), file), 'img')
}

beforeEach(() => {
  svc.clearAssetCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-aufw-'))
})
afterEach(() => {
  svc.clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('assetUrlForWorld', () => {
  it('builds an rptasset:// URL for a resolved portrait (encoded file)', () => {
    write('w1', '爱莎_头像.jpg')
    expect(svc.assetUrlForWorld('p1', ['w1'], '爱莎', '头像')).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像.jpg')}`
    )
  })
  it('prefers a mood variant', () => {
    write('w1', '爱莎_头像.jpg')
    write('w1', '爱莎_头像_愤怒.png')
    expect(svc.assetUrlForWorld('p1', ['w1'], '爱莎', '头像', '愤怒')).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像_愤怒.png')}`
    )
  })
  it('returns null when no asset resolves', () => {
    expect(svc.assetUrlForWorld('p1', ['w1'], '无名', '头像')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- assetUrlForWorld`
Expected: FAIL — `assetUrlForWorld` not exported.

- [ ] **Step 3: Implement `assetUrlForWorld` in `worldAssetService.ts`**

`resolveAssetFile` already returns `{ lorebookId, absPath, usedMood }`. Add (it returns the category-scoped `rptasset://` URL; category is always `character` for portraits here):

```typescript
import { AssetType, AssetCategory } from '../../shared/worldAssets/types'

/** Resolve a character portrait to an rptasset:// URL for one world's lorebook ids, or null. */
export function assetUrlForWorld(
  profileId: string,
  lorebookIds: string[],
  name: string,
  type: AssetType,
  mood?: string
): string | null {
  const category: AssetCategory = 'character'
  const hit = resolveAssetFile(profileId, lorebookIds, category, name, type, mood)
  if (!hit) return null
  const file = hit.absPath.split(/[\\/]/).pop() as string
  return `rptasset://${profileId}/${hit.lorebookId}/${category}/${encodeURIComponent(file)}`
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test -- assetUrlForWorld`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the `wcv-host-asset-url` IPC handler**

In `src/main/ipc/wcvIpc.ts`, import the service and add a handler inside `registerWcvIpc` (mirrors `wcv-host-chat-worldbook-ids-sync`'s lorebook-id resolution). At the top imports add:

```typescript
import * as worldAssetService from '../services/worldAssetService'
```

Add the handler (near the other `wcv-host-*` reads):

```typescript
  // Resolve a World Assets portrait URL for the calling card's world (rptasset://… or null). Mood-aware.
  ipcMain.handle('wcv-host-asset-url', (e, name, type, mood) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return null
    const ids =
      chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
      (ctx.characterId ? [ctx.characterId] : [])
    return worldAssetService.assetUrlForWorld(ctx.profileId, ids, String(name ?? ''), type, mood)
  })
```

(`chatService` is already imported in this file.)

- [ ] **Step 6: Expose `rpt.assetUrl` in `wcvHost.ts`**

In `src/preload/wcvHost.ts`, add to the `rpt` object (with the other invoke-based methods):

```typescript
    assetUrl: (name: string, type: string, mood?: string) =>
      ipcRenderer.invoke('wcv-host-asset-url', name, type, mood),
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run typecheck` → no errors. Run: `npm run test` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/main/services/worldAssetService.ts src/main/ipc/wcvIpc.ts src/preload/wcvHost.ts test/assetUrlForWorld.test.ts
git commit -m "feat(world-assets): rpt.assetUrl bridge for WCV card panels"
```

---

### Task 3: Δ1a — `injectLeftPanel` layout helper

**Files:**
- Modify: `src/shared/workspaceLayout.ts`
- Test: `test/injectLeftPanel.test.ts`

**Interfaces:**
- Consumes: `WsNode`, `PanelNode`, `SplitNode` from `./workspaceLayout`.
- Produces: `hasPanelView(node: WsNode, view: string): boolean`; `injectLeftPanel(root: WsNode, view: string, key: string, leftPct?: number): WsNode`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/injectLeftPanel.test.ts
import { describe, it, expect } from 'vitest'
import { injectLeftPanel, hasPanelView } from '../src/shared/workspaceLayout'
import type { WsNode } from '../src/shared/workspaceLayout'

const base: WsNode = { type: 'split', dir: 'row', sizes: [50, 50], children: [
  { type: 'panel', key: 'center', view: 'chat' },
  { type: 'panel', key: 'right', view: 'status' }
] }

describe('injectLeftPanel', () => {
  it('wraps the root in a row split with the new panel on the left', () => {
    const out = injectLeftPanel(base, 'regex:party', 'card-left', 14) as any
    expect(out.type).toBe('split')
    expect(out.dir).toBe('row')
    expect(out.sizes).toEqual([14, 86])
    expect(out.children[0]).toEqual({ type: 'panel', key: 'card-left', view: 'regex:party' })
    expect(out.children[1]).toBe(base)
  })
  it('is idempotent — does not add a second panel for the same view', () => {
    const once = injectLeftPanel(base, 'regex:party', 'card-left')
    const twice = injectLeftPanel(once, 'regex:party', 'card-left')
    expect(twice).toBe(once)
  })
})

describe('hasPanelView', () => {
  it('finds a view anywhere in the tree', () => {
    expect(hasPanelView(base, 'status')).toBe(true)
    expect(hasPanelView(base, 'regex:party')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- injectLeftPanel`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement in `workspaceLayout.ts`**

Append:

```typescript
/** True if any panel leaf in the tree hosts `view`. */
export function hasPanelView(node: WsNode, view: string): boolean {
  if (node.type === 'panel') return node.view === view
  return node.children.some((c) => hasPanelView(c, view))
}

/** Wrap `root` in a row split with a new left panel hosting `view`. Idempotent: if `view`
 *  already appears anywhere, returns `root` unchanged (don't double-add on re-seed). */
export function injectLeftPanel(
  root: WsNode,
  view: string,
  key: string,
  leftPct = 14
): WsNode {
  if (hasPanelView(root, view)) return root
  return {
    type: 'split',
    dir: 'row',
    sizes: [leftPct, 100 - leftPct],
    children: [{ type: 'panel', key, view }, root]
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test -- injectLeftPanel`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workspaceLayout.ts test/injectLeftPanel.test.ts
git commit -m "feat(workspace): injectLeftPanel layout helper"
```

---

### Task 4: Δ1b — `left_panel` card field + auto-inject wiring

**Files:**
- Modify: `src/main/types/character.ts`
- Modify: `src/renderer/src/stores/workspaceStore.ts`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `injectLeftPanel`/`hasPanelView` (Task 3); `usePanelRegexStore` (`panels: { file, scriptName, url }[]`, `VIEW_PREFIX`); `useCharacterStore` (`activeCharacter.card.data.extensions.rp_terminal.left_panel`).
- Produces: `rp_terminal.left_panel?: { name: string }` schema field; `workspaceStore.ensureLeftPanel(view: string): void` (injects the left panel into every mode's current layout if absent).

- [ ] **Step 1: Add the schema field**

In `src/main/types/character.ts`, inside the `rp_terminal` object schema (near `panel_ui`), add:

```typescript
    /** A card UI panel (renderMode:'panel', matched by its scriptName) the app auto-docks on the
     *  workspace's left when this card is active. */
    left_panel: z
      .object({ name: z.string() })
      .optional(),
```

- [ ] **Step 2: Write the failing test for the store decision helper**

The injectable decision is pure; test it via `injectLeftPanel` already (Task 3). The store method is thin wiring over `injectLeftPanel`; add `ensureLeftPanel` and verify by typecheck + the Task-3 helper test (no new unit test — it mutates Zustand state from React, consistent with the store's other methods). Proceed to implement.

- [ ] **Step 3: Add `ensureLeftPanel` to `workspaceStore.ts`**

Add to the store (it walks every loaded mode layout and injects the left panel if absent, keyed `card-left`):

```typescript
import { injectLeftPanel } from '../../../shared/workspaceLayout'
// ... in the store object:
  ensureLeftPanel: (view: string) => {
    set((s) => {
      const layouts = { ...s.layouts }
      for (const mode of Object.keys(layouts)) {
        layouts[mode] = { root: injectLeftPanel(layouts[mode].root, view, 'card-left') }
      }
      return { layouts }
    })
  },
```

Add `ensureLeftPanel: (view: string) => void` to the store's TypeScript interface.

- [ ] **Step 4: Wire it in `App.tsx`**

Where the active card + its promoted panels are known, resolve the declared `left_panel.name` to its view id and ensure it's docked. Add this effect (near the existing `usePanelRegexStore().load(...)` effect):

```tsx
  const leftPanelName = activeCharacter?.card?.data?.extensions?.rp_terminal?.left_panel?.name
  const panelRegexes = usePanelRegexStore((s) => s.panels)
  useEffect(() => {
    if (!leftPanelName) return
    const match = panelRegexes.find((p) => p.scriptName === leftPanelName)
    if (match) useWorkspaceStore.getState().ensureLeftPanel(`${VIEW_PREFIX}${match.file}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftPanelName, panelRegexes.map((p) => p.file).join(',')])
```

Import `VIEW_PREFIX` from `'./stores/panelRegexStore'` and `useWorkspaceStore` (already imported) / `usePanelRegexStore`.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck` → no errors. Run: `npm run test` → all green.

- [ ] **Step 6: Manual verification note (record in report)**

Document for the executor: this is verified end-to-end in Task 6 (with the patched card, the panel auto-docks left). At this point, typecheck + suite green is the gate; the renderer wiring is exercised manually once the card content exists.

- [ ] **Step 7: Commit**

```bash
git add src/main/types/character.ts src/renderer/src/stores/workspaceStore.ts src/renderer/src/App.tsx
git commit -m "feat(workspace): auto-dock a card-declared left_panel"
```

---

### Task 5: Card content — the BG3 party-avatar panel HTML

**Files:**
- Create: `docs/sdk/examples/poem-party-panel.html`
- Create: `docs/sdk/examples/poem-party-panel.regex.json`

This is bespoke card UI (HTML/CSS/JS) shipped in the card, rendered in a WCV — **manual-verify**, like `poem-combat-sheet.html`. No app unit tests (it's not app code). Build it to the spec below.

- [ ] **Step 1: Build `poem-party-panel.html`**

A self-contained page (inline CSS + JS) that:

1. **Reads party** from the WCV bridge:

```js
const sd = (window.rpt && window.rpt.statData && window.rpt.statData()) || {}
const hero = sd['主角']
const rel = sd['关系列表'] || {}
const party = [
  hero && { name: hero['姓名'] || hero['名称'] || '主角', data: hero, isHero: true },
  ...Object.entries(rel).filter(([, c]) => c && c['在场'] === true).map(([name, data]) => ({ name, data, isHero: false }))
].filter(Boolean)
```

2. **Strip** (always visible, thin vertical column): for each member a framed mood-aware 头像 + name + a static vital-bar shell. Resolve the portrait:

```js
async function setPortrait(imgEl, name, type) {
  const url = window.rpt && window.rpt.assetUrl ? await window.rpt.assetUrl(name, type) : null
  if (url) imgEl.src = url; else imgEl.replaceWith(placeholderEl(name)) // initial/emblem fallback
}
```

   (Mood: optionally pass the member's current mood as the 3rd arg later; v1 may omit it — base portrait. Keep the call shape `assetUrl(name, type, mood?)`.)

3. **Click a portrait → detail overlay** (absolutely-positioned, dismissable on backdrop/Esc): the member's 立绘 (`assetUrl(name,'立绘')`), an identity line (职业/身份 · 等级 · 生命层级), 好感度 + 性格 (companions, from `data['好感度']`/`data['性格']`), a 状态效果 row (`data['状态效果']` → 类型/层数/剩余时间), and **vital bars as a static shell** (生命/法力/体力 frames with no values bound).

4. **Re-render on host var changes:** listen for the host's broadcast (the WCV shim delivers stat_data updates — reuse whatever event the card's other panels use; e.g. re-read `rpt.statData()` on the same signal `poem-combat-sheet` uses). Degrade gracefully when `rpt`/assets are absent.

5. **Look (BG3, manual-verify):** dark slate panel; gilded/engraved portrait frames (CSS border-image or layered box-shadows); subtle mood tint; RPG-styled vital bars (inset track + sheen, not flat); a status-effect icon row; the overlay as a framed "character sheet" with 立绘 prominent. Use the app theme tokens (`--rpt-*`) for base colors so it tracks the theme; keep the strip ~64–80px wide.

- [ ] **Step 2: Produce `poem-party-panel.regex.json`**

Wrap the HTML as a card regex with `renderMode:'panel'` and a stable `scriptName` (e.g. `命定之诗-队伍面板`) — mirror the structure of `poem-combat-sheet.regex.json` (same fields: find/replace/placement + the rp_terminal renderMode marker). The `scriptName` MUST match what the card's `left_panel.name` will reference (Task 6).

- [ ] **Step 3: Manual verification note (record in report)**

Note that visual verification happens in Task 6 (panel loaded in-app). Here, confirm the HTML is self-contained and the regex JSON is well-formed (valid JSON; `renderMode:'panel'`; `scriptName` set).

- [ ] **Step 4: Commit**

```bash
git add docs/sdk/examples/poem-party-panel.html docs/sdk/examples/poem-party-panel.regex.json
git commit -m "feat(poem): BG3 party-avatar panel card UI (strip + detail overlay)"
```

---

### Task 6: Card content — patch the card to ship + auto-dock the panel

**Files:**
- Create: `docs/sdk/examples/patch-poem-party-panel.cjs`

A Node script (mirror `patch-poem-card.cjs`) that reads the 命定之诗 card PNG (chara_card_v3 embedded JSON), installs the `poem-party-panel.regex.json` into the card's regex scripts, and sets `data.extensions.rp_terminal.left_panel = { name: '命定之诗-队伍面板' }` (matching Task 5's `scriptName`), writing a new `…+party.png`. **Manual-verify** against the gitignored card.

- [ ] **Step 1: Write the patch script**

Follow `patch-poem-card.cjs`'s read/parse/embed/write approach (PNG tEXt `chara` chunk). It must: load `poem-party-panel.regex.json`, append it to the card's `data.extensions.regex_scripts` (or the rp_terminal regex slot, matching how `patch-poem-card.cjs` adds regex), set `rp_terminal.left_panel`, and write the output PNG next to the source.

- [ ] **Step 2: Apply it to the local (gitignored) card**

Run: `node docs/sdk/examples/patch-poem-party-panel.cjs "<path to 命定之诗 v4.2.1+combat.png>" "<out path …+party.png>"`
Expected: writes the patched PNG, logs the installed panel + the `left_panel` declaration.

- [ ] **Step 3: Manual end-to-end verification (record in report)**

With `npm run dev`: import the patched card, open a chat, drop a couple of `character/<name>_头像.jpg` (+ `_立绘`) into the world's `.assets/` (via the Asset Manager's Import/Open-folder). Confirm: the avatar strip **auto-docks on the left**; portraits load (rptasset:// via the WCV session); a missing portrait shows the placeholder; clicking a portrait opens the BG3 detail overlay with 立绘 + identity + 好感度/性格 + 状态效果 + the vital-bar shell; dismiss works. Capture a screenshot or note results.

- [ ] **Step 4: Commit**

```bash
git add docs/sdk/examples/patch-poem-party-panel.cjs
git commit -m "feat(poem): patch script — ship + auto-dock the party-avatar panel"
```

---

### Task 7: Document the SDK deltas

**Files:**
- Modify: `docs/sdk/` (the SDK reference — add to the existing component/API inventory).

- [ ] **Step 1: Document `left_panel` + `rpt.assetUrl`**

Add concise entries to the SDK docs: (a) `rp_terminal.left_panel: { name }` — a card declares a `renderMode:'panel'` UI to auto-dock left (matched by `scriptName`); (b) `rpt.assetUrl(name, type, mood?) → Promise<rptasset://… | null>` — WCV cards resolve World Assets portraits (head/立绘, mood-aware), served on the WCV session. Note the World Assets layer is the prerequisite.

- [ ] **Step 2: Commit**

```bash
git add docs/sdk
git commit -m "docs(sdk): document left_panel + rpt.assetUrl deltas"
```

---

## Self-review notes

- **Spec coverage:** Δ1 auto-dock (Tasks 3–4) ✓; Δ2 WCV asset access (Tasks 1–2) ✓; card content = strip + overlay + all detail + vital shell + BG3 look (Tasks 5–6) ✓; party = 主角 + 在场 (Task 5) ✓; portraits mood-aware head/立绘 (Tasks 2, 5) ✓; docs (Task 7) ✓. Deferred items (relationship graph, companion vitals) are out of scope by design.
- **Vital bars** are explicitly a static shell in Task 5 (no data binding) per the spec.
- **Manual-verify scope:** the protocol/IPC/renderer wiring and the bespoke card HTML are manual-verify (consistent with the existing card-UI + combat-sheet patterns); the pure helpers (`parseAssetUrl`, `assetUrlForWorld`, `injectLeftPanel`) are TDD'd.
- **Plan-grounded binding (from the spec's open item):** a card panel's workspace `ViewId` = `${VIEW_PREFIX}${file}` resolved from `panelRegexStore.panels` by `scriptName` — confirmed in `Panel.tsx`; Task 4 uses exactly that.
- **Type consistency:** `assetUrlForWorld`/`parseAssetUrl`/`injectLeftPanel`/`ensureLeftPanel`/`left_panel.name`/`rpt.assetUrl` names are consistent across tasks.
