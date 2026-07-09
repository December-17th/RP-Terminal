# Runtime message-box / play theme API — design

Status: **Implemented (2026-07-08)**. Scope: a universal, card-callable runtime theming surface for the play
shell and the chat message box. Not scoped to any single card (命定之诗 is one consumer, not the contract).

Implemented across: message-box tokens ([index.css](../src/renderer/src/assets/index.css) `.floor-block` /
`.message-content` / `.user-action`), derivation + msg-scoped contrast + the `resolveRuntimeTheme` gate
([cardTheme.ts](../src/renderer/src/cardTheme.ts)), the renderer authority + session slot
([cardBridge/playTheme.ts](../src/renderer/src/cardBridge/playTheme.ts), [uiStore.ts](../src/renderer/src/stores/uiStore.ts)),
the runtime facade + `Host` seam ([thRuntime](../src/shared/thRuntime/index.ts) + [types.ts](../src/shared/thRuntime/types.ts)),
both adapters ([cardBridge/host.ts](../src/renderer/src/cardBridge/host.ts) + [wcvHost.ts](../src/preload/wcvHost.ts)),
the WCV relay IPC ([wcvIpc.ts](../src/main/ipc/wcvIpc.ts) + [wcvManager.ts](../src/main/services/wcvManager.ts)),
and the `.play-root` composition + snapshot push ([App.tsx](../src/renderer/src/App.tsx)). See
[rpt-api.md](rpt-api.md) "Theme / appearance".

This design extends the existing **static** card-theme path (§6a of
[ui-rehaul-design.md](ui-rehaul-design.md)); it does not replace it. When you implement it, update
[rpt-api.md](rpt-api.md), [sdk/component-inventory.md](sdk/component-inventory.md), and §6a of
[ui-rehaul-design.md](ui-rehaul-design.md) in the same change (the SDK-is-the-contract rule in
[CLAUDE.md](../CLAUDE.md) / [sdk/README.md](sdk/README.md)).

---

## 1. Problem

A card can ship a look, but only **statically** and only **shell-wide**:

- The theme is read **once** from `data.extensions.rp_terminal.theme` and memoized on the card's static
  data (`playTokens` in [App.tsx](../src/renderer/src/App.tsx) ~L238). A card's **running UI** — an
  in-play settings panel, a WCV panel, a frontend card reacting to story state (night scene → dark
  palette) — has **no way to change it at runtime.** There is no theme method anywhere in
  `src/shared/thRuntime`, and [rpt-api.md](rpt-api.md) exposes none.
- The **message box has no theme tokens of its own.** `.floor-block` / `.message-content` /
  `.user-action` ([FloorBlock.tsx](../src/renderer/src/components/FloorBlock.tsx),
  [index.css](../src/renderer/src/assets/index.css) ~L945) draw their background from the shell-wide
  `--rpt-bg-secondary`, border from `--rpt-border`, and a **hardcoded** `8px` radius. Only font-size
  (`--rpt-chat-font`) and prose family (`--rpt-chat-font-family`) are message-scoped. So a card cannot
  restyle the message box without repainting every panel, menu, and toolbar that shares those tokens.

Goal: let a card's UI **set the theme for the message box (and, optionally, the play shell) at runtime**,
through a universal API, without weakening the existing trust/contrast guarantees.

## 2. Current state (what we build on)

- **Card data:** `data.extensions.rp_terminal.theme` — `z.record(z.string(), z.any())`
  ([character.ts](../src/main/types/character.ts) ~L131). Accepts `{ base?, tokens: {…}, css? }` or a
  bare override map.
- **Derivation + trust:** `deriveCardTheme()`
  ([cardTheme.ts](../src/renderer/src/cardTheme.ts)) layers card **fills** over a base app theme,
  **derives** readable text / on-accent tokens by luminance, and **rejects the whole theme** (returns
  `null`, caller keeps the user theme) if the load-bearing pairs fail WCAG-AA. Card-supplied text colors
  are never trusted. Friendly aliases already map `chat-font`/`prose-font` → `--rpt-chat-font-family`.
- **Application:** `playTokens` memo in [App.tsx](../src/renderer/src/App.tsx) sets the derived tokens
  **inline on `.play-root`** (play mode only — the launcher and settings popup keep the user theme).
  Gated by `settings.ui.allow_card_themes` (default on).
