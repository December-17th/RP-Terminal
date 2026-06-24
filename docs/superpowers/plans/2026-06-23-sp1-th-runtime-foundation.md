# SP1 — Unified TH Runtime Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the two card-API shims (`cardBridge` inline + `wcvPreload` WCV) into one clean-room `shared/thRuntime` behind a `Host` interface, so the TavernHelper/Mvu/SillyTavern/EjsTemplate surface is implemented once and both transports become thin adapters.

**Architecture:** A realm-agnostic `createThRuntime(host)` builds the whole globals bag from an abstract `Host` (sync getters + async ops + events + `evalTemplate`). `cardBridge` provides a renderer `Host` (Zustand + `window.api`); `wcvPreload` provides a preload `Host` (`ipcRenderer.sendSync`/`invoke`). Drifted functions converge to one canonical, service-backed behavior (chat-message mapping, worldbook). Strangler migration keeps the app green at each step.

**Tech Stack:** TypeScript (strict), Vitest, electron-vite (renderer + preload rollup builds), Zustand, quickjs EJS engine (per-transport).

**Spec:** [docs/superpowers/specs/2026-06-23-sp1-th-runtime-foundation.md](../specs/2026-06-23-sp1-th-runtime-foundation.md)

## Global Constraints

- Prettier: **no semicolons, single quotes, 2-space indent, printWidth 100, no trailing commas**.
- `any` is intentional at the card boundary (repo disables `@typescript-eslint/no-explicit-any`).
- `src/shared/thRuntime/**` imports **nothing realm-specific** (no `electron`, `window`, Zustand, `fs`, no quickjs variant) — only its own modules/types.
- Clean-room: never copy/vendor JSR source.
- Run `npm run typecheck`, `npm test`, `npm run build` before each task's commit; no new lint errors.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Create `src/shared/thRuntime/ops.ts` — pure JSON-Patch op builders (moved from `cardBridge/ops.ts`).
- Create `src/shared/thRuntime/types.ts` — `Host`, `CardCtx`, `ThMessage`, `StMessage`, `FloorLike`, `GenCfgNormalized`, `ThGlobals`.
- Create `src/shared/thRuntime/shapes.ts` — pure `floorsToThMessages`, `floorsToStChat`, `currentMessageId`.
- Create `src/shared/thRuntime/index.ts` — `createThRuntime(host): ThGlobals`.
- Create `src/renderer/src/cardBridge/host.ts` — `createInlineHost(ctx): Host`.
- Create `src/preload/wcvHost.ts` — `createWcvHost(): Host`.
- Modify `src/renderer/src/cardBridge/createCardBridge.ts` — collapse to `createThRuntime(createInlineHost(ctx))`.
- Modify `src/renderer/src/cardBridge/ops.ts` — re-export from the shared module (keep existing import paths working).
- Modify `src/preload/wcvPreload.ts` — replace the surface bag with `createThRuntime(createWcvHost())`, keep layout/lib/EJS bootstrap.
- Modify the WCV main IPC (the file registering `wcv-host-*` handlers) — add `wcv-host-get-floors-sync`.
- Create `test/thRuntimeShapes.test.ts`, `test/thRuntime.test.ts`.

---

### Task 1: Move the JSON-Patch op builders to `shared/thRuntime`

**Files:**
- Create: `src/shared/thRuntime/ops.ts`
- Modify: `src/renderer/src/cardBridge/ops.ts` (becomes a re-export)

**Interfaces:**
- Produces: `VarOp`, `toPointer`, `keyPointer`, `setVarOps`, `assignVarOps`, `replaceStatDataOps` from `shared/thRuntime/ops`.

- [ ] **Step 1: Create the shared module** — copy the current contents of `src/renderer/src/cardBridge/ops.ts` verbatim into `src/shared/thRuntime/ops.ts`, changing only the top comment path:

```ts
// src/shared/thRuntime/ops.ts
//
// Build RFC-6902 JSON Patch ops for the variable write path. The main applier
// (generationService.applyVariableOps → applyJsonPatch) operates on the floor's `stat_data`, expects
// JSON Pointer paths, and SKIPS empty/zero-segment paths — so wholesale replaces go per top-level key.
export type VarOp = { op: string; path: string; value?: unknown; from?: string }

const esc = (s: string): string => String(s).replace(/~/g, '~0').replace(/\//g, '~1')

/** Dot/bracket card path ("a.b.c") → JSON Pointer ("/a/b/c"), each segment escaped. */
export function toPointer(dotPath: string): string {
  return '/' + String(dotPath).split('.').filter(Boolean).map(esc).join('/')
}

/** A single key → JSON Pointer ("/key"), WITHOUT dot-splitting (the key may legitimately contain a dot). */
export function keyPointer(key: string): string {
  return '/' + esc(key)
}

/** One "set" op at a dot path (e.g. from Mvu.setMvuVariable). */
export function setVarOps(dotPath: string, value: unknown): VarOp[] {
  return [{ op: 'set', path: toPointer(dotPath), value }]
}

/** "set" ops for each TOP-LEVEL key of `obj` (TavernHelper insert/assign semantics — keys are not paths). */
export function assignVarOps(obj: Record<string, unknown>): VarOp[] {
  return Object.entries(obj || {}).map(([k, v]) => ({ op: 'set', path: keyPointer(k), value: v }))
}

/** Ops that make stat_data equal `next`: remove top-level keys absent from `next`, then set all of
 *  `next`. (A whole-root replace path is skipped by the applier, so replace is expressed per key.) */
export function replaceStatDataOps(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): VarOp[] {
  const cur = current && typeof current === 'object' ? current : {}
  const safeNext = next && typeof next === 'object' ? next : {}
  const ops: VarOp[] = []
  for (const k of Object.keys(cur))
    if (!(k in safeNext)) ops.push({ op: 'remove', path: keyPointer(k) })
  for (const [k, v] of Object.entries(safeNext))
    ops.push({ op: 'set', path: keyPointer(k), value: v })
  return ops
}
```

