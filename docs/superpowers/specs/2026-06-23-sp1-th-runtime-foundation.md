# SP1 — Unified TH Runtime Foundation

> First sub-project of the [JSR faithful-host architecture](2026-06-23-jsr-faithful-host-architecture.md).
> Extract today's two card-API shims (`cardBridge` inline + `wcvPreload` WCV) into **one** clean-room
> runtime behind a `Host` seam, converging drifted functions to a single canonical behavior. No new TH
> domains, no rendering-env changes. Clean-room (no JSR source). Branch: `feat/dual-mode-card-rendering`.

## 1. Problem

The inline (`src/renderer/src/cardBridge/createCardBridge.ts`) and WCV
(`src/preload/wcvPreload.ts`) transports each build the **same** card-facing surface
(`TavernHelper`/`Mvu`/`SillyTavern`/`EjsTemplate`/`toastr` + the event bus + enums) but implement every
function **twice**, against different data sources (Zustand stores + `window.api` vs `ipcRenderer.sendSync`
+ `invoke`). They have already drifted (e.g. chat-message shape is built in the renderer shim for inline
but in a main IPC handler for WCV; worldbook reads use different code paths). Every future TH function
would be written twice — the same class of bug that produced the inline/WCV CSP and height parity defects.

## 2. Goal & non-goals

**Goal:** a single `shared/thRuntime` builds the *entire current* surface from an abstract `Host`
interface; the two transports become thin `Host` adapters. Functions that drifted converge to one
canonical behavior, service-backed where possible. Parity becomes structural, not test-enforced.

**Non-goals (later sub-projects):** new TH domains / filling stubs (SP3+), rendering-env parity — libs,
`--TH-viewport-height`, avatar CSS (SP2), scripts/STScript (C), EJS/MVU depth (D). SP1 changes *structure*,
not the set of features a card can use (except the intended convergence in §5).

## 3. Module layout

```
src/shared/thRuntime/
  index.ts     createThRuntime(host: Host): ThGlobals   — builds the globals bag
  types.ts     Host, CardCtx, VarOp, ThMessage, StMessage, FloorLike, GenCfgNormalized, ThGlobals
  shapes.ts    pure: floorsToThMessages(), floorsToStChat(), currentMessageId()
src/renderer/src/cardBridge/
  host.ts      createInlineHost(ctx): Host             — Zustand reads + window.api
  createCardBridge.ts   → build inlineHost, return createThRuntime(host) (+ lib globals stay in index.ts)
src/preload/
  wcvHost.ts   createWcvHost(): Host                   — ipcRenderer.sendSync / invoke
  wcvPreload.ts → build wcvHost, Object.assign(window, createThRuntime(host)) (+ layout/lib bits stay)
test/
  thRuntime.test.ts      mock-Host surface + behavior
  thRuntimeShapes.test.ts shape mappers
```

`shared/thRuntime` imports **nothing realm-specific** (no `electron`, `window`, Zustand, `fs`) — only its
own types. Both the renderer build and the preload build import it.

## 4. The `Host` seam (full signature)

```ts
export type CardCtx = { profileId: string; chatId: string; characterId: string }
export type VarOp = { op: 'add' | 'remove' | 'replace' | 'set'; path: string; value?: any }
export type ThMessage = { message_id: number; role: 'user' | 'assistant'; message: string; name?: string }
export type StMessage = {
  is_user: boolean; name: string; mes: string; send_date: string
  swipes: string[]; swipe_id: number; extra: Record<string, any>
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
  userInput?: string; prompt?: string; systemPrompt?: string
  maxChatHistory?: number; maxTokens?: number; overrides?: any
}

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
```

## 5. `thRuntime` responsibilities & canonical behavior

`createThRuntime(host)` returns `ThGlobals` = `{ TavernHelper, ...helpers, Mvu, SillyTavern, EjsTemplate,
toastr, tavern_events, __rptDispose }`. It owns:

- **`statData` cache** — seeded from `host.statData()` at construction; refreshed in the
  `host.onVarsChanged` callback. All sync reads serve from the cache. Writes update the cache
  optimistically, then call `host.applyVariableOps` / `host.setVariables`.
