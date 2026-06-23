# Dual-mode inline card rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render scripted "beautification" cards either **inline** (a same-origin `srcdoc` iframe embedded in the message DOM, scrolls with the chat, grows to content) or **isolated** (the existing `WebContentsView`), with a global default + per-card override, and full TavernHelper/Mvu/SillyTavern/EJS API parity in both modes.

**Architecture:** Scripted card blocks (the `isInteractiveHtml` branch in `MessageContent`) route by **resolved mode = per-card override ?? global default**. Inline mode embeds a same-origin sandboxed (`allow-scripts allow-same-origin`) `srcdoc` iframe; a parse-time bootstrap script pulls a renderer-hosted **card bridge** (`window.parent.__rptCardBridge`) for the API globals (synchronous, same realm) and loads the DOM libraries (Vue/jQuery) as iframe-realm global builds. Isolated mode is the existing `WcvMessageFrame`, unchanged. Per-card mode rides on the regex `_meta` sidecar and is carried to render time by an HTML-comment marker the render-time regex applier emits, which `splitHtml` parses.

**Tech Stack:** Electron, React + zustand (renderer), TypeScript, Vite, quickjs-emscripten (shared `templateEngine.ts`, already initialized in the renderer), DOMPurify, vitest.

## Global Constraints

- **Clean-room only.** Do NOT vendor or copy from js-slash-runner / TavernHelper (AFPL/non-free). The card bridge is an independent implementation of the same *surface*.
- **Cards are trusted.** No card sandboxing/CSP-as-security; the WCV process boundary is the only isolation, and that's opt-in. CSP changes are about letting trusted cards load assets.
- **Full API parity in both modes.** Any card must work identically in inline or isolated mode: the complete TavernHelper / Mvu / SillyTavern surface, the EJS engine, and the library globals (Vue, jQuery, lodash, zod, toastr) — including the **synchronous** getters.
- **Do not remove the WCV path.** `WcvMessageFrame` + `wcvManager` + `wcvPreload` stay as the isolated mode.
- **Shared, pure code stays pure.** `src/shared/*` imports nothing from `src/main` or `src/renderer`.
- **Render mode union is exactly** `'inline' | 'isolated'`; the global default is `'inline'`.
- **Mode marker literal is exactly** `<!--rpt:mode=inline-->` / `<!--rpt:mode=isolated-->` (no spaces inside the directive; matcher tolerates surrounding whitespace).

---

## File structure

**New**
- `src/shared/cardRenderMode.ts` — the `CardRenderMode` union + `DEFAULT_CARD_RENDER_MODE` + `resolveCardMode()`.
- `src/renderer/src/components/cardDoc.ts` — `buildCardDoc(html, { headInject })` (moved out of `WcvMessageFrame`, generalized).
- `src/renderer/src/cardBridge/createCardBridge.ts` — `createCardBridge(ctx)` → the API globals object (reads renderer stores synchronously; writes via `window.api`).
- `src/renderer/src/cardBridge/index.ts` — installs `window.__rptCardBridge` on module load.
- `src/renderer/src/cardBridge/cardLibs.ts` — the iframe-realm library global-build URLs (`?url` imports).
- `src/renderer/src/components/InlineCardFrame.tsx` — the same-origin inline iframe + bootstrap + auto-height.
- Tests: `test/cardRenderMode.test.ts`, `test/cardDoc.test.ts`, `test/regexMarker.test.ts`, `test/splitHtmlMode.test.ts`, `test/scopeMetaRenderMode.test.ts`, `test/regexRenderMode.test.ts`.

**Changed**
- `src/renderer/index.html` — scoped CSP loosening.
- `src/renderer/src/components/MessageContent.tsx` — `splitHtml` parses the mode marker; route interactive cards by resolved mode.
- `src/renderer/src/components/WcvMessageFrame.tsx` — import `buildCardDoc` from `./cardDoc` (no behavior change).
- `src/shared/regexTransform.ts` — export `isCardPayload`; add `marker` apply option.
- `src/shared/regexTypes.ts` — `RenderRegexRule.renderMode?`, `RegexScriptInfo.renderMode?`.
- `src/shared/artifactScope.ts` — `ScopeMeta.renderMode?`.
- `src/main/services/scopeMeta.ts` — `setRenderMode()` + prune update.
- `src/main/services/regexService.ts` — `setScriptRenderMode()`, attach `renderMode` in `getAllRules`/`listScripts`.
- `src/main/ipc/regexIpc.ts` — `regex-set-render-mode` handler.
- `src/preload/index.ts` — `setRegexRenderMode` method.
- `src/renderer/src/stores/regexStore.ts` — `setRenderMode` action; pass the `marker` option in `apply`.
- `src/renderer/src/components/RegexPanel.tsx` — per-script Default/Inline/Isolated selector.
- `src/main/types/models.ts` + `src/main/services/settingsService.ts` + `src/renderer/src/stores/settingsStore.ts` + `src/renderer/src/components/SettingsPanel.tsx` — `cards.renderMode` setting.
- `test/wcvCardDoc.test.ts` — update `buildCardDoc` import path.

**Reused / unchanged**
- `rpt-card://` scheme + `wcvManager` (isolated mode only).
- `src/shared/templateEngine.ts` + `src/renderer/src/plugin/rendererEngine.ts` (engine already initialized in the renderer) + `src/renderer/src/plugin/renderTemplate.ts` (`buildRenderContext`).
- `HtmlFrame` (static, script-free cards) — unchanged.

---

## Conventions for this plan

- Run a single test file with: `npx vitest run test/<file>.test.ts`
- Run the full suite with: `npm test`
- Type-check with: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json` (use whichever the repo's `npm run typecheck`/`lint` wraps — check `package.json` scripts; if a `typecheck` script exists, prefer `npm run typecheck`).
- "Commit" steps assume the working tree is otherwise clean; stage only the files the task touched.

---

# Phase A — Foundations

## Task A1: `CardRenderMode` type + `resolveCardMode`

**Files:**
- Create: `src/shared/cardRenderMode.ts`
- Test: `test/cardRenderMode.test.ts`

**Interfaces:**
- Produces: `type CardRenderMode = 'inline' | 'isolated'`; `const DEFAULT_CARD_RENDER_MODE: CardRenderMode`; `resolveCardMode(override: CardRenderMode | undefined, globalDefault: CardRenderMode): CardRenderMode`.

- [ ] **Step 1: Write the failing test**

```ts
// test/cardRenderMode.test.ts
import { describe, it, expect } from 'vitest'
import {
  resolveCardMode,
  DEFAULT_CARD_RENDER_MODE
} from '../src/shared/cardRenderMode'

