# 命定之诗 Party Panel v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 命定之诗 party panel (PR #23) draggable within its panel, fix its dark-on-dark contrast, and switch it to a manual per-chat party — backed by one new general per-chat card KV scope (`type:'chat'`) that is documented in the SDK.

**Architecture:** One small app/SDK delta + card-side changes. App: a per-chat, card-scoped key/value store (`chatCardVarsService`) exposed to card pages as `getVariables({type:'chat'})` / the chat-scoped setters, wired through the `Host` seam + both transports (WCV ctx-scoped IPC; inline `window.api`) — independent of MVU `stat_data` (never schema-stripped). Card: rewrite `poem-party-panel.html` to read the party from that KV (主角 + a manual `party.members` list added from `关系列表`), make the strip a draggable `position:fixed` element clamped to the panel with its position persisted in the KV, and make the gilded palette explicit so text is always legible.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, Zustand, Vitest. Card UI is plain HTML/CSS/JS embedded as a regex `replaceString`, served to a `WebContentsView` as a `data:text/html` URL.

## Global Constraints

- **No new dependencies.** Use existing helpers (`storageService`, the existing IPC/transport patterns).
- **Repo style:** 2-space indent, **no semicolons** in `src/**` TypeScript. Card HTML/JS keeps its existing style (the IIFE in `poem-party-panel.html` uses semicolons — match the file).
- **Module boundaries (enforced by `npm run check:deps`):** `shared/thRuntime` is transport-agnostic; transports (`cardBridge`, `wcvPreload`/`wcvHost`) never import each other; `shared/*` must not import `renderer`/`main`. The new store + IPC are `main`-only; the new `Host` methods live in `shared/thRuntime/types.ts`.
- **i18n:** N/A here — this is **card content** (its own theme + `staticLocale`), not app UI. Do not add app locale keys for the panel's text.
- **Per-chat KV is a GENERAL scope, not party-specific.** It stores arbitrary JSON; the party panel is its first consumer. **Namespace keys** — the panel uses `party.members` and `party.stripPos`.
- **Verify before declaring done:** `npm run typecheck && npm run check:deps && npm run test`.
- **Card UI render is manual-verify** (owner-run; subagents cannot drive the dev Electron app). The automatable check for the card is parse-back of the patched PNG.
- Test runner: `npm run test` (vitest). Filter a file with `npm run test -- <substr>`.

---

### Task 1 (PB1): Per-chat card-vars store service

**Files:**
- Create: `src/main/services/chatCardVarsService.ts`
- Test: `test/chatCardVars.test.ts`

**Interfaces:**
- Consumes: `getAppDir`, `readJsonSync`, `writeJsonSyncAtomic` from `src/main/services/storageService.ts` (signatures: `getAppDir(): string`, `readJsonSync<T>(filePath): T | null`, `writeJsonSyncAtomic(filePath, data): void`).
- Produces:
  - `getChatCardVars(profileId: string, chatId: string): Record<string, any>` — the per-chat KV object (`{}` if absent/corrupt).
  - `setChatCardVars(profileId: string, chatId: string, vars: Record<string, any>): void` — replace that chat's KV object (whole-object semantics).
  - Storage: one per-profile JSON `profiles/<profileId>/chat-card-vars.json` shaped `{ [chatId]: Record<string,any> }`.

- [ ] **Step 1: Write the failing test**

Create `test/chatCardVars.test.ts`. The test suite aliases `electron` so `getAppDir()` resolves under a temp dir (see other `*Service` tests, e.g. `test/` that import storageService). Mirror that setup — read an existing service test to copy the `getAppDir`/temp-dir boilerplate exactly.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getChatCardVars, setChatCardVars } from '../src/main/services/chatCardVarsService'

const P = 'profA'

