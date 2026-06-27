# 命定之诗 BG3 party-avatar panel (design)

Status: **Design approved (2026-06-27).** A left-docked, Baldur's-Gate-3-style party-avatar panel for
the 命定之诗 card. Successor to the World Assets arc (it consumes that layer's portraits). The original
"relationship web" (spec 2) is **narrowed**: the node graph + affinity edges are **deferred**; this spec
is only the **party-avatar panel**.

## Context & motivation

The World Assets layer (shipped: `src/shared/worldAssets/`, `rptasset://`, the Asset Manager) lets the app
resolve a character's portrait by name + type (头像/立绘) + mood. This feature is the first in-game
*consumer* of those portraits: a BG3-style party panel showing 主角 + 在场 companions as mood-aware
avatars, expandable to a detailed character card.

**Owner-locked framing (2026-06-27):** this is **命定之诗 expansion content, not an app feature**. It
ships as a **card UI panel rendered in a WCV** (the isolated card-UI surface), docked into the left of the
workspace. The app provides only the generic affordances the card needs — same "card consumes the app
SDK; gaps become documented app deltas" philosophy as the combat expansion. So the deliverable splits
into **two app/SDK deltas** + **card content**.

### Scope (locked via Q&A, 2026-06-27)

- **Party-avatar panel only.** Relationship graph + 好感度 edges = deferred.
- Delivered as a **card-imported WCV panel** (not an app-native React view).
- **Auto-docked left** by default when the card is active (chat to its right).
- **Strip + detail overlay** interaction: a thin vertical portrait strip; click a portrait → a larger,
  dismissable detail card.
- Detail shows **all** of: 立绘, vital bars, 状态效果, 好感度/性格 + identity.
- **Vital bars are a UI shell only** — no data binding yet (MVU has no 生命/法力/体力 for companions, and
  per the owner, no vital-data code in this pass even for 主角).
- Portraits come from **World Assets** (mood-aware).
- **Look:** dark, ornate, real-RPG (BG3) feel for the detail card.

## Current state (what we build on)

- **Workspace** is a resizable split-tree: `shared/workspaceLayout.ts` (`WsNode = SplitNode | PanelNode`,
  `PanelNode = { type:'panel', key, view: ViewId }`), defaults from `shared/layoutDefaults.ts`
  (`defaultLayoutForMode(mode)`), seeded + merged-with-saved in `renderer/.../stores/workspaceStore.ts`.
  Each panel hosts a "view"; card UIs render in a **WCV** (`workspace/WcvPanel.tsx`); a card regex with
  `renderMode:'panel'` is promotable to such a panel.
- **WCV card bridge** (`preload/wcvHost.ts`, exposed as `rpt.*`): `statData()`, `floors()`, `charData()`,
  `charAvatarPath()`, `applyVariableOps()`, `setVariables()`, … — **no asset-resolution method**.
- **`rptasset://`** is registered on the **default** session only (`worldAssetProtocol`); the WCV card
  surface uses the `persist:wcv-cards` session (`wcvManager`), whose CSP already allows `img-src *`.
- **World Assets resolver:** `worldAssetService.resolveAssetFile(profileId, lorebookIds, category, name,
  type, mood?)` + the `asset-url` IPC + `assetUrlFor(...)`; mood via `shared/worldAssets/mood.currentMoodFor`.
- **MVU `关系列表` companion fields** (recovered schema): each in-场 companion carries `在场`, `好感度`,
  `性格`, `身份`/`职业`, `等级`, `生命层级`, `属性`, `状态效果`, `装备`, `技能` — but **NOT** the vital
  pairs `生命值`/`法力值`/`体力值` (only `主角` has those). This is exactly why vitals are a shell here.
- The card already emits per-character **mood** (`mood="…"` / `[情绪]:`) — the signal `currentMoodFor` reads.

## Architecture

### SDK Δ1 — auto-dock a card-declared left panel

Add an optional `rp_terminal.left_panel` declaration to the card manifest (a panel the app docks on the
left). When the active card declares it, the workspace's default layout for each mode gains a left
`PanelNode` whose `view` renders the card's declared panel (a `renderMode:'panel'` card regex, identified
by name), with the existing content (chat) to its right.

- The injection is a **pure layout helper** — `injectLeftPanel(root: WsNode, view: ViewId): WsNode`
  (wraps the existing root in a left/right split) — applied in `layoutDefaults`/`workspaceStore` seeding
  when the active card has `left_panel`. Saved user layouts still win on merge (don't clobber a
  user-customized layout).
- **Plan must ground** the exact view-id ↔ card-panel binding against the existing promoted-panel
  (`renderMode:'panel'`) + `WcvPanel` machinery (how a named card panel becomes a workspace `ViewId`).
  The spec fixes the *behavior* (a left WCV panel rendering the card's avatar UI, auto-present when the
  card is active); the plan fixes the wiring.

### SDK Δ2 — WCV World-Assets access

So the card's WCV panel can show portraits:
- **Register `rptasset://` on the `persist:wcv-cards` session** (the deferred item from the World Assets
  spec). Path validation is unchanged (`resolveProtocolPath`).
