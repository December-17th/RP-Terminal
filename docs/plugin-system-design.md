# Plugin / Extension System — Design

Status: **draft for review** (no implementation yet). This document defines the
architecture for installing and running third-party plugins/extensions — the class
of feature exemplified by [js-slash-runner](https://github.com/n0vi028/js-slash-runner)
(a.k.a. Tavern Helper). It is design-doc-first on purpose: the API contract and the
permission model are hard to change once plugins depend on them.

---

## 1. Purpose & scope

Let third-party authors extend RP Terminal without forking it:

- **Card scripts** — interactive JavaScript shipped *with a character card* (or
  lorebook) that reads/writes state, drives generation, and renders its own UI in
  the chat. This is js-slash-runner's niche.
- **App extensions** — plugins that extend the *app shell*: add a left-panel tab,
  a top-nav button, a slash command, or react to lifecycle/chat events.

### Goals
- Run **untrusted** third-party code safely (the whole point — and the hard part).
- A **stable, versioned API** (`rpt.v1`) so plugins keep working across app updates.
- **Per-plugin permissions**, declared in a manifest and enforced by the host.
- Install / enable / disable / configure via UI; plugins are just files on disk.
- A **best-effort compatibility shim** so common js-slash-runner / Tavern Helper
  scripts run with little or no change — without reimplementing all of SillyTavern.

### Non-goals (v1)
- 100% SillyTavern-extension compatibility (ST extensions assume ST's full runtime —
  `getContext`, jQuery, the ST DOM, full STScript). We target *script-level* compat,
  not *extension-package* compat.
- A hosted plugin marketplace / auto-update (later).
- Plugins written in anything but JS/HTML/CSS.

---

## 2. Threat model & security principles (the foundation)

A plugin system **changes the threat model** from "we author all code" to "we run
arbitrary third-party code." This is precisely what the product spec (§3.3) warned
against, so isolation is non-negotiable and drives the whole design.

Principles:
1. **Plugin code is untrusted.** Assume any installed plugin may be malicious or
   buggy. It must be unable to touch the filesystem, the OS, other plugins' data,
   the app's internals, or the network — except through the permissioned API.
2. **Sandbox by construction, not by review.** Don't rely on auditing plugin source.
   Use OS/browser isolation primitives so a plugin *physically cannot* exceed its
   grant.
3. **Capability + permission.** A plugin can only call API methods (a) that exist in
   the API and (b) it was granted in its manifest, approved by the user at install.
4. **No ambient authority.** The sandbox has no `process`, `require`, `fetch`,
   `localStorage`, parent DOM, or `window.api`. Everything goes through the bridge.

### Chosen sandbox: `sandbox="allow-scripts"` iframe + postMessage RPC
We already render card HTML in an iframe (B1). For *scripts*, use an iframe with
**`sandbox="allow-scripts"` and NOT `allow-same-origin`** → the iframe gets a unique
**opaque origin**: scripts run, but cannot access the parent window/DOM, cookies,
storage, or make same-origin requests. Its *only* channel to the app is
`postMessage`. The host (renderer) injects a small **bridge shim** that wraps
postMessage into the friendly API; every call is permission-checked host-side and,
where it touches the engine (vars, generation, storage), forwarded over IPC to main.

```
┌─ plugin iframe (opaque origin, allow-scripts) ─┐   postMessage   ┌─ renderer host ─┐   IPC   ┌─ main ─┐
│ plugin code → rpt.getvar('hp')                 │ ───────────────▶ │ perm check +    │ ──────▶ │ engine │
│              ← Promise resolves with value     │ ◀─────────────── │ dispatch        │ ◀────── │        │
└────────────────────────────────────────────────┘                 └─────────────────┘         └────────┘
```

Why not Node `vm`? Not a boundary (already rejected for templates). Why not only
quickjs? quickjs is great for *pure logic* (no DOM) and we already use it for
templates — but plugins need to render UI, so the iframe is the natural home; quickjs
remains an option for headless "logic-only" plugin hooks if we want a lighter path.

**Reuse:** this is B1's iframe + a message bridge + the existing variable system + IPC.

---

## 3. Plugin taxonomy

| | **Card script** | **App extension** |
|---|---|---|
| Ships in | a character card / lorebook (`extensions.rp_terminal.scripts`) or a standalone plugin package | a standalone plugin package |
| Lifecycle | loaded when its card is active in a session | loaded at app start (if enabled) |
| Typical API | vars, chat read, generate, render UI in-message | + register panels/buttons/commands, lifecycle hooks |
| Trust | scoped to the active world/session | broader (touches the shell) — stricter permission prompts |
| js-slash-runner analog | the frontend scripts it runs | the extension itself |

Both run in the same sandbox model; they differ in *which API capabilities* and
*UI extension points* they may request.

---

## 4. Manifest format (`manifest.json`)

```jsonc
{
  "id": "dev.author.my-plugin",        // reverse-DNS, unique
  "name": "My Plugin",
  "version": "1.0.0",
  "type": "app-extension",             // "card-script" | "app-extension"
  "entry": "main.js",                  // sandboxed entry; may pull in main.css/html
  "apiVersion": "rpt.v1",
  "permissions": [                     // requested capabilities (see §6)
    "vars:read", "vars:write", "chat:read", "generate",
    "ui:panel", "slash:register", "storage"
  ],
  "contributes": {                     // declarative UI/command surface
    "panels": [{ "id": "stats", "title": "Stats" }],
    "commands": [{ "name": "roll", "description": "Roll dice" }]
  }
}
```

Storage: `userData/rp-terminal-data/plugins/<id>/` (files), enable-state + granted
permissions per profile in SQLite (`plugins` table) or a small JSON. Card scripts
embedded in a card need no separate install — they come with the card.

---

## 5. Architecture

- **Plugin host (main)** — discovers installed plugins, reads manifests, tracks
  enabled/permission state, serves plugin files, and dispatches permission-checked
  API calls that touch the engine (vars/generation/lorebook/storage).
- **Plugin runtime (renderer)** — for each active plugin, creates the sandboxed
  iframe, injects the bridge shim + the plugin's `entry`, and routes postMessage
  RPC: UI calls handled in the renderer, engine calls forwarded to main over IPC.
- **Bridge shim** — the `rpt` global injected into every plugin iframe: thin
  promise-returning wrappers over `postMessage` with a request-id correlation map.

New IPC: `plugins:list/enable/disable/install/uninstall`, `plugin-api:<method>`
(dispatched with the calling plugin id for permission checks), and an event channel
for host→plugin events.

---

## 6. The Plugin API (`rpt.v1`) — versioned

Every method is gated by a manifest permission. Sketch (promise-based):

- **vars** (`vars:read`/`vars:write`) — `getvar/setvar/incvar/decvar` (same engine as
  templates; chat + global scope).
- **chat** (`chat:read`/`chat:write`) — `getMessages(range)`, `getLastMessage()`,
  `sendUserMessage(text)`, `editMessage(floor, text)`.
- **generate** (`generate`) — `generate(opts)` → triggers a turn; stream events via
  callbacks.
- **lorebook** (`lorebook:read`) — `getEntries()`, `activate(keys)`.
- **ui** (`ui:panel`/`ui:button`/`ui:toast`) — `registerPanel(def)`,
  `registerButton(def)`, `toast(msg)`, `openModal(html)` (rendered in *the plugin's
  own* sandboxed surface).
- **slash** (`slash:register`) — `registerCommand(name, handler)`,
  `runCommand(line)`.
- **storage** (`storage`) — plugin-scoped key/value (`get/set/keys`), persisted under
  the plugin's dir; isolated per plugin.
- **events** — `on('messageRendered'|'generateStart'|'generateEnd'|'appReady'|…, cb)`.
- **net** (`net`, opt-in, off by default) — restricted `fetch` to allow-listed hosts.

Versioning: `apiVersion: "rpt.v1"`. Additive changes stay v1; breaking changes bump
to v2 and the host can offer both.

---

## 7. Permission model

- Manifest lists requested `permissions`. On **install** (or first enable), the user
  is shown a clear list ("This plugin wants to: read chat, trigger generation,
  add a panel") and approves or declines.
- The host stores granted permissions and **enforces every API call** against them;
  the sandbox makes bypass physically impossible.
- Sensitive caps (`net`, `chat:write`, `generate`) are highlighted. `net` is **off by
  default** with an explicit host allow-list.

---

## 8. Slash-command / STScript runtime (subset)

js-slash-runner leans on STScript (`/command`). v1 ships a **minimal** runtime: parse
`/name arg1 arg2`, a registry of built-in commands (e.g. `/setvar`, `/gen`, `/echo`)
plus plugin-registered ones, run from the input box or by plugins. Pipes/closures/the
full STScript grammar are a later stretch goal — flagged as a known fidelity gap.

---

## 9. js-slash-runner / Tavern Helper compatibility

We do **not** load ST extensions directly. Instead, inject a **`TavernHelper` shim**
into card-script iframes that maps the common Tavern-Helper surface onto `rpt.v1`:
`getVariables/setVariables` → vars, `getChatMessages` → chat.getMessages,
`triggerSlash` → slash.runCommand, `generate` → generate, event registration →
events. Goal: the common 80% of community scripts run unmodified; deeply ST-coupled
ones (jQuery DOM surgery, full STScript, ST-internal APIs) are explicitly out of scope
for v1 and degrade gracefully (unknown calls no-op + warn in the Logs panel).

---

## 10. Lifecycle & management UI

- A **Plugins** left-panel tab: list installed plugins (name/version/type), toggle
  enable, view/grant permissions, open settings, uninstall, and **Install** (pick a
  plugin folder or `.zip`; later, PNG cartridge).
- Card scripts surface under the World/card view (they travel with the card).

---

## 11. Phased implementation plan

| Phase | Deliverable | Reuses |
|---|---|---|
| **D0** | This design doc + decisions on the open questions (§12). | — |
| **D1** | **Card-script runtime**: sandboxed `allow-scripts` iframe + postMessage RPC bridge + core API (vars, chat:read, generate, ui:toast/in-message panel). Runs `card.extensions.rp_terminal.scripts`. *This alone delivers js-slash-runner-style interactivity, safely.* | B1 iframe, vars engine, IPC |
| **D2** | **Plugin host/loader**: manifest, `plugins/` dir, install/enable/disable, permission prompts, Plugins tab. | file storage, SQLite |
| **D3** | **App-extension contributions**: `registerPanel/registerButton/registerCommand`, event hooks, shell UI injection points. | tabbed shell |
| **D4** | **Slash-command runtime (subset)** + **Tavern Helper shim**. | D1 bridge |
| **D5** | Packaging (`.zip` / PNG cartridge), settings persistence, optional `net` allow-list. | cartridge parser (vNext §L) |

D1 is the highest-value, lowest-risk start and is mostly additive on B1.

---

## 12. Decisions (resolved 2026-06-20)

1. **Start with P1 — the card-script runtime** (our `rpt.v1` API first). The
   Tavern-Helper compat shim + slash runtime come later (P4).
2. **Permission UX: prompt only for sensitive capabilities.** Low-risk caps
   (`vars:read`, `chat:read`, `ui:*`, `storage`) are auto-granted; the user is
   prompted to approve sensitive ones (`generate`, `chat:write`, and `net` if ever
   enabled). Granted set is recorded per plugin.
3. **v1 = card scripts only.** App-extension contributions (panels/commands/hooks,
   P3) come after — smaller blast radius first.
4. **No network in v1.** The `net` capability is not implemented; plugins cannot
   `fetch`. Revisit (opt-in, host allow-list) post-v1.
5. **Distribution: TBD at P2.** Likely plugin folders / `.zip`; PNG cartridges align
   with the vNext card format. Card scripts (P1) need no installer — they travel in
   the card's `extensions.rp_terminal.scripts`.

These choices simplify P1: a sandboxed iframe + bridge + a small auto-granted API
(`vars`, `chat:read`, `generate` [prompted], `ui:toast`/in-message UI), no network,
running scripts embedded in the active card.

---

## 13. What we already have (so this is incremental, not a rewrite)

- Sandboxed **iframe** rendering (B1 `HtmlFrame`) — the isolation primitive.
- **quickjs** WASM sandbox (templates) — option for headless logic hooks.
- **Variable engine** (`getvar/setvar/…` over floor + global vars).
- **IPC bridge** + preload pattern — the host↔engine channel.
- **File-based artifact storage** + SQLite — plugin storage & state.
- A **tabbed UI shell** with clean panel slots — extension points.

The genuinely new work is the **manifest/host/loader**, the **versioned API contract**,
the **permission model**, the **postMessage bridge**, and the **slash/STScript +
Tavern-Helper shim**.
