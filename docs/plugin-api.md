# RP Terminal Plugin API — `rpt.v1` (Card Scripts)

Developer reference for **card scripts**: JavaScript that ships inside a character
card and runs, sandboxed, while that card is active in a session. This is the P1
slice of the [plugin system](plugin-system-design.md) — the safe, interactive
"frontend script" capability (the niche that js-slash-runner fills for
SillyTavern), built on RP Terminal's own API.

> **Stability.** Everything documented under **"Available now"** is part of the
> `rpt.v1` contract. Additive changes stay within `v1`; anything breaking bumps to
> `v2` (and the host can offer both). Sections marked **Roadmap** are *not* yet
> callable — don't ship against them.

---

## 1. What a card script is

A card script is an entry in a character card under
`data.extensions.rp_terminal.scripts`:

```jsonc
{
  "spec": "chara_card_v3",
  "data": {
    "name": "My Character",
    "extensions": {
      "rp_terminal": {
        "scripts": [
          { "name": "stats-panel", "code": "/* your JS here */" }
        ]
      }
    }
  }
}
```

- `name` — a label (used in logs and error messages). Make it unique per card.
- `code` — the script body, plain JavaScript (ES2020+). No bundler, no modules —
  it runs as an inline `<script>`.

When the card is the active world **and** a session is open, all of its scripts
load into a single sandboxed iframe shown as the **⚙ Card Scripts** panel in the
right sidebar. Your script renders its UI into that iframe's `document.body` and
talks to the app through the injected `rpt` global.

Author scripts in-app from the **Scripts** tab (select a World first): add, edit,
rename, and delete a card's scripts, then **Save**. Saving persists them into the
card and live-reloads the running ⚙ Card Scripts panel. (Scripts also travel in
the card JSON under `data.extensions.rp_terminal.scripts`, so they import/export
with the card.)

---

## 2. Quick start

A complete, working script — a stat readout with a button that mutates state and
reacts to each AI turn:

```js
const root = document.createElement('div')
document.body.appendChild(root)

async function refresh() {
  const hp = await rpt.vars.get('stats.hp')
  root.innerHTML = `<b>HP:</b> ${hp ?? '—'}`

  const btn = document.createElement('button')
  btn.textContent = '+10 HP'
  btn.onclick = async () => {
    await rpt.vars.inc('stats.hp', 10)
    rpt.ui.toast('Healed +10 HP')
    refresh()
  }
  root.appendChild(btn)
}

rpt.on('ready', refresh)            // initial paint
rpt.on('generation:end', refresh)   // re-read after each AI response
refresh()
```