- **Add `rpt.assetUrl(name, type, mood?) → string | null`** to the WCV bridge (`wcvHost`) + a
  `wcv-host-asset-url` IPC handler that resolves against the active world's lorebook ids via
  `resolveAssetFile` and returns an `rptasset://…` URL (or null). Mood-aware through the existing resolver.
  (`type` ∈ 头像/立绘.)

### Card content (命定之诗 expansion)

A `renderMode:'panel'` regex shipped with the card (applied via a patch script in the gitignored card
dir, like the combat work's `patch-poem-card.cjs`), declared as the `left_panel`. The panel HTML/JS:

- **Party selection:** read `rpt.statData()` → 主角 + every `关系列表[name]` with `在场 === true`.
- **Strip (always visible):** per member, a framed mood-aware **头像** (`rpt.assetUrl(name,'头像',mood)`)
  + name; a thin **vital-bar shell** (static, no data). Missing portrait → stylized placeholder
  (initial/emblem). Click a portrait → open the detail overlay for that member.
- **Detail overlay (on click, dismissable):** the member's **立绘** (`rpt.assetUrl(name,'立绘',mood)`) as
  the centerpiece; **identity** line (职业/身份, 等级, 生命层级); **好感度 + 性格** (companions);
  **状态效果** row (类型/层数/剩余时间) — all wired from `stat_data`; plus the **vital bars as a static
  UI shell** (生命/法力/体力 frames with no values bound).
- **Look:** dark ornate RPG frame — gilded/engraved portrait frames, subtle mood tint, RPG-styled (not
  flat) vital bars, a status-effect icon row, and the detail card as a framed "character sheet" with the
  立绘 prominent. Reuse the app's theme tokens (`--rpt-*`) for color so it tracks the active theme.

## Data flow

```
rpt.statData() ─▶ party = [主角] + 关系列表.filter(在场)
   each member ─▶ rpt.assetUrl(name, '头像', currentMood) ─▶ rptasset://… ─▶ <img> (strip)
   click ─▶ overlay: rpt.assetUrl(name, '立绘', currentMood) + identity/好感度/性格/状态效果 from stat_data
            + vital bars (static shell, no binding)
```

`currentMood` is derived from the latest message's `mood="…"`/`[情绪]:` for the member (reuse the
World Assets mood convention; the card can pass it to `assetUrl`).

## Error handling & edge cases

- **No portrait** → stylized placeholder (initial/emblem); panel never shows a broken image.
- **No party / empty 关系列表** → an empty-state ("no companions present").
- **Assets absent entirely** → strip degrades to placeholders + names; detail still shows wired stats +
  the vital shell.
- **`rptasset://` not yet on the WCV session** (before Δ2) → portraits 404; Δ2 is the fix and is in scope.
- **Vitals** are intentionally unbound — the shell renders fixed/empty frames, clearly not live data.

## Testing

- **Δ1:** unit-test the pure `injectLeftPanel(root, view)` layout helper (wraps root in a left/right split;
  idempotent; doesn't clobber); unit-test the "active card declares `left_panel`" → seed-layout decision.
- **Δ2:** unit-test the `assetUrl` bridge resolution (name/type/mood → `rptasset://` URL via
  `resolveAssetFile`, null when absent) — mirrors the existing `assetUrlFor`/`asset-url` tests.
- **Card content:** the party-selection logic (主角 + 在场 filter) is pure and unit-testable against a
  fixture `stat_data`. The WCV panel HTML/CSS + click/overlay + the actual look are **manual-verify**
  (consistent with other card-UI panels), with a checklist (strip renders party, portrait + placeholder,
  click→overlay, wired stats present, vital shell visible).

## Decisions (resolved)

- Scope = party-avatar panel only; relationship graph/edges **deferred**. ✔
- Surface = card WCV panel (expansion content), **auto-docked left**. ✔
- Interaction = strip + dismissable detail overlay. ✔
- Detail content = 立绘 + vitals(shell) + 状态效果 + 好感度/性格 + identity. ✔
- Vitals = **UI shell, no data binding** (MVU lacks companion vitals; no vital code this pass). ✔
- Portraits = World Assets, mood-aware, via a new WCV bridge method. ✔

## Deferred (future specs)

- The **relationship web**: node graph of companions, 好感度-weighted edges, inter-companion links.
- **Companion vital data**: deriving/representing 生命/法力/体力 for non-主角 members (ties into the
  combat `资源推演` formulas) → then wire the vital bars.
- 装备/技能 in the detail card (the card's existing 角色查看器 covers full sheets).

## Related

- World Assets specs/plan (2026-06-27, merged): the layer this consumes
  (`assetUrl`, `currentMoodFor`, `rosterFromStatData`, `rptasset://`).
- The combat expansion (`docs/combat-poem-of-destiny-expansion.md`): the same app-SDK-delta + card-content
  split; the card-patch delivery pattern (`patch-poem-card.cjs`).
- 命定之诗 card material (gitignored, local): `example sillytarvern character card, presets, extensions
  and scripts/命定之诗/`.
