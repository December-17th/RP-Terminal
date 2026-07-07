# PM-A6 — `assetUrl` resolves location-category types (unblocks PM-B6 in-app)

Status: ready-for-human
Priority: P0 (blocks the owner's in-app pass — without it the band art silently never loads)
Dispatch: opus-4.8/medium
Scope: app (both card transports + shared resolve + SDK docs)
Origin: PM-B6 finding 2026-07-07 (its Comments have full citations)

## What

The card-facing `window.assetUrl(name, type, mood)` seam carries no category argument and BOTH
transports hardcode `'character'`:
- WCV: `src/main/services/worldAssetService.ts:166` (`assetUrlForWorld` — `const category:
  AssetCategory = 'character'`)
- Inline: `src/renderer/src/.../cardBridge/host.ts:274` (passes `'character'` literally)

`resolveAsset` scopes to that category (`src/shared/worldAssets/resolve.ts:20`) while `背景`/`全景`
are indexed under `location` (`src/shared/worldAssets/types.ts:28-31`), so a location lookup can
NEVER hit. Fix: infer the category from the asset TYPE — `categoryForType` already exists at
`types.ts:33-35`. Apply in `assetUrlForWorld` AND mirror in `cardBridge/host.ts:274` (the two
transports must stay at parity — repo rule; the change lives at the seam each transport fills,
verify there is no shared spot higher up that fits better before duplicating).

## Rules

- Card-agnostic app change; do not touch the poem surfaces.
- Characterization test: character-type lookups resolve exactly as before (same names/moods);
  NEW test that a `全景`/`背景` lookup resolves from the location index through BOTH the service
  path and (if testable) the bridge path.
- `docs/sdk/` update in the SAME commit (the assetUrl API doc — state that category is inferred
  from type; `docs/sdk/README.md` has the touch-X-update-Y map).
- Gate: npm run typecheck && npm run check:deps && npm run test — green at 2043/219 or higher.

## Acceptance

A WCV or inline card page calling `assetUrl('雾港','全景')` gets a `rptasset://` URL when the
world has that asset; character lookups byte-identical to before; SDK docs updated; gate green.

## Comments

**Done.** Both transports' `assetUrl(name, type, mood)` fill-in points now infer the category from
the asset TYPE instead of hardcoding `'character'`.

### Where the inference lives (design decision)

The category-inference RULE stays in ONE shared place — `categoryForType`
(`src/shared/worldAssets/types.ts:33-35`). Both transports call that single function at their own
fill-in point (no duplicated logic; just two call sites over one definition):

- **WCV path:** `src/main/services/worldAssetService.ts:166` — `const category = categoryForType(type)`
  (was `= 'character'`). `categoryForType` was already imported there.
- **Inline path:** `src/renderer/src/cardBridge/host.ts` `createInlineHost` — now imports
  `categoryForType` (+ the `AssetType` type) from `shared/worldAssets/types` and computes
  `const category = categoryForType(type as AssetType)` before calling `window.api.assetUrl(...)`
  (was the literal `'character'`).

**No higher shared seam fit.** The two card-facing paths do NOT converge on a common wrapper: WCV
goes through the `assetUrlForWorld` service convenience wrapper, while the inline path goes straight
to the generic `asset-url` IPC (`worldAssetIpc.ts` `asset-url`) that already takes an explicit
category (correctly used by `useDuelAssets.ts:60` for both `character` and `location`). Routing the
inline path through `assetUrlForWorld` would need a new dedicated card-facing IPC — larger scope and
no benefit, since `categoryForType` is already the single home for the rule. So both paths flow
through `categoryForType`; that satisfies "one definition both paths flow through." Unknown/garbage
`type` values fall back to `character` (the old hardcoded default), so no behavior regresses.

**No boundary change needed.** renderer→shared and main→shared imports were already legal;
`check:deps` clean (391 modules), no dependency-cruiser edit required.

### Tests (same commit)

- Characterization (`test/assetUrlForWorld.test.ts`): the existing 头像 base + mood-variant + null
  cases are untouched and still pass — character lookups byte-identical.
- New (same file): a `全景` and a `背景` lookup resolve from the `location` index; plus a
  cross-category guard (a name filed only under `character` does NOT satisfy a `全景` request).
- Bridge path: the inline closure (`createInlineHost.assetUrl`) is NOT cleanly unit-testable in the
  `node` vitest env — `host.ts` pulls in the whole renderer Zustand-store graph + `window.api`, so
  driving it needs an Electron/jsdom store harness (out of scope). Its only new behavior is the
  `categoryForType(type)` inference forwarded as the category arg; that seam is pinned by a new case
  in `test/worldAssetCategory.test.ts` ("is the single category-inference seam both transports flow
  through") + the IPC/service location path is covered by `worldAssetIpc.ts`/`worldAssetService`
  tests. Per the issue's "cover the bridge path too IF it is unit-testable without Electron."

Gate: typecheck clean · check:deps clean (391 modules) · test **2047 passed / 219 files** (was
2043/219; +4 new cases).

### SDK docs touched (same commit)

- `docs/sdk/component-inventory.md` — the World Assets runtime-API row (§2) + the "World Assets on
  WCV cards" note (§3): state that category is inferred from `type` and list the type→category
  mapping.
- `docs/rpt-api.md` — the `assetUrl` entry: same, with the `assetUrl('雾港','全景')` example.

(Per `docs/sdk/README.md`'s touch-X-update-Y map: runtime-behavior → component-inventory §2 +
rpt-api.md; cardBridge → component-inventory §2-3.)