- **App themes:** `applyTheme()` in [theme.ts](../src/renderer/src/theme.ts) sets the token set on
  `<html>`; the `dark`/`carbon`/`light` sets define the semantic tokens.
- **The `css` escape hatch is declared but unimplemented** — `deriveCardTheme` skips `css`. This design
  does **not** implement it; it stays a token-only path (safer, no sanitizer needed).

## 3. Design

Two additive parts. Part A is useful on its own (even for the static path); Part B is the new runtime
capability and depends on A.

### 3A. Message-box token namespace (additive, CSS-only)

New `--rpt-msg-*` tokens, each with a **CSS fallback** to today's shell token so existing cards and the
three app themes are visually unchanged until someone sets them.

```css
.floor-block {
  background: var(--rpt-msg-bg, var(--rpt-bg-secondary));
  border-color: var(--rpt-msg-border, var(--rpt-border));
  border-radius: var(--rpt-msg-radius, 8px);
  font-size: var(--rpt-chat-font, 16px);
}
.message-content { color: var(--rpt-msg-text, var(--rpt-text-primary)); }
.user-action    { color: var(--rpt-msg-user, var(--rpt-text-secondary)); }
```

| Token | Friendly alias | Default (fallback) | Drives |
| --- | --- | --- | --- |
| `--rpt-msg-bg` | `msg-bg` | `--rpt-bg-secondary` | message box fill |
| `--rpt-msg-border` | `msg-border` | `--rpt-border` | message box border |
| `--rpt-msg-radius` | `msg-radius` | `8px` | message box corner radius |
| `--rpt-msg-text` | `msg-text` | `--rpt-text-primary` | AI prose color |
| `--rpt-msg-user` | `msg-user` | `--rpt-text-secondary` | user-action (`> …`) line |
| `--rpt-chat-font` | `chat-size` | `16px` | prose font-size (existing) |
| `--rpt-chat-font-family` | `chat-font` / `prose-font` | `inherit` | prose font-family (existing) |

Add the friendly aliases to `ALIAS` in `cardTheme.ts`. `--rpt-msg-radius` is a length, not a color — it
passes through the derivation untouched (like the font tokens do today). The color tokens
(`msg-bg`/`msg-text`/`msg-user`) run through contrast derivation (§4).

This alone lets a card theme the message box **distinctly from the shell** — even via the existing static
`theme` map, no runtime API needed.

### 3B. Runtime theme setter

A **host-privilege** method mirroring `requestOverlay` / `requestAssetImport`: it lives on `rptHost` and
`window.TavernHelper`, and routes through the shared `Host` seam so both transports (inline `cardBridge`,
isolated `wcvPreload`) inherit identical behavior — the anti-drift rule in
[rpt-api.md §5](rpt-api.md).

```ts
// Apply a token override at runtime. Universal — any card, any scope.
setPlayTheme(
  theme:
    | { base?: string; tokens: Record<string, string> }
    | Record<string, string>
    | null,               // null / {} clears the runtime layer
  opts?: {
    target?: 'shell' | 'message'            // default 'shell'
    persist?: 'session' | 'chat' | 'global' // default 'session'
  }
): Promise<boolean>       // false if rejected (contrast/AA) or allow_card_themes is off

getPlayTheme(): { tokens: Record<string, string>; source: 'user' | 'card' | 'runtime' } // sync

// sugar
setMessageTheme(tokens, opts?) ≡ setPlayTheme({ tokens }, { target: 'message', ...opts })
```

**Semantics**