describe('resolveCardMode', () => {
  it('uses the override when present', () => {
    expect(resolveCardMode('isolated', 'inline')).toBe('isolated')
    expect(resolveCardMode('inline', 'isolated')).toBe('inline')
  })
  it('falls back to the global default when no override', () => {
    expect(resolveCardMode(undefined, 'isolated')).toBe('isolated')
    expect(resolveCardMode(undefined, 'inline')).toBe('inline')
  })
  it('defaults to inline', () => {
    expect(DEFAULT_CARD_RENDER_MODE).toBe('inline')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/cardRenderMode.test.ts`
Expected: FAIL — cannot find module `../src/shared/cardRenderMode`.

- [ ] **Step 3: Implement**

```ts
// src/shared/cardRenderMode.ts
/**
 * Card render mode — shared by main (regex _meta) and renderer (routing + settings).
 * Pure (no node/electron/DOM).
 *
 * - inline:   same-origin srcdoc iframe embedded in the message DOM (native feel).
 * - isolated: out-of-process WebContentsView overlay (crash-isolated).
 */
export type CardRenderMode = 'inline' | 'isolated'

export const DEFAULT_CARD_RENDER_MODE: CardRenderMode = 'inline'

/** Effective mode for a card block: a per-card override wins, else the global default. */
export const resolveCardMode = (
  override: CardRenderMode | undefined,
  globalDefault: CardRenderMode
): CardRenderMode => override ?? globalDefault
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run test/cardRenderMode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/cardRenderMode.ts test/cardRenderMode.test.ts
git commit -m "feat(cards): shared CardRenderMode type + resolveCardMode"
```

---

## Task A2: Global-default setting (`cards.renderMode`)

**Files:**
- Modify: `src/main/types/models.ts` (the `Settings` interface)
- Modify: `src/main/services/settingsService.ts:61-137` (`getDefaultSettings`) and `:144-225` (`normalize`)
- Modify: `src/renderer/src/stores/settingsStore.ts` (the renderer `Settings` interface)
- Modify: `src/renderer/src/components/SettingsPanel.tsx` (add the control)

**Interfaces:**
- Consumes: `CardRenderMode` from `src/shared/cardRenderMode` (Task A1).
- Produces: `settings.cards.renderMode: CardRenderMode` readable in the renderer; default `'inline'`; persisted through `normalize`.

**Why no TDD test here:** this is wiring an optional settings field through an existing typed pipeline; `normalize` returns an explicit allowlist, so the only failure mode (the field being dropped on save) is covered by manual verification in Step 5. Settings have no unit-test harness in this repo.

- [ ] **Step 1: Add `cards` to the main `Settings` type**

In `src/main/types/models.ts`, find the `Settings` interface (it declares `templates`, `ui`, etc.). Add the import at the top and a `cards` field:

```ts
import type { CardRenderMode } from '../../shared/cardRenderMode'
```

Add inside `interface Settings { ... }` (place it next to `templates`):

```ts
  /** Card rendering: the global default mode for scripted beautification cards. */
  cards: {
    renderMode: CardRenderMode
  }
```

- [ ] **Step 2: Default it**

In `src/main/services/settingsService.ts`, inside `getDefaultSettings()` (after the `templates: { ... }` block, before `modes:`), add:

```ts
  cards: {
    renderMode: 'inline'
  },
```

- [ ] **Step 3: Merge it in `normalize`**

In `normalize()`, add a merge line near the other section merges (e.g. after `const cache = ...`):

```ts
  const cards = { ...d.cards, ...(stored.cards || {}) }
```

and add `cards` to the returned object literal (the `return { api, ..., pricing }` block):

```ts
    cards,
```

- [ ] **Step 4: Mirror the field in the renderer `Settings` type**

In `src/renderer/src/stores/settingsStore.ts`, add to the exported `Settings` interface (next to `templates`):

```ts
  cards?: {
    renderMode: 'inline' | 'isolated'
  }
```

(Optional here because the renderer reads it defensively with `?? 'inline'`.)

- [ ] **Step 5: Add the Settings UI control**

In `src/renderer/src/components/SettingsPanel.tsx`, inside the `{settings && ( <> ... </> )}` block (after the "Agent Mode" `<select>` block, before the "Show FPS" toggle), add:

```tsx
            <label className="field-label" style={{ marginTop: 18 }}>
              Card rendering (default)
            </label>
            <select
              value={settings.cards?.renderMode ?? 'inline'}
              onChange={(e) =>
                updateSettings(profileId, {
                  cards: { renderMode: e.target.value as 'inline' | 'isolated' }
                })
              }
              style={{ width: '100%' }}
            >
              <option value="inline">Inline (native, embedded in the message)</option>
              <option value="isolated">Isolated (crash-resistant overlay window)</option>
            </select>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              <b>Inline</b>: beautification cards render directly in the chat and scroll with it.{' '}
              <b>Isolated</b>: each card runs in its own process — safest for heavy cards. Per-card
              overrides live in the Regex panel.
            </div>
```

- [ ] **Step 6: Type-check + manual verify**

Run: `npx tsc --noEmit` (or `npm run typecheck`).
Expected: no new type errors.

Manual: `npm run dev`, open Settings, change "Card rendering (default)" to Isolated, restart the app, confirm it persisted (the select shows Isolated). This proves `normalize` kept the field.

- [ ] **Step 7: Commit**

```bash
git add src/main/types/models.ts src/main/services/settingsService.ts src/renderer/src/stores/settingsStore.ts src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(cards): global default card render mode setting"
```

---

## Task A3: Move `buildCardDoc` to a shared `cardDoc.ts` with a `headInject` option

**Files:**
- Create: `src/renderer/src/components/cardDoc.ts`
- Modify: `src/renderer/src/components/WcvMessageFrame.tsx:37-46` (remove local `buildCardDoc`, import it) and `:18-24` (the `CSP` const moves with usage)
- Modify: `test/wcvCardDoc.test.ts` (import path)
- Test: `test/cardDoc.test.ts`

**Interfaces:**
- Produces: `buildCardDoc(html: string, opts?: { headInject?: string }): string` — full doc: inject `headInject` at the very start of `<head>`; bare fragment: wrap `<body>` inner in a doc whose `<head>` is exactly `headInject`.
- Consumes (callers): WCV passes `headInject` = its CSP `<meta>`; `InlineCardFrame` (Task B2) passes the bootstrap.

- [ ] **Step 1: Write the failing test**

```ts
// test/cardDoc.test.ts
import { describe, it, expect } from 'vitest'
import { buildCardDoc } from '../src/renderer/src/components/cardDoc'

describe('buildCardDoc', () => {
  it('injects headInject at the start of an existing <head>, preserving styles/links', () => {
    const html =
      '<!doctype html><html><head><style>.x{color:red}</style><link rel="stylesheet" href="a.css"></head><body><div id="app"></div></body></html>'
    const out = buildCardDoc(html, { headInject: '<!--MARK-->' })
    expect(out).toContain('<head><!--MARK--><style>.x{color:red}</style>')
    expect(out).toContain('<link rel="stylesheet" href="a.css">')
    expect(out).toContain('<div id="app"></div>')
  })

  it('keeps <head> attributes', () => {
    const out = buildCardDoc('<html><head lang="en"></head><body>x</body></html>', {
      headInject: '<!--M-->'
    })
    expect(out).toContain('<head lang="en"><!--M-->')
  })

  it('wraps a bare fragment, using headInject as the head', () => {
    const out = buildCardDoc('<div>hi</div>', { headInject: '<!--M-->' })
    expect(out).toContain('<head><!--M--></head>')
    expect(out).toContain('<body><div>hi</div></body>')
  })

  it('takes <body> inner when given a bare body', () => {
    const out = buildCardDoc('<body class="c"><p>x</p></body>', { headInject: '' })
    expect(out).toContain('<body><p>x</p></body>')
  })

  it('defaults headInject to empty string', () => {
    const out = buildCardDoc('<html><head></head><body>z</body></html>')
    expect(out).toContain('<head></head>')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/cardDoc.test.ts`
Expected: FAIL — cannot find module `cardDoc`.

- [ ] **Step 3: Create `cardDoc.ts`**

```ts
// src/renderer/src/components/cardDoc.ts
/**
 * Build the document a card runs inside, from the regex-injected block.
 *
 * The block is EITHER a full `<!doctype html>` document — whose `<style>`/font `<link>` live in
 * `<head>` (the static beautification cards) — OR a bare `<body>`/fragment whose script loads its
 * UI (the loader cards). We must keep the `<head>` for the former: stripping it drops ALL the card's
 * CSS (including its `html,body{background:transparent}`), so the card paints as an oversized white
 * box of unstyled text. `headInject` is placed at the very START of `<head>` so the host's additions
 * (CSP meta for WCV; the bootstrap + library globals for the inline iframe) run before the card's own
 * head content.
 */
export function buildCardDoc(html: string, opts: { headInject?: string } = {}): string {
  const inject = opts.headInject ?? ''
  // Full document: keep it intact (doctype/head/styles/body/script); inject at head start.
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${inject}`)
  }
  // Bare fragment: take the <body> inner if present, else the whole string, and wrap it.
  const inner = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html
  return `<!doctype html><html><head>${inject}</head><body>${inner}</body></html>`
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run test/cardDoc.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Refactor `WcvMessageFrame` to use it**

In `src/renderer/src/components/WcvMessageFrame.tsx`:

1. Add the import at the top:
```ts
import { buildCardDoc } from './cardDoc'
```
2. Delete the local `export function buildCardDoc(html: string): string { ... }` (lines ~37–46) and its doc comment.
3. Keep the `CSP` const (lines ~18–24). Change the `dataUrl` memo (lines ~62–65) to pass the CSP as `headInject`:
```ts
  const dataUrl = useMemo(
    () =>
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        buildCardDoc(html, {
          headInject: `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`
        })
      ),
    [html]
  )
```
(`CARD_SCHEME` serving in `wcvManager` decodes this same data URL — no main-side change; the doc bytes are identical to before, just sourced via the option.)

- [ ] **Step 6: Update the existing WCV doc test's import**

In `test/wcvCardDoc.test.ts`, change the import of `buildCardDoc` from `'../src/renderer/src/components/WcvMessageFrame'` to `'../src/renderer/src/components/cardDoc'`. If a test asserted the CSP `<meta>` was injected by `buildCardDoc` itself, update it to pass `{ headInject: '<meta ...>' }` and assert that, OR delete those CSP-specific assertions (CSP injection is now the caller's responsibility, covered in Task B/manual). Keep the head-preservation assertions.

- [ ] **Step 7: Run both doc tests**

Run: `npx vitest run test/cardDoc.test.ts test/wcvCardDoc.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/cardDoc.ts src/renderer/src/components/WcvMessageFrame.tsx test/cardDoc.test.ts test/wcvCardDoc.test.ts
git commit -m "refactor(cards): extract buildCardDoc to shared cardDoc with headInject option"
```

---

## Task A4: Loosen the renderer CSP, scoped to trusted CDN hosts

**Files:**
- Modify: `src/renderer/index.html:16-19` (the CSP `<meta>`)

**Why now:** inline cards load their ESM (gsap/pinia/js-yaml) and fonts from CDNs and the iframe inherits this CSP. Without this, the Phase B manual test can't load any real card.

**No automated test** (CSP is environment-level; verified by the Phase B manual test). This is a single, reviewable line change.

- [ ] **Step 1: Replace the CSP meta**

In `src/renderer/index.html`, replace the `content="..."` of the CSP `<meta>` (line 18) with the scoped allowlist below. Keep the explanatory comment above it and extend it to note the inline-card CDN allowance.

```html
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self';
        script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:
          https://cdn.jsdelivr.net https://fastly.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com;
        style-src 'self' 'unsafe-inline'
          https://cdn.jsdelivr.net https://fastly.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com https://fonts.googleapis.com;
        font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;
        img-src 'self' data: blob: https:;
        connect-src 'self' data: blob:
          https://cdn.jsdelivr.net https://fastly.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com;
        media-src 'self' data: blob: https:"
    />
```

(The CSP `content` may be a single line; the multi-line form above is for readability — collapse it to one line if the build complains about newlines in the attribute. Newlines between directives are valid CSP, but keep semicolons.)

- [ ] **Step 2: Sanity-run the app**

Run: `npm run dev`
Expected: app loads, existing functionality unaffected, no new CSP violations in the console for the app's own assets. (Card CDN loads are exercised in Phase B.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(cards): loosen renderer CSP scoped to trusted card CDNs"
```

---

# Phase B — Inline rendering (default mode)

## Task B1: The renderer card bridge (`createCardBridge` + install)

**Files:**
- Create: `src/renderer/src/cardBridge/createCardBridge.ts`
- Create: `src/renderer/src/cardBridge/index.ts`
- Modify (later, B2): imported by `InlineCardFrame`

**Interfaces:**
- Consumes (synchronous store reads): `useChatStore`, `useCharacterStore`, `usePresetStore`, `useRegexStore`, `useProfileStore`, `useSettingsStore` (`.getState()`); the EJS engine via `evalTemplate` + `buildRenderContext` from `src/renderer/src/plugin/renderTemplate`.
- Consumes (async writes): `window.api.applyVariableOps`, `window.api.generate`, `window.api.generateRaw`, `window.api.getLorebook`, `window.api.saveLorebook`, `window.api.editFloor` (see B-Phase-C tasks for write wiring; B1 ships reads + stubs that don't throw).
- Produces: `createCardBridge(ctx: CardCtx): Record<string, unknown>` returning the globals object; `installCardBridge()` setting `window.__rptCardBridge`.
- `type CardCtx = { profileId: string; chatId: string; characterId: string }`.

**This is the API contract.** The bridge mirrors the surface of `src/preload/wcvPreload.ts`, but with two transport differences: **sync getters read renderer zustand stores** (not `ipcRenderer.sendSync`), and **async ops call `window.api.*`** (not `ipcRenderer.invoke`). Below is the complete core; the long-tail methods (audio stubs, rarely-used getters) follow the same patterns and are listed in the **method map** table — implement each per its category. Mark none of these "TODO"; each table row specifies its exact transport.

- [ ] **Step 1: Implement the bridge core**

```ts
// src/renderer/src/cardBridge/createCardBridge.ts
//
// Renderer-side card API bridge — the SAME TavernHelper/Mvu/SillyTavern/EJS surface as the WCV
// preload (src/preload/wcvPreload.ts), but for same-origin inline iframes. Sync getters read the
// renderer's live zustand stores; async ops go through window.api. Clean-room: not derived from JSR.
//
// Dynamically typed throughout (card args are user-supplied) — `any` is intentional, matching
// wcvPreload.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { evalTemplate } from '../../../shared/templateEngine'
import { buildRenderContext } from '../plugin/renderTemplate'

export type CardCtx = { profileId: string; chatId: string; characterId: string }

// --- live store reads (always the active chat/character the card is rendered in) -----------------
const latestFloor = (): any => {
  const floors = useChatStore.getState().floors
  return floors[floors.length - 1]
}
const latestVars = (): Record<string, any> => latestFloor()?.variables ?? {}
const statData = (): any => {
  const v = latestVars()
  return v && typeof v === 'object' && 'stat_data' in v ? (v as any).stat_data : v
}
const cardData = (): any => useCharacterStore.getState().activeCharacter?.card?.data ?? null

// --- per-frame event bus (mirrors wcvPreload's local bus) ---------------------------------------
const makeBus = (): {
  on: (n: string, cb: (...a: any[]) => void) => void
  emit: (n: string, ...a: any[]) => void
  off: (n: string, cb: (...a: any[]) => void) => void
} => {
  const map: Record<string, Array<(...a: any[]) => void>> = {}
  return {
    on: (n, cb) => {
      ;(map[n] ||= []).push(cb)
    },
    emit: (n, ...a) => {
      for (const cb of map[n] || []) {
        try {
          cb(...a)
        } catch (e) {
          console.error('[rpt card event]', n, e)
        }
      }
    },
    off: (n, cb) => {
      map[n] = (map[n] || []).filter((f) => f !== cb)
    }
  }
}

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

// errorCatched(fn): wrap fn, swallow + log throws/rejections (cards call it bare in onMounted).
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

const toastr = {
  success: (m?: any) => console.info('[toast]', m),
  error: (m?: any) => console.error('[toast]', m),
  info: (m?: any) => console.info('[toast]', m),
  warning: (m?: any) => console.warn('[toast]', m),
  clear: () => {},
  remove: () => {},
  options: {}
}

export function createCardBridge(ctx: CardCtx): Record<string, unknown> {
  const bus = makeBus()

  // ---- EjsTemplate: reuse the renderer's already-initialized shared engine -----------------------
  const EjsTemplate = {
    evalTemplate: (tmpl: string, _data?: any): string =>
      evalTemplate(tmpl, buildRenderContext(latestVars())),
    prepareContext: (_data?: any) => buildRenderContext(latestVars()),
    getSyntaxErrorInfo: (_tmpl: string, _data?: any) => null,
    allVariables: () => statData(),
    saveVariables: (_vars: any) => true,
    compileTemplate: (tmpl: string) => () => evalTemplate(tmpl, buildRenderContext(latestVars())),
    setFeatures: () => undefined,
    getFeatures: () => ({}),
    resetFeatures: () => undefined,
    refreshWorldInfo: () => undefined,
    defines: {},
    initialVariables: () => statData()
  }

  // ---- TavernHelper helpers (bare globals) ------------------------------------------------------
  const helpers: Record<string, any> = {
    // SYNC getters (store reads)
    getVariables: (_opts?: any) => ({ stat_data: statData() }),
    getChatMessages: (..._a: any[]) => {
      const floors = useChatStore.getState().floors
      const out: any[] = []
      floors.forEach((f: any, i: number) => {
        out.push({ message_id: i * 2, role: 'user', message: f.user_message?.content ?? '' })
        out.push({ message_id: i * 2 + 1, role: 'assistant', message: f.response?.content ?? '' })
      })
      return out
    },
    getCurrentMessageId: () => {
      const n = useChatStore.getState().floors.length
      return n > 0 ? n * 2 - 1 : 0
    },
    getTavernHelperVersion: () => '4.3.17',
    getCharData: (..._a: any[]) => cardData(),
    getCharAvatarPath: (..._a: any[]) => null,
    getPreset: (..._a: any[]) => {
      const p = usePresetStore.getState().preset
      return p ? { name: p.name, parameters: p.parameters } : null
    },
    getPresetNames: (..._a: any[]) => usePresetStore.getState().presets.map((p: any) => p.name),
    getCharWorldbookNames: (..._a: any[]) => ({ primary: null, additional: [] }), // refined in Phase C
    getWorldbookNames: (..._a: any[]) => [],
    getCurrentCharPrimaryLorebook: () => null,
    getCharLorebooks: (..._a: any[]) => [],
    getTavernRegexes: (..._a: any[]) =>
      useRegexRules().map((r: any) => ({ find: r.source, replace: r.replace })),
    formatAsTavernRegexedString: (text: any, ..._a: any[]) =>
      useChatStore.getState() && typeof text === 'string'
        ? // reuse the renderer's display regex applier
          (window as any).api && useRegexApply(text),

    // EVENT bus
    eventOn: (n: string, cb: any) => bus.on(n, cb),
    eventMakeFirst: (n: string, cb: any) => bus.on(n, cb),
    eventOnce: (n: string, cb: any) => bus.on(n, cb),
    eventEmit: (n: string, ...a: any[]) => bus.emit(n, ...a),
    eventRemoveListener: (n: string, cb: any) => bus.off(n, cb),

    // misc sync stubs (parity with wcvPreload)
    waitGlobalInitialized: async (..._a: any[]) => true,
    substitudeMacros: (text: string) => text,
    getLorebookSettings: () => ({}),
    setLorebookSettings: () => {},
    audioImport: () => {},
    audioPlay: () => {},
    audioPause: () => {},
    audioMode: () => {},
    audioEnable: () => {},
    errorCatched,

    // ASYNC ops — implemented in Phase C; here they no-op safely so a read-only card never crashes.
    replaceVariables: async (..._a: any[]) => undefined,
    insertOrAssignVariables: async (..._a: any[]) => undefined,
    updateVariablesWith: async (..._a: any[]) => undefined,
    setChatMessages: async (..._a: any[]) => false,
    deleteChatMessages: async (..._a: any[]) => false,
    createChat: async (..._a: any[]) => '',
    createChatMessages: async (..._a: any[]) => '',
    triggerSlash: async (..._a: any[]) => '',
    generate: async (..._a: any[]) => '',
    generateRaw: async (..._a: any[]) => '',
    getWorldbook: async (..._a: any[]) => [],
    replaceWorldbook: async (..._a: any[]) => false,
    updateWorldbookWith: async (..._a: any[]) => [],
    getLorebookEntries: async (..._a: any[]) => [],
    replaceTavernRegexes: async (..._a: any[]) => undefined
  }

  // ---- Mvu ---------------------------------------------------------------------------------------
  const Mvu = {
    getMvuData: (_o?: any) => ({ stat_data: statData(), schema: {} }),
    getMvuVariable: (_d: any, path: string, o?: any) => {
      const v = getByPath(statData(), path)
      return v === undefined ? o?.default_value : v
    },
    setMvuVariable: (_d: any, _path: string, _value: any, _o?: any) => undefined, // write: Phase C
    replaceMvuData: (_d: any, _o?: any) => undefined, // write: Phase C
    parseMessage: (..._a: any[]) => undefined,
    reloadInitVar: (..._a: any[]) => undefined,
    events: MVU_EVENTS
  }

  // ---- SillyTavern -------------------------------------------------------------------------------
  const stChat = (): any[] => {
    const floors = useChatStore.getState().floors
    const charName = cardData()?.name || 'Character'
    const userName = useSettingsName()
    const out: any[] = []
    floors.forEach((f: any) => {
      out.push({
        is_user: true,
        name: userName,
        mes: f.user_message?.content ?? '',
        send_date: '',
        swipes: [],
        swipe_id: 0,
        extra: {}
      })
      out.push({
        is_user: false,
        name: charName,
        mes: f.response?.content ?? '',
        send_date: '',
        swipes: f.swipes ?? [f.response?.content ?? ''],
        swipe_id: f.swipe_id ?? 0,
        extra: {}
      })
    })
    return out
  }
  const eventSource = {
    on: bus.on,
    emit: bus.emit,
    makeFirst: bus.on,
    once: bus.on,
    removeListener: bus.off
  }
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
    substituteParams: (text: string) => text,
    saveChat: async () => true, // write: Phase C
    reloadCurrentChat: async () => true
  }

  return {
    TavernHelper: helpers,
    ...helpers,
    Mvu,
    SillyTavern,
    tavern_events: TAVERN_EVENTS,
    EjsTemplate,
    toastr,
    _: undefined, // overwritten below by index.ts globals (lodash)
    z: undefined
  }
}

// --- small helpers ------------------------------------------------------------------------------
function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((c: any, k) => (c == null ? c : c[k]), obj)
}

// Lazy imports to avoid a static cycle through stores at module load.
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
const useRegexRules = (): any[] => useRegexStore.getState().rules
const useRegexApply = (text: string): string => useRegexStore.getState().apply(text)
const useSettingsName = (): string => useSettingsStore.getState().settings?.persona?.name || 'User'
```

> **Implementer note (not a placeholder):** the `formatAsTavernRegexedString` body above is written awkwardly to show intent — simplify it to:
> ```ts
> formatAsTavernRegexedString: (text: any, ..._a: any[]) =>
>   typeof text === 'string' ? useRegexStore.getState().apply(text) : text,
> ```
> and move the three `import`/`const` helpers (`useRegexStore`, `useSettingsStore`, etc.) to the top of the file with the other imports (the trailing placement above is only to keep the diff readable; consolidate on implementation).

- [ ] **Step 2: Install the bridge globally**

```ts
// src/renderer/src/cardBridge/index.ts
import { createCardBridge, type CardCtx } from './createCardBridge'
import lodash from 'lodash'
import { z } from 'zod'

/**
 * Install window.__rptCardBridge so an inline card's bootstrap (running in a same-origin iframe)
 * can synchronously fetch its API globals via window.parent.__rptCardBridge(ctx). Idempotent.
 * Vue/jQuery are NOT provided here — they must run in the IFRAME's realm (see cardLibs.ts), so they
 * bind to the iframe's document; only realm-safe values (data + pure functions) come from here.
 */
export function installCardBridge(): void {
  if ((window as any).__rptCardBridge) return
  ;(window as any).__rptCardBridge = (ctx: CardCtx): Record<string, unknown> => {
    const g = createCardBridge(ctx)
    // realm-safe pure libs (no DOM): provide from the app bundle.
    g._ = lodash
    g.z = z
    return g
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Fix any from the consolidation note in Step 1.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/cardBridge/createCardBridge.ts src/renderer/src/cardBridge/index.ts
git commit -m "feat(cards): renderer card bridge (reads + EJS + events; writes stubbed)"
```

### Method map (bridge ↔ wcvPreload parity)

Every method already appears in Step 1; this table is the audit checklist — confirm each is present and on the right transport. "store read" = synchronous; "window.api" = async (Phase C); "stub" = parity no-op matching wcvPreload.

| Method | Category | Source |
|---|---|---|
| getVariables, getChatMessages, getCurrentMessageId, getCharData, getPreset, getPresetNames, getTavernRegexes | sync getter | store read |
| getTavernHelperVersion | const | `'4.3.17'` |
| getCharWorldbookNames, getWorldbookNames, getCurrentCharPrimaryLorebook, getCharLorebooks, getCharAvatarPath | sync getter | store read (worldbook refined in C) |
| formatAsTavernRegexedString | sync | `regexStore.apply` |
| eventOn/eventMakeFirst/eventOnce/eventEmit/eventRemoveListener | event | per-frame bus |
| substitudeMacros, getLorebookSettings, setLorebookSettings, waitGlobalInitialized, audio* | stub | parity no-op |
| errorCatched | helper | wrap+log |
| replaceVariables, insertOrAssignVariables, updateVariablesWith, Mvu.setMvuVariable, Mvu.replaceMvuData | async write | window.api (Phase C) |
| setChatMessages, deleteChatMessages, createChatMessages, createChat, triggerSlash | async write | window.api / stub (Phase C) |
| generate, generateRaw | async | window.api (Phase C) |
| getWorldbook, replaceWorldbook, updateWorldbookWith, getLorebookEntries | async | window.api (Phase C) |
| SillyTavern.saveChat, reloadCurrentChat | async | window.api (Phase C) |

---

## Task B2: `InlineCardFrame` component

**Files:**
- Create: `src/renderer/src/cardBridge/cardLibs.ts`
- Create: `src/renderer/src/components/InlineCardFrame.tsx`

**Interfaces:**
- Consumes: `buildCardDoc` (A3); `installCardBridge` (B1); store hooks for ctx; the lib URLs from `cardLibs`.
- Produces: `<InlineCardFrame html onContextMenu? />` — a same-origin sandboxed `srcdoc` iframe that auto-heights to content.

- [ ] **Step 1: Resolve library global-build URLs**

First verify the dist filenames exist:

Run: `ls node_modules/vue/dist/vue.global.prod.js node_modules/jquery/dist/jquery.min.js`
(If `pinia`/`vue-router` are installed and you want global parity, also check `node_modules/pinia/dist/pinia.iife.prod.js` and `node_modules/vue-router/dist/vue-router.global.prod.js`. Only include the ones that exist.)

```ts
// src/renderer/src/cardBridge/cardLibs.ts
//
// DOM-binding libraries the card expects as globals (window.Vue, window.$). They must execute in the
// IFRAME's realm so they bind to the iframe's document and pass cross-realm instanceof checks — so we
// inject them as classic <script src> tags (iframe-realm), NOT by assigning the renderer's Vue onto
// the iframe (that would create nodes in the top document and break Vue's instanceof guards).
// Vite `?url` resolves each to a same-origin asset URL the iframe can load under 'self' CSP.
import vueUrl from 'vue/dist/vue.global.prod.js?url'
import jqueryUrl from 'jquery/dist/jquery.min.js?url'
// If installed and you need global Pinia/VueRouter parity, uncomment after verifying the dist names:
// import piniaUrl from 'pinia/dist/pinia.iife.prod.js?url'
// import vueRouterUrl from 'vue-router/dist/vue-router.global.prod.js?url'

/** Ordered list of classic-script URLs to inject before the card's own scripts (Vue first). */
export const CARD_LIB_URLS: string[] = [
  vueUrl,
  jqueryUrl
  // piniaUrl, vueRouterUrl
]
```

If Vite cannot resolve `?url` for these dist files, add a `vite` types reference (`/// <reference types="vite/client" />`) at the top of the file, or declare the module:
```ts
declare module '*?url' { const url: string; export default url }
```

- [ ] **Step 2: Implement `InlineCardFrame`**

```tsx
// src/renderer/src/components/InlineCardFrame.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { buildCardDoc } from './cardDoc'
import { installCardBridge } from '../cardBridge'
import { CARD_LIB_URLS } from '../cardBridge/cardLibs'

installCardBridge() // idempotent; ensures window.__rptCardBridge exists before any frame mounts.

/**
 * Inline card renderer — the card runs in a SAME-ORIGIN srcdoc iframe embedded in the message DOM.
 * Because the iframe is same-origin (srcdoc inherits the app origin) and sandboxed with BOTH
 * allow-scripts + allow-same-origin, a parse-time bootstrap can reach window.parent.__rptCardBridge
 * SYNCHRONOUSLY for the API globals, and we can measure the content height to auto-size the element
 * (so the card grows into the message column and scrolls with the chat — no inner scrollbar).
 *
 * Trusted-card policy: allow-scripts+allow-same-origin intentionally lifts sandboxing (cards are
 * trusted). The crash-isolated alternative is Isolated (WCV) mode.
 */
export function InlineCardFrame({
  html,
  onContextMenu
}: {
  html: string
  onContextMenu?: (x: number, y: number) => void
}): React.ReactElement {
  const ref = useRef<HTMLIFrameElement>(null)
  const ctxRef = useRef(onContextMenu)
  ctxRef.current = onContextMenu
  const [height, setHeight] = useState(120)

  const profileId = useProfileStore((s) => s.activeProfile?.id ?? '')
  const chatId = useChatStore((s) => s.activeChatId ?? '')
  const characterId = useCharacterStore((s) => s.activeCharacter?.id ?? '')

  const srcDoc = useMemo(() => {
    const ctx = { profileId, chatId, characterId }
    const libTags = CARD_LIB_URLS.map((u) => `<script src="${u}"></script>`).join('')
    // Classic bootstrap: runs synchronously during head parse, BEFORE the card's deferred modules.
    const boot =
      `<meta charset="utf-8">` +
      `<script>(function(){try{` +
      `var ctx=${JSON.stringify(ctx)};` +
      `var g=window.parent.__rptCardBridge(ctx);` +
      `for(var k in g){try{if(g[k]!==undefined)window[k]=g[k];}catch(e){}}` +
      `}catch(e){console.error('[rpt card bridge]',e);}})();</script>` +
      libTags
    return buildCardDoc(html, { headInject: boot })
  }, [html, profileId, chatId, characterId])

  // Auto-height (same-origin: read contentDocument) + right-click forwarding. Mirrors HtmlFrame.
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    const measure = (): void => {
      try {
        const doc = frame.contentDocument
        if (doc?.documentElement) setHeight(doc.documentElement.scrollHeight + 4)
      } catch {
        /* cross-origin guard (shouldn't happen — same origin) */
      }
    }
    const onCtx = (e: Event): void => {
      e.preventDefault()
      const me = e as MouseEvent
      const rect = frame.getBoundingClientRect()
      ctxRef.current?.(rect.left + me.clientX, rect.top + me.clientY)
    }
    const onLoad = (): void => {
      measure()
      try {
        const doc = frame.contentDocument
        const body = doc?.body
        if (body && 'ResizeObserver' in window) {
          observer = new ResizeObserver(measure)
          observer.observe(doc!.documentElement)
        }
        doc?.addEventListener('contextmenu', onCtx)
      } catch {
        /* ignore */
      }
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      observer?.disconnect()
    }
  }, [srcDoc])

  return (
    <iframe
      ref={ref}
      className="card-frame"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block' }}
      title="card content"
    />
  )
}
```

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit` then `npm run dev`
Expected: compiles; the app still loads. (No card is routed to it yet — that's B3.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/cardBridge/cardLibs.ts src/renderer/src/components/InlineCardFrame.tsx
git commit -m "feat(cards): InlineCardFrame same-origin iframe + bootstrap + auto-height"
```

---

## Task B3: Route interactive cards to inline (global default)

**Files:**
- Modify: `src/renderer/src/components/MessageContent.tsx:5-6` (imports), `:40-50` (routing)

**Interfaces:**
- Consumes: `InlineCardFrame` (B2), `WcvMessageFrame` (existing), `resolveCardMode` + `DEFAULT_CARD_RENDER_MODE` (A1), `useSettingsStore` (global default).
- Produces: interactive card segments render via the resolved mode. (Per-segment `mode` arrives in Phase D; here it is always `undefined` → global default.)

**No new unit test** (routing is JSX wiring; covered by the Phase B manual test and the Task D5 `splitHtml` test). `splitHtml` is unchanged in this task.

- [ ] **Step 1: Add imports**

In `src/renderer/src/components/MessageContent.tsx`, add:

```ts
import { InlineCardFrame } from './InlineCardFrame'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveCardMode, DEFAULT_CARD_RENDER_MODE } from '../../../shared/cardRenderMode'
```

- [ ] **Step 2: Read the global default and route**

Inside the `MessageContent` component, before `return`:

```ts
  const globalMode =
    useSettingsStore((s) => s.settings?.cards?.renderMode) ?? DEFAULT_CARD_RENDER_MODE
```

Replace the interactive-card branch (currently `isInteractiveHtml(p.text) ? (<WcvMessageFrame .../>) : (<HtmlFrame .../>)`) with:

```tsx
          isInteractiveHtml(p.text) ? (
            resolveCardMode(undefined, globalMode) === 'isolated' ? (
              <WcvMessageFrame key={i} html={p.text} />
            ) : (
              <InlineCardFrame key={i} html={p.text} onContextMenu={onContextMenu} />
            )
          ) : (
            <HtmlFrame key={i} html={p.text} css={css} onContextMenu={onContextMenu} />
          )
```

(The `undefined` first arg becomes `p.mode` in Task D5.)

- [ ] **Step 3: Manual test — the three cards inline**

Run: `npm run dev`. With default settings (inline), open a chat whose messages trigger the beautification regex for each of:
- **红花戏票** (ticket card) — renders styled, sized to content, scrolls WITH the chat (no inner scrollbar).
- **对话美化fix** (Ellia, Vue app importing gsap/pinia, uses global Vue + `errorCatched`) — Vue mounts (no `errorCatched is not defined`, no blank `$1` text), animates, reads variables.
- **角色查看器v3.0.5** (`min-height:100vh` viewer) — renders; note: a `100vh` card fills ~one viewport inline and scrolls with the page (expected). If its layout is unusable inline, that's the documented case for flipping it to Isolated (Phase D) — record the observation, don't block.

Verify in DevTools console: no `Storage is disabled`, no `errorCatched is not defined`, no `SyntaxError`, no uncaught CSP violations for the CDNs in the allowlist. If a card imports from a CDN not in the allowlist, add that host in Task A4's list and note it.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/MessageContent.tsx
git commit -m "feat(cards): route interactive cards to InlineCardFrame by global default"
```

---

# Phase C — Writes & events parity

## Task C1: Bridge writes (variables, generate, worldbook, chat edit)

**Files:**
- Modify: `src/renderer/src/cardBridge/createCardBridge.ts` (replace the async no-op stubs with real `window.api` calls + optimistic store updates)

**Interfaces:**
- Consumes: `window.api.applyVariableOps(profileId, chatId, floor, ops)`, `window.api.generate(profileId, chatId, userAction)`, `window.api.generateRaw(profileId, chatId, config)`, `window.api.getLorebook(profileId, id)`, `window.api.saveLorebook(profileId, id, lorebook)`, `window.api.editFloor(profileId, chatId, floorIndex, userContent, responseContent)`; the `chatStore.applyVariableOps` action for optimistic updates.
- Produces: variable writes persist + are visible to the card immediately; `generate`/`generateRaw` return text; worldbook get/replace round-trip.

**Why no unit test:** these are thin adapters over `window.api` (mocked-store tests would assert little beyond "calls the api"); they're verified by the Task C-manual step against a real writing card. The pure variable-op construction is the one testable piece — extract and test it.

- [ ] **Step 1: Write the failing test for the op builder**

```ts
// test/cardBridgeOps.test.ts
import { describe, it, expect } from 'vitest'
import { setVarOps } from '../src/renderer/src/cardBridge/ops'

describe('setVarOps', () => {
  it('builds a single set op at a dotted path', () => {
    expect(setVarOps('a.b.c', 5)).toEqual([{ op: 'set', path: 'a.b.c', value: 5 }])
  })
  it('builds assign ops from an object of path→value', () => {
    expect(setVarOps({ 'x.y': 1, z: 2 })).toEqual([
      { op: 'set', path: 'x.y', value: 1 },
      { op: 'set', path: 'z', value: 2 }
    ])
  })
})
```

> Confirm the op shape the main applier expects by reading `chatStore.applyVariableOps` / `window.api.applyVariableOps` and `src/main` variable-op handling. If the canonical op uses a different `op` name (e.g. `'replace'`) or key (`from`), match it exactly and update this test. `VarOp` is `{ op, path, value?, from? }` (per `chatStore`).

- [ ] **Step 2: Run it — fails (no `ops.ts`)**

Run: `npx vitest run test/cardBridgeOps.test.ts` → FAIL.

- [ ] **Step 3: Implement `ops.ts`**

```ts
// src/renderer/src/cardBridge/ops.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
export type VarOp = { op: string; path: string; value?: unknown; from?: string }

/** Build set-variable ops from either (path, value) or an object map of path→value. */
export function setVarOps(pathOrMap: string | Record<string, unknown>, value?: unknown): VarOp[] {
  if (typeof pathOrMap === 'string') return [{ op: 'set', path: pathOrMap, value }]
  return Object.entries(pathOrMap).map(([path, v]) => ({ op: 'set', path, value: v }))
}
```

- [ ] **Step 4: Run it — passes**

Run: `npx vitest run test/cardBridgeOps.test.ts` → PASS.

- [ ] **Step 5: Wire writes into the bridge**

In `createCardBridge.ts`, import the op builder and the chat store, then replace the async stubs. Use the live ctx-resolved ids and the latest floor index:

```ts
import { setVarOps } from './ops'
// (useChatStore already imported)

const floorIndex = (): number => Math.max(0, useChatStore.getState().floors.length - 1)
const writeVars = async (ops: any[]): Promise<void> => {
  if (!ops.length) return
  // Optimistic: update the store so the card sees its own change immediately; then persist.
  try {
    await useChatStore.getState().applyVariableOps(ctx.profileId, ops, floorIndex())
  } catch (e) {
    console.error('[card writeVars]', e)
  }
}
```

Replace the relevant `helpers` entries:

```ts
    insertOrAssignVariables: async (vars: any, _opts?: any) => {
      await writeVars(setVarOps(vars))
    },
    replaceVariables: async (vars: any, _opts?: any) => {
      // wholesale replace of stat_data; express as a single set at the root stat_data path.
      await writeVars([{ op: 'set', path: 'stat_data', value: vars?.stat_data ?? vars }])
    },
    updateVariablesWith: async (updater: any, _opts?: any) => {
      if (typeof updater !== 'function') return
      const next = updater(structuredClone(statData()))
      await writeVars([{ op: 'set', path: 'stat_data', value: next }])
    },
    generate: async (a: any) => {
      const action = typeof a === 'string' ? a : (a?.user_input ?? a?.injects ?? '')
      const r: any = await window.api.generate(ctx.profileId, ctx.chatId, action)
      return typeof r === 'string' ? r : (r?.content ?? '')
    },
    generateRaw: async (config: any) => {
      const r: any = await window.api.generateRaw(ctx.profileId, ctx.chatId, config)
      return typeof r === 'string' ? r : (r?.content ?? '')
    },
    getWorldbook: async (name: any) => normalizeWb(await fetchWorldbook(name)),
    getLorebookEntries: async (name: any) => normalizeWb(await fetchWorldbook(name)),
    replaceWorldbook: async (name: any, entries: any) => {
      await saveWorldbook(name, entries)
      return true
    },
    updateWorldbookWith: async (name: any, updater: any) => {
      const cur = normalizeWb(await fetchWorldbook(name))
      const next = typeof updater === 'function' ? updater(cur) : cur
      await saveWorldbook(name, next)
      return next
    },
```

And the Mvu writes:

```ts
    setMvuVariable: (_d: any, path: string, value: any, _o?: any) => {
      bus.emit(MVU_EVENTS.VARIABLE_UPDATE_STARTED, statData())
      void writeVars([{ op: 'set', path: `stat_data.${path}`, value }]).then(() => {
        bus.emit(MVU_EVENTS.VARIABLE_UPDATED, statData())
        bus.emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, statData())
      })
      return value
    },
    replaceMvuData: (d: any, _o?: any) => {
      void writeVars([{ op: 'set', path: 'stat_data', value: d?.stat_data ?? d }])
    },
```

Add the worldbook helpers near the bottom of `createCardBridge` (using `window.api` — confirm `getCharWorldbookNames`/`getLorebook` mapping against `window.api.scriptWorldbookGet`/`getLorebook` and the active card's own book = `id === characterId`, per the WCV invariants):

```ts
  const fetchWorldbook = async (_name?: any): Promise<any> => {
    // The card's own book is its character_book at id === characterId (WCV invariant). Use the
    // chat-resolved character id; getLorebook returns { name, entries }.
    try {
      return await window.api.getLorebook(ctx.profileId, ctx.characterId)
    } catch {
      return { entries: [] }
    }
  }
  const saveWorldbook = async (_name: any, entries: any): Promise<void> => {
    const lb = (await fetchWorldbook()) || { name: '', entries: [] }
    const next = Array.isArray(entries) ? { ...lb, entries } : entries
    try {
      await window.api.saveLorebook(ctx.profileId, ctx.characterId, next)
    } catch (e) {
      console.error('[card saveWorldbook]', e)
    }
  }
  const normalizeWb = (lb: any): any[] =>
    Array.isArray(lb?.entries) ? lb.entries : Array.isArray(lb) ? lb : []
```

Refine the sync worldbook-name getters now that the active book is known:

```ts
    getCharWorldbookNames: (..._a: any[]) => {
      const name = useCharacterStore.getState().activeCharacter?.card?.data?.name || null
      return { primary: name, additional: [] }
    },
    getWorldbookNames: (..._a: any[]) => {
      const name = useCharacterStore.getState().activeCharacter?.card?.data?.name
      return name ? [name] : []
    },
```

> **Verify before finalizing:** open `src/preload/index.ts` for the exact `getLorebook`/`saveLorebook`/`applyVariableOps`/`generate`/`generateRaw` signatures and the `chatStore.applyVariableOps` action signature; match arg order exactly. If `getLorebook` needs a lorebook *id* distinct from `characterId`, resolve it via `window.api.getChatLorebooks(profileId, chatId)` first (mirror the WCV worldbook bridge).

- [ ] **Step 6: Type-check + manual write test**

Run: `npx tsc --noEmit`, then `npm run dev`. With a card that writes a variable on a button click (e.g. a stat tracker / the Ellia card's interactions), confirm: the write persists (reload the chat, value retained), and the card re-reads its own change without a full reload. Confirm a `generate`-calling card produces a new response.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/cardBridge/createCardBridge.ts src/renderer/src/cardBridge/ops.ts test/cardBridgeOps.test.ts
git commit -m "feat(cards): inline bridge writes — variables, generate, worldbook"
```

---

## Task C2: Bridge events on store changes

**Files:**
- Modify: `src/renderer/src/cardBridge/createCardBridge.ts` (subscribe to `chatStore`; emit MVU/lifecycle events)

**Interfaces:**
- Consumes: `useChatStore.subscribe`.
- Produces: when the chat's latest-floor variables change (e.g. after a generation), the bridge emits `mag_variable_updated` and `message_received` on the per-frame bus, so cards that registered `eventOn` react. The subscription is torn down when the frame unmounts (the bridge returns an `__rptDispose`).

**No unit test** (zustand subscription side-effects; verified by an event-driven card in manual test).

- [ ] **Step 1: Add a subscription + dispose hook**

In `createCardBridge`, after creating `bus`:

```ts
  let lastVarsJson = ''
  const unsub = useChatStore.subscribe((state) => {
    const f = state.floors[state.floors.length - 1]
    const json = JSON.stringify(f?.variables ?? null)
    if (json !== lastVarsJson) {
      lastVarsJson = json
      bus.emit(MVU_EVENTS.VARIABLE_UPDATED, statData())
      bus.emit(TAVERN_EVENTS.MESSAGE_UPDATED)
    }
  })
```

Add to the returned object:

```ts
    __rptDispose: () => unsub()
```

- [ ] **Step 2: Call dispose on unmount in `InlineCardFrame`**

The bootstrap assigns globals from the bridge object; capture the dispose on the iframe window and call it on cleanup. In `InlineCardFrame`'s effect cleanup, add:

```ts
      try {
        ;(frame.contentWindow as any)?.__rptDispose?.()
      } catch {
        /* ignore */
      }
```

(Place it inside the returned cleanup function, alongside `observer?.disconnect()`. The bootstrap already copies `__rptDispose` onto the iframe `window` via the `for (var k in g)` loop, since it's an own-enumerable key.)

- [ ] **Step 3: Manual test**

Run: `npm run dev`. With an event-driven card (one that calls `eventOn('mag_variable_updated', ...)` or `eventOn(tavern_events.MESSAGE_RECEIVED, ...)`), trigger a generation or a variable write elsewhere and confirm the card updates. Switch chats / unmount and confirm no console errors from a stale subscription.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/cardBridge/createCardBridge.ts src/renderer/src/components/InlineCardFrame.tsx
git commit -m "feat(cards): inline bridge emits MVU/lifecycle events on store changes"
```

---

# Phase D — Per-card override (mode marker end-to-end)

## Task D1: `ScopeMeta.renderMode` + `scopeMeta.setRenderMode`

**Files:**
- Modify: `src/shared/artifactScope.ts:17-22` (`ScopeMeta`)
- Modify: `src/main/services/scopeMeta.ts:20-24` (`prune`), add `setRenderMode`
- Test: `test/scopeMetaRenderMode.test.ts`

**Interfaces:**
- Consumes: `CardRenderMode` (A1).
- Produces: `ScopeMeta.renderMode?: CardRenderMode`; `setRenderMode(dir, file, renderMode: CardRenderMode | null): void` (null clears it); `prune` drops an entry only when it also has no `renderMode`.

- [ ] **Step 1: Write the failing test**

```ts
// test/scopeMetaRenderMode.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readScopeMeta, setRenderMode, setScope } from '../src/main/services/scopeMeta'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-scope-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('setRenderMode', () => {
  it('stores a renderMode override', () => {
    setRenderMode(dir, 'a.json', 'isolated')
    expect(readScopeMeta(dir)['a.json']).toMatchObject({ renderMode: 'isolated' })
  })
  it('clears the override with null (and prunes a now-empty entry)', () => {
    setRenderMode(dir, 'a.json', 'isolated')
    setRenderMode(dir, 'a.json', null)
    expect(readScopeMeta(dir)['a.json']).toBeUndefined()
  })
  it('preserves scope/owner when set, and keeps the entry while a renderMode is present', () => {
    setScope(dir, 'a.json', 'world', 'card-1')
    setRenderMode(dir, 'a.json', 'inline')
    expect(readScopeMeta(dir)['a.json']).toMatchObject({
      scope: 'world',
      owner: 'card-1',
      renderMode: 'inline'
    })
  })
  it('does not prune a global+enabled entry that still carries a renderMode', () => {
    setRenderMode(dir, 'a.json', 'inline')
    expect(readScopeMeta(dir)['a.json']).toMatchObject({ renderMode: 'inline' })
  })
})
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run test/scopeMetaRenderMode.test.ts` → FAIL (`setRenderMode` not exported).

- [ ] **Step 3: Implement**

In `src/shared/artifactScope.ts`, add the import and field:

```ts
import type { CardRenderMode } from './cardRenderMode'
```
```ts
export interface ScopeMeta {
  scope: ArtifactScope
  owner?: string
  disabled?: boolean
  /** Per-card render-mode override; absent = follow the global default. */
  renderMode?: CardRenderMode
}
```

In `src/main/services/scopeMeta.ts`:
- Add import: `import type { CardRenderMode } from '../../shared/cardRenderMode'`
- Update `prune` to also require no renderMode:
```ts
const prune = (meta: Record<string, ScopeMeta>, file: string): void => {
  const m = meta[file]
  if (m && (m.scope ?? 'global') === 'global' && !m.owner && !m.disabled && !m.renderMode)
    delete meta[file]
}
```
- Update `setScope` and `setDisabled` to preserve `renderMode` (carry `prev.renderMode` in the written object). For `setScope`:
```ts
  meta[file] = {
    scope,
    owner: scope === 'global' ? undefined : owner,
    disabled: prev.disabled,
    renderMode: prev.renderMode
  }
```
For `setDisabled`:
```ts
  meta[file] = {
    scope: prev.scope ?? 'global',
    owner: prev.owner,
    disabled: disabled || undefined,
    renderMode: prev.renderMode
  }
```
- Add the new setter:
```ts
/** Set (or clear, with null) a per-card render-mode override, preserving scope/owner/disabled. */
export const setRenderMode = (
  dir: string,
  file: string,
  renderMode: CardRenderMode | null
): void => {
  const meta = readScopeMeta(dir)
  const prev = meta[file] || ({ scope: 'global' } as ScopeMeta)
  meta[file] = {
    scope: prev.scope ?? 'global',
    owner: prev.owner,
    disabled: prev.disabled,
    renderMode: renderMode ?? undefined
  }
  prune(meta, file)
  writeScopeMeta(dir, meta)
}
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run test/scopeMetaRenderMode.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/artifactScope.ts src/main/services/scopeMeta.ts test/scopeMetaRenderMode.test.ts
git commit -m "feat(cards): scope sidecar renderMode override + setRenderMode"
```

---

## Task D2: `regexService` — `setScriptRenderMode` + carry `renderMode` to rules/scripts

**Files:**
- Modify: `src/shared/regexTypes.ts:9-15` (`RenderRegexRule`), `:18-25` (`RegexScriptInfo`)
- Modify: `src/main/services/regexService.ts` — `getAllRules` (attach), `listScripts` (surface), add `setScriptRenderMode`, re-export `setRenderMode` usage
- Test: `test/regexRenderMode.test.ts`

**Interfaces:**
- Consumes: `setRenderMode` (D1), `CardRenderMode` (A1).
- Produces: `RenderRegexRule.renderMode?: CardRenderMode`; `RegexScriptInfo.renderMode?: CardRenderMode`; `setScriptRenderMode(profileId, file, renderMode: CardRenderMode | null): void`; `getAllRules` stamps each rule from the file's `_meta.renderMode`; `listScripts` surfaces it.

- [ ] **Step 1: Write the failing test**

```ts
// test/regexRenderMode.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point the app dir at a temp folder before importing the service.
let appDir: string
vi.mock('../src/main/services/storageService', async (orig) => {
  const actual = (await orig()) as any
  return { ...actual, getAppDir: () => appDir }
})

import * as regexService from '../src/main/services/regexService'

const profile = 'p1'
const regexDir = (): string => path.join(appDir, 'profiles', profile, 'regex')

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-regex-'))
  fs.mkdirSync(regexDir(), { recursive: true })
  fs.writeFileSync(
    path.join(regexDir(), 'card.json'),
    JSON.stringify([{ scriptName: 'Card', findRegex: '/x/g', replaceString: '<html></html>', placement: [2] }])
  )
})
afterEach(() => fs.rmSync(appDir, { recursive: true, force: true }))

describe('regexService renderMode', () => {
  it('rules carry no renderMode by default', () => {
    expect(regexService.getAllRules(profile)[0].renderMode).toBeUndefined()
  })
  it('setScriptRenderMode stamps the rule + script info', () => {
    regexService.setScriptRenderMode(profile, 'card.json', 'isolated')
    expect(regexService.getAllRules(profile)[0].renderMode).toBe('isolated')
    expect(regexService.listScripts(profile).find((s) => s.file === 'card.json')?.renderMode).toBe(
      'isolated'
    )
  })
  it('null clears it', () => {
    regexService.setScriptRenderMode(profile, 'card.json', 'isolated')
    regexService.setScriptRenderMode(profile, 'card.json', null)
    expect(regexService.getAllRules(profile)[0].renderMode).toBeUndefined()
  })
})
```

> If mocking `getAppDir` per the above doesn't match how other regexService tests set up their temp dir, follow the existing pattern in the repo's regex tests (search `test/` for `regexService`); the assertions stay the same.

- [ ] **Step 2: Run — fails**

Run: `npx vitest run test/regexRenderMode.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `src/shared/regexTypes.ts`:
```ts
import type { CardRenderMode } from './cardRenderMode'
```
Add `renderMode?: CardRenderMode` to both `RenderRegexRule` and `RegexScriptInfo`.

In `src/main/services/regexService.ts`:
- Import `setRenderMode` from `./scopeMeta` (add to the existing import) and `CardRenderMode`:
```ts
import { readScopeMeta, getScopeMeta, setScope, setDisabled, setRenderMode, removeScopeEntry } from './scopeMeta'
import type { CardRenderMode } from '../../shared/cardRenderMode'
```
- In `getAllRules`, stamp the renderMode per file:
```ts
    const mode = meta[file]?.renderMode
    for (const raw of rulesInFile(path.join(dir, file))) {
      const rule = normalizeRule(raw)
      if (mode) rule.renderMode = mode
      out.push(rule)
    }
```
(replaces the existing `for (const raw of ...) out.push(normalizeRule(raw))` line.)
- In `listScripts`, add `renderMode: m?.renderMode` to the returned object.
- Add the setter next to `setScriptScope`:
```ts
/** Set/clear a regex script's per-card render-mode override (null = follow global default). */
export const setScriptRenderMode = (
  profileId: string,
  file: string,
  renderMode: CardRenderMode | null
): void => {
  if (isUnsafe(file)) return
  setRenderMode(regexDir(profileId), file, renderMode)
}
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run test/regexRenderMode.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/regexTypes.ts src/main/services/regexService.ts test/regexRenderMode.test.ts
git commit -m "feat(cards): regexService carries per-card renderMode + setScriptRenderMode"
```

---

## Task D3: IPC + preload for `setRegexRenderMode`

**Files:**
- Modify: `src/main/ipc/regexIpc.ts:10-12` (add handler near `regex-set-scope`)
- Modify: `src/preload/index.ts:180-181` (add method near `setRegexScope`)

**Interfaces:**
- Produces: `window.api.setRegexRenderMode(profileId, file, renderMode: string | null): Promise<unknown>` → IPC `regex-set-render-mode` → `regexService.setScriptRenderMode`.

**No unit test** (IPC plumbing; exercised end-to-end by Task D6's manual test). One line each, mirroring an existing handler.

- [ ] **Step 1: Add the IPC handler**

In `src/main/ipc/regexIpc.ts`, after the `regex-set-scope` handler:

```ts
  ipcMain.handle('regex-set-render-mode', (_, profileId, file, renderMode) =>
    regexService.setScriptRenderMode(profileId, file, renderMode)
  )
```

- [ ] **Step 2: Add the preload method**

In `src/preload/index.ts`, after `setRegexScope`:

```ts
  setRegexRenderMode: (profileId: string, file: string, renderMode: string | null) =>
    ipcRenderer.invoke('regex-set-render-mode', profileId, file, renderMode),
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/regexIpc.ts src/preload/index.ts
git commit -m "feat(cards): IPC + preload for setRegexRenderMode"
```

---

## Task D4: `regexTransform` — export `isCardPayload` + `marker` apply option

**Files:**
- Modify: `src/shared/regexTransform.ts:24-25` (export rename), `:62-98` (`ApplyOptions` + apply loop)
- Test: `test/regexMarker.test.ts`

**Interfaces:**
- Produces: `export const isCardPayload(s: string): boolean`; `ApplyOptions.marker?: (rule: R) => string | undefined` — a string prepended to that rule's replacement output per match.

- [ ] **Step 1: Write the failing test**

```ts
// test/regexMarker.test.ts
import { describe, it, expect } from 'vitest'
import { applyRegexRules, isCardPayload, type RegexLikeRule } from '../src/shared/regexTransform'

const rule = (over: Partial<RegexLikeRule & { renderMode?: string }> = {}): any => ({
  source: 'X',
  flags: 'g',
  replace: '<html><body>card</body></html>',
  placement: [],
  trimStrings: [],
  ...over
})

describe('isCardPayload', () => {
  it('detects card-ish html payloads', () => {
    expect(isCardPayload('<html></html>')).toBe(true)
    expect(isCardPayload('```html\nx```')).toBe(true)
    expect(isCardPayload('<script>1</script>')).toBe(true)
    expect(isCardPayload('plain text')).toBe(false)
  })
})

describe('applyRegexRules marker option', () => {
  it('prepends the marker the callback returns', () => {
    const out = applyRegexRules('X', [rule({ renderMode: 'isolated' })], {}, {
      marker: (r: any) => (r.renderMode ? `<!--rpt:mode=${r.renderMode}-->` : undefined)
    })
    expect(out).toBe('<!--rpt:mode=isolated--><html><body>card</body></html>')
  })
  it('emits nothing when the callback returns undefined', () => {
    const out = applyRegexRules('X', [rule()], {}, { marker: () => undefined })
    expect(out).toBe('<html><body>card</body></html>')
  })
})
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run test/regexMarker.test.ts` → FAIL (`isCardPayload` not exported / `marker` ignored).

- [ ] **Step 3: Implement**

In `src/shared/regexTransform.ts`:
- Rename `isCodePayload` → `isCardPayload` and export it; update its one internal use in `buildReplacement`:
```ts
/** A "frontend card" payload — beautification HTML carrying its own <script>/<style>. ... */
export const isCardPayload = (s: string): boolean =>
  /```html|<script[\s>]|<style[\s>]|<(?:html|body)[\s>]/i.test(s)
```
```ts
  if (!isCardPayload(rule.replace)) out = out.replace(/\\n/g, '\n')
```
- Add to `ApplyOptions<R>`:
```ts
  /**
   * Render-only: given the matched rule, return a marker string to PREPEND to that rule's
   * replacement output (e.g. a per-card render-mode HTML comment). Undefined → no marker.
   */
  marker?: (rule: R) => string | undefined
```
- In the apply loop, change the replace callback:
```ts
    out = out.replace(re, (...args) => {
      const { match, groups } = replaceArgs(args)
      const repl = buildReplacement(rule, match, groups, ctx)
      const mk = opts.marker?.(rule)
      return mk ? mk + repl : repl
    })
```

- [ ] **Step 4: Run — passes (and the existing regex suite stays green)**

Run: `npx vitest run test/regexMarker.test.ts test/regexApply.test.ts`
Expected: PASS. (If anything imported `isCodePayload` by name, update it — grep first: `npx grep`/search for `isCodePayload`.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/regexTransform.ts test/regexMarker.test.ts
git commit -m "feat(cards): regexTransform marker option + export isCardPayload"
```

---

## Task D5: `splitHtml` parses the mode marker + route by resolved mode

**Files:**
- Modify: `src/renderer/src/components/MessageContent.tsx:61-77` (`Segment` + `splitHtml`), `:40-50` (routing)
- Test: `test/splitHtmlMode.test.ts`

**Interfaces:**
- Consumes: `CardRenderMode` (A1).
- Produces: `Segment = { type: 'md' | 'html'; text: string; mode?: CardRenderMode }`; `splitHtml` strips a trailing `<!--rpt:mode=...-->` from the md text preceding an html block and attaches `mode` to that html segment.

- [ ] **Step 1: Write the failing test**

```ts
// test/splitHtmlMode.test.ts
import { describe, it, expect } from 'vitest'
import { splitHtml } from '../src/renderer/src/components/MessageContent'

describe('splitHtml mode marker', () => {
  it('attaches isolated mode from a marker before an html block and strips it', () => {
    const segs = splitHtml('intro <!--rpt:mode=isolated--><html><body>c</body></html> after')
    const html = segs.find((s) => s.type === 'html')!
    expect(html.mode).toBe('isolated')
    const md = segs.find((s) => s.type === 'md' && s.text.includes('intro'))!
    expect(md.text).not.toContain('rpt:mode')
    expect(md.text).toContain('intro')
  })
  it('handles inline mode + whitespace/newline between marker and block', () => {
    const segs = splitHtml('<!--rpt:mode=inline-->\n```html\n<div>x</div>\n```')
    expect(segs.find((s) => s.type === 'html')!.mode).toBe('inline')
  })
  it('leaves mode undefined when there is no marker', () => {
    const segs = splitHtml('<html><body>c</body></html>')
    expect(segs.find((s) => s.type === 'html')!.mode).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run test/splitHtmlMode.test.ts` → FAIL.

- [ ] **Step 3: Implement `splitHtml` v2**

In `src/renderer/src/components/MessageContent.tsx`, add the import:
```ts
import type { CardRenderMode } from '../../../shared/cardRenderMode'
```
Replace the `Segment` type and `splitHtml`:
```ts
type Segment = { type: 'md' | 'html'; text: string; mode?: CardRenderMode }

// A render-mode marker the regex applier emits immediately before a card block (see regexStore.apply).
const MODE_MARKER = /<!--\s*rpt:mode=(inline|isolated)\s*-->\s*$/i

export const splitHtml = (content: string): Segment[] => {
  const segs: Segment[] = []
  const re = new RegExp(HTML_BLOCK)
  let last = 0
  let m: RegExpExecArray | null
  let pendingMode: CardRenderMode | undefined
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      let md = content.slice(last, m.index)
      const mk = md.match(MODE_MARKER)
      if (mk) {
        pendingMode = mk[1].toLowerCase() as CardRenderMode
        md = md.slice(0, mk.index) // strip the marker from the visible md text
      }
      if (md) segs.push({ type: 'md', text: md })
    }
    segs.push({
      type: 'html',
      text: m[1] !== undefined ? m[1] : m[2],
      mode: pendingMode
    })
    pendingMode = undefined
    last = m.index + m[0].length
  }
  if (last < content.length) segs.push({ type: 'md', text: content.slice(last) })
  if (segs.length === 0) segs.push({ type: 'md', text: content })
  return segs
}
```

- [ ] **Step 4: Route by the per-segment resolved mode**

Update the routing from Task B3 to use `p.mode`:
```tsx
            resolveCardMode(p.mode, globalMode) === 'isolated' ? (
              <WcvMessageFrame key={i} html={p.text} />
            ) : (
              <InlineCardFrame key={i} html={p.text} onContextMenu={onContextMenu} />
            )
```

- [ ] **Step 5: Run — passes**

Run: `npx vitest run test/splitHtmlMode.test.ts` → PASS. Then `npm test` to confirm nothing regressed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/MessageContent.tsx test/splitHtmlMode.test.ts
git commit -m "feat(cards): parse render-mode marker in splitHtml + route by resolved mode"
```

---

## Task D6: `regexStore` emits the marker + RegexPanel per-script selector

**Files:**
- Modify: `src/renderer/src/stores/regexStore.ts:1-2` (import), `:15-33` (state), `:81-101` (action + apply)
- Modify: `src/renderer/src/components/RegexPanel.tsx:25-27` (destructure), add `changeRenderMode` + the selector JSX

**Interfaces:**
- Consumes: `isCardPayload` (D4), `setRegexRenderMode` (D3), `RegexScriptInfo.renderMode` (D2), `CardRenderMode` (A1).
- Produces: `regexStore.apply` prepends `<!--rpt:mode=...-->` for rules that carry `renderMode` and emit a card payload; `regexStore.setRenderMode(profileId, file, renderMode | null)` action; a Default/Inline/Isolated `<select>` per script.

**No new unit test** (the marker emission is covered by `test/regexMarker.test.ts`; the UI is manual). End-to-end is the manual test in Step 5.

- [ ] **Step 1: Emit the marker in `apply`**

In `src/renderer/src/stores/regexStore.ts`:
- Update the import:
```ts
import { applyRegexRules, isCardPayload, type RegexApplyContext } from '../../../shared/regexTransform'
import type { CardRenderMode } from '../../../shared/cardRenderMode'
```
- Add the action to the `RegexState` interface:
```ts
  setRenderMode: (
    profileId: string,
    file: string,
    renderMode: CardRenderMode | null
  ) => Promise<void>
```
- Add the marker helper above the store and use it in `apply`:
```ts
const modeMarker = (rule: RenderRegexRule): string | undefined =>
  rule.renderMode && isCardPayload(rule.replace) ? `<!--rpt:mode=${rule.renderMode}-->` : undefined
```
```ts
  apply: (content, ctx) =>
    applyRegexRules(content, get().rules, ctx ?? {}, { compile: getRe, marker: modeMarker })
```
- Add the action implementation (mirror `setScope`):
```ts
  setRenderMode: async (profileId, file, renderMode) => {
    await window.api.setRegexRenderMode(profileId, file, renderMode)
    await get().load(profileId)
    await get().loadScripts(profileId)
  },
```

- [ ] **Step 2: Add the selector to `RegexPanel`**

In `src/renderer/src/components/RegexPanel.tsx`:
- Destructure the new action and import the type:
```ts
import { useRegexStore, RegexRuleDetail, RegexRulePatch, RegexScriptInfo, ArtifactScope } from '../stores/regexStore'
import type { CardRenderMode } from '../../../shared/cardRenderMode'
```
```ts
  const { scripts, loadScripts, importScripts, remove, updateRule, setScope, setDisabled, setRenderMode } =
    useRegexStore()
```
- Add the change handler next to `changeScope`:
```ts
  const changeRenderMode = (file: string, v: string): void => {
    setRenderMode(profileId, file, v === '' ? null : (v as CardRenderMode))
  }
```
- In `renderScript`, after the scope `<select>` (the block ending at line ~94), add a render-mode select:
```tsx
          <select
            className="scope-select"
            value={s.renderMode ?? ''}
            title="Render mode — how this card's UI is displayed (Default follows Settings)."
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => changeRenderMode(s.file, e.target.value)}
          >
            <option value="">Default</option>
            <option value="inline">Inline</option>
            <option value="isolated">Isolated</option>
          </select>
```

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 4: Manual end-to-end test**

Run: `npm run dev`.
1. Set global default = Inline (Settings). Open a chat with the **角色查看器** card → it renders inline.
2. In the Regex panel, find that script, set its render mode = **Isolated**. Re-render the message (re-open the chat / new turn) → the same card now renders in a WCV overlay (crash-isolated), proving the marker round-trips disk → rules → `apply` → `splitHtml` → routing.
3. Set it back to **Default** → it follows the global setting again.
4. Flip the global default to **Isolated**; a card with no override renders isolated; one set to **Inline** stays inline.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/regexStore.ts src/renderer/src/components/RegexPanel.tsx
git commit -m "feat(cards): per-script render-mode selector + emit mode marker"
```

---

## Final verification

- [ ] **Run the whole suite + type-check**

Run: `npm test && npx tsc --noEmit` (or `npm run typecheck` / `npm run lint` if defined).
Expected: all green.

- [ ] **Manual parity matrix** — for each of 红花戏票, 对话美化fix, 角色查看器:
  - Inline mode: renders, content-height, scrolls with chat, variable read **and** write, EJS (`<% %>`) evaluated, no console errors.
  - Isolated mode (flip the per-card override): identical behavior, crash-isolated.
  - One card with a CDN import (Ellia/gsap/pinia) loads its CDN assets under the new CSP.

- [ ] **Update the WCV-invariants memory** with the inline-mode invariants discovered during manual testing (the realm rule for Vue/jQuery, the marker round-trip, the `?url` lib injection) — append to `rp-terminal-wcv-compat-invariants.md`.

---

## Self-review notes (author)

- **Spec coverage:** Inline same-origin iframe (B2) ✓; isolated unchanged (B3/D5 route) ✓; full API parity — reads+EJS (B1), writes (C1), events (C2) ✓; same-origin rationale honored (bridge B1) ✓; CSP scoped loosening (A4) ✓; global default + per-card override + block tagging + manager UI (A2, D1–D6) ✓; buildCardDoc reuse (A3) ✓; shadow-DOM alternative is recorded in the spec, not implemented (correct).
- **Known approximation (flagged, not a placeholder):** the bridge's long-tail methods are specified by the method-map table + per-category worked code, not 60 verbatim bodies — each row names its exact transport, so implementation is mechanical. The audio/slash/createChat stubs match wcvPreload's own stubs.
- **Open runtime risk to validate in manual test:** `100vh` cards inline (the 角色查看器) — if unusable, the per-card Isolated override is the sanctioned fallback (Phase D), and the global default can stay Inline. The DOM-library realm decision (inject Vue/jQuery as iframe-realm global builds) is the mitigation for cross-realm `instanceof` breakage; if a needed lib has no global build, fall back to a CDN `<script>` in the bootstrap.
- **Type consistency:** `CardRenderMode` is the single union used by settings, scope meta, regex types, splitHtml, and routing. `setRenderMode` (scopeMeta) ↔ `setScriptRenderMode` (regexService) ↔ `setRegexRenderMode` (preload/store) — names are intentionally distinct per layer, matching the existing `setScope`/`setScriptScope`/`setRegexScope` convention.