describe('chatCardVarsService', () => {
  it('returns {} for an unknown chat', () => {
    expect(getChatCardVars(P, 'no-such-chat')).toEqual({})
  })

  it('round-trips a per-chat KV object', () => {
    setChatCardVars(P, 'chat1', { 'party.members': ['爱莎', '凯尔'], 'party.stripPos': { x: 12, y: 30 } })
    expect(getChatCardVars(P, 'chat1')).toEqual({
      'party.members': ['爱莎', '凯尔'],
      'party.stripPos': { x: 12, y: 30 }
    })
  })

  it('isolates chats from each other', () => {
    setChatCardVars(P, 'chatA', { 'party.members': ['甲'] })
    setChatCardVars(P, 'chatB', { 'party.members': ['乙'] })
    expect(getChatCardVars(P, 'chatA')).toEqual({ 'party.members': ['甲'] })
    expect(getChatCardVars(P, 'chatB')).toEqual({ 'party.members': ['乙'] })
  })

  it('replaces (not merges) a chat KV on set', () => {
    setChatCardVars(P, 'chatC', { a: 1, b: 2 })
    setChatCardVars(P, 'chatC', { a: 9 })
    expect(getChatCardVars(P, 'chatC')).toEqual({ a: 9 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- chatCardVars`
Expected: FAIL (`Cannot find module '../src/main/services/chatCardVarsService'`).

- [ ] **Step 3: Write the implementation**

Create `src/main/services/chatCardVarsService.ts` (mirror `templateService`'s `loadGlobals`/`saveGlobals`):

```ts
// Per-chat, card-scoped key/value store (TavernHelper getVariables({type:'chat'})). A general bag for any
// card's per-session UI state — NOT MVU stat_data (never schema-validated/stripped). One per-profile JSON
// keyed by chatId; whole-object set semantics. Cards must namespace their keys (e.g. party.members).
import path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'

type AllChats = Record<string, Record<string, any>>

const filePath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chat-card-vars.json')

const loadAll = (profileId: string): AllChats =>
  readJsonSync<AllChats>(filePath(profileId)) || {}

export const getChatCardVars = (profileId: string, chatId: string): Record<string, any> => {
  const all = loadAll(profileId)
  const v = all[chatId]
  return v && typeof v === 'object' ? v : {}
}

export const setChatCardVars = (
  profileId: string,
  chatId: string,
  vars: Record<string, any>
): void => {
  try {
    const all = loadAll(profileId)
    all[chatId] = vars && typeof vars === 'object' ? vars : {}
    writeJsonSyncAtomic(filePath(profileId), all)
  } catch {
    /* non-fatal — UI state */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- chatCardVars`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/chatCardVarsService.ts test/chatCardVars.test.ts
git commit -m "feat(cardvars): per-chat card-scoped KV store (chatCardVarsService)"
```

---

### Task 2 (PB2): Expose `type:'chat'` through the Host seam + runtime

**Files:**
- Modify: `src/shared/thRuntime/types.ts` (the `Host` interface, near the `getScriptVars`/`setScriptVars` methods)
- Modify: `src/shared/thRuntime/index.ts` (`getVariables` ~line 253; `replaceVariables` ~line 347; `updateVariablesWith` ~line 353)
- Test: `test/thRuntimeChatVars.test.ts`

**Interfaces:**
- Consumes: nothing new (only the new `Host` methods it defines here).
- Produces (new `Host` methods both transports must implement in PB3):
  - `getChatVars(): Record<string, any>` — SYNC (called without await), like `getScriptVars`.
  - `setChatVars(vars: Record<string, any>): Promise<void>` — whole-object persist, like `setScriptVars`.
- Produces (card-page API, used by PB5):
  - `getVariables({ type: 'chat' })` → `host.getChatVars()`
  - `updateVariablesWith(updater, { type: 'chat' })` → read-modify-write the chat KV (no clobber); returns the next object
  - `replaceVariables(obj, { type: 'chat' })` → full replace of the chat KV

- [ ] **Step 1: Write the failing test**

Create `test/thRuntimeChatVars.test.ts` (mirror `test/thRuntimeAssetUrl.test.ts`'s fake-Host):

```ts
import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'

function fakeHost(over = {}) {
  let chat: Record<string, any> = { 'party.members': ['爱莎'] }
  return {
    statData: () => ({}),
    onVarsChanged: () => () => {},
    onHostEvent: () => () => {},
    floors: () => [],
    charData: () => null,
    personaName: () => 'User',
    listWorldbooks: () => [],
    getChatVars: vi.fn(() => chat),
    setChatVars: vi.fn(async (v: Record<string, any>) => {
      chat = v
    }),
    ...over
  } as any
}

describe('createThRuntime — type:chat per-chat KV', () => {
  it('getVariables({type:chat}) returns host.getChatVars()', () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    expect(g.getVariables({ type: 'chat' })).toEqual({ 'party.members': ['爱莎'] })
    expect(host.getChatVars).toHaveBeenCalled()
  })

  it('updateVariablesWith(updater,{type:chat}) read-modify-writes via setChatVars', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    const next = await g.updateVariablesWith(
      (v: any) => ({ ...v, 'party.members': [...(v['party.members'] || []), '凯尔'] }),
      { type: 'chat' }
    )
    expect(next).toEqual({ 'party.members': ['爱莎', '凯尔'] })
    expect(host.setChatVars).toHaveBeenCalledWith({ 'party.members': ['爱莎', '凯尔'] })
  })

  it('replaceVariables(obj,{type:chat}) full-replaces via setChatVars and does NOT touch stat_data', async () => {
    const applyVariableOps = vi.fn(async () => {})
    const host = fakeHost({ applyVariableOps })
    const g = createThRuntime(host)
    await g.replaceVariables({ 'party.stripPos': { x: 5, y: 5 } }, { type: 'chat' })
    expect(host.setChatVars).toHaveBeenCalledWith({ 'party.stripPos': { x: 5, y: 5 } })
    expect(applyVariableOps).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- thRuntimeChatVars`
Expected: FAIL (`getVariables({type:'chat'})` returns `{ stat_data: {} }`, not the chat KV; `setChatVars` not called).

- [ ] **Step 3a: Add the Host methods**

In `src/shared/thRuntime/types.ts`, right after the `getScriptVars()` line (the SYNC getters block) add:

```ts
  // Chat-scope variables (TH getVariables({type:'chat'})) — a per-chat card-owned KV, NOT stat_data.
  getChatVars(): Record<string, any>
```

and right after the `setScriptVars(...)` line (the async ops block) add:

```ts
  // Persist the per-chat KV (the full object; mirrors updateVariablesWith({type:'chat'}) returning all).
  setChatVars(vars: Record<string, any>): Promise<void>
```

- [ ] **Step 3b: Wire the runtime**

In `src/shared/thRuntime/index.ts`:

`getVariables` (~line 253) — add the `chat` branch:

```ts
    getVariables: (opt?: any) =>
      opt && opt.type === 'script'
        ? host.getScriptVars()
        : opt && opt.type === 'chat'
          ? host.getChatVars()
          : { stat_data: stat },
```

`replaceVariables` (~line 347) — add an `opt` param + the `chat` branch at the top:

```ts
    replaceVariables: async (vars: any, opt?: any) => {
      if (opt && opt.type === 'chat') {
        await host.setChatVars(vars && typeof vars === 'object' ? vars : {})
        return
      }
      const next = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
    },
```

`updateVariablesWith` (~line 353) — add a `chat` branch mirroring the existing `script` branch (right after the `if (opt && opt.type === 'script') { … }` block):

```ts
      if (opt && opt.type === 'chat') {
        const cur = clone(host.getChatVars()) || {}
        const next = (await updater(cur)) || cur
        await host.setChatVars(next)
        return next
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- thRuntimeChatVars`
Expected: PASS (3 tests).

- [ ] **Step 5: Run typecheck (the Host interface gained methods)**

Run: `npm run typecheck`
Expected: FAIL — `createWcvHost` and `createInlineHost` don't yet implement `getChatVars`/`setChatVars` (that's PB3). This is expected; do NOT fix it here. (If you prefer green-at-each-step, you may do PB3 before committing PB2 — but commit them as the two separate commits below.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/thRuntime/types.ts src/shared/thRuntime/index.ts test/thRuntimeChatVars.test.ts
git commit -m "feat(thRuntime): expose per-chat KV via getVariables/updateVariablesWith/replaceVariables type:'chat'"
```

---

### Task 3 (PB3): Wire both transports + IPC + preload

**Files:**
- Modify: `src/preload/wcvHost.ts` (WCV transport — add `getChatVars`/`setChatVars`)
- Modify: `src/renderer/src/cardBridge/host.ts` (inline transport — add `getChatVars` cache + `setChatVars`)
- Modify: `src/main/ipc/wcvIpc.ts` (add `wcv-host-chat-vars-get-sync` + `wcv-host-chat-vars-set`)
- Create: `src/main/ipc/chatCardVarsIpc.ts` (generic `chat-card-vars-get`/`-set` for the inline transport)
- Modify: `src/main/ipc/index.ts` (register the new IPC)
- Modify: `src/preload/index.ts` (`window.api.chatCardVarsGet` / `chatCardVarsSet`)

**Interfaces:**
- Consumes: `getChatCardVars`/`setChatCardVars` (PB1); the `Host` methods (PB2); `wcvManager.contextFor(senderId)` → `{ profileId, chatId, characterId }`.
- Produces: both transports implement the `Host` `getChatVars`/`setChatVars`; `window.api.chatCardVarsGet(profileId, chatId)` / `chatCardVarsSet(profileId, chatId, vars)`.

- [ ] **Step 1: WCV transport (`src/preload/wcvHost.ts`)**

Add `getChatVars` in the SYNC getters block (next to `getScriptVars`, ~line 75):

```ts
    getChatVars: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-chat-vars-get-sync') || {}
      } catch {
        return {}
      }
    },
```

Add `setChatVars` in the async ops block (next to `setScriptVars`, ~line 86):

```ts
    setChatVars: (vars) => ipcRenderer.invoke('wcv-host-chat-vars-set', vars),
```

- [ ] **Step 2: WCV IPC handlers (`src/main/ipc/wcvIpc.ts`)**

Import the service near the other service imports at the top of the file:

```ts
import { getChatCardVars, setChatCardVars } from '../services/chatCardVarsService'
```

Add these two handlers next to the script-vars handlers (~line 405-427), mirroring their ctx pattern (`wcvManager.contextFor(e.sender.id)`):

```ts
  // Chat-scope vars (getVariables({type:'chat'})) — a per-chat card-owned KV, NOT stat_data. SYNC read.
  ipcMain.on('wcv-host-chat-vars-get-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx ? getChatCardVars(ctx.profileId, ctx.chatId) : {}
  })
  // Persist the whole per-chat KV object (replaceVariables / updateVariablesWith with type:'chat').
  ipcMain.handle('wcv-host-chat-vars-set', (e, vars) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    setChatCardVars(ctx.profileId, ctx.chatId, vars && typeof vars === 'object' ? vars : {})
    return true
  })
```

- [ ] **Step 3: Generic IPC for the inline transport (`src/main/ipc/chatCardVarsIpc.ts`)**

Create the file (mirror the small registration style of other `ipc/*.ts`):

```ts
import { ipcMain } from 'electron'
import { getChatCardVars, setChatCardVars } from '../services/chatCardVarsService'

// Per-chat card KV for the INLINE transport (the renderer passes profileId+chatId explicitly; the WCV
// transport resolves them from e.sender in wcvIpc).
export function registerChatCardVarsIpc(): void {
  ipcMain.handle('chat-card-vars-get', (_e, profileId: string, chatId: string) =>
    getChatCardVars(String(profileId), String(chatId))
  )
  ipcMain.handle('chat-card-vars-set', (_e, profileId: string, chatId: string, vars: any) => {
    setChatCardVars(String(profileId), String(chatId), vars && typeof vars === 'object' ? vars : {})
    return true
  })
}
```

Register it in `src/main/ipc/index.ts` — add the import alongside the others and call `registerChatCardVarsIpc()` where the other `register*Ipc()` calls are (e.g. next to `registerWorldAssetIpc()`):

```ts
import { registerChatCardVarsIpc } from './chatCardVarsIpc'
// …
  registerChatCardVarsIpc()
```

- [ ] **Step 4: Preload `window.api` (`src/preload/index.ts`)**

Add to the `api` object next to the World Assets methods (~line 320):

```ts
  // Per-chat card KV (inline transport): general scope, getVariables({type:'chat'}).
  chatCardVarsGet: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('chat-card-vars-get', profileId, chatId),
  chatCardVarsSet: (profileId: string, chatId: string, vars: Record<string, any>) =>
    ipcRenderer.invoke('chat-card-vars-set', profileId, chatId, vars),
```

(`window.api` is typed `any` in `src/preload/index.d.ts`, so no `.d.ts` change is needed.)

- [ ] **Step 5: Inline transport (`src/renderer/src/cardBridge/host.ts`)**

Mirror the `scriptVarCache` pattern (it backs the SYNC `getScriptVars`). After the existing `scriptVarCache` hydration block (~line 60-66), add a chat-vars cache:

```ts
  // Chat-scope vars (getVariables({type:'chat'})) — a per-chat card-owned KV. getChatVars must be SYNC, so
  // back it with a cache hydrated async from the same per-chat store the WCV transport reads.
  let chatVarCache: Record<string, any> = {}
  if (ctx.chatId)
    void window.api
      .chatCardVarsGet(ctx.profileId, ctx.chatId)
      .then((all: any) => {
        chatVarCache = all || {}
      })
      .catch(() => {})
```

Add `getChatVars` next to `getScriptVars` (~line 95):

```ts
    getChatVars: () => chatVarCache,
```

Add `setChatVars` next to `setScriptVars` (~line 144):

```ts
    setChatVars: async (vars: Record<string, any>) => {
      const next = vars && typeof vars === 'object' ? vars : {}
      chatVarCache = next
      try {
        if (ctx.chatId) await window.api.chatCardVarsSet(ctx.profileId, ctx.chatId, next)
      } catch (e) {
        console.error('[inline setChatVars]', e)
      }
    },
```

- [ ] **Step 6: Verify the whole delta builds + passes**

Run: `npm run typecheck`
Expected: PASS (both transports now satisfy `Host`).

Run: `npm run check:deps`
Expected: PASS (no boundary violations — store + IPC are main-only).

Run: `npm run test`
Expected: PASS (full suite, including PB1 + PB2 tests; no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/preload/wcvHost.ts src/renderer/src/cardBridge/host.ts src/main/ipc/wcvIpc.ts src/main/ipc/chatCardVarsIpc.ts src/main/ipc/index.ts src/preload/index.ts
git commit -m "feat(cardvars): wire per-chat KV through both transports + IPC + preload"
```

---

### Task 4 (PB4): Document the `type:'chat'` scope in the SDK

**Files:**
- Modify: `docs/sdk/component-inventory.md` (add the scope next to the existing variable-scope docs)
- Modify: `docs/rpt-api.md` (add the scope to the variables API)

**Interfaces:** none (docs only). Content comes from the spec's **Contract** section
(`docs/superpowers/specs/2026-06-27-poem-party-panel-v2-design.md`).

- [ ] **Step 1: Locate where the variable scopes are documented**

Run: `grep -rnE "type:.?'script'|getVariables|variable scope|script-scope" docs/sdk/component-inventory.md docs/rpt-api.md`
Use the matches to find the section that lists `message`/`script`/`global` scopes; add `chat` alongside them (same format).

- [ ] **Step 2: Write the contract entry**

Add a `chat` scope entry to both files using this content (adapt prose to each file's surrounding style):

```markdown
### `type:'chat'` — per-chat card KV (general, app-managed)

A per-**chat/session**, card-scoped key/value store. Survives app restarts for that chat. A **general
scope** for any card's per-session UI/state — its first consumer is the 命定之诗 party panel.

- **Read:** `getVariables({ type: 'chat' })` → an arbitrary JSON object.
- **Write (recommended, no-clobber):** `updateVariablesWith(prev => ({ ...prev, 'feat.key': v }), { type: 'chat' })`.
- **Write (full replace):** `replaceVariables(obj, { type: 'chat' })`.
- **Shared bag — namespace your keys** (e.g. `party.members`, `party.stripPos`) so multiple widgets in
  the same chat don't collide.
- **NOT MVU `stat_data`:** not AI-authored, not sent to the model, not validated/stripped by the card's
  `data_schema`. Use `type:'chat'` for UI/session state; use `stat_data` (`type:'message'`) for story state.

| scope | persistence | written by | in prompt? |
|-------|-------------|-----------|-----------|
| `message`/`stat_data` | per-chat | AI (MVU) + card | yes |
| `script` | per-**card** (all its chats) | card | no |
| `global` | per-**profile** | card | no |
| `chat` | per-**chat** | card | no |

Backed by `chatCardVarsService` (`profiles/<profileId>/chat-card-vars.json`), exposed via the `Host`
(`getChatVars`/`setChatVars`) and both transports.
```

- [ ] **Step 3: Verify the docs reference real symbols**

Run: `grep -rnE "getChatVars|chatCardVarsService|type: 'chat'|type:'chat'" docs/sdk/component-inventory.md docs/rpt-api.md src/shared/thRuntime`
Expected: the doc symbols match the code added in PB1-PB3.

- [ ] **Step 4: Commit**

```bash
git add docs/sdk/component-inventory.md docs/rpt-api.md
git commit -m "docs(sdk): document the type:'chat' per-chat card KV scope + contract"
```

---

### Task 5 (PB5): Rewrite the party panel (membership + drag + contrast) and re-ship

**Files:**
- Modify: `docs/sdk/examples/poem-party-panel.html`
- Modify: `docs/sdk/examples/poem-party-panel.regex.json` (regenerated `replaceString`)
- Run (no edit expected): `docs/sdk/examples/patch-poem-party-panel.cjs`

**Interfaces:**
- Consumes (card-page API from PB2): `getVariables({ type: 'chat' })`, `updateVariablesWith(updater, { type: 'chat' })`, plus the existing `getVariables().stat_data` and `window.assetUrl`.
- Produces: the panel reads `party.members` / `party.stripPos` from the per-chat KV; ships in `…+party.png`.

This is **card content** — verified by parse-back of the patched PNG + the owner's in-app manual test. Keep the file's existing JS style (semicolons, `var`, IIFE).

- [ ] **Step 1: Membership — read the per-chat party, drop "在场"**

In `poem-party-panel.html`'s script, add a SYNC reader for the chat KV and rewrite `buildParty` to use a manual list. Replace the current `buildParty(SD)` (lines ~798-816) with:

```js
    /* per-chat card KV (getVariables({type:'chat'})) — SYNC in both transports */
    function chatKV() {
      try {
        var v = typeof getVariables === 'function' ? getVariables({ type: 'chat' }) : {}
        return v && typeof v === 'object' && typeof v.then !== 'function' ? v : {}
      } catch (_) { return {} }
    }
    function partyMembers() {
      var m = chatKV()['party.members']
      return Array.isArray(m) ? m : []
    }

    /* party = 主角 (always) + the manual party.members list (NOT 关系列表-在场) */
    function buildParty(SD) {
      var hero = SD['主角'] || null
      var rel  = SD['关系列表'] || {}
      var party = []
      if (hero) {
        party.push({ name: hero['姓名'] || hero['名称'] || '主角', data: hero, isHero: true })
      }
      partyMembers().forEach(function (n) {
        party.push({ name: n, data: rel[n] || {}, isHero: false })
      })
      return party
    }
```

- [ ] **Step 2: Manage UI — add/remove from known NPCs**

Add a "管理队伍" control at the bottom of the strip and a picker that reuses the overlay. Add a persist helper (read-modify-write so `party.stripPos` is never clobbered) and a `showManage()`:

```js
    /* persist a single chat-KV key without clobbering siblings */
    function setKV(key, value) {
      try {
        if (typeof updateVariablesWith === 'function') {
          var obj = {}; obj[key] = value
          return updateVariablesWith(function (prev) {
            var next = prev && typeof prev === 'object' ? prev : {}
            next[key] = value
            return next
          }, { type: 'chat' })
        }
      } catch (_) {}
      return Promise.resolve()
    }

    function setParty(members) {
      return setKV('party.members', members).then(refresh)
    }

    /* manage overlay: every known NPC (关系列表 keys) with a toggle; checked = in party */
    function showManage() {
      gv().then(function (SD) {
        var rel = SD['关系列表'] || {}
        var inParty = partyMembers()
        var names = Object.keys(rel)
        var rows = names.length
          ? names.map(function (n) {
              var on = inParty.indexOf(n) >= 0
              return (
                '<label class="poem-pp-mg-row">' +
                '<input type="checkbox" data-name="' + esc(n) + '"' + (on ? ' checked' : '') + '>' +
                '<span>' + esc(n) + '</span></label>'
              )
            }).join('')
          : '<div class="poem-pp-empty">暂无已知角色（关系列表为空）</div>'
        bodyEl.innerHTML =
          '<div class="poem-pp-ow-sect" style="margin:4px 0 10px">管理队伍</div>' +
          '<div class="poem-pp-mg-list">' + rows + '</div>'
        openOverlay()
        var boxes = bodyEl.querySelectorAll('input[type=checkbox]')
        Array.prototype.forEach.call(boxes, function (b) {
          b.addEventListener('change', function () {
            var cur = partyMembers().slice()
            var nm = b.getAttribute('data-name')
            var i = cur.indexOf(nm)
            if (b.checked && i < 0) cur.push(nm)
            if (!b.checked && i >= 0) cur.splice(i, 1)
            setParty(cur)
          })
        })
      })
    }
```

In `renderStrip(party)`, after the `party.forEach(...)` loop (before the function returns, ~line 794), append the manage button:

```js
      var mgBtn = document.createElement('div')
      mgBtn.className = 'poem-pp-manage'
      mgBtn.textContent = '＋ 管理队伍'
      mgBtn.title = '从已知角色添加/移除队员'
      mgBtn.addEventListener('click', showManage)
      stripEl.appendChild(mgBtn)
```

And change the empty-party case in `renderStrip` (lines ~713-716) so the manage button still shows when only 主角 is present (it won't be empty because 主角 is always pushed; but keep the guard tolerant):

```js
      if (!party.length) {
        stripEl.innerHTML = '<div class="poem-pp-loading">无队员</div>'
        // fall through is not used; manage button is appended below in the normal path
      }
```

(Leave the normal path to render members + the manage button.)

- [ ] **Step 3: Draggable strip — fixed within the panel, clamped, persisted**

Make the strip `position: fixed` and add a drag handle. In the `<style>`, change `.poem-pp-strip` to be positioned and add handle + manage styles (append near the strip styles, ~line 66):

```css
  .poem-pp-strip {
    position: fixed;
    left: 8px;
    top: 8px;
    z-index: 50;
  }
  .poem-pp-drag {
    width: 100%;
    height: 14px;
    margin-bottom: 4px;
    cursor: grab;
    border-radius: 4px;
    background: linear-gradient(90deg, transparent, rgba(201,168,76,.5), transparent);
    flex-shrink: 0;
  }
  .poem-pp-drag:active { cursor: grabbing; }
  .poem-pp-manage {
    margin-top: 8px;
    font-size: 10px;
    color: #c8a87a;
    border: 1px solid #5a412a;
    border-radius: 4px;
    padding: 3px 4px;
    text-align: center;
    cursor: pointer;
    width: 58px;
  }
  .poem-pp-manage:hover { color: #f4e3c8; border-color: #7a5e2a; }
  .poem-pp-mg-list { display: flex; flex-direction: column; gap: 6px; }
  .poem-pp-mg-row { display: flex; align-items: center; gap: 8px; color: #f4e3c8; font-size: 13px; cursor: pointer; }
```

> Keep these CSS rules merged with the existing `.poem-pp-strip` block (don't create a duplicate selector that drops the existing gradient/border — add the four new props to the existing rule).

In the script, add a drag handle element at the top of the strip and restore/persist position. At the start of `renderStrip` after `stripEl.innerHTML = ''` (~line 719), insert the handle and restore the saved position:

```js
      var handle = document.createElement('div')
      handle.className = 'poem-pp-drag'
      handle.title = '拖动'
      stripEl.appendChild(handle)
      applyStripPos()
      enableDrag(handle)
```

Add these helpers inside the IIFE (above `renderStrip`):

```js
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
    function applyStripPos() {
      var p = chatKV()['party.stripPos']
      var w = stripEl.offsetWidth || 76, h = stripEl.offsetHeight || 120
      var x = p && typeof p.x === 'number' ? p.x : 8
      var y = p && typeof p.y === 'number' ? p.y : 8
      stripEl.style.left = clamp(x, 0, Math.max(0, window.innerWidth - w)) + 'px'
      stripEl.style.top  = clamp(y, 0, Math.max(0, window.innerHeight - h)) + 'px'
    }
    function enableDrag(handle) {
      var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false
      function down(e) {
        dragging = true
        sx = e.clientX; sy = e.clientY
        ox = parseInt(stripEl.style.left || '8', 10)
        oy = parseInt(stripEl.style.top || '8', 10)
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
        e.preventDefault()
      }
      function move(e) {
        if (!dragging) return
        var w = stripEl.offsetWidth, h = stripEl.offsetHeight
        var nx = clamp(ox + (e.clientX - sx), 0, Math.max(0, window.innerWidth - w))
        var ny = clamp(oy + (e.clientY - sy), 0, Math.max(0, window.innerHeight - h))
        stripEl.style.left = nx + 'px'
        stripEl.style.top = ny + 'px'
      }
      function up() {
        dragging = false
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        setKV('party.stripPos', {
          x: parseInt(stripEl.style.left || '8', 10),
          y: parseInt(stripEl.style.top || '8', 10)
        })
      }
      handle.addEventListener('pointerdown', down)
    }
```

- [ ] **Step 4: Contrast fix — make the gilded palette explicit**

The panel renders in an isolated `data:` document; relying on `var(--rpt-text-*, …)` is what lets a dark inherited token produce dark-on-dark. Make the text/border/bg tokens **explicit** (use the existing fallback values as the values). In the `.poem-pp` token block (lines ~28-44), replace each `var(--rpt-…, #hex)` with just `#hex`:

```css
  .poem-pp {
    --bg:        #18140f;
    --card:      #251c14;
    --border:    #5a412a;
    --window:    #130f0a;
    --gold:      #c9a84c;
    --gold-hi:   #e8cc6e;
    --gold-lo:   #7a5e2a;
    --t1:        #f4e3c8;
    --t2:        #c8a87a;
    --t3:        #8a6e52;
    --hp:        #b73a2b;
    --mp:        #2d5aa0;
    --sp:        #3b7f52;
    --hero-ring: #e8cc6e;
    --comp-ring: #8a9fc8;
    --overlay-bg:#0d0a07ee;
    font-family: 'Noto Sans SC', 'Noto Serif SC', serif;
    display: block;
    position: relative;
  }
```

- [ ] **Step 5: Regenerate the regex.json from the HTML**

There is no separate generator — `poem-party-panel.regex.json` embeds the HTML as `replaceString`. Sync it:

Run:
```bash
node -e "const fs=require('fs');const p='docs/sdk/examples/';const j=JSON.parse(fs.readFileSync(p+'poem-party-panel.regex.json','utf8'));j.replaceString=fs.readFileSync(p+'poem-party-panel.html','utf8');fs.writeFileSync(p+'poem-party-panel.regex.json',JSON.stringify(j,null,2)+'\n');console.log('synced replaceString:',j.replaceString.length,'chars')"
```
Expected: prints a char count larger than 23531 (the v1 size).

- [ ] **Step 6: Re-run the patch + parse-back verify**

The 命定之诗 card is gitignored, only in the MAIN checkout. Run the patch (defaults read `v4.2.1+combat.png`, write `v4.2.1+combat+party.png` in that folder):

Run:
```bash
node docs/sdk/examples/patch-poem-party-panel.cjs
```
Expected: `patched 2 chunk(s) -> …v4.2.1+combat+party.png` + the install log.

Parse-back verify the OUTPUT PNG:
```bash
node -e "const fs=require('fs');const path=require('path');const ROOT=process.cwd();const f=path.join(ROOT,'example sillytarvern character card, presets, extensions and scripts','命定之诗','v4.2.1+combat+party.png');const b=fs.readFileSync(f);let o=8;while(o<b.length){const L=b.readUInt32BE(o),T=b.toString('ascii',o+4,o+8);if(T==='tEXt'){const d=b.slice(o+8,o+8+L);const z=d.indexOf(0);const kw=d.slice(0,z).toString('latin1');if(kw==='chara'){const c=JSON.parse(Buffer.from(d.slice(z+1).toString('latin1'),'base64').toString('utf8'));const r=(c.data.extensions.regex_scripts||[]).find(s=>s&&s.scriptName==='命定之诗-队伍面板');console.log('regex present:',!!r);console.log('renderMode:',r&&r.renderMode);console.log('has chat-KV read:',!!r&&r.replaceString.indexOf(\"type: 'chat'\")>=0);console.log('has manage UI:',!!r&&r.replaceString.indexOf('管理队伍')>=0);console.log('left_panel:',c.data.extensions.rp_terminal&&c.data.extensions.rp_terminal.left_panel&&c.data.extensions.rp_terminal.left_panel.name);break;}}o+=12+L;if(T==='IEND')break;}"
```
Expected output:
```
regex present: true
renderMode: panel
has chat-KV read: true
has manage UI: true
left_panel: 命定之诗-队伍面板
```

- [ ] **Step 7: Full verification**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: all green (this task changed no `src/**`; confirms PB1-PB3 still green).

- [ ] **Step 8: Commit (HTML + regex.json only — the generated PNG is gitignored)**

```bash
git add docs/sdk/examples/poem-party-panel.html docs/sdk/examples/poem-party-panel.regex.json
git commit -m "feat(poem): party panel v2 — draggable strip, manual per-chat party, contrast fix"
```

- [ ] **Step 9: Record the owner manual-test steps in the SDD ledger / report**

The in-app render is the owner's manual test. Document these steps (do not attempt the GUI yourself):
1. Re-import `…\命定之诗\v4.2.1+combat+party.png` (overwrites the card); open a chat.
2. The panel docks left. Text is legible (cream-on-dark). The strip shows **only 主角** initially.
3. Click **＋ 管理队伍** → toggle known NPCs → they appear/disappear in the strip (persists across reopen of the chat; a *different* chat has its own party).
4. Drag the strip by its gold handle — it moves, stays within the panel, and keeps its position after a re-render.
5. Click a portrait → BG3 detail overlay (vitals still an unbound shell). Portraits load if `<name>_头像/立绘` assets exist for the world.

---

## Self-Review

**Spec coverage:**
- Draggable strip (clamped, per-chat-persisted) → PB5 Step 3. ✓
- Contrast fix → PB5 Step 4. ✓
- Manual per-chat membership (主角 + `party.members`, add from `关系列表`) → PB5 Steps 1-2. ✓
- Per-chat KV app delta (store + Host + runtime + transports + IPC + preload) → PB1, PB2, PB3. ✓
- General/extensible + namespaced keys → PB2 (generic `Record<string,any>`), PB5 (`party.*` keys). ✓
- SDK-documented contract → PB4. ✓
- Tests: store (PB1), runtime (PB2); wiring via typecheck/check:deps/suite (PB3); card via parse-back (PB5). ✓

**Type consistency:** `getChatVars()`/`setChatVars()` named identically across types.ts (PB2), wcvHost.ts + cardBridge/host.ts (PB3). Runtime methods `getVariables`/`updateVariablesWith`/`replaceVariables` match the existing signatures (added an optional `opt`/second arg). IPC channels: `wcv-host-chat-vars-get-sync` / `wcv-host-chat-vars-set` (WCV) and `chat-card-vars-get` / `chat-card-vars-set` (generic) — used consistently in handlers + transports + preload. Card keys `party.members` / `party.stripPos` consistent across PB5 + PB4 docs.

**Placeholder scan:** none — every code/command step has concrete content.
