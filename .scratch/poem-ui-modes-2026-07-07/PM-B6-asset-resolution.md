# PM-B6 — v3 asset resolution: band 背景/全景 by 地点 + portrait by persona name

Status: ready-for-human
Priority: P0 (the owner's headline reason for keeping ensemble mode: HUGE location art)
Dispatch: opus-4.8/medium
Scope: card v3 surfaces (`poem-stage-surface.html`, `poem-self-surface.html`)
Order: after PM-B4, before PM-B3 (see PRD sequencing)

## What

Port the v4 asset-resolution fixes (v4 doc §1.3/§1.4) to the v3 surfaces — nothing app-side is
needed (`window.assetUrl` → `rptasset://` already works in WCV panels; verified in the v4 doc
trace against `wcvIpc.ts:552-560`, `thRuntime/index.ts:472`).

1. **STAGE band background** (`poem-stage-surface.html`): resolve automatically from
   `stat_data.世界.地点` — try the location name as a `全景` asset first (the band is panoramic —
   this is ensemble mode's showcase), then `背景`, then card-authored
   `stat_data.stage.background` override BEFORE both, then the themed gradient fallback (current
   behavior). Re-resolve on `mag_variable_updated` when 地点 changes; crossfade via the existing
   band transition if one exists (read the file first).
2. **SELF portrait** (`poem-self-surface.html`): resolve by PERSONA NAME with `'主角'` as
   fallback (today it asks literally for `'主角'` and no imported asset matches). Ground how the
   persona name is readable from the runtime (`getVariables()`/chat model — verify in
   `docs/sdk/` + `shared/thRuntime`; if the persona name is NOT reachable from a WCV, STOP and
   report the exact gap).
3. **Failure diagnostics:** on any asset lookup failure, keep the current placeholder but log a
   single clear `console.warn` naming the tried keys (the old silent `img.onerror` removal was
   the bug that hid all this).

## Verification

Standalone with a mocked `assetUrl` map (hit + miss paths); in-app verification is the owner's
pass after `--apply` (agents never touch the card asset folder).

## Acceptance

Location-driven band art with the documented precedence; persona-name portrait with fallback;
warnings on misses; gradient fallback unchanged when nothing resolves. Gate green.

## Comments

**Commit:** `a10b31a` (`feat(poem-v3): 地点-driven band art + persona-name portrait (PM-B6)`), on
branch `claude/nifty-mcclintock-6e6a1b`, base was `31fd88d` (PM-B4).

**Gate:** all green — `typecheck` clean, `check:deps` clean (391 modules), `test` **2043 passed /
219 files** (matches the expected count).

### Grounded facts (with citations)

- **Persona name IS reachable from a WCV surface.** The runtime exposes
  `SillyTavern.substituteParams` (`src/shared/thRuntime/index.ts:543` = `substMacros`), which expands
  `{{user}}` over `{ user: host.personaName(), … }` (`index.ts:115-123`, `:119`). The runtime object is
  spread onto the card window in the WCV transport (`src/preload/wcvPreload.ts:285-296`,
  `Object.assign(w, g)`), and `SillyTavern` is one of the returned members (`index.ts:583-595`,
  `:587`). Documented in `docs/sdk/component-inventory.md:87,107`. So the SELF surface reads the persona
  name via `SillyTavern.substituteParams('{{user}}')`. **Note:** there is NO bare `substituteParams`
  window global — it lives only on `SillyTavern` (grep of `src` finds it only at `index.ts:113,543`); the
  pre-existing PM-B7 `personaName()` used the bare global, which would silently fail in WCV. I hardened it
  to prefer `SillyTavern.substituteParams`, keeping the bare call as a secondary fallback.

- **`window.assetUrl(name, type, mood)` plumbing.** WCV: `wcvPreload` → `wcvHost.assetUrl`
  (`src/preload/wcvHost.ts:138`) → IPC `wcv-host-asset-url` (`src/main/ipc/wcvIpc.ts:553-560`) →
  `worldAssetService.assetUrlForWorld` (`src/main/services/worldAssetService.ts:159-171`). The runtime
  method is `index.ts:472` (`host.assetUrl`). Location vs character categories are defined in
  `src/shared/worldAssets/types.ts:27-35` (`背景`/`全景` → `location`); the index is built per-category
  (`worldAssetService.ts:27-44`) and `resolveAsset` keys off `indexes[pos][category][name][type]`
  (`src/shared/worldAssets/resolve.ts:20`).

### ⚠️ Reality contradicts the issue's grounding — reported, not redesigned (per HARD RULE)

The issue says the band-background half needs "nothing app-side" because "`window.assetUrl` →
`rptasset://` already works in WCV panels." **That is false for LOCATION-category types.** The
card-facing `window.assetUrl` seam carries NO category argument, and BOTH transports fill it with the
literal `'character'`:

- WCV: `assetUrlForWorld` hardcodes `const category: AssetCategory = 'character'`
  (`src/main/services/worldAssetService.ts:166`).
- Inline: `cardBridge/host.ts:274` passes `'character'` directly to `window.api.assetUrl(...)`.

Because `resolveAsset` scopes the lookup to that category (`resolve.ts:20`) and `背景`/`全景` are indexed
only under the `location` category (`types.ts:28-31`, `buildIndex` at `worldAssetService.ts:29-41`), a
`全景`/`背景` request from ANY card surface can never hit — it will always return `null`. The v4 doc's
finding #4 (`docs/design/poem-play-area-redesign-v4.md:34-37`) verified the *storage/index* layer has
location types, but the trace only exercised *character* portraits (finding #3); it did not verify the
card-facing resolution path can reach the `location` category.

**Consequence:** the STAGE band code implements the full card-side precedence correctly and is verified
in a standalone harness, but **in-app the band will always fall back to the themed gradient** until an
app-side fix lands. The one-line fix (out of PM-B6's card-only scope; needs both transports at parity +
`docs/sdk/` update + a characterization test) is to infer the category from the type, e.g. in
`assetUrlForWorld`: `const category = categoryForType(type)` (`categoryForType` already exists at
`src/shared/worldAssets/types.ts:33-35`), and mirror it in `cardBridge/host.ts:274`. **Recommend the
controller spin this into a follow-up app-side issue before running `--apply`,** otherwise the owner's
in-app pass will see gradient-only bands. The SELF portrait (character category) is unaffected and works
in-app.

### Verification matrix (standalone, srcdoc harness with stubbed host — all pass)

| Surface | Scenario | Result |
|---|---|---|
| STAGE band | override present | `王座厅/全景` queried first, `has-img` = override art; 地点 not consulted |
| STAGE band | hit on 全景 | `--scene-img` set, `has-img`, no warn |
| STAGE band | miss 全景 → hit 背景 | falls through to 背景, `has-img`, no warn |
| STAGE band | total miss | `has-img` cleared (gradient kept), ONE warn `[poem-stage] … [全景:X, 背景:X]` |
| STAGE band | 地点 change on `mag_variable_updated` | re-queries new 地点 (`雾港/全景`→`雾港/背景`); `sceneKey` guard allows it |
| SELF portrait | persona-name hit | `alt=<persona>`, image loads, placeholder hidden, no warn |
| SELF portrait | fallback to 主角 | persona miss → `alt=主角` loads, placeholder hidden |
| SELF portrait | no persona → 主角 | npName '你', portrait resolves 主角 |
| SELF portrait | total miss | placeholder retained, ONE warn `[poem-self] … [立绘:<persona>, 立绘:主角]` |
| SELF nameplate | persona reachable | `npName` shows the persona name (was the fallback '你' before) |

Screenshots were best-effort only (the PRD's known `preview_screenshot` hang on these pages); layout
asserted via DOM/computed-style measurement in an iframe harness rooted at the running `docs-static`
server. The committable standalone stubs (`?assets=` on STAGE; `?persona=&assets=` on SELF) install only
when the real host is absent.