- [ ] **Step 2: Replace the renderer file with a re-export** — overwrite `src/renderer/src/cardBridge/ops.ts` with:

```ts
// src/renderer/src/cardBridge/ops.ts
// Moved to shared/thRuntime/ops.ts (used by both the inline + WCV transports). Re-exported here so
// existing renderer imports keep working.
export * from '../../../shared/thRuntime/ops'
export type { VarOp } from '../../../shared/thRuntime/ops'
```

- [ ] **Step 3: Verify** — `npm run typecheck` (expect pass; `createCardBridge.ts` still imports from `./ops`).

- [ ] **Step 4: Commit**

```bash
git add src/shared/thRuntime/ops.ts src/renderer/src/cardBridge/ops.ts
git commit -m "refactor(cards): move var-op builders to shared/thRuntime

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Define the `Host` interface and runtime types

**Files:**
- Create: `src/shared/thRuntime/types.ts`

**Interfaces:**
- Produces: `Host`, `CardCtx`, `ThMessage`, `StMessage`, `FloorLike`, `GenCfgNormalized`, `ThGlobals`.

- [ ] **Step 1: Write the types file**

```ts
// src/shared/thRuntime/types.ts
import type { VarOp } from './ops'

export type CardCtx = { profileId: string; chatId: string; characterId: string }

export type ThMessage = { message_id: number; role: 'user' | 'assistant'; message: string; name?: string }

export type StMessage = {
  is_user: boolean
  name: string
  mes: string
  send_date: string
  swipes: string[]
  swipe_id: number
  extra: Record<string, any>
}

export type FloorLike = {
  floor?: number
  user_message?: { content?: string }
  response?: { content?: string }
  variables?: any
  swipes?: string[]
  swipe_id?: number
}

export type GenCfgNormalized = {
  userInput?: string
  prompt?: string
  systemPrompt?: string
  maxChatHistory?: number
  maxTokens?: number
  overrides?: any
}

/** The single seam between the realm-agnostic TH runtime and each transport. */
export interface Host {
  ctx: CardCtx
  // --- SYNC getters (called without await) ---
  statData(): any
  floors(): FloorLike[]
  charData(): any
  charAvatarPath(): string | null
  preset(): { name: string; parameters?: any } | null
  presetNames(): string[]
  worldbookNames(): { primary: string | null; additional: string[] }
  regexes(): { find: string; replace: string }[]
  formatRegex(text: string): string
  personaName(): string
  // --- ASYNC ops ---
  applyVariableOps(ops: VarOp[]): Promise<void>
  setVariables(statData: any): Promise<void>
  generate(input: string): Promise<{ content: string } | string>
  generateRaw(cfg: GenCfgNormalized): Promise<string>
  getWorldbook(name?: string): Promise<{ name?: string; entries: any[] }>
  saveWorldbook(name: string | undefined, entries: any[]): Promise<void>
  setChatMessages(msgs: any): Promise<boolean>
  deleteChatMessages(ids: any): Promise<boolean>
  createChat(arg?: any): Promise<string>
  createChatMessages(msgs: any): Promise<string>
  saveChat(chat: StMessage[]): Promise<boolean>
  reloadChat(): Promise<boolean>
  triggerSlash(cmd: string): Promise<string>
  setInput(text: string): void
  // --- events + engine ---
  onVarsChanged(cb: (statData: any) => void): () => void
  onHostEvent(cb: (name: string, payload?: any) => void): () => void
  evalTemplate(tmpl: string, data?: any): string
  evalTemplateError(tmpl: string, data?: any): string | null
}

/** What createThRuntime returns — spread onto the card window by each transport. */
export type ThGlobals = Record<string, any>
```

- [ ] **Step 2: Verify** — `npm run typecheck` (expect pass).

- [ ] **Step 3: Commit**

```bash
git add src/shared/thRuntime/types.ts
git commit -m "feat(cards): Host interface + TH runtime types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pure shape mappers (TDD)

**Files:**
- Create: `src/shared/thRuntime/shapes.ts`
- Test: `test/thRuntimeShapes.test.ts`

**Interfaces:**
- Consumes: `FloorLike`, `ThMessage`, `StMessage` from `./types`.
- Produces: `floorsToThMessages(floors)`, `currentMessageId(floors)`, `floorsToStChat(floors, names)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/thRuntimeShapes.test.ts
import { describe, it, expect } from 'vitest'
import {
  floorsToThMessages,
  currentMessageId,
  floorsToStChat
} from '../src/shared/thRuntime/shapes'

const floors = [
  { floor: 0, user_message: { content: 'hi' }, response: { content: 'hello' } },
  { floor: 1, user_message: { content: 'bye' }, response: { content: 'cya' }, swipes: ['cya', 'later'], swipe_id: 1 }
]

describe('floorsToThMessages', () => {
  it('flattens floors to sequential ids (user 2i, assistant 2i+1)', () => {
    expect(floorsToThMessages(floors)).toEqual([
      { message_id: 0, role: 'user', message: 'hi' },
      { message_id: 1, role: 'assistant', message: 'hello' },
      { message_id: 2, role: 'user', message: 'bye' },
      { message_id: 3, role: 'assistant', message: 'cya' }
    ])
  })
  it('handles missing content as empty strings', () => {
    expect(floorsToThMessages([{}])).toEqual([
      { message_id: 0, role: 'user', message: '' },
      { message_id: 1, role: 'assistant', message: '' }
    ])
  })
})

describe('currentMessageId', () => {
  it('is the last flat index', () => {
    expect(currentMessageId(floors)).toBe(3)
  })
  it('is 0 for no floors', () => {
    expect(currentMessageId([])).toBe(0)
  })
})

describe('floorsToStChat', () => {
  it('emits user+assistant ST messages with names and swipes', () => {
    const chat = floorsToStChat(floors, { charName: 'Ellia', userName: 'Player' })
    expect(chat).toHaveLength(4)
    expect(chat[0]).toMatchObject({ is_user: true, name: 'Player', mes: 'hi', swipes: [], swipe_id: 0 })
    expect(chat[3]).toMatchObject({ is_user: false, name: 'Ellia', mes: 'cya', swipes: ['cya', 'later'], swipe_id: 1 })
  })
  it('defaults assistant swipes to [response content] when none', () => {
    const chat = floorsToStChat([{ response: { content: 'x' } }], { charName: 'C', userName: 'U' })
    expect(chat[1].swipes).toEqual(['x'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/thRuntimeShapes.test.ts`