Because `stats.hp` is a **local** variable, writing it also updates any
`StatBar`/`Text` status-panel widget bound to `stats.hp`, and the next AI turn
sees the new value. See [§5 Variables](#5-variables-in-depth).

---

## 3. Runtime & security model

Card scripts are **untrusted code**, so they run with no ambient authority.

The host renders them in an `<iframe sandbox="allow-scripts">` **without**
`allow-same-origin`. That gives the frame a unique **opaque origin**, and the
document carries a strict Content-Security-Policy. The practical consequences:

**You CAN:**
- Run normal JavaScript: timers, `Promise`/`async`, JSON, `Math`, closures, etc.
- Fully control your own document — `document.body` is your canvas. Create DOM,
  attach event listeners, inject `<style>`, animate, etc. Base dark-theme styling
  is provided so your UI matches the app.
- Use the `rpt` API (below) for state, chat, generation, UI, logging, and events.
- Render inline images via `data:`/`blob:` URLs.

**You CANNOT (by construction, not by policy):**
- Touch the parent page — no access to the app's `window`, DOM, React, stores, or
  `window.api`. The opaque origin makes cross-frame access throw.
- Reach the network — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `sendBeacon`, remote `<img>`/`<script>`/`<link>` are all blocked by the CSP
  (`connect-src 'none'`, `default-src 'none'`). **There is no network in v1.**
- Use `localStorage`, `sessionStorage`, cookies, or IndexedDB (opaque origin →
  access throws or is partitioned away).
- Touch Node, the filesystem, or the OS — there is no `require`, `process`,
  `module`, or `__dirname` in the frame.
- Submit forms or open new windows (`allow-forms`/`allow-popups` are not granted).

The frame's **only** channel to the app is `postMessage`, which the injected
bridge wraps into the `rpt` API. Every call that reaches the engine is
permission-checked on the host side before it runs (see [§6](#6-permissions)).

### One frame per card

All scripts of a card share one iframe (they are same-author, so they are not
isolated from each other). The frame is **rebuilt from scratch** when:
- you switch the active card or session (the panel is keyed by card + chat), or
- you toggle the panel's **On/Off** switch.

A reload means your top-level code runs again and any in-memory state is lost —
persist anything important with `rpt.vars`/`rpt.global`.

---

## 4. The `rpt` API — reference

`window.rpt` is available to your script synchronously (the bridge is injected
before your code). **Every method that crosses into the app returns a `Promise`**
— `await` it.

### `rpt.version`
`string` — the API version, currently `"rpt.v1"`. Use it to feature-detect.

### Variables — `rpt.vars` (chat-local) and `rpt.global` (per-profile)

Both objects expose the same shape. `rpt.vars` reads/writes the **current
session's** variables; `rpt.global` reads/writes variables shared across all of a
profile's chats. Keys are **dot/bracket paths** (`"stats.hp"`, `"party[0].name"`).

| Method | Returns | Description |
|---|---|---|
| `rpt.vars.get(key)` | `Promise<any>` | Value at `key`, or `undefined` if unset. |
| `rpt.vars.all()` | `Promise<object>` | The entire variable object for the scope. |
| `rpt.vars.set(key, value)` | `Promise<value>` | Set `key`; creates intermediate objects. Resolves with `value`. |
| `rpt.vars.inc(key, n?)` | `Promise<number>` | Add `n` (default `1`); treats missing/NaN as `0`. Resolves with the new number. |
| `rpt.vars.dec(key, n?)` | `Promise<number>` | Subtract `n` (default `1`). Resolves with the new number. |
| `rpt.vars.del(key)` | `Promise<undefined>` | Delete `key`. |

`value` may be any JSON-serializable type (number, string, boolean, array,
object). **Permission:** auto-granted (`vars:read`/`vars:write`). See
[§5](#5-variables-in-depth) for semantics.

```js
await rpt.vars.set('inventory', ['torch', 'rope'])
await rpt.vars.inc('stats.gold', 25)
const gold = await rpt.vars.get('stats.gold')

await rpt.global.set('newGamePlus', true)   // survives across sessions
```

### Chat — `rpt.chat`

| Method | Returns | Description |
|---|---|---|
| `rpt.chat.getMessages()` | `Promise<Message[]>` | The full transcript, oldest first. |
| `rpt.chat.getLastMessage()` | `Promise<string>` | The latest AI response text (`''` if none). |

`Message` = `{ floor: number, user: string, response: string }`. `floor` is the
turn index (floor `0` is the opening greeting, which has an empty `user`). The
`response` is the **raw** model output (before display regex/beautification).

**Permission:** auto-granted (`chat:read`).

```js
const msgs = await rpt.chat.getMessages()
const lastFloor = msgs[msgs.length - 1]
if (/\bgoblin\b/i.test(lastFloor.response)) rpt.ui.toast('A goblin appears!')
```

### Generation — `rpt.generate`

```js
rpt.generate(text) // => Promise<true>
```

Starts a full turn using `text` as the user action — exactly as if the user
typed it. The prompt is assembled in the engine, streamed into the main chat
view, post-processed, and persisted as a new floor. Resolves `true` after the
floor lands; `generation:start` / `generation:end` events fire around it.

- **Permission:** **prompted** the first time per card (`generate`), then
  remembered. If the user declines, the call **rejects** with
  `permission denied: generate`.
- **Rejects** with `busy: a generation is already running` if a turn is already
  in flight — guard against double-firing.

```js
btn.onclick = async () => {
  try {
    await rpt.generate('I search the room for traps.')
  } catch (e) {
    rpt.log('generate failed:', e.message)
  }
}
```

### UI — `rpt.ui`

| Method | Returns | Description |
|---|---|---|
| `rpt.ui.toast(message)` | `Promise<true>` | Show a transient toast (auto-dismisses ~3s). |

**Permission:** auto-granted (`ui`). For richer UI, render directly into your
iframe `document.body` — that *is* your UI surface.

### Logging — `rpt.log`

```js
rpt.log('value is', x, '!')
```

Joins its arguments with spaces and writes to **both** the browser DevTools
console (prefixed `[card-script]`) and the app's **Logs** tab (prefixed with your
card name). Fire-and-forget — does not return a Promise. Great for debugging
without opening DevTools.

### Events — `rpt.on`

```js
rpt.on(eventName, callback) // register a handler; multiple handlers per event OK
```

Handlers registered at top level are guaranteed to be in place before any event
fires. Available events:

| Event | Payload | Fires when |
|---|---|---|
| `ready` | `{}` | The frame has loaded and the API is connected. Use for initial paint. |
| `generation:start` | `{}` | A turn begins (whether user- or script-triggered). |
| `generation:end` | `{}` | A turn finishes. Re-read vars/chat here to refresh your UI. |
| `chat:changed` | `{ floors: number }` | The session's message count changed (new floor, regenerate, delete). |

```js
rpt.on('generation:start', () => setBusy(true))
rpt.on('generation:end', () => { setBusy(false); refresh() })
```

---

## 5. Variables in depth

There are two scopes:

- **Local (`rpt.vars`)** — the active session's variables. Concretely, these are
  stored on the **latest floor's** `variables`. This is the *same* object that:
  - drives the right-panel **status widgets** (`ui_layout` entries reference these
    by path, e.g. a `StatBar` bound to `stats.hp`),
  - is mutated by `<rpt-event>` tags the model emits, and by ST-Prompt-Template
    `setvar()` calls during prompt assembly,
  - **seeds the next generation**, so a value you set now is visible to the model
    on the following turn.

  A local write from a script is persisted immediately and reflected live in the
  widgets. (If a session has no floors yet — e.g. a card with no greeting — local
  writes are a no-op until the first turn exists.)

- **Global (`rpt.global`)** — per-profile variables persisted to disk
  (`template-globals.json`), shared across every chat in that profile. Use for
  cross-session progress (achievements, New Game+, author-wide counters).

Both scopes use **dot/bracket paths**: `set('stats.hp', 10)` creates
`{ stats: { hp: 10 } }`. Numeric helpers (`inc`/`dec`) coerce missing or
non-numeric values to `0` before applying the delta.

Everything is async — values round-trip through the engine over IPC — so always
`await`.

---

## 6. Permissions

The host enforces a capability check on every engine-touching call. Per the
[design decisions](plugin-system-design.md#12-decisions-resolved-2026-06-20), low-risk
capabilities are auto-granted and only sensitive ones prompt:

| Capability | Methods | Grant |
|---|---|---|
| `vars:read` / `vars:write` | `rpt.vars.*`, `rpt.global.*` | **Auto** |
| `chat:read` | `rpt.chat.*` | **Auto** |
| `ui` | `rpt.ui.toast` | **Auto** |
| `generate` | `rpt.generate` | **Prompted** once per card, then remembered |

Grants are stored **per card** (the card id is the script's identity) in
`profiles/<id>/plugin-grants.json`. The panel's **On/Off** toggle disables a
card's scripts entirely (also persisted there). A denied or not-yet-granted
sensitive call rejects, so always wrap `rpt.generate` in try/catch.

There is **no network capability in v1**, by design.

---

## 7. Lifecycle

1. User opens a session for a card that has `scripts`.
2. The host builds one sandboxed iframe: CSP + base styles + the bridge shim +
   each script (each wrapped in its own `try/catch`, so one failing script can't
   break the others).
3. On load, the bridge connects and the host emits **`ready`**.
4. During play, the host forwards **`generation:start` / `generation:end` /
   `chat:changed`** as they happen.
5. Switching card/session or toggling the panel **rebuilds** the frame from
   scratch (top-level code re-runs; in-memory state resets).

An error thrown by one script is logged with its `name` and isolated; sibling
scripts keep running.

---

## 8. Recipes

**React to what the model wrote:**
```js
rpt.on('generation:end', async () => {
  const text = await rpt.chat.getLastMessage()
  if (/you take (\d+) damage/i.test(text)) {
    const dmg = Number(RegExp.$1)
    await rpt.vars.dec('stats.hp', dmg)
  }
})
```

**A quick-action bar that drives the story:**
```js
for (const action of ['Look around', 'Wait', 'Leave']) {
  const b = document.createElement('button')
  b.textContent = action
  b.onclick = () => rpt.generate(action).catch((e) => rpt.log(e.message))
  document.body.appendChild(b)
}
```

**Cross-session counter:**
```js
rpt.on('generation:end', async () => {
  const total = await rpt.global.inc('turnsPlayed')
  rpt.log('lifetime turns:', total)
})
```

---

## 9. Limitations & gotchas (v1)

- **Everything is async.** All `rpt.*` engine calls return Promises.
- **No network.** Blocked at the sandbox/CSP level — there's no workaround, by
  design.
- **No chat writes / message edits / slash commands** yet (Roadmap).
- **No durable per-plugin storage** beyond `rpt.vars`/`rpt.global` (Roadmap:
  `storage`).
- **State resets on frame reload** (card/session switch, toggle). Persist via
  variables.
- **Scripts of the same card share one frame** — they are not isolated from each
  other (same author). Different cards never share a frame.
- **Height auto-sizes** to your content; very tall UIs are capped (~1200px) —
  scroll within your own layout if needed.
- **No assistant prefill / direct model access** — go through `rpt.generate`.

---

## 10. Roadmap (not yet callable)

Planned for later plugin phases (see the [design doc](plugin-system-design.md)):

- `rpt.chat.sendUserMessage` / `editMessage` (`chat:write`).
- `rpt.lorebook.getEntries` / `activate` (`lorebook:read`).
- `rpt.slash.registerCommand` / `runCommand` + a minimal STScript subset.
- A **Tavern-Helper compatibility shim** mapping common
  `getVariables`/`setVariables`/`triggerSlash`/`generate` calls onto `rpt.v1`
  (clean-room — see below).
- `rpt.storage` — plugin-scoped key/value persistence.
- **App extensions** (panels/buttons/commands/hooks), a manifest, and an
  install/enable/disable **Plugins** tab (P2+).
- Opt-in `net` with a host allow-list.

---

## 11. Versioning & compatibility

- `rpt.version === 'rpt.v1'`. New methods/events added to v1 are additive and
  safe; existing signatures won't change under v1.
- A future breaking revision becomes `rpt.v2`; the host may run both so older
  cards keep working.
- Feature-detect before calling anything outside the table above:
  `if (rpt.lorebook) { … }`.

---

## 12. Provenance

The `rpt` API is **original, clean-room** work. RP Terminal does **not** copy,
vendor, or load any code from js-slash-runner / Tavern Helper (AGPL-3.0). We match
*formats and concepts* where useful for compatibility, and implement them
ourselves. See [`plugin-system-design.md` §9](plugin-system-design.md#9-js-slash-runner--tavern-helper-compatibility)
and the repo's `CLAUDE.md` → Licensing & Attribution.