- **Event bus** — local `on/emit/off`. `host.onHostEvent` feeds host-pushed `tavern_events` into it.
  On a var change, emit the MVU lifecycle events + `MESSAGE_UPDATED` (preserving today's behavior).
- **Shape derivation** (via `shapes.ts`, the single source) from `host.floors()`:
  `getChatMessages` → `floorsToThMessages` (flat list, **sequential ids** `0..N-1`; floor *i* →
  user `2i`, assistant `2i+1` — equivalent to today's inline ids, now produced once);
  `getCurrentMessageId` → `currentMessageId`; `SillyTavern.chat` → `floorsToStChat` (with
  `host.charData().name` / `host.personaName()`).
- **Normalization** — `generate`/`generateRaw` snake→camel mapping, written once.
- **The objects** — `TavernHelper` helpers (bare + namespaced), `Mvu` (cache reads + `host` writes + bus
  events), `SillyTavern` (`getContext`, `chat`, `substituteParams`, `saveChat`→`host.saveChat`,
  `reloadCurrentChat`→`host.reloadChat`), `EjsTemplate` (delegates to `host.evalTemplate` /
  `evalTemplateError`), console-based `toastr`, `errorCatched`, `waitGlobalInitialized()→true`,
  `getTavernHelperVersion()→'4.3.17'` (constant, as today).
- **`__rptDispose`** — calls the unsub fns returned by `host.onVarsChanged` / `host.onHostEvent`.

**Convergence decisions (the only intended behavior changes):**
- **Chat messages / current id:** one mapping in `shapes.ts` fed by `host.floors()`. Removes the
  inline-shim-builds-it vs main-IPC-builds-it split. Canonical shape `{message_id, role, message}` with
  sequential ids. (The WCV adapter gains a `wcv-host-get-floors-sync` IPC returning raw floors; the older
  `…-get-messages-sync` / `…-get-chat-sync` handlers are no longer used by the shim.)
- **Worldbook:** `{name, entries}` via the service-backed path on both transports.
- Everything else: behavior preserved.

## 6. The adapters

**Inline (`createInlineHost(ctx)`):** sync getters read Zustand (`useChatStore`/`useCharacterStore`/
`usePresetStore`/`useRegexStore`/`useSettingsStore`) exactly as `createCardBridge` does today; async ops
call `window.api.*` with the existing optimistic `chatStore.applyVariableOps` semantics;
`onVarsChanged` wraps `useChatStore.subscribe`; `onHostEvent` is a no-op (inline has no host-push channel
yet — unchanged from today); `evalTemplate` uses the renderer's shared engine
(`shared/templateEngine.evalTemplate` + `buildRenderContext`); `setInput` routes to the composer store
(same effect as WCV's `wcv-host-set-input`) — or a no-op for SP1 if the composer API isn't a clean fit,
since inline cards don't drive onboarding (verify the composer store's surface before wiring).

**WCV (`createWcvHost()`):** sync getters use `ipcRenderer.sendSync('wcv-host-…')` (existing handlers +
the new `…-get-floors-sync`); async ops use `ipcRenderer.invoke`; `onVarsChanged` wraps
`ipcRenderer.on('wcv-vars-changed')` (seeded by the existing sync read); `onHostEvent` wraps
`ipcRenderer.on('wcv-event')`; `evalTemplate` uses the WCV's own quickjs singlefile engine (kept in the
adapter); `setInput` → `ipcRenderer.send('wcv-host-set-input')`. `ctx` is resolved as today.

**Stays in the transport (NOT in `thRuntime`):** lib injection (`cardLibs` global `<script>`s for inline
vs lazy `require` for WCV), the `buildCardDoc` document wrap, and the layout bridge (inline parent-side
measure in `InlineCardFrame` vs WCV's `wcv-content-size` report + wheel-chaining). These are realm/process
specific and unrelated to the TH surface.

## 7. Migration (strangler — app builds & runs at every step)

1. Land `shared/thRuntime` (`types.ts`, `shapes.ts`, `index.ts`) + the two test files. No wiring yet.
2. Add `createInlineHost`; rewrite `createCardBridge` to `return createThRuntime(createInlineHost(ctx))`
   (lib-global assignment stays in the cardBridge `index.ts`). Verify inline cards (ellia, 角色查看器)
   render + variable writes/generate still work.
3. Add `wcv-host-get-floors-sync` IPC; add `createWcvHost`; rewrite `wcvPreload` to
   `Object.assign(window, createThRuntime(createWcvHost()))` keeping the layout/lib/EJS-engine bootstrap.
   Verify WCV cards.
4. Delete the now-dead duplicated surface from both files.

## 8. Tests

- `test/thRuntimeShapes.test.ts` — `floorsToThMessages` (ids, roles, content, empty), `floorsToStChat`
  (names, swipes/swipe_id passthrough, user/assistant ordering), `currentMessageId` (0 floors → 0).
- `test/thRuntime.test.ts` — construct with a **mock Host**; assert: the full surface exists (bare +
  `TavernHelper.*` + `Mvu` + `SillyTavern` + `EjsTemplate` + `tavern_events`); sync getters read the
  cache; `onVarsChanged` refreshes the cache and emits MVU + `MESSAGE_UPDATED`; `setMvuVariable` updates
  the cache optimistically and calls `host.applyVariableOps`; `generate`/`generateRaw` snake→camel
  mapping reaches the mock host; `errorCatched` swallows throws and rejections; `__rptDispose` unsubs.
- Adapter wiring is verified manually (needs Electron — no jsdom layout/IPC). Existing suites must stay
  green.

## 9. Build / realm notes

- Confirm `electron.vite.config.ts` bundles `src/shared/**` into the **preload** output (the renderer
  already imports shared modules). If not, add it — `thRuntime` must resolve in the preload realm.
- Keep the WCV quickjs singlefile variant in `wcvHost`/`wcvPreload` (it backs `host.evalTemplate`); the
  inline host backs `host.evalTemplate` with the renderer's already-initialized engine. `thRuntime` never
  imports a quickjs variant.
- `any` stays intentional at the card boundary (the repo disables `no-explicit-any`).

## 10. Acceptance criteria

- `shared/thRuntime` + both adapters landed; `createCardBridge` and `wcvPreload` no longer duplicate the
  surface (each is adapter + `createThRuntime`).
- New unit tests pass; full `npm test`, `npm run typecheck`, `npm run build` green; no new lint errors.
- Manual: inline + WCV cards (ellia, 角色查看器) render and their variable-write / generate paths work.
- Any behavior change is limited to the §5 convergence and noted in the commit.