Expected: FAIL ("Failed to resolve import '../src/shared/thRuntime/shapes'").

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/thRuntime/shapes.ts
import type { FloorLike, ThMessage, StMessage } from './types'

/** Floors → a flat TH message list with sequential ids (floor i → user 2i, assistant 2i+1). */
export function floorsToThMessages(floors: FloorLike[]): ThMessage[] {
  const out: ThMessage[] = []
  floors.forEach((f, i) => {
    out.push({ message_id: i * 2, role: 'user', message: f.user_message?.content ?? '' })
    out.push({ message_id: i * 2 + 1, role: 'assistant', message: f.response?.content ?? '' })
  })
  return out
}

/** Last flat message index (2n-1), or 0 when there are no floors. */
export function currentMessageId(floors: FloorLike[]): number {
  const n = floors.length
  return n > 0 ? n * 2 - 1 : 0
}

/** Floors → the SillyTavern `chat[]` shape (each turn = a user + an assistant message). */
export function floorsToStChat(
  floors: FloorLike[],
  names: { charName: string; userName: string }
): StMessage[] {
  const out: StMessage[] = []
  for (const f of floors) {
    out.push({
      is_user: true,
      name: names.userName,
      mes: f.user_message?.content ?? '',
      send_date: '',
      swipes: [],
      swipe_id: 0,
      extra: {}
    })
    out.push({
      is_user: false,
      name: names.charName,
      mes: f.response?.content ?? '',
      send_date: '',
      swipes: f.swipes ?? [f.response?.content ?? ''],
      swipe_id: f.swipe_id ?? 0,
      extra: {}
    })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/thRuntimeShapes.test.ts`
Expected: PASS (8 assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add src/shared/thRuntime/shapes.ts test/thRuntimeShapes.test.ts
git commit -m "feat(cards): pure floors->TH/ST shape mappers + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `createThRuntime` core (TDD)

**Files:**
- Create: `src/shared/thRuntime/index.ts`
- Test: `test/thRuntime.test.ts`

**Interfaces:**
- Consumes: `Host`, `ThGlobals` from `./types`; mappers from `./shapes`; op builders from `./ops`.
- Produces: `createThRuntime(host: Host): ThGlobals` — bag with `TavernHelper`, the bare helpers, `Mvu`, `SillyTavern`, `EjsTemplate`, `toastr`, `tavern_events`, `__rptDispose`.

- [ ] **Step 1: Write the failing test**

```ts
// test/thRuntime.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import type { Host } from '../src/shared/thRuntime/types'

function mockHost(over: Partial<Host> = {}): { host: Host; calls: any } {
  const calls: any = { applyVariableOps: [], generate: [], generateRaw: [], saveWorldbook: [] }
  let varsCb: ((sd: any) => void) | null = null
  const host: Host = {
    ctx: { profileId: 'p', chatId: 'c', characterId: 'ch' },
    statData: () => ({ hp: 1 }),
    floors: () => [{ user_message: { content: 'u' }, response: { content: 'a' } }],
    charData: () => ({ name: 'Ellia' }),
    charAvatarPath: () => null,
    preset: () => ({ name: 'P' }),
    presetNames: () => ['P'],
    worldbookNames: () => ({ primary: 'Ellia', additional: [] }),
    regexes: () => [{ find: 'a', replace: 'b' }],
    formatRegex: (t) => t.toUpperCase(),
    personaName: () => 'Player',
    applyVariableOps: async (ops) => { calls.applyVariableOps.push(ops) },
    setVariables: async () => {},
    generate: async (i) => { calls.generate.push(i); return { content: 'gen:' + i } },
    generateRaw: async (cfg) => { calls.generateRaw.push(cfg); return 'raw' },
    getWorldbook: async () => ({ entries: [{ keys: ['k'] }] }),
    saveWorldbook: async (n, e) => { calls.saveWorldbook.push([n, e]) },
    setChatMessages: async () => true,
    deleteChatMessages: async () => true,
    createChat: async () => 'id',
    createChatMessages: async () => '',
    saveChat: async () => true,
    reloadChat: async () => true,
    triggerSlash: async () => '',
    setInput: () => {},
    onVarsChanged: (cb) => { varsCb = cb; return () => { varsCb = null } },
    onHostEvent: () => () => {},
    evalTemplate: (t) => 'ejs:' + t,
    evalTemplateError: () => null,
    ...over
  }
  return { host, calls, fireVars: (sd: any) => varsCb && varsCb(sd) } as any
}

describe('createThRuntime', () => {
  it('exposes the surface (bare + namespaced)', () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(typeof g.getVariables).toBe('function')
    expect(g.TavernHelper.getChatMessages).toBe(g.getChatMessages)
    expect(g.Mvu).toBeTruthy()
    expect(g.SillyTavern).toBeTruthy()
    expect(g.EjsTemplate).toBeTruthy()
    expect(g.tavern_events.MESSAGE_RECEIVED).toBe('message_received')
  })

  it('reads sync getters via the host + shape mappers', () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } })
    expect(g.getChatMessages()).toEqual([
      { message_id: 0, role: 'user', message: 'u' },
      { message_id: 1, role: 'assistant', message: 'a' }
    ])
    expect(g.getCurrentMessageId()).toBe(1)
    expect(g.getCharData()).toEqual({ name: 'Ellia' })
    expect(g.formatAsTavernRegexedString('hi')).toBe('HI')
    expect(g.SillyTavern.chat[0].name).toBe('Player')
  })

  it('refreshes the cache + emits MVU events on host var change', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    const seen: any[] = []
    g.eventOn('mag_variable_updated', (sd: any) => seen.push(sd))
    m.fireVars({ hp: 99 })
    expect(g.getVariables()).toEqual({ stat_data: { hp: 99 } })
    expect(seen).toEqual([{ hp: 99 }])
  })

  it('setMvuVariable persists via applyVariableOps', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.Mvu.setMvuVariable({}, 'a.b', 5)
    await Promise.resolve()
    expect(m.calls.applyVariableOps[0]).toEqual([{ op: 'set', path: '/a/b', value: 5 }])
  })

  it('normalizes generate/generateRaw config', async () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    expect(await g.generate('hi')).toBe('gen:hi')
    expect(await g.generate({ user_input: 'yo' })).toBe('gen:yo')
    await g.generateRaw({ user_input: 'x', max_tokens: 7 })
    expect(m.calls.generateRaw[0]).toMatchObject({ userInput: 'x', maxTokens: 7 })
  })

  it('errorCatched swallows throws and rejections', async () => {
    const { host } = mockHost()
    const g = createThRuntime(host)
    expect(g.errorCatched(() => { throw new Error('x') })()).toBeUndefined()
    await expect(g.errorCatched(async () => { throw new Error('y') })()).resolves.toBeUndefined()
  })

  it('__rptDispose unsubscribes from host vars', () => {
    const m: any = mockHost()
    const g = createThRuntime(m.host)
    g.__rptDispose()
    m.fireVars({ hp: 7 })
    expect(g.getVariables()).toEqual({ stat_data: { hp: 1 } }) // cache unchanged after dispose
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/thRuntime.test.ts`
Expected: FAIL ("Failed to resolve import '../src/shared/thRuntime'").

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/thRuntime/index.ts
import type { Host, ThGlobals } from './types'
import { floorsToThMessages, floorsToStChat, currentMessageId } from './shapes'
import { setVarOps, assignVarOps, replaceStatDataOps, type VarOp } from './ops'

const TAVERN_EVENTS = {
  GENERATION_STARTED: 'generation_started',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SWIPED: 'message_swiped',
  CHAT_CHANGED: 'chat_changed',
  STREAM_TOKEN_RECEIVED: 'stream_token_received'
}
const MVU_EVENTS = {
  VARIABLE_INITIALIZED: 'mag_variable_initialized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  VARIABLE_UPDATED: 'mag_variable_updated'
}

const getByPath = (root: any, path: string): any =>
  String(path)
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), root)

const clone = (v: any): any => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

export function createThRuntime(host: Host): ThGlobals {
  // --- event bus ---
  const map: Record<string, Array<(...a: any[]) => void>> = {}
  const on = (n: string, cb: (...a: any[]) => void): void => {
    ;(map[n] ||= []).push(cb)
  }
  const off = (n: string, cb: (...a: any[]) => void): void => {
    map[n] = (map[n] || []).filter((f) => f !== cb)
  }
  const emit = (n: string, ...a: any[]): void => {
    for (const cb of map[n] || []) {
      try {
        cb(...a)
      } catch (e) {
        console.error('[th event]', n, e)
      }
    }
  }

  // --- statData cache (authoritative refresh via host.onVarsChanged; optimistic on write) ---
  let stat: any = host.statData() || {}
  const offVars = host.onVarsChanged((sd) => {
    stat = sd || {}
    emit(MVU_EVENTS.VARIABLE_UPDATE_STARTED, stat)
    emit(MVU_EVENTS.VARIABLE_UPDATED, stat)
    emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, stat)
    emit(TAVERN_EVENTS.MESSAGE_UPDATED)
  })
  const offHost = host.onHostEvent((name, payload) => emit(name, payload))

  const writeVars = (ops: VarOp[]): Promise<void> =>
    ops.length ? host.applyVariableOps(ops) : Promise.resolve()

  const errorCatched =
    (fn: any) =>
    (...args: any[]): any => {
      try {
        const r = typeof fn === 'function' ? fn(...args) : undefined
        if (r && typeof r.then === 'function') return r.catch((e: any) => console.error('[card]', e))
        return r
      } catch (e) {
        console.error('[card]', e)
        return undefined
      }
    }

  const normRaw = (c: any): any => ({
    userInput: c?.user_input ?? c?.userInput ?? c?.prompt,
    prompt: c?.prompt,
    systemPrompt: c?.system_prompt ?? c?.systemPrompt,
    maxChatHistory: c?.max_chat_history ?? c?.maxChatHistory ?? 0,
    maxTokens: c?.max_tokens ?? c?.maxTokens,
    overrides: c?.overrides
  })

  const wbEntries = async (name?: any): Promise<any[]> => (await host.getWorldbook(name)).entries || []

  // --- TavernHelper helpers (bare + namespaced) ---
  const helpers: Record<string, any> = {
    // SYNC getters
    getVariables: () => ({ stat_data: stat }),
    getChatMessages: () => floorsToThMessages(host.floors()),
    getCurrentMessageId: () => currentMessageId(host.floors()),
    getTavernHelperVersion: () => '4.3.17',
    getCharData: () => host.charData(),
    getCharAvatarPath: () => host.charAvatarPath(),
    getPreset: () => host.preset(),
    getPresetNames: () => host.presetNames(),
    getCharWorldbookNames: () => host.worldbookNames(),
    getWorldbookNames: () => {
      const r = host.worldbookNames()
      return [r.primary, ...(r.additional || [])].filter(Boolean)
    },
    getCurrentCharPrimaryLorebook: () => host.worldbookNames().primary,
    getCharLorebooks: () => {
      const r = host.worldbookNames()
      return [r.primary, ...(r.additional || [])].filter(Boolean)
    },
    getTavernRegexes: () => host.regexes(),
    formatAsTavernRegexedString: (t: any) => (typeof t === 'string' ? host.formatRegex(t) : t),
    // EVENTS
    eventOn: on,
    eventMakeFirst: on,
    eventOnce: on,
    eventEmit: emit,
    eventRemoveListener: off,
    // misc
    waitGlobalInitialized: async () => true,
    substitudeMacros: (t: string) => t,
    getLorebookSettings: () => ({}),
    setLorebookSettings: () => {},
    audioImport: () => {},
    audioPlay: () => {},
    audioPause: () => {},
    audioMode: () => {},
    audioEnable: () => {},
    errorCatched,
    // ASYNC writes
    insertOrAssignVariables: async (vars: any) => {
      const obj = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      stat = { ...stat, ...(obj || {}) }
      await writeVars(assignVarOps(obj || {}))
    },
    replaceVariables: async (vars: any) => {
      const next = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
    },
    updateVariablesWith: async (updater: any) => {
      if (typeof updater !== 'function') return
      const next = updater(clone(stat))
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
    },
    generate: async (a: any) => {
      const input = typeof a === 'string' ? a : (a?.user_input ?? a?.userInput ?? a?.text ?? '')
      const r = await host.generate(String(input ?? ''))
      return typeof r === 'string' ? r : (r?.content ?? '')
    },
    generateRaw: async (cfg: any) => host.generateRaw(normRaw(cfg)),
    getWorldbook: async (name: any) => wbEntries(name),
    getLorebookEntries: async (name: any) => wbEntries(name),
    replaceWorldbook: async (name: any, entries: any) => {
      await host.saveWorldbook(name, entries)
      return true
    },
    updateWorldbookWith: async (name: any, updater: any) => {
      const cur = await wbEntries(name)
      const next = typeof updater === 'function' ? await updater(cur) : cur
      await host.saveWorldbook(name, next)
      return next
    },
    setChatMessages: async (m: any) => host.setChatMessages(m),
    deleteChatMessages: async (ids: any) => host.deleteChatMessages(ids),
    createChat: async (a?: any) => host.createChat(a),
    createChatMessages: async (m: any) => host.createChatMessages(m),
    triggerSlash: async (c: any) => host.triggerSlash(String(c ?? '')),
    replaceTavernRegexes: async () => undefined
  }

  // --- Mvu ---
  const Mvu = {
    getMvuData: () => ({ stat_data: stat, schema: {} }),
    getMvuVariable: (_d: any, path: string, o?: any) => {
      const v = getByPath(stat, path)
      return v === undefined ? o?.default_value : v
    },
    setMvuVariable: (_d: any, path: string, value: any) => {
      const next = clone(stat) || {}
      const parts = String(path).split('.').filter(Boolean)
      let o = next
      for (let i = 0; i < parts.length - 1; i++) {
        if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
        o = o[parts[i]]
      }
      if (parts.length) o[parts[parts.length - 1]] = value
      stat = next
      void writeVars(setVarOps(path, value))
      return value
    },
    replaceMvuData: (d: any) => {
      const next = d?.stat_data && typeof d.stat_data === 'object' ? d.stat_data : d
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      void writeVars(ops)
    },
    parseMessage: () => undefined,
    reloadInitVar: () => undefined,
    events: MVU_EVENTS
  }

  // --- SillyTavern ---
  const stChat = (): any[] =>
    floorsToStChat(host.floors(), {
      charName: host.charData()?.name || 'Character',
      userName: host.personaName()
    })
  const eventSource = { on, emit, makeFirst: on, once: on, removeListener: off }
  const getContext = (): any => ({
    chat: stChat(),
    eventSource,
    eventTypes: TAVERN_EVENTS,
    event_types: TAVERN_EVENTS,
    extensionSettings: { EjsTemplate: { enabled: true } },
    getContext: () => getContext()
  })
  const SillyTavern = {
    chat: stChat(),
    getContext,
    substituteParams: (t: string) => t,
    saveChat: async () => host.saveChat(SillyTavern.chat),
    reloadCurrentChat: async () => host.reloadChat()
  }

  // --- EjsTemplate (engine lives in the transport via host.evalTemplate) ---
  const EjsTemplate = {
    evalTemplate: (tmpl: string, data?: any) => host.evalTemplate(tmpl, data),
    prepareContext: (data?: any) => data || {},
    getSyntaxErrorInfo: (tmpl: string, data?: any) => {
      const e = host.evalTemplateError(tmpl, data)
      return e ? { message: e } : null
    },
    allVariables: () => stat,
    saveVariables: (vars: any) => {
      stat = vars || {}
      void host.setVariables(stat)
      return true
    },
    compileTemplate: (tmpl: string) => (data?: any) => host.evalTemplate(tmpl, data),
    setFeatures: () => undefined,
    getFeatures: () => ({}),
    resetFeatures: () => undefined,
    refreshWorldInfo: () => undefined,
    defines: {},
    initialVariables: () => stat
  }

  const toastr = {
    success: (m?: any) => console.info('[toast]', m),
    error: (m?: any) => console.error('[toast]', m),
    info: (m?: any) => console.info('[toast]', m),
    warning: (m?: any) => console.warn('[toast]', m),
    clear: () => {},
    remove: () => {},
    options: {}
  }

  return {
    TavernHelper: helpers,
    ...helpers,
    Mvu,
    SillyTavern,
    tavern_events: TAVERN_EVENTS,
    EjsTemplate,
    toastr,
    __rptDispose: () => {
      offVars()
      offHost()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/thRuntime.test.ts`
Expected: PASS (all `describe` blocks).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: all green (existing suites unaffected — nothing imports `thRuntime` yet).

- [ ] **Step 6: Commit**

```bash
git add src/shared/thRuntime/index.ts test/thRuntime.test.ts
git commit -m "feat(cards): createThRuntime core (one TH surface over a Host) + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Inline `Host` adapter + rewire `createCardBridge`

**Files:**
- Create: `src/renderer/src/cardBridge/host.ts`
- Modify: `src/renderer/src/cardBridge/createCardBridge.ts`

**Interfaces:**
- Consumes: `Host`, `CardCtx` from `shared/thRuntime/types`; `createThRuntime` from `shared/thRuntime`.
- Produces: `createInlineHost(ctx: CardCtx): Host`.

> The inline `Host` is built by lifting the data-access logic that `createCardBridge` performs today
> (read the current file first). Map each `Host` method to the existing behavior:
> sync getters → the `useXStore.getState()` reads; async ops → `window.api.*` + the optimistic
> `chatStore.applyVariableOps` fold; `generate` keeps the "fold the new floor into the store" behavior
> and returns `{ content }`; `evalTemplate` uses the renderer's shared engine.

- [ ] **Step 1: Write the inline adapter**

```ts
// src/renderer/src/cardBridge/host.ts
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { evalTemplate, evalTemplateDetailed } from '../../../shared/templateEngine'
import { buildRenderContext } from '../plugin/renderTemplate'
import type { Host, CardCtx, FloorLike } from '../../../shared/thRuntime/types'
import type { VarOp } from '../../../shared/thRuntime/ops'

const floorsOf = (): FloorLike[] => useChatStore.getState().floors as any
const latestVars = (): any => {
  const f = floorsOf()
  return f.length ? (f[f.length - 1] as any).variables ?? {} : {}
}
const statOf = (): any => {
  const v = latestVars()
  return v && typeof v === 'object' && 'stat_data' in v ? v.stat_data : v
}
const cardOf = (): any => useCharacterStore.getState().activeCharacter?.card?.data ?? null
const floorIndex = (): number => {
  const f = floorsOf()
  return f.length ? ((f[f.length - 1] as any).floor ?? f.length - 1) : 0
}

export function createInlineHost(ctx: CardCtx): Host {
  const fetchWb = async (): Promise<any> => {
    try {
      return await window.api.getLorebook(ctx.profileId, ctx.characterId)
    } catch {
      return { entries: [] }
    }
  }
  return {
    ctx,
    statData: () => statOf(),
    floors: () => floorsOf(),
    charData: () => cardOf(),
    charAvatarPath: () => null,
    preset: () => {
      const p = usePresetStore.getState().preset as any
      return p ? { name: p.name, parameters: p.parameters } : null
    },
    presetNames: () => usePresetStore.getState().presets.map((p: any) => p.name),
    worldbookNames: () => ({
      primary: useCharacterStore.getState().activeCharacter?.card?.data?.name || null,
      additional: []
    }),
    regexes: () =>
      useRegexStore.getState().rules.map((r: any) => ({ find: r.source, replace: r.replace })),
    formatRegex: (t) => useRegexStore.getState().apply(t),
    personaName: () => useSettingsStore.getState().settings?.persona?.name || 'User',

    applyVariableOps: async (ops: VarOp[]) => {
      await useChatStore.getState().applyVariableOps(ctx.profileId, ops as any, floorIndex())
    },
    setVariables: async (sd: any) => {
      // express a whole replace via applyVariableOps in the core; here just persist the given object
      await useChatStore.getState().applyVariableOps(
        ctx.profileId,
        Object.entries(sd || {}).map(([k, v]) => ({ op: 'set', path: '/' + k, value: v })) as any,
        floorIndex()
      )
    },
    generate: async (input: string) => {
      const r: any = await window.api.generate(ctx.profileId, ctx.chatId, input)
      if (r && typeof r !== 'string' && ctx.chatId === useChatStore.getState().activeChatId) {
        useChatStore.setState((s) => ({ floors: [...s.floors, r] }))
      }
      return typeof r === 'string' ? r : { content: r?.response?.content ?? '' }
    },
    generateRaw: async (cfg) => {
      const r: any = await window.api.generateRaw(ctx.profileId, ctx.chatId, cfg)
      return typeof r === 'string' ? r : (r?.response?.content ?? '')
    },
    getWorldbook: async () => {
      const lb = await fetchWb()
      const entries = Array.isArray(lb?.entries) ? lb.entries : Array.isArray(lb) ? lb : []
      return { name: lb?.name, entries }
    },
    saveWorldbook: async (_name, entries) => {
      const lb = (await fetchWb()) || { name: '', entries: [] }
      const next = Array.isArray(entries) ? { ...lb, entries } : entries
      try {
        await window.api.saveLorebook(ctx.profileId, ctx.characterId, next)
      } catch (e) {
        console.error('[inline saveWorldbook]', e)
      }
    },
    setChatMessages: async () => false,
    deleteChatMessages: async () => false,
    createChat: async () => '',
    createChatMessages: async () => '',
    saveChat: async () => true,
    reloadChat: async () => true,
    triggerSlash: async () => '',
    setInput: () => {
      // inline cards don't drive onboarding; no-op for SP1 (see spec §6).
    },

    onVarsChanged: (cb) => {
      let last = ''
      return useChatStore.subscribe((state) => {
        const f = state.floors[state.floors.length - 1] as any
        const v = f?.variables ?? {}
        const sd = v && typeof v === 'object' && 'stat_data' in v ? v.stat_data : v
        const json = JSON.stringify(sd ?? null)
        if (json !== last) {
          last = json
          cb(sd)
        }
      })
    },
    onHostEvent: () => () => {},
    evalTemplate: (tmpl) => evalTemplate(tmpl, buildRenderContext(latestVars())),
    evalTemplateError: (tmpl) => {
      const r: any = evalTemplateDetailed(tmpl, buildRenderContext(latestVars()))
      return r?.error ?? null
    }
  }
}
```

> Note: if `evalTemplateDetailed` is not exported from `shared/templateEngine`, use `evalTemplate` and
> return `null` from `evalTemplateError` (verify the export before writing this line).

- [ ] **Step 2: Rewire `createCardBridge`** — replace the body of `src/renderer/src/cardBridge/createCardBridge.ts` so it delegates to the runtime, preserving the lib-global placeholders the bridge index wires:

```ts
// src/renderer/src/cardBridge/createCardBridge.ts
import { createThRuntime } from '../../../shared/thRuntime'
import { createInlineHost } from './host'
import type { CardCtx } from '../../../shared/thRuntime/types'

export type { CardCtx }

export function createCardBridge(ctx: CardCtx): Record<string, unknown> {
  const g = createThRuntime(createInlineHost(ctx))
  // lodash `_` and Zod `z` are injected by cardBridge/index.ts onto the result; keep the keys present.
  return { ...g, _: undefined, z: undefined }
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: pass. (If `cardBridge/index.ts` referenced the old internal helpers directly, adjust it to use the returned `g` — read it first; it should only assign `_`/`z` onto the returned object.)

- [ ] **Step 4: Manual smoke (Electron)** — `npm run dev`; open a chat with an inline scripted card (ellia / 角色查看器). Confirm: card renders; a variable-writing control still updates the status panel; `generate` from a card still appends a floor. No console errors from `__rptCardBridge`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/cardBridge/host.ts src/renderer/src/cardBridge/createCardBridge.ts
git commit -m "refactor(cards): inline transport uses the unified TH runtime via a Host adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: WCV `Host` adapter + floors-sync IPC + rewire `wcvPreload`

**Files:**
- Create: `src/preload/wcvHost.ts`
- Modify: `src/preload/wcvPreload.ts`
- Modify: the WCV main IPC file (search for `'wcv-host-get-messages-sync'` to find it) — add `wcv-host-get-floors-sync`.

**Interfaces:**
- Consumes: `Host`, `CardCtx` from `shared/thRuntime/types`; `createThRuntime` from `shared/thRuntime`.
- Produces: `createWcvHost(deps): Host`.

- [ ] **Step 1: Add the floors-sync IPC handler (main)** — find the handler registering `wcv-host-get-messages-sync` (e.g. `src/main/ipc/wcv.ts` or `src/main/services/wcvManager.ts`; `grep -rn "wcv-host-get-messages-sync" src/main`). Beside it, add a synchronous handler that returns the same ctx-scoped chat's **raw floors** the renderer uses:

```ts
// in the WCV ipc registration, next to the other wcv-host-*-sync handlers
ipcMain.on('wcv-host-get-floors-sync', (e) => {
  const ctx = slotCtx(e.sender) // however the file resolves the per-slot ctx today
  try {
    e.returnValue = floorService.getFloors(ctx.profileId, ctx.chatId)
  } catch {
    e.returnValue = []
  }
})
```

> Use the same ctx-resolution + service the existing `wcv-host-get-messages-sync` handler uses; return
> the raw floor rows (the `FloorFile`/floor objects), not transformed messages.

- [ ] **Step 2: Write the WCV adapter** — it wraps `ipcRenderer` exactly as `wcvPreload` does today; `evalTemplate` is injected (so the quickjs engine stays in the preload):

```ts
// src/preload/wcvHost.ts
import { ipcRenderer } from 'electron'
import type { Host, CardCtx, FloorLike } from '../shared/thRuntime/types'
import type { VarOp } from '../shared/thRuntime/ops'

type Deps = {
  ctx: CardCtx
  evalTemplate: (tmpl: string, data?: any) => string
  evalTemplateError: (tmpl: string, data?: any) => string | null
}

export function createWcvHost(deps: Deps): Host {
  const wbNames = (): any => ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')
  return {
    ctx: deps.ctx,
    statData: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-vars-sync') || {}
      } catch {
        return {}
      }
    },
    floors: () => {
      try {
        return (ipcRenderer.sendSync('wcv-host-get-floors-sync') as FloorLike[]) || []
      } catch {
        return []
      }
    },
    charData: () => ipcRenderer.sendSync('wcv-host-get-char-data'),
    charAvatarPath: () => ipcRenderer.sendSync('wcv-host-get-char-avatar'),
    preset: () => ipcRenderer.sendSync('wcv-host-get-preset'),
    presetNames: () => ipcRenderer.sendSync('wcv-host-get-preset-names'),
    worldbookNames: () => {
      const r = wbNames()
      return { primary: r?.primary ?? null, additional: r?.additional || [] }
    },
    regexes: () => ipcRenderer.sendSync('wcv-host-get-regexes'),
    formatRegex: (t) => ipcRenderer.sendSync('wcv-host-format-regex', t),
    personaName: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-persona-name') || 'User'
      } catch {
        return 'User'
      }
    },

    applyVariableOps: (ops: VarOp[]) => ipcRenderer.invoke('wcv-host-apply-vars', ops),
    setVariables: (sd: any) => ipcRenderer.invoke('wcv-host-set-vars', sd),
    generate: (input: string) => ipcRenderer.invoke('wcv-host-generate', input),
    generateRaw: (cfg) => ipcRenderer.invoke('wcv-host-generate-raw', cfg),
    getWorldbook: async (name) => {
      const entries = await ipcRenderer.invoke('wcv-host-get-worldbook', name)
      return { entries: Array.isArray(entries) ? entries : (entries?.entries ?? []) }
    },
    saveWorldbook: (name, entries) => ipcRenderer.invoke('wcv-host-replace-worldbook', name, entries),
    setChatMessages: (m) => ipcRenderer.invoke('wcv-host-set-chat-messages', m),
    deleteChatMessages: (ids) => ipcRenderer.invoke('wcv-host-delete-chat-messages', ids),
    createChat: () => Promise.resolve(''),
    createChatMessages: (m: any) => {
      const arr = Array.isArray(m) ? m : [m]
      const last = arr[arr.length - 1]
      const text =
        (last && (last.message ?? last.content ?? last.mes)) ||
        (typeof last === 'string' ? last : '')
      if (text) ipcRenderer.send('wcv-host-set-input', String(text))
      return Promise.resolve('')
    },
    saveChat: (chat) => ipcRenderer.invoke('wcv-host-save-chat', chat),
    reloadChat: () => ipcRenderer.invoke('wcv-host-reload-chat'),
    triggerSlash: () => Promise.resolve(''),
    setInput: (text) => ipcRenderer.send('wcv-host-set-input', text),

    onVarsChanged: (cb) => {
      const l = (_e: any, v: any): void => cb(v)
      ipcRenderer.on('wcv-vars-changed', l)
      return () => ipcRenderer.removeListener('wcv-vars-changed', l)
    },
    onHostEvent: (cb) => {
      const l = (_e: any, d: any): void => d && d.name && cb(d.name, d.payload)
      ipcRenderer.on('wcv-event', l)
      return () => ipcRenderer.removeListener('wcv-event', l)
    },
    evalTemplate: deps.evalTemplate,
    evalTemplateError: deps.evalTemplateError
  }
}
```

> `wcv-host-get-persona-name` may not exist yet — if so, add a trivial sync handler beside the others
> returning the persona name (or have the adapter fall back to `'User'`, which it already does).

- [ ] **Step 2b: Rewire `wcvPreload.ts`** — keep the top-of-file bootstrap (layout bridge, `rptHost`, the quickjs EJS engine init via `initEngine`/`buildEjsCtx`, the lazy lib globals `_`/`z`/`$`/`Vue`/…). Replace the hand-written `helpers`/`Mvu`/`SillyTavern`/`EjsTemplate`/`tavern_events` blocks with:

```ts
import { createThRuntime } from '../shared/thRuntime'
import { createWcvHost } from './wcvHost'

// ctx for this slot — resolve as the file already does (or read from the slot init payload).
const ctx = { profileId: '', chatId: '', characterId: '' } // replace with the existing ctx resolution

const g = createThRuntime(
  createWcvHost({
    ctx,
    evalTemplate: (tmpl, data) => ejsEval(String(tmpl ?? ''), buildEjsCtx(data)),
    evalTemplateError: (tmpl, data) => {
      const err = ejsEvalDetailed(String(tmpl ?? ''), buildEjsCtx(data)).error
      return err || null
    }
  })
)
Object.assign(w, g)
w.TavernHelper = g.TavernHelper
```

> Keep `w._`/`w.z`/`w.$`/`w.Vue`/`w.VueRouter`/`w.Pinia`/`w.toastr` library wiring as-is (those are
> transport lib injection, not part of the runtime). Remove the now-duplicated surface definitions.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: pass (the preload bundles `shared/thRuntime` — already proven, `wcvPreload` imports `shared/templateEngine` today).

- [ ] **Step 4: Manual smoke (Electron)** — open a card in **Isolated (WCV)** mode (ellia / 角色查看器). Confirm: renders; reads `stat_data`; a write control round-trips; the home onboarding `createChatMessages → input injection` still works.

- [ ] **Step 5: Commit**

```bash
git add src/preload/wcvHost.ts src/preload/wcvPreload.ts src/main/ipc/wcv.ts
git commit -m "refactor(cards): WCV transport uses the unified TH runtime via a Host adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> (Adjust the `git add` path for the main IPC file to wherever the floors-sync handler landed.)

---

### Task 7: Remove dead surface + full verification

**Files:**
- Modify: `src/renderer/src/cardBridge/createCardBridge.ts`, `src/preload/wcvPreload.ts` (delete any now-unused helpers/imports left behind).

- [ ] **Step 1: Delete leftovers** — remove any now-unreferenced imports, the old `makeBus`/`TAVERN_EVENTS`/`MVU_EVENTS`/`toastr`/`errorCatched`/`stChat`/`getByPath` blocks that survived the rewires, and unused store imports. Let lint/typecheck guide you.

- [ ] **Step 2: Full gate**

Run: `npm run typecheck && npx vitest run && npm run build && npx eslint src/shared/thRuntime src/renderer/src/cardBridge/host.ts src/preload/wcvHost.ts`
Expected: typecheck clean; all tests pass; build OK; **0 lint errors** on the new files.

- [ ] **Step 3: Manual regression** — inline AND WCV cards both render and their variable-write + generate paths work (the §10 acceptance list). Note any intended convergence change (chat-message ids/worldbook shape) in the commit body.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(cards): drop the duplicated card-API surface (now unified in thRuntime)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (author)

- **Spec coverage:** §3 layout → Tasks 1–6; §4 Host → Task 2; §5 thRuntime + convergence → Task 4 (+ shapes Task 3); §6 adapters → Tasks 5–6; §7 migration → the Task 1→7 order; §8 tests → Tasks 3–4; §9 build/realm → Task 5/6 verify steps; §10 acceptance → Task 7. Covered.
- **Placeholder scan:** the two `> Note` blocks (evalTemplateDetailed export, ctx resolution, persona-name handler) are *verification instructions*, not deferred work — each names the exact thing to confirm and the fallback. No "TODO/handle edge cases" left.
- **Type consistency:** `Host` method names match between `types.ts` (Task 2), `createThRuntime` calls (Task 4), and both adapters (Tasks 5–6); `VarOp` shape consistent (Task 1); shape-mapper names match Task 3 ↔ Task 4 imports.