- `target: 'message'` restricts the override to the `--rpt-msg-*` / `chat-font` family; other keys are
  ignored. `target: 'shell'` (default) accepts the full alias set (today's behavior).
- `theme = null` / `{}` **clears** the runtime layer → falls back to the static card theme → user theme.
- **Precedence** (unchanged base rule, one new layer): user base theme → static card tokens →
  **runtime override** → user accent.
- **Persistence** reuses existing stores so the look survives reload / remount:
  - `'chat'` → `chatCardVarsService` (per-chat card vars — the store the party panel uses).
  - `'global'` → per-profile `templateService` globals (the store 艾莉亚's `dialog_beauty.ui` uses).
  - `'session'` (default) → a new ephemeral field in `uiStore`; lost on app restart / world switch.
  - Namespace the persisted key (e.g. `rpt.playTheme` / `rpt.msgTheme`) to avoid collisions.
- **Event:** emit `PLAY_THEME_CHANGED` on the existing `cardHostEvents` (inline) / `wcv-event` (WCV) bus
  so sibling panels can re-read via `getPlayTheme()`.

## 4. Trust model

Runtime tokens are the **same untrusted design input** as static ones and get the **same guarantees**:

- Every color override passes through `deriveCardTheme()` — text / on-accent are **derived**, never
  trusted from the card, and the result is **rejected** (method returns `false`, theme unchanged) if the
  load-bearing pairs fail WCAG-AA. For `target:'message'`, check `--rpt-msg-text` and `--rpt-msg-user`
  against `--rpt-msg-bg` (falling back to `--rpt-bg-secondary` when the card didn't set `msg-bg`).
- `settings.ui.allow_card_themes === false` ⇒ the method is a no-op returning `false` (honors the user
  opt-out, same as the static path).
- **Scope** is ctx-bound like every card call ([rpt-api.md §2](rpt-api.md)): a card themes only its own
  play session. The launcher and settings popup render **outside `.play-root`** and always stay on the
  user's theme — a card can never restyle app chrome or lock the user out of settings.
- A broken / illegible runtime theme can never make play unreadable: rejection keeps the prior tokens.

## 5. Transport wiring (the "add an API" contract, rpt-api.md §5)

Implement on **one shared surface**, both transports delegate:

1. **CSS + tokens** — add `--rpt-msg-*` wiring in `index.css`; the defaults live in the CSS fallbacks, so
   `theme.ts` need not define them (add them there only if a built-in theme wants a non-default value).
2. **Aliases / target filter** — extend `ALIAS` + add the `target` filter in `cardTheme.ts`; export a
   small `deriveMessageTheme` (or a `target` param on `deriveCardTheme`) that runs the msg-scoped
   contrast check.
3. **Runtime methods** — `setPlayTheme` / `getPlayTheme` in
   [thRuntime/index.ts](../src/shared/thRuntime/index.ts); `Host.setPlayTheme` /
   `Host.getPlayThemeSync` on the `Host` type ([thRuntime/types.ts](../src/shared/thRuntime/types.ts))
   and on **both** adapters ([cardBridge/host.ts](../src/renderer/src/cardBridge/host.ts) +
   [wcvPreload.ts](../src/preload/wcvPreload.ts)). Expose as `window.rptHost.setPlayTheme`,
   `window.setPlayTheme`, `window.TavernHelper.setPlayTheme` (match how `requestOverlay` is exposed).
4. **IPC** — `wcv-host-set-play-theme` (+ a sync `-get-play-theme-sync`) in
   [wcvIpc.ts](../src/main/ipc/wcvIpc.ts), resolved against the calling view's ctx.
5. **Store + apply** — hold the runtime override in `uiStore` (session) and/or the persisted var store;
   in [App.tsx](../src/renderer/src/App.tsx) compose the runtime layer over `playTokens` and set it on
   `.play-root`. Inline transport writes the store directly; WCV pushes via IPC + a `wcv-vars-changed`-
   style refresh.
6. **Docs** — update [rpt-api.md](rpt-api.md) (new "Theme / appearance" subsection),
   [sdk/component-inventory.md](sdk/component-inventory.md), and §6a of
   [ui-rehaul-design.md](ui-rehaul-design.md).

## 6. Verification

Per [CLAUDE.md](../CLAUDE.md): `npm run typecheck && npm run check:deps && npm run test`.

- Add a `cardTheme` unit test: msg-scoped override applies `--rpt-msg-*`; a failing-contrast msg theme is
  rejected (returns null / `false`) and leaves prior tokens intact; `allow_card_themes:false` no-ops.
- Parity: `setPlayTheme` behaves identically inline vs WCV (drive it from both hosts).
- Regression: with no `--rpt-msg-*` set, the message box renders exactly as before (fallbacks).

## 7. Decisions to confirm before/while building

1. **`session` persistence store** — new `uiStore.playThemeOverride` field vs. folding into an existing
   store. (Recommend a dedicated `uiStore` field: ephemeral, no schema migration.)
2. **`getPlayTheme` shape** — return the raw override the card set, or the fully-resolved effective token
   map? (Recommend the **resolved** map + a `source` tag, so a card can read what's actually on screen.)
3. **`target:'message'` alias whitelist** — exact key set that survives the message filter (the
   `--rpt-msg-*` + `--rpt-chat-*` family above).
