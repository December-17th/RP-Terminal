# Duel Build-Preview — fork 战斗 tab (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new **战斗 tab** to the 命定之诗 status app (the fork) that renders the engine-computed duel build (deck-as-cards + a resource/relic header + a party-member selector) from the RPT `getDuelPreview()` host API.

**Architecture:** A zustand+immer store calls the card-page global `getDuelPreview()` (with a static fixture fallback for dev / older RPT), and a `CombatTab` page renders it — a member selector, a resource/relic header (reusing the app's `ResourceBar` + `StatusEffectDisplay`), and a deck grid of `DuelCard`s. Every color is a `--theme-*` token (works across all 8 themes incl. the light default `ivory`); the layout reflows wide↔tall via CSS container queries. Recompute is keyed to the app's existing `mvu-data` refresh plus a local refresh button.

**Tech Stack:** React 19 + TSX + zustand v5 + immer + **SCSS Modules** (`*.module.scss`), webpack (`build` runs `ts-loader` typecheck), ESLint flat config + Prettier. **No unit-test harness** — verification is `lint` + `build` + a static `DuelPreview` fixture + a visual check.

> **Repo:** this plan executes in the **fork** at `E:\Projects\FrontEnd-for-destined-journey-TPR-STS` (NOT the RPT app repo). All paths below are relative to that repo unless prefixed `RPT:`.
> **Depends on:** [Plan A](2026-06-30-duel-preview-host-api.md) — **already built & verified** (the `getDuelPreview` host API + `DuelPreview` contract). Plan B can still be built/checked against the **fixture** with no live RPT host; the `typeof getDuelPreview === 'function'` guard picks up the live API automatically when the card runs inside RPT.

---

## Grounding — facts verified against the fork (read these before starting)

These were checked against the actual fork source so the executor doesn't re-derive them. Cited as `file:line`.

- **The fork uses SCSS Modules**, not global stylesheets. Every component does `import styles from './X.module.scss'` and `className={styles.someClass}` (camelCase keys). E.g. [`ResourceBar.tsx:3`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/shared/components/ResourceBar/ResourceBar.tsx), [`StatusTab.tsx:28`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/pages/status/StatusTab.tsx). **Do not** write global-class SCSS.
- **Stores are zustand v5 + immer.** Pattern: `create<T>()(immer((set, get) => ({ ... })))`, mutate via `set(state => { state.x = … })`. See [`mvu-data.store.ts:28`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/core/stores/mvu-data.store.ts), [`theme.store.ts:32`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/core/stores/theme.store.ts).
- **Theme tokens are emitted as `--theme-<kebab>`** by `applyCssVariables` ([`theme.store.ts:112-121`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/core/stores/theme.store.ts)): it walks `ThemeColors` and does `--theme-${key.replace(/([A-Z])/g,'-$1').toLowerCase()}`. So `energyGem → --theme-energy-gem`, `ratingAccent → --theme-rating-accent`, `powerText → --theme-power-text`, `qualityEpic → --theme-quality-epic`, `resourceHp → --theme-resource-hp`, `cardBg → --theme-card-bg`, etc.
- **There are exactly 8 presets** (`parchment, crimson, indigo, bronze, sakura, obsidian, ivory, misty-lilac`) and **`DefaultTheme = IvoryTheme`** — a **light** theme ([`theme-presets.ts:656-668`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/config/theme-presets.ts)). `ivory` + `misty-lilac` are light; the other 6 are dark. Light-legibility is not optional — the default ships light.
- **`getDuelPreview` is a bare card-page global** (same install path as `getVariables`/`assetUrl`, which the fork already calls bare — [`mvu-data.store.ts:48`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/core/stores/mvu-data.store.ts), [`theme.store.ts:42`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/core/stores/theme.store.ts)). RPT exposes it at `RPT:src/shared/thRuntime/index.ts:451` beside `assetUrl`. Its return type is **`Promise<DuelPreview | null>`** (per `RPT:docs/rpt-api.md:172`) — it may also be **absent** on older RPT / standalone dev, so it must be guarded with `typeof getDuelPreview === 'function'`.
- **TH globals are declared in vendored type packs** under `@types/function/*` and `@types/iframe/*` — **do not edit those.** Declare the new global in the **repo-root** [`global.d.ts`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/global.d.ts) (the project's own ambient file).
- **`ResourceBar` props** ([`ResourceBar.tsx:5-12`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/shared/components/ResourceBar/ResourceBar.tsx)): `{ label, current, max, type: 'hp'|'mp'|'sp'|'exp', icon?, showValues? }`. Reuse directly (it already themes itself).
- **`StatusEffectDisplay` props** ([`StatusEffectDisplay.tsx:7-27`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/shared/components/StatusEffectDisplay/StatusEffectDisplay.tsx)): `effects: Record<string, { 类型?, 效果?, 层数?, 剩余时间?, 来源? }>`, plus `mode='chips'|'full'`, `compact`, `maxVisible`, `showRemainingCount`, `emptyText`. We reuse it in **chips** mode for `conditions` by mapping our neutral `conditions[]` into that record.
- **`TabItem.id` is `string`** ([`TabBar.tsx:4-10`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/layout/TabBar/TabBar.tsx)) — adding `id:'combat'` needs **no** type change. `App.tsx`'s `activeTab` is a `string` and `renderTabContent` is a `switch` ([`App.tsx:32-55`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/App.tsx)).
- **Refresh is manual, not event-driven.** `Window` calls `useMvuDataStore().refresh()` once on mount ([`Window.tsx:14-21`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/layout/Window/Window.tsx)); `TitleBar` has a manual refresh button. `refresh()` bumps `lastRefreshTime`. So the combat tab recomputes on **mount + when `lastRefreshTime` changes + a local refresh button** (design §9 Q4 "auto on change + a light refresh button").
- **FontAwesome is host-provided FA6 *Free*** (the status app runs inside RPT's card iframe; no FA bundled in the fork's `index.html`/`public`). `fa-swords` is **Pro-only** → use a free solid icon. Tabs use plain `fa-solid fa-*` nouns ([`tabs.config.ts`](E:/Projects/FrontEnd-for-destined-journey-TPR-STS/src/status/config/tabs.config.ts)). Use **`fa-solid fa-khanda`** (free; reads as crossed swords); fallback `fa-shield-halved` / `fa-hand-fist`.
- **`fa-rotate-right`** is used for the refresh button (free; same family the app already uses for chevrons/trash icons).
- **Types barrel:** `core/types/index.ts` re-exports type modules (`export type * from './mvu-data'`, `'./theme.d'`) — add the new contract here so components import it from `'../../core/types'` like `StatData`.

---

## Global Constraints

- **Theme tokens only — no hardcoded colors.** Every color is a `--theme-*` CSS variable. Must be legible on **light** themes (`ivory` is the default; `misty-lilac`) and the 6 dark ones.
- **SCSS Modules only.** New styles go in `*.module.scss`, referenced via the imported `styles` object. No global selectors.
- **Flexible wide AND tall** via CSS **container queries** on the tab root (sizes to the panel, not the viewport). No fixed px widths/heights for layout.
- **Render-only consumer.** The tab reads `DuelPreview`; it never recomputes the deck/parse/评级 (that's RPT, Plan A) and never writes `stat_data`.
- **Coexist with the party panel** — this tab's member selector only *views* builds; it does not manage party membership.
- **Prettier/ESLint clean:** single quotes, semicolons, trailing commas, 2-space indent (run `npm run format` then `npm run lint:fix` if needed before the gate).
- **Verification gate (each task's last step):** `npm run lint && npm run build` must pass (`build` = `webpack --mode production`, which runs the `ts-loader` typecheck). Plus the per-task **visual check** where noted.
- **Follow existing fork patterns:** mirror `pages/status/StatusTab.tsx`, `core/stores/*.store.ts`, `shared/components/*`. Read the component you reuse before wiring its props.

---

## File Structure (in the fork)

| File | Responsibility |
| --- | --- |
| `src/status/core/types/duel-preview.d.ts` (new) | The `DuelPreview`/`CombatantPreview`/`CardPreview` contract — an exact copy of Plan A's `preview.ts` (the shared interface). |
| `src/status/core/types/index.ts` (modify) | Re-export the contract from the types barrel. |
| `global.d.ts` (modify) | Ambient declaration for the `getDuelPreview()` card-page global. |
| `src/status/core/utils/duel-preview-fixture.ts` (new) | A static `DuelPreview` for dev/visual checks before the live API is present. |
| `src/status/core/types/theme.d.ts` (modify) | Add `energyGem` / `ratingAccent` / `powerText` to `ThemeColors`. |
| `src/status/config/theme-presets.ts` (modify) | Add values for the 3 new tokens to **all 8** presets. |
| `src/status/core/stores/duel-preview.store.ts` (new) | zustand+immer store: `load()` via `getDuelPreview()` (fixture fallback) + `select()`; `selectViewed` selector. |
| `src/status/core/stores/index.ts` (modify) | Export the new store. |
| `src/status/pages/combat/DuelCard.tsx` (new) | Render one `CardPreview` as a themed card. |
| `src/status/pages/combat/DuelCard.module.scss` (new) | Card styling (tokens only). |
| `src/status/pages/combat/CombatTab.tsx` (new) | The tab: selector + resource/relic header + deck grid; container-responsive. |
| `src/status/pages/combat/CombatTab.module.scss` (new) | Container-query layout (tokens only). |
| `src/status/pages/combat/index.ts` (new) | Barrel export. |
| `src/status/config/tabs.config.ts` (modify) | Add the `combat` tab entry. |
| `src/status/App.tsx` (modify) | Render `<CombatTab/>` for the `combat` tab. |
| `src/status/pages/index.ts` (modify) | Export `CombatTab`. |

---

## Task 0: Bootstrap the fork toolchain (prerequisite)

The fork has **no `node_modules`** and **pnpm is not installed** on this machine (only `npm` 10.9.3). Nothing lints/builds until deps are installed. This task has no commit; it's a one-time setup.

- [ ] **Step 1: Create a working branch**

```bash
cd "E:/Projects/FrontEnd-for-destined-journey-TPR-STS"
git checkout -b feat/combat-build-tab
```

- [ ] **Step 2: Install dependencies**

The lockfile is `pnpm-lock.yaml`. Prefer pnpm via corepack; fall back to npm if corepack/pnpm is unavailable.

```bash
# preferred (matches the lockfile):
corepack enable
corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile
# fallback if pnpm cannot be provisioned:
#   npm install
```

- [ ] **Step 3: Confirm the gate runs on a clean tree**

```bash
npm run lint && npm run build
```
Expected: both succeed on the untouched `main` snapshot (this is the baseline; if `build` fails before any change, stop and report — the toolchain isn't healthy). `npm run <script>` invokes the package.json scripts regardless of which installer populated `node_modules`.

> All later tasks' gate = `npm run lint && npm run build` (equivalently `pnpm lint && pnpm build`).

---

## Task 1: Contract type + barrel + ambient global + fixture

**Files:**
- Create: `src/status/core/types/duel-preview.d.ts`, `src/status/core/utils/duel-preview-fixture.ts`
- Modify: `src/status/core/types/index.ts`, `global.d.ts`

**Interfaces:**
- Produces: `DuelPreview`, `CombatantPreview`, `CardPreview` (the shared contract); `DUEL_PREVIEW_FIXTURE`; the ambient `getDuelPreview()` global.

- [ ] **Step 1: Copy the contract type (exact, from Plan A's `preview.ts`)**

Create `src/status/core/types/duel-preview.d.ts`:

```ts
// The generic, card-agnostic duel build-preview contract returned by the RPT host API
// getDuelPreview(). Keep IDENTICAL to RPT's src/shared/combat/deckbuilder/preview.ts — it is the
// shared interface (the contract). Neutral field names; the card's ruleset supplies values +
// display strings, this app applies labels/theming.
// See docs/superpowers/specs/2026-06-30-duel-build-preview-tab-design.md §2.

export interface DuelPreview {
  config: { energyPerTurn: number; handSize: number };
  lead: CombatantPreview;
  party: CombatantPreview[];
}

export interface CombatantPreview {
  id: string;
  name: string;
  tier: number;
  level: number;
  resources: { hp: number; maxHp: number; mp: number; maxMp: number; sp: number; maxSp: number };
  /** aggregated relic/gear/passive modifiers; `label` is the ruleset's display text. */
  modifiers: { key: string; label: string; value: number }[];
  conditions: { id: string; label: string; stacks?: number; turns?: number; kind: 'buff' | 'debuff' }[];
  deck: CardPreview[];
}

export interface CardPreview {
  id: string;
  name: string;
  /** stable rarity id mapped to a theme quality token (e.g. 'epic'). */
  rarityKey: string;
  /** the ruleset's display label for the rarity (e.g. '史诗'). */
  rarityLabel: string;
  kind: 'attack' | 'defend' | 'skill' | 'heal' | 'power';
  energyCost: number;
  resourceCost: { hp?: number; mp?: number; sp?: number };
  scalingAttr?: string;
  power?: number;
  /** pre-formatted, display-ready effect lines. */
  effectLines: string[];
  ratingEstimate?: number;
  copies: number;
  /** World Assets '卡面' key; null today (rarity frame), real art when card-import (D6) lands. */
  artKey?: string;
}
```

- [ ] **Step 2: Re-export from the types barrel**

In `src/status/core/types/index.ts`, add beside the other `export type *` lines:

```ts
export type * from './duel-preview';
```

- [ ] **Step 3: Declare the ambient global**

Append to the repo-root `global.d.ts` (NOT `@types/*`). It returns `DuelPreview | null` and may be absent at runtime; the `declare function` form lets `typeof getDuelPreview === 'function'` typecheck while the guard protects the call site.

```ts
/**
 * RPT-only host method (read-only): the engine-computed duel build preview for the active chat.
 * Exposed as a card-page global by RPT's createThRuntime (alongside getVariables/assetUrl).
 * Absent on older RPT / standalone dev — always guard with `typeof getDuelPreview === 'function'`.
 */
declare function getDuelPreview(): Promise<
  import('./src/status/core/types/duel-preview').DuelPreview | null
>;
```

- [ ] **Step 4: Add the dev fixture**

Create `src/status/core/utils/duel-preview-fixture.ts`:

```ts
import type { DuelPreview } from '../types/duel-preview';

/** Static preview for dev / no-RPT-host builds so the 战斗 tab is buildable + visually checkable. */
export const DUEL_PREVIEW_FIXTURE: DuelPreview = {
  config: { energyPerTurn: 3, handSize: 5 },
  lead: {
    id: '主角',
    name: '主角',
    tier: 2,
    level: 8,
    resources: { hp: 1820, maxHp: 2340, mp: 320, maxMp: 500, sp: 450, maxSp: 500 },
    modifiers: [
      { key: '武器攻击', label: '攻击', value: 60 },
      { key: '防御', label: '防御', value: 50 },
      { key: '命中', label: '命中', value: 1 },
    ],
    conditions: [{ id: '流血', label: '流血', turns: 2, kind: 'debuff' }],
    deck: [
      { id: '主角/普攻', name: '普攻', rarityKey: 'common', rarityLabel: '普通', kind: 'attack', energyCost: 1, resourceCost: { sp: 5 }, scalingAttr: '力量', power: 20, effectLines: [], ratingEstimate: 1.0, copies: 4 },
      { id: '主角/格挡', name: '格挡', rarityKey: 'common', rarityLabel: '普通', kind: 'defend', energyCost: 1, resourceCost: { sp: 5 }, effectLines: ['护盾 117'], copies: 4 },
      { id: '主角/乱舞', name: '乱舞', rarityKey: 'uncommon', rarityLabel: '优良', kind: 'attack', energyCost: 1, resourceCost: { sp: 40 }, scalingAttr: '力量', power: 60, effectLines: ['连击 3', '固伤 10'], ratingEstimate: 1.0, copies: 2 },
      { id: '主角/烈焰斩', name: '烈焰斩', rarityKey: 'epic', rarityLabel: '史诗', kind: 'attack', energyCost: 2, resourceCost: { mp: 30 }, scalingAttr: '智力', power: 140, effectLines: ['锥形', '燃烧 30/2回合'], ratingEstimate: 1.0, copies: 1 },
      { id: '主角/锋锐', name: '锋锐', rarityKey: 'uncommon', rarityLabel: '优良', kind: 'power', energyCost: 0, resourceCost: {}, effectLines: ['伤害增幅 12%'], copies: 1 },
    ],
  },
  party: [
    { id: '苏璃', name: '苏璃', tier: 2, level: 7, resources: { hp: 1200, maxHp: 1500, mp: 400, maxMp: 480, sp: 300, maxSp: 360 }, modifiers: [], conditions: [], deck: [] },
  ],
};
```

- [ ] **Step 5: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS (types compile; the ambient global resolves; no lint errors).

```bash
git add src/status/core/types/duel-preview.d.ts src/status/core/types/index.ts src/status/core/utils/duel-preview-fixture.ts global.d.ts
git commit -m "feat(combat-tab): DuelPreview contract type, ambient getDuelPreview global, dev fixture"
```

---

## Task 2: New combat theme tokens (all 8 presets)

**Files:**
- Modify: `src/status/core/types/theme.d.ts`, `src/status/config/theme-presets.ts`

**Interfaces:**
- Produces: the `--theme-energy-gem`, `--theme-rating-accent`, `--theme-power-text` CSS vars (emitted automatically by `applyCssVariables`).

- [ ] **Step 1: Extend `ThemeColors`**

In `src/status/core/types/theme.d.ts`, add after the `// 货币颜色` block (after `currencyCopper`):

```ts
  // 战斗卡组（combat deck tab）
  /** 行动力宝石颜色 */
  energyGem: string;
  /** 评级强调色 */
  ratingAccent: string;
  /** 卡牌威力文字色 */
  powerText: string;
```

- [ ] **Step 2: Add values to all 8 presets**

In `src/status/config/theme-presets.ts`, add the three keys to **every** preset's `colors`, right after that preset's `currencyCopper:` line. Values below are drawn from each theme's own currency/quality palette so they fit (light themes use dark values for legibility on light `cardBg`). The `ThemeColors` type now *requires* the keys, so any preset missing them fails the build — add all 8.

```ts
// ParchmentTheme (dark)
energyGem: '#f3c94f', ratingAccent: '#c28b48', powerText: '#e1c067',
// CrimsonTheme (dark)
energyGem: '#f2c653', ratingAccent: '#b04a54', powerText: '#e0b35e',
// IndigoTheme (dark)
energyGem: '#f1cf6a', ratingAccent: '#5a78c6', powerText: '#e1c36d',
// BronzeTheme (dark)
energyGem: '#e6c04a', ratingAccent: '#9a7f2f', powerText: '#e2b858',
// SakuraTheme (dark)
energyGem: '#f2c85a', ratingAccent: '#c06a95', powerText: '#e0b56a',
// ObsidianTheme (dark)
energyGem: '#f5c24f', ratingAccent: '#8f9fff', powerText: '#e5c166',
// IvoryTheme (light — default)
energyGem: '#9a7514', ratingAccent: '#b08343', powerText: '#8a6813',
// MistyLilacTheme (light)
energyGem: '#9d741b', ratingAccent: '#7255a8', powerText: '#8d6a14',
```

- [ ] **Step 3: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS. If `build` reports a preset literal missing a key, that preset wasn't updated — add the three keys there.

```bash
git add src/status/core/types/theme.d.ts src/status/config/theme-presets.ts
git commit -m "feat(combat-tab): combat deck theme tokens across all 8 presets"
```

---

## Task 3: The `duel-preview` store

**Files:**
- Create: `src/status/core/stores/duel-preview.store.ts`
- Modify: `src/status/core/stores/index.ts`

**Interfaces:**
- Consumes: `DuelPreview`/`CombatantPreview` (Task 1), `DUEL_PREVIEW_FIXTURE` (Task 1), the ambient `getDuelPreview` global (Task 1).
- Produces: `useDuelPreviewStore` with `{ preview, selectedId, loading, load(), select(id) }`; the `selectViewed(state) => CombatantPreview | null` selector.

- [ ] **Step 1: Write the store**

Create `src/status/core/stores/duel-preview.store.ts` (mirrors the zustand+immer shape of `mvu-data.store.ts`):

```ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { CombatantPreview, DuelPreview } from '../types/duel-preview';
import { DUEL_PREVIEW_FIXTURE } from '../utils/duel-preview-fixture';

interface DuelPreviewState {
  /** 引擎计算出的对战构筑预览 */
  preview: DuelPreview | null;
  /** 当前查看的成员 id（主角或队友） */
  selectedId: string | null;
  /** 是否正在加载 */
  loading: boolean;
}

interface DuelPreviewActions {
  /** 调用 getDuelPreview() 重新加载（无宿主时回退 fixture） */
  load: () => Promise<void>;
  /** 切换查看的成员 */
  select: (id: string) => void;
}

type DuelPreviewStore = DuelPreviewState & DuelPreviewActions;

export const useDuelPreviewStore = create<DuelPreviewStore>()(
  immer((set, get) => ({
    preview: null,
    selectedId: null,
    loading: false,

    load: async () => {
      set(state => {
        state.loading = true;
      });

      let result: DuelPreview | null = null;
      try {
        // getDuelPreview 是 RPT 注入的卡面全局；旧版 RPT / 独立开发环境中可能不存在。
        if (typeof getDuelPreview === 'function') {
          result = await getDuelPreview();
        }
      } catch (error) {
        console.error('[StatusBar] getDuelPreview 调用失败:', error);
      }

      // 开发 / 无 RPT 宿主时回退静态 fixture，便于独立构建与视觉检查。
      const preview: DuelPreview = result ?? DUEL_PREVIEW_FIXTURE;

      set(state => {
        state.preview = preview;
        state.loading = false;
        if (!state.selectedId) {
          state.selectedId = preview.lead.id;
        }
      });

      // 若当前选中的成员已不在新构筑中，回退到主角。
      const all = [preview.lead, ...preview.party];
      if (!all.some(c => c.id === get().selectedId)) {
        set(state => {
          state.selectedId = preview.lead.id;
        });
      }
    },

    select: id =>
      set(state => {
        state.selectedId = id;
      }),
  })),
);

/** 当前查看的战斗者（主角或队友）；找不到时回退主角。 */
export const selectViewed = (state: DuelPreviewState): CombatantPreview | null => {
  if (!state.preview) {
    return null;
  }
  const all = [state.preview.lead, ...state.preview.party];
  return all.find(c => c.id === state.selectedId) ?? state.preview.lead;
};
```

- [ ] **Step 2: Export it from the stores barrel**

In `src/status/core/stores/index.ts`, add:

```ts
export { useDuelPreviewStore, selectViewed } from './duel-preview.store';
```

- [ ] **Step 3: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS.

```bash
git add src/status/core/stores/duel-preview.store.ts src/status/core/stores/index.ts
git commit -m "feat(combat-tab): duel-preview store (host API + fixture fallback)"
```

---

## Task 4: The `DuelCard` component

**Files:**
- Create: `src/status/pages/combat/DuelCard.tsx`, `src/status/pages/combat/DuelCard.module.scss`

**Interfaces:**
- Consumes: `CardPreview` (Task 1).
- Produces: `<DuelCard card={CardPreview} onInspect?={(c) => void} />`.

- [ ] **Step 1: Write the component**

`rarityKey` maps to a `--theme-quality-*` token (the quality tokens already exist in every preset — verified in `theme.d.ts`). Applied as an inline border/accent color so we don't generate dynamic module classes.

Create `src/status/pages/combat/DuelCard.tsx`:

```tsx
import { FC } from 'react';
import type { CardPreview } from '../../core/types';
import styles from './DuelCard.module.scss';

const QUALITY_VAR: Record<string, string> = {
  common: '--theme-quality-common',
  uncommon: '--theme-quality-uncommon',
  rare: '--theme-quality-rare',
  epic: '--theme-quality-epic',
  legendary: '--theme-quality-legendary',
  mythic: '--theme-quality-mythic',
  unique: '--theme-quality-unique',
};

const KIND_LABEL: Record<CardPreview['kind'], string> = {
  attack: '攻击',
  defend: '防御',
  skill: '技能',
  heal: '治疗',
  power: '能力',
};

const costLabel = (c: CardPreview['resourceCost']): string =>
  [c.hp != null ? `${c.hp} HP` : '', c.mp != null ? `${c.mp} MP` : '', c.sp != null ? `${c.sp} SP` : '']
    .filter(Boolean)
    .join(' ') || '—';

export interface DuelCardProps {
  card: CardPreview;
  onInspect?: (card: CardPreview) => void;
}

export const DuelCard: FC<DuelCardProps> = ({ card, onInspect }) => {
  const rarity = `var(${QUALITY_VAR[card.rarityKey] ?? '--theme-quality-common'})`;
  const isPower = card.kind === 'power';

  return (
    <button
      type="button"
      className={`${styles.card} ${isPower ? styles.power : ''}`}
      style={{ borderColor: rarity }}
      onClick={() => onInspect?.(card)}
    >
      {isPower ? (
        <span className={`${styles.copies} ${styles.copiesPower}`}>常驻</span>
      ) : (
        <span className={styles.copies}>×{card.copies}</span>
      )}
      {!isPower && <span className={styles.energy}>{card.energyCost}</span>}
      <span className={styles.name}>{card.name}</span>
      <span className={styles.type} style={{ color: rarity }}>
        {KIND_LABEL[card.kind]} · {card.rarityLabel}
      </span>
      {(card.power != null || card.scalingAttr) && (
        <span className={styles.stat}>
          {card.power != null ? `威力 ${card.power}` : ''}
          {card.scalingAttr ? ` · ${card.scalingAttr}` : ''}
        </span>
      )}
      <span className={styles.eff}>
        {card.effectLines.join(' · ') || (isPower ? '常驻加成 · 不进牌库' : '')}
      </span>
      <span className={styles.foot}>
        <span className={styles.cost}>{costLabel(card.resourceCost)}</span>
        {card.ratingEstimate != null && (
          <span className={styles.rate}>评级~{card.ratingEstimate.toFixed(1)}</span>
        )}
      </span>
    </button>
  );
};
```

- [ ] **Step 2: Write the card SCSS module (tokens only)**

Create `src/status/pages/combat/DuelCard.module.scss`:

```scss
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 150px;
  text-align: left;
  border-radius: 9px;
  padding: 6px;
  cursor: pointer;
  background: var(--theme-card-bg);
  border: 2px solid var(--theme-card-border);
  color: var(--theme-text-primary);
}

.power {
  border-style: dashed;
}

.energy {
  position: absolute;
  top: -8px;
  left: -7px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  background: var(--theme-energy-gem);
  color: var(--theme-window-bg);
}

.copies {
  position: absolute;
  top: -7px;
  right: -6px;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 9px;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
}

.copiesPower {
  color: var(--theme-rating-accent);
}

.name {
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  margin-top: 2px;
}

.type {
  text-align: center;
  font-size: 9px;
  margin: 1px 0 3px;
}

.stat {
  text-align: center;
  font-size: 10px;
  color: var(--theme-power-text);
}

.eff {
  flex: 1;
  text-align: center;
  font-size: 9px;
  color: var(--theme-text-muted);
  margin-top: 2px;
  line-height: 1.35;
}

.foot {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px solid var(--theme-card-border);
}

.rate {
  color: var(--theme-rating-accent);
}
```

- [ ] **Step 3: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS.

```bash
git add src/status/pages/combat/DuelCard.tsx src/status/pages/combat/DuelCard.module.scss
git commit -m "feat(combat-tab): DuelCard — render a CardPreview with themed rarity frame"
```

---

## Task 5: The `CombatTab` page + responsive SCSS

**Files:**
- Create: `src/status/pages/combat/CombatTab.tsx`, `src/status/pages/combat/CombatTab.module.scss`, `src/status/pages/combat/index.ts`

**Interfaces:**
- Consumes: `useDuelPreviewStore`/`selectViewed` (Task 3), `useMvuDataStore` (existing), `DuelCard` (Task 4), `ResourceBar` + `StatusEffectDisplay` (existing), `StatusEffectItem` (existing type).
- Produces: `<CombatTab/>`.

- [ ] **Step 1: Write the page**

Notes baked in from the grounding:
- Reuse `ResourceBar` (`type='hp'|'mp'|'sp'`, same game-icons the StatusTab uses).
- Reuse `StatusEffectDisplay` in **chips** mode for `conditions`, mapping our neutral `conditions[]` → its `Record<string, StatusEffectItem>` shape.
- Recompute keyed on `useMvuDataStore().lastRefreshTime` (+ mount + a local refresh button).
- **All hooks run before the early return** (rules of hooks): the `conditions→effects` map is a plain const computed *after* the guard, not a hook.

Create `src/status/pages/combat/CombatTab.tsx`:

```tsx
import { FC, useEffect } from 'react';
import { useMvuDataStore } from '../../core/stores';
import { selectViewed, useDuelPreviewStore } from '../../core/stores';
import { ResourceBar, StatusEffectDisplay } from '../../shared/components';
import type { StatusEffectItem } from '../../shared/components/StatusEffectDisplay/StatusEffectDisplay';
import { DuelCard } from './DuelCard';
import styles from './CombatTab.module.scss';

export const CombatTab: FC = () => {
  const preview = useDuelPreviewStore(s => s.preview);
  const selectedId = useDuelPreviewStore(s => s.selectedId);
  const loading = useDuelPreviewStore(s => s.loading);
  const load = useDuelPreviewStore(s => s.load);
  const select = useDuelPreviewStore(s => s.select);
  const viewed = useDuelPreviewStore(selectViewed);
  const lastRefresh = useMvuDataStore(s => s.lastRefreshTime);

  // 初次加载 + 当底层 stat_data 刷新（全局刷新按钮）时重算预览。
  useEffect(() => {
    void load();
  }, [load, lastRefresh]);

  if (!preview || !viewed) {
    return <div className={styles.empty}>{loading ? '加载中…' : '战斗预览不可用'}</div>;
  }

  const members = [preview.lead, ...preview.party];
  const total = viewed.deck.reduce((n, c) => n + c.copies, 0);

  // 将中立的 conditions[] 映射回 StatusEffectDisplay 的 effects 形状，复用主题化的 chips。
  const conditionEffects: Record<string, StatusEffectItem> = {};
  for (const c of viewed.conditions) {
    conditionEffects[c.label] = {
      类型: c.kind === 'buff' ? '增益' : '减益',
      层数: c.stacks,
      剩余时间: c.turns != null ? `${c.turns}回合` : undefined,
    };
  }

  return (
    <div className={styles.combatTab}>
      <div className={styles.selector}>
        <span className={styles.selectorLabel}>查看</span>
        {members.map(m => (
          <button
            key={m.id}
            type="button"
            className={`${styles.chip} ${m.id === selectedId ? styles.chipActive : ''}`}
            onClick={() => select(m.id)}
          >
            <span className={styles.avatar}>{m.name.slice(0, 1)}</span>
            <span className={styles.chipName}>{m.name}</span>
          </button>
        ))}
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void load()}
          title="刷新战斗预览"
        >
          <i className="fa-solid fa-rotate-right" />
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.resBlock}>
          <div className={styles.resTop}>
            <span className={styles.resName}>{viewed.name}</span>
            <span className={styles.resMeta}>
              第{viewed.tier}层级 · 等级 {viewed.level}
            </span>
          </div>
          <ResourceBar label="HP" current={viewed.resources.hp} max={viewed.resources.maxHp} type="hp" icon="game-icons:heart-plus" />
          <ResourceBar label="MP" current={viewed.resources.mp} max={viewed.resources.maxMp} type="mp" icon="game-icons:water-drop" />
          <ResourceBar label="SP" current={viewed.resources.sp} max={viewed.resources.maxSp} type="sp" icon="game-icons:focused-lightning" />
          {viewed.conditions.length > 0 && (
            <div className={styles.pills}>
              <StatusEffectDisplay
                effects={conditionEffects}
                mode="chips"
                compact
                showRemainingCount
                emptyText="无状态"
              />
            </div>
          )}
          {viewed.modifiers.length > 0 && (
            <div className={styles.relics}>
              {viewed.modifiers.map(m => (
                <span key={m.key} className={styles.relic}>
                  {m.label} {m.value}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className={styles.deck}>
          <div className={styles.deckHead}>
            <span className={styles.deckTitle}>卡组</span>
            <span className={styles.deckMeta}>
              {total} 张 · 行动力 {preview.config.energyPerTurn}/回合 · 手牌 {preview.config.handSize}
            </span>
          </div>
          <div className={styles.grid}>
            {viewed.deck.map(c => (
              <DuelCard key={c.id} card={c} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
```

> If ESLint's import-x flags the two `from '../../core/stores'` lines, merge them into one import:
> `import { selectViewed, useDuelPreviewStore, useMvuDataStore } from '../../core/stores';`

- [ ] **Step 2: Write the responsive SCSS module (tokens only)**

Create `src/status/pages/combat/CombatTab.module.scss` — container-query driven (wide → header beside deck; tall → stacked), all colors from `--theme-*`:

```scss
.combatTab {
  container-type: inline-size;
  color: var(--theme-text-primary);
  font-size: 13px;
}

.empty {
  color: var(--theme-text-muted);
  padding: 16px;
  text-align: center;
}

.selector {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--theme-card-border);
}

.selectorLabel {
  font-size: 11px;
  color: var(--theme-text-muted);
  white-space: nowrap;
}

.chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  background: none;
  border: none;
  cursor: pointer;
  min-width: 46px;
}

.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 700;
  background: var(--theme-surface-muted);
  border: 2px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
}

.chipActive .avatar {
  border-color: var(--theme-rating-accent);
  color: var(--theme-text-primary);
}

.chipName {
  font-size: 10px;
  color: var(--theme-text-secondary);
}

.chipActive .chipName {
  color: var(--theme-text-primary);
}

.refreshBtn {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--theme-text-muted);
  font-size: 13px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.resBlock {
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: 10px;
  padding: 11px 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.resTop {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.resName {
  font-size: 16px;
  font-weight: 700;
}

.resMeta {
  font-size: 11px;
  color: var(--theme-text-muted);
}

.pills,
.relics {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}

.relic {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 7px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
}

.deckHead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.deckTitle {
  font-size: 13px;
  color: var(--theme-rating-accent);
}

.deckMeta {
  font-size: 11px;
  color: var(--theme-text-muted);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 9px;
}

@container (min-width: 560px) {
  .body {
    flex-direction: row;
    align-items: flex-start;
  }

  .resBlock {
    flex: 0 0 240px;
  }

  .deck {
    flex: 1;
  }
}
```

- [ ] **Step 3: Barrel export**

Create `src/status/pages/combat/index.ts`:

```ts
export { CombatTab } from './CombatTab';
```

- [ ] **Step 4: Build + visual check**

Run: `npm run lint && npm run build`
Expected: PASS.

**Visual check:** the page renders only after the tab is registered (Task 6) — defer the live visual check to Task 6's. Here, confirm the build is clean and the SCSS module compiles.

- [ ] **Step 5: Commit**

```bash
git add src/status/pages/combat/CombatTab.tsx src/status/pages/combat/CombatTab.module.scss src/status/pages/combat/index.ts
git commit -m "feat(combat-tab): CombatTab page + container-responsive, token-only SCSS"
```

---

## Task 6: Register the tab

**Files:**
- Modify: `src/status/config/tabs.config.ts`, `src/status/pages/index.ts`, `src/status/App.tsx`

- [ ] **Step 1: Add the tab config**

In `src/status/config/tabs.config.ts`, add an entry to `TabsConfig` (e.g. after `map`):

```ts
  {
    id: 'combat',
    label: '战斗',
    icon: 'fa-solid fa-khanda',
  },
```

(`fa-khanda` is free FA6 and reads as crossed swords. If it renders as a blank box in the host, swap to `fa-solid fa-shield-halved` or `fa-solid fa-hand-fist` — all free.)

- [ ] **Step 2: Export the page**

In `src/status/pages/index.ts`, add (alphabetical-ish, mirroring the others):

```ts
export { CombatTab } from './combat';
```

- [ ] **Step 3: Render the page**

In `src/status/App.tsx`, add `CombatTab` to the import from `'./pages'`:

```ts
import { CombatTab, DestinyTab, ItemsTab, MapTab, NewsTab, QuestsTab, SettingsTab, StatusTab } from './pages';
```

and add a case in `renderTabContent`'s `switch`:

```tsx
      case 'combat':
        return <CombatTab />;
```

- [ ] **Step 4: Build + visual check**

Run: `npm run lint && npm run build`
Expected: PASS.

**Visual check** (preview the built status app the way the fork is normally previewed — e.g. open the webpack output / load it in a card, or the project's single-file preview):
1. A **战斗** tab appears in the tab bar with the sword icon; selecting it renders `CombatTab` showing the fixture: member chips (主角 / 苏璃), HP/MP/SP bars, the 流血 condition chip, relic chips (攻击 60 / 防御 50 / 命中 1), and the deck grid (普攻 ×4, 格挡 ×4, 乱舞 ×2, 烈焰斩 ×1, 锋锐 常驻) with energy gems + ×N + rarity-colored borders.
2. Switching member chips swaps the viewed build (苏璃 has an empty deck → an empty grid, no crash).
3. **Reflow:** narrows to one column; at a container width ≥560px the resource block sits beside the deck.
4. **Legibility:** readable in a **dark** theme (e.g. obsidian) AND the **light default** (ivory) — toggle via the settings theme picker. Fix any unreadable token pairing.

- [ ] **Step 5: Commit**

```bash
git add src/status/config/tabs.config.ts src/status/pages/index.ts src/status/App.tsx
git commit -m "feat(combat-tab): register the 战斗 tab in the status app"
```

---

## Self-Review

**Spec coverage:** the contract type (design §2) → Task 1; theming across all 8 themes incl. the light default + the 3 new tokens (§4-theming) → Tasks 2 + 4 + 5 (token-only module SCSS); the host-API consumer + fixture fallback (§1, §4) → Task 3; deck-as-cards centerpiece with copies + rarity frame + 评级 + 常驻 powers (§0.3, §4) → Tasks 4 + 5; resource/relic header + member selector (§4 regions) → Task 5 (reuses `ResourceBar` + `StatusEffectDisplay`); container-responsive wide/tall (§4-responsive) → Task 5 SCSS; recompute trigger = auto-on-refresh + button (§9 Q4) → Task 5; tab registration → Task 6; coexist-with-party-panel + render-only (§5) → honored (no membership writes, no `stat_data` writes). Member portraits via World Assets (§4 region 1) are **deferred to a follow-on** — v1 uses name initials (the contract carries no combatant `artKey`); noted, not a regression. ✓

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N". Every code step shows complete code. The two judgement calls (`fa-khanda` icon fallback; merging the two `core/stores` imports if import-x complains) are concrete conditionals with the exact fallback given, not missing logic. ✓

**Type consistency:** `DuelPreview`/`CombatantPreview`/`CardPreview` (Task 1) are used unchanged by the store (Task 3), `DuelCard` (Task 4), and `CombatTab` (Task 5). `useDuelPreviewStore`/`selectViewed` (Task 3, exported from the stores barrel) are consumed in Task 5. `DuelCard` props (Task 4) match its use in Task 5. The new theme keys `energyGem`/`ratingAccent`/`powerText` (Task 2) match the `--theme-energy-gem`/`--theme-rating-accent`/`--theme-power-text` vars used in Tasks 4–5 SCSS. `getDuelPreview(): Promise<DuelPreview | null>` (Task 1 ambient) matches the store's `result ?? FIXTURE` handling (Task 3). `StatusEffectItem` (existing) matches the `conditionEffects` record built in Task 5. ✓

---

## Execution

Runs **in the fork repo** on branch `feat/combat-build-tab`. Task 0 bootstraps deps (no `node_modules`/pnpm present). Build against the **fixture** (Task 1) without waiting on Plan A; when the card runs inside RPT, the store's `typeof getDuelPreview === 'function'` branch picks up the live API with no code change. Verification per task = `npm run lint && npm run build` + the described visual check (no unit-test harness in the fork). Execute via subagent-driven development or executing-plans; because there are no unit tests, the reviewer relies on the build/lint result + the implementer's visual-check report (and a screenshot where possible). The owner (December-17th) drives any merge of the fork branch.
