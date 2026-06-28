# 命定之诗 party panel v2 (design)

Status: **Design approved (2026-06-27).** Iteration on the party-avatar panel (PR #23, branch
`feat/poem-party-avatar-panel`) after the owner viewed it. Three changes — a **draggable** strip, a
**contrast fix**, and **manual per-chat party membership** — the last requiring one small app/SDK delta
(a per-chat card-scoped KV). The panel stays a card WCV panel; the rest is card-side.

## Context & motivation

The shipped v1 panel (`docs/sdk/examples/poem-party-panel.html`) renders a fixed strip of **everyone 在场**
(主角 + `关系列表` where `在场`), reading `getVariables().stat_data`, and renders once per regex injection.
Owner feedback after seeing it in-app:
1. **Draggable** — the strip + detail overlay should be draggable *within* the panel (the panel is the
   card's own surface and will host other card UI later; the strip floats above, clamped to the panel).
2. **Contrast** — the panel has dark text on a dark background in places; fix legibility.
3. **Party ≠ present** — "在场" doesn't mean "in the party." The party is a **manually-curated** list the
   user builds by adding from the **known-NPC list** (`关系列表` keys). Per **session/chat**.

Confirmed: 主角 is always in the party; the party list is **per-chat**; the panel remains the card's own
WCV surface (so dragging is in-document, card-side; no app overlay needed). Per-chat storage is the only
piece that needs the app, because card *script* vars are per-card and MVU `stat_data` strips unknown keys
(strict `data_schema`).

## Current state (what we build on)

- v1 panel: `poem-party-panel.html` (render-once per injection; reads `getVariables().stat_data`; party =
  主角 + 在场; `window.assetUrl` portraits; a `position:fixed` detail overlay) + `poem-party-panel.regex.json`
  (`renderMode:'panel'`, scriptName `命定之诗-队伍面板`) + `patch-poem-party-panel.cjs`.
- `createThRuntime(host)` (`src/shared/thRuntime/index.ts`) builds the card page API: `getVariables({type})`
  → `'script'` = card KV (per-card, `host.getScriptVars`), anything else = `stat_data` (per-chat,
  MVU-schema-bound). `setVar(key,value,scope)` maps `scope==='global'`→`host.setGlobalVar`. The `Host`
  interface (`thRuntime/types.ts`) is implemented by both transports (`preload/wcvHost.ts`,
  `renderer/cardBridge/host.ts`); `wcvIpc.ts` handlers resolve ctx via `wcvManager.contextFor(sender)`.
- No per-chat, card-writable, schema-free KV exists today (MVU `stat_data` is per-chat but strict; script
  vars are per-card; globals are per-profile).
- `wcv-host-asset-url` (the v1 bridge) is the pattern to mirror for the new bridge.

## Architecture

### App delta — per-chat card-scoped KV (`type:'chat'`)

A per-chat key/value store the card reads/writes, independent of MVU `stat_data` (so it's never
schema-stripped):

- **Store:** a small service `chatCardVars` — `getChatCardVars(profileId, chatId): Record<string,any>` and
  `setChatCardVars(profileId, chatId, obj): void`. Chats live in SQLite (no per-chat dir), so persist to a
  single profile-level JSON keyed by chat: `profiles/<profileId>/chat-card-vars.json` =
  `{ [chatId]: { … } }` (fs via storageService helpers, tolerant of missing/corrupt → `{}`; mirrors how
  `pluginStorageService`/`templateService` keep a per-profile JSON). Unit-testable with temp dirs.
- **`Host` interface** gains `getChatVars(): Record<string,any>` and `setChatVars(obj): void`; implemented
  in both transports (WCV → `wcv-host-chat-vars-get`/`-set` IPC, ctx-scoped via `contextFor`; inline →
  `window.api.chatCardVars*` against the active chat).
- **`createThRuntime`** maps `getVariables({type:'chat'})` → `host.getChatVars()` and the setter
  (`insertOrAssignVariables`/`replaceVariables`/`setVar` with `scope/type === 'chat'`) →
  `host.setChatVars(...)`. Exposed on the card page like the other TH globals.
- **IPC + preload:** `wcv-host-chat-vars-get`/`wcv-host-chat-vars-set` (wcvIpc); `chatCardVarsGet`/`Set`
  on `window.api` for the inline transport.

**Extensible by design — a general scope, not party-specific.** The KV layer stores an arbitrary JSON
object; nothing about "party" lives in it. The party panel is merely the first consumer (it uses the
`party.members` / `party.stripPos` keys). Because it's a **single shared per-chat bag**, cards/features must
**namespace their keys** (e.g. `party.members`, `party.stripPos`, or a feature prefix) to avoid
collisions between widgets that later share the same chat. The full contract is documented in the SDK
(see "SDK documentation" below) so future card features can rely on it.

#### Contract (documented in `docs/sdk/`)
- **Scope:** per **chat/session**, per card surface (the active chat). Survives app restarts for that chat.
- **Shape:** an arbitrary JSON object; keys are a shared namespace — **prefix your keys**.
- **NOT** MVU `stat_data`: not AI-authored, not sent to the model, not validated/stripped by the card's
  `data_schema`. Use `type:'chat'` for UI/session state; use `stat_data` (`type:'message'`) for story state.
- **vs other scopes:** `message`/`stat_data` = MVU story state (per-chat, in-prompt, schema-bound);
  `script` = per-**card** KV (all that card's chats); `global` = per-**profile**; `chat` = per-**chat** UI/session KV (new).
- **API:** read `getVariables({type:'chat'})`; write via the chat-scoped setter (full-object semantics,
  same family as the other scopes' setters).

### Card-side changes (`poem-party-panel.html` → regen `regex.json` → re-run patch)

- **Membership:** party = `主角` (always) + a manual member list (`party.members: string[]`) read from
  the per-chat KV (`getVariables({type:'chat'})['party.members']`). The strip renders only those.
  Default `[]` (just 主角).
- **Manage UI:** a **+** control opens a picker listing **known NPCs** = `关系列表` keys not already in
  `party.members`; clicking one adds it. An **×** on each non-主角 member removes it. Both persist via the
  per-chat setter. (Re-render reflects the updated list.)
- **Draggable strip:** the strip is `position:absolute` within the panel, with a drag **handle**; pointer
  drag updates its position, **clamped** to the panel viewport; `z-index` above the card's other/future
  content. The position persists in the per-chat KV (`party.stripPos: {x,y}`) so re-render-per-injection doesn't
  reset it. The detail overlay anchors to the strip's current position.
- **Namespacing:** per the contract, the panel uses prefixed keys in the per-chat KV — `party.members`
  (string[]) and `party.stripPos` ({x,y}) — so future widgets sharing the chat KV don't collide.
- **Contrast:** every text element uses a readable foreground (light `--rpt-text`-style with explicit
  fallbacks) against its actual background; audit strip/name/identity/好感度/性格/状态效果.

## Data flow

```
card page:
  getVariables({type:'chat'})  ─▶ host.getChatVars() ─▶ wcv-host-chat-vars-get ─▶ chatCardVars(profileId,chatId)
     → { "party.members": string[], "party.stripPos": {x,y} }   (namespaced keys per the contract)
  party = [主角] + party.members   (NOT 关系列表-在场)
  manage +: pick from Object.keys(关系列表) \ party.members → setVariables({type:'chat'}, …) → host.setChatVars
  drag:    update party.stripPos → host.setChatVars
  portraits: window.assetUrl(name, '头像'/'立绘', mood)   (unchanged)
```

## Error handling & edge cases

- Per-chat KV missing/corrupt → `{}` (party = just 主角; default strip position). Never throws.
- An NPC in `party.members` no longer in `关系列表` → still shown by name with a placeholder (or skipped if
  it has no data — render name + placeholder, don't crash).
- Drag clamped so the strip can't be dragged out of the panel; a reset is implicit (clear `party.stripPos`).
- No `window.assetUrl`/`getVariables` (degraded host) → placeholders + empty party, as v1.

## Testing

- **App delta (unit):** `chatCardVars` get/set round-trip + missing/corrupt → `{}` (temp dirs);
  `createThRuntime` exposes `getVariables({type:'chat'})`/the chat setter delegating to
  `host.getChatVars`/`setChatVars` (fake-Host test, mirroring the `thRuntimeAssetUrl` test). The
  `wcv-host-chat-vars` IPC + preload + inline transport are wiring (typecheck + suite green).
- **Card UI (manual-verify):** party = 主角 + curated members (not 在场); +/× add/remove from known NPCs
  persists per-chat; the strip drags + clamps + persists position; contrast is legible. (Bespoke card UI,
  like v1.)

## SDK documentation (deliverable)

Document the new `type:'chat'` per-chat card KV in `docs/sdk/` (its own entry alongside the existing
variable scopes in `component-inventory.md`) and in `docs/rpt-api.md`, using the **Contract** above:
scope (per-chat, survives restarts), shape (arbitrary JSON, shared bag → namespace keys), the NOT-stat_data
distinction, the scope-comparison table, and the read/write API. It must read as a stable, reusable card
surface — the party panel is named only as the first example. This is a required deliverable, not optional.

## Decisions (resolved)

- Delivery unchanged (card WCV panel; the added left panel stays). ✔
- Draggable strip = card-side, in-document, clamped, persisted per-chat. ✔
- Party = 主角 (always) + manual `party.members`; add from `关系列表`; **per-chat**. ✔
- Per-chat storage = a new app `type:'chat'` KV (not MVU `stat_data`, not per-card script vars), **a
  general extensible scope** (arbitrary namespaced JSON), **documented in the SDK** as a stable card surface. ✔
- Contrast = card CSS fix. ✔

## Deferred

- The relationship graph / 好感度 edges; companion vital data; the "other things" the panel will host
  later (this spec only makes the strip draggable so it can coexist).

## Related

- v1: `docs/superpowers/specs/2026-06-27-poem-party-avatar-panel-design.md` + its plan; the World Assets
  layer (`window.assetUrl`). Same branch / PR #23.
