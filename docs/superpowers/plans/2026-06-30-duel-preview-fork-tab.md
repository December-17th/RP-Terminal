# Duel Build-Preview — fork 战斗 tab (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new **战斗 tab** to the 命定之诗 status app (the fork) that renders the engine-computed duel build (deck-as-cards + resource/relic panels + a party-member selector) from the RPT `getDuelPreview()` host API.

**Architecture:** A zustand store calls `getDuelPreview()` (with a static fixture fallback for dev), and a `CombatTab` page renders it — a member selector, a resource/relic header (reusing the app's `ResourceBar`/`StatusEffectDisplay`), and a deck grid of `DuelCard`s. Every color is a `--theme-*` token (works across all 8 themes incl. light); the layout reflows wide↔tall via CSS container queries.

**Tech Stack:** React 19 + TSX + zustand + SCSS, webpack (`npm run build` runs `ts-loader` typecheck), ESLint. **No unit-test harness** — verification is `lint` + `build` + a static `DuelPreview` fixture + a visual check.

> **Repo:** this plan executes in the **fork** at `E:\Projects\FrontEnd-for-destined-journey-TPR-STS` (NOT the RPT app repo). All paths below are relative to that repo.
> **Depends on:** [Plan A](2026-06-30-duel-preview-host-api.md) (the `getDuelPreview` API + `DuelPreview` contract). Plan B can be built against the **fixture** before Plan A ships; wire the live API once it's available.

## Global Constraints

- **Theme tokens only — no hardcoded colors.** Every color is a `--theme-*` CSS variable ([theme.store.ts] `applyCssVariables` emits `--theme-<kebab>` for each `ThemeColors` key). Must be legible on **light** themes (`ivory` is default, `misty-lilac`) and dark.
- **Flexible wide AND tall** via CSS **container queries** on the tab root (sizes to the panel, not the viewport). No fixed px widths/heights for layout.
- **Render-only consumer.** The tab reads `DuelPreview`; it never recomputes the deck/parse/评级 (that's RPT, Plan A). It does not write `stat_data`.
- **Coexist with the party panel** — this tab's member selector only *views* builds; it does not manage party membership.
- **Verification gate (each task's last step):** `npm run lint && npm run build` must pass (build = `webpack --mode production`, which runs `ts-loader` typecheck). Plus the per-task **visual check** described in the task.
- **Follow existing fork patterns:** mirror how existing tabs/pages/stores/components are written (e.g. `pages/status/StatusTab.tsx`, `core/stores/mvu-data.store.ts`, `shared/components/ResourceBar`, `Card`, `StatusEffectDisplay`). Read the component you reuse before wiring its props.

---

## File Structure (in the fork)

| File | Responsibility |
| --- | --- |
| `src/status/core/types/duel-preview.d.ts` (new) | A copy of the `DuelPreview`/`CombatantPreview`/`CardPreview` contract (the shared interface with Plan A). |
| `global.d.ts` (modify) | Ambient declaration for the `getDuelPreview()` card-page global. |
| `src/status/core/utils/duel-preview-fixture.ts` (new) | A static `DuelPreview` for dev/visual checks before the live API exists. |
| `src/status/core/types/theme.d.ts` (modify) | Add the new combat tokens to `ThemeColors`. |
| `src/status/config/theme-presets.ts` (modify) | Add values for the new tokens to **all 8** presets. |
| `src/status/core/stores/duel-preview.store.ts` (new) | zustand store: load via `getDuelPreview()` (fixture fallback), hold `DuelPreview` + selected member. |
| `src/status/pages/combat/DuelCard.tsx` (new) | Render one `CardPreview` as a themed card. |
| `src/status/pages/combat/CombatTab.tsx` (new) | The tab: selector + resource/relic header + deck grid; container-responsive. |
| `src/status/pages/combat/CombatTab.scss` (new) | Container-query layout + card styling (tokens only). |
| `src/status/pages/combat/index.ts` (new) | Barrel export. |
| `src/status/config/tabs.config.ts` (modify) | Add the `combat` tab entry. |
| `src/status/App.tsx` (modify) | Render `<CombatTab/>` for the `combat` tab. |
| `src/status/pages/index.ts` (modify) | Export `CombatTab`. |

---

## Task 1: Contract type + ambient global + fixture

**Files:**
- Create: `src/status/core/types/duel-preview.d.ts`, `src/status/core/utils/duel-preview-fixture.ts`
- Modify: `global.d.ts`

- [ ] **Step 1: Copy the contract type**

Create `src/status/core/types/duel-preview.d.ts` with the **exact** contract from Plan A's `preview.ts` (keep the two copies identical — it's the shared interface):

```ts
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
  modifiers: { key: string; label: string; value: number }[];
  conditions: { id: string; label: string; stacks?: number; turns?: number; kind: 'buff' | 'debuff' }[];
  deck: CardPreview[];
}
export interface CardPreview {
  id: string;
  name: string;
  rarityKey: string;
  rarityLabel: string;
  kind: 'attack' | 'defend' | 'skill' | 'heal' | 'power';
  energyCost: number;
  resourceCost: { hp?: number; mp?: number; sp?: number };
  scalingAttr?: string;
  power?: number;
  effectLines: string[];
  ratingEstimate?: number;
  copies: number;
  artKey?: string;
}
```

- [ ] **Step 2: Declare the ambient global**

Read `global.d.ts` to match its existing TH-global declaration style (`getVariables`, `insertOrAssignVariables`, …), then add:

```ts
declare function getDuelPreview(): Promise<import('./src/status/core/types/duel-preview').DuelPreview>;
```

(Adjust the import path to match how `global.d.ts` references `src/` — mirror the existing declarations' style. If the fork declares globals as optional/possibly-undefined, follow that so the dev fixture-fallback typechecks.)

- [ ] **Step 3: Add the dev fixture**

Create `src/status/core/utils/duel-preview-fixture.ts`:

```ts
import type { DuelPreview } from '../types/duel-preview';

export const DUEL_PREVIEW_FIXTURE: DuelPreview = {
  config: { energyPerTurn: 3, handSize: 5 },
  lead: {
    id: '主角', name: '主角', tier: 2, level: 8,
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

- [ ] **Step 4: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS (types compile; no lint errors).

```bash
git add src/status/core/types/duel-preview.d.ts src/status/core/utils/duel-preview-fixture.ts global.d.ts
git commit -m "feat(combat-tab): DuelPreview contract type, ambient getDuelPreview, dev fixture"
```

---

## Task 2: New combat theme tokens (all 8 presets)

**Files:**
- Modify: `src/status/core/types/theme.d.ts`, `src/status/config/theme-presets.ts`

**Interfaces:**
- Produces: `--theme-energy-gem`, `--theme-rating-accent`, `--theme-power-text` (emitted automatically by `applyCssVariables`).

- [ ] **Step 1: Extend `ThemeColors`**

In `src/status/core/types/theme.d.ts`, add to the `ThemeColors` interface (after the 货币颜色 block):

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

In `src/status/config/theme-presets.ts`, add the three keys to **every** preset's `colors` (parchment, crimson, indigo, bronze, sakura, obsidian, ivory, misty-lilac). Use each theme's own currency/quality palette so they fit. Suggested per theme (tune to taste, but every preset MUST define all three):

```ts
// parchment
energyGem: '#f3c94f', ratingAccent: '#c28b48', powerText: '#e1c067',
// crimson
energyGem: '#f2c653', ratingAccent: '#b04a54', powerText: '#e0b35e',
// indigo
energyGem: '#f1cf6a', ratingAccent: '#5a78c6', powerText: '#e1c36d',
// bronze
energyGem: '#e6c04a', ratingAccent: '#9a7f2f', powerText: '#e2b858',
// sakura
energyGem: '#f2c85a', ratingAccent: '#c06a95', powerText: '#e0b56a',
// obsidian
energyGem: '#f5c24f', ratingAccent: '#8f9fff', powerText: '#e5c166',
// ivory (light)
energyGem: '#9a7514', ratingAccent: '#b08343', powerText: '#8A6813',
// misty-lilac (light)
energyGem: '#9D741B', ratingAccent: '#7255A8', powerText: '#8D6A14',
```

- [ ] **Step 3: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS (the `ThemeColors` type now requires the keys; all presets define them → compiles). If the build complains a preset is missing a key, add it.

```bash
git add src/status/core/types/theme.d.ts src/status/config/theme-presets.ts
git commit -m "feat(combat-tab): combat deck theme tokens across all 8 presets"
```

---

## Task 3: The `duel-preview.store`

**Files:**
- Create: `src/status/core/stores/duel-preview.store.ts`
- Modify: `src/status/core/stores/index.ts` (export it, mirroring the other stores)

- [ ] **Step 1: Write the store**

Read `core/stores/mvu-data.store.ts` + `theme.store.ts` to match the zustand+immer pattern, then:

```ts
// src/status/core/stores/duel-preview.store.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { DuelPreview } from '../types/duel-preview';
import { DUEL_PREVIEW_FIXTURE } from '../utils/duel-preview-fixture';

interface DuelPreviewState {
  preview: DuelPreview | null;
  selectedId: string | null;
  loading: boolean;
}
interface DuelPreviewActions {
  load: () => Promise<void>;
  select: (id: string) => void;
}

export const useDuelPreviewStore = create<DuelPreviewState & DuelPreviewActions>()(
  immer((set, get) => ({
    preview: null,
    selectedId: null,
    loading: false,

    load: async () => {
      set(s => { s.loading = true; });
      let preview: DuelPreview | null = null;
      try {
        if (typeof getDuelPreview === 'function') preview = await getDuelPreview();
      } catch (e) {
        console.error('[StatusBar] getDuelPreview failed:', e);
      }
      // Dev / no-RPT-host fallback so the tab is buildable + visually checkable standalone.
      if (!preview) preview = DUEL_PREVIEW_FIXTURE;
      set(s => {
        s.preview = preview;
        s.loading = false;
        if (!s.selectedId) s.selectedId = preview!.lead.id;
      });
    },

    select: id => set(s => { s.selectedId = id; }),
  })),
);

/** The currently-viewed combatant (lead or a party member). */
export const selectViewed = (s: DuelPreviewState): DuelPreview['lead'] | null => {
  if (!s.preview) return null;
  const all = [s.preview.lead, ...s.preview.party];
  return all.find(c => c.id === s.selectedId) ?? s.preview.lead;
};
```

(`getDuelPreview` is the ambient global from Task 1; the `typeof … === 'function'` guard + fixture fallback makes the tab work before Plan A ships and in standalone dev.)

- [ ] **Step 2: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS.

```bash
git add src/status/core/stores/duel-preview.store.ts src/status/core/stores/index.ts
git commit -m "feat(combat-tab): duel-preview store (host API + fixture fallback)"
```

---

## Task 4: The `DuelCard` component

**Files:**
- Create: `src/status/pages/combat/DuelCard.tsx`

**Interfaces:**
- Consumes: `CardPreview` (Task 1).
- Produces: `<DuelCard card={CardPreview} onInspect={(c) => void} />`.

- [ ] **Step 1: Write the component**

Map `rarityKey` → a theme quality CSS var. Read `core/utils/quality.ts` first — if it already maps a rarity to a `--theme-quality-*` var or class, reuse it; otherwise use this local map:

```tsx
// src/status/pages/combat/DuelCard.tsx
import { FC } from 'react';
import type { CardPreview } from '../../core/types/duel-preview';

const QUALITY_VAR: Record<string, string> = {
  common: '--theme-quality-common', uncommon: '--theme-quality-uncommon', rare: '--theme-quality-rare',
  epic: '--theme-quality-epic', legendary: '--theme-quality-legendary', mythic: '--theme-quality-mythic',
  unique: '--theme-quality-unique',
};

export const DuelCard: FC<{ card: CardPreview; onInspect?: (c: CardPreview) => void }> = ({ card, onInspect }) => {
  const rarity = `var(${QUALITY_VAR[card.rarityKey] ?? '--theme-quality-common'})`;
  const cost = card.resourceCost;
  return (
    <button className={`duel-card kind-${card.kind}`} style={{ borderColor: rarity }} onClick={() => onInspect?.(card)}>
      {card.kind === 'power'
        ? <span className="dc-copies dc-power">常驻</span>
        : <span className="dc-copies">×{card.copies}</span>}
      {card.kind !== 'power' && <span className="dc-energy">{card.energyCost}</span>}
      <span className="dc-name">{card.name}</span>
      <span className="dc-type" style={{ color: rarity }}>{kindLabel(card.kind)} · {card.rarityLabel}</span>
      {(card.power != null || card.scalingAttr) && (
        <span className="dc-stat">{card.power != null ? `威力 ${card.power}` : ''}{card.scalingAttr ? ` · ${card.scalingAttr}` : ''}</span>
      )}
      <span className="dc-eff">{card.effectLines.join(' · ') || (card.kind === 'power' ? '常驻加成 · 不进牌库' : '')}</span>
      <span className="dc-foot">
        <span className="dc-cost">{costLabel(cost)}</span>
        {card.ratingEstimate != null && <span className="dc-rate">评级~{card.ratingEstimate.toFixed(1)}</span>}
      </span>
    </button>
  );
};

const kindLabel = (k: CardPreview['kind']): string =>
  ({ attack: '攻击', defend: '防御', skill: '技能', heal: '治疗', power: '能力' }[k]);

const costLabel = (c: CardPreview['resourceCost']): string =>
  [c.hp != null ? `${c.hp} HP` : '', c.mp != null ? `${c.mp} MP` : '', c.sp != null ? `${c.sp} SP` : '']
    .filter(Boolean).join(' ') || '—';
```

- [ ] **Step 2: Verify build + commit**

Run: `npm run lint && npm run build`
Expected: PASS (styling comes in Task 5's SCSS; the component compiles now).

```bash
git add src/status/pages/combat/DuelCard.tsx
git commit -m "feat(combat-tab): DuelCard — render a CardPreview with themed rarity frame"
```

---

## Task 5: The `CombatTab` page + responsive SCSS

**Files:**
- Create: `src/status/pages/combat/CombatTab.tsx`, `src/status/pages/combat/CombatTab.scss`, `src/status/pages/combat/index.ts`

**Interfaces:**
- Consumes: `useDuelPreviewStore`/`selectViewed` (Task 3), `DuelCard` (Task 4), the existing `ResourceBar` + `StatusEffectDisplay` components.
- Produces: `<CombatTab/>`.

- [ ] **Step 1: Write the page**

Read `shared/components/ResourceBar` + `StatusEffectDisplay` props first, then compose (adjust the reused-component props to their real signatures):

```tsx
// src/status/pages/combat/CombatTab.tsx
import { FC, useEffect } from 'react';
import './CombatTab.scss';
import { useDuelPreviewStore, selectViewed } from '../../core/stores/duel-preview.store';
import { DuelCard } from './DuelCard';

export const CombatTab: FC = () => {
  const { preview, selectedId, load, select } = useDuelPreviewStore();
  const viewed = useDuelPreviewStore(selectViewed);

  useEffect(() => { void load(); }, [load]);

  if (!preview || !viewed) return <div className="combat-empty">战斗预览不可用</div>;

  const members = [preview.lead, ...preview.party];
  const total = viewed.deck.reduce((n, c) => n + c.copies, 0);

  return (
    <div className="combat-tab">
      <div className="ct-selector">
        <span className="ct-sel-lbl">查看</span>
        {members.map(m => (
          <button key={m.id} className={`ct-chip${m.id === selectedId ? ' active' : ''}`} onClick={() => select(m.id)}>
            <span className="ct-av">{m.name.slice(0, 1)}</span>
            <span className="ct-cn">{m.name}</span>
          </button>
        ))}
      </div>

      <div className="ct-body">
        <div className="ct-resblock">
          <div className="ct-rtop"><span className="ct-rname">{viewed.name}</span>
            <span className="ct-rmeta">第{viewed.tier}层级 · 等级 {viewed.level}</span></div>
          <Bar label="生命" value={viewed.resources.hp} max={viewed.resources.maxHp} varName="--theme-resource-hp" />
          <Bar label="法力" value={viewed.resources.mp} max={viewed.resources.maxMp} varName="--theme-resource-mp" />
          <Bar label="体力" value={viewed.resources.sp} max={viewed.resources.maxSp} varName="--theme-resource-sp" />
          {viewed.conditions.length > 0 && (
            <div className="ct-pills">{viewed.conditions.map(c => (
              <span key={c.id} className={`ct-pill ${c.kind}`}>{c.label}{c.turns ? ` ${c.turns}` : ''}</span>
            ))}</div>
          )}
          {viewed.modifiers.length > 0 && (
            <div className="ct-relics">{viewed.modifiers.map(m => (
              <span key={m.key} className="ct-relic">{m.label} {m.value}</span>
            ))}</div>
          )}
        </div>

        <div className="ct-deck">
          <div class="ct-deckhead"><span className="ct-dh-title">卡组</span>
            <span className="ct-dh-meta">{total} 张 · 行动力 {preview.config.energyPerTurn}/回合 · 手牌 {preview.config.handSize}</span></div>
          <div className="ct-grid">
            {viewed.deck.map(c => <DuelCard key={c.id} card={c} />)}
          </div>
        </div>
      </div>
    </div>
  );
};

const Bar: FC<{ label: string; value: number; max: number; varName: string }> = ({ label, value, max, varName }) => (
  <div className="ct-bar-row">
    <span className="ct-bl">{label}</span>
    <span className="ct-bar"><i style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%`, background: `var(${varName})` }} /></span>
    <span className="ct-bv">{value} / {max}</span>
  </div>
);
```

(If the app's `ResourceBar`/`StatusEffectDisplay` cover the HP/MP/SP bars + condition pills, prefer them over the local `Bar`/pill markup — read their props and swap them in. The local `Bar` is a token-driven fallback.)

> NB: fix the one intentional typo if you transcribe verbatim — `class=` → `className=` on `ct-deckhead`. (JSX uses `className`.)

- [ ] **Step 2: Write the responsive, token-only SCSS**

Create `src/status/pages/combat/CombatTab.scss` — container-query driven (wide → header beside deck; tall → stacked), all colors from `--theme-*`:

```scss
.combat-tab { container-type: inline-size; color: var(--theme-text-primary); font-size: 13px; }
.ct-selector { display: flex; align-items: center; gap: 10px; overflow-x: auto;
  padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--theme-card-border); }
.ct-sel-lbl { font-size: 11px; color: var(--theme-text-muted); white-space: nowrap; }
.ct-chip { display: flex; flex-direction: column; align-items: center; gap: 3px; background: none; border: none; cursor: pointer; min-width: 46px; }
.ct-av { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; background: var(--theme-surface-muted); border: 2px solid var(--theme-card-border); color: var(--theme-text-secondary); }
.ct-chip.active .ct-av { border-color: var(--theme-rating-accent); color: var(--theme-text-primary); }
.ct-cn { font-size: 10px; color: var(--theme-text-secondary); }
.ct-chip.active .ct-cn { color: var(--theme-text-primary); }

.ct-body { display: flex; flex-direction: column; gap: 12px; }
.ct-resblock { background: var(--theme-surface-muted); border: 1px solid var(--theme-card-border); border-radius: 10px; padding: 11px 13px; }
.ct-rtop { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.ct-rname { font-size: 16px; font-weight: 700; }
.ct-rmeta { font-size: 11px; color: var(--theme-text-muted); }
.ct-bar-row { display: flex; align-items: center; gap: 8px; font-size: 11px; margin-top: 5px; }
.ct-bl { width: 30px; color: var(--theme-text-secondary); }
.ct-bar { flex: 1; height: 9px; border-radius: 5px; background: var(--theme-content-bg); overflow: hidden; }
.ct-bar > i { display: block; height: 100%; border-radius: 5px; }
.ct-bv { width: 84px; text-align: right; color: var(--theme-resource-text); }
.ct-pills, .ct-relics { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.ct-pill { font-size: 10px; padding: 2px 8px; border-radius: 11px; }
.ct-pill.buff { background: var(--theme-tag-present); color: var(--theme-tag-present-text); }
.ct-pill.debuff { background: var(--theme-tag-contract); color: var(--theme-tag-contract-text); }
.ct-relic { font-size: 10px; padding: 2px 7px; border-radius: 7px; background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border); color: var(--theme-text-secondary); }

.ct-deckhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.ct-dh-title { font-size: 13px; color: var(--theme-rating-accent); }
.ct-dh-meta { font-size: 11px; color: var(--theme-text-muted); }
.ct-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 9px; }

.duel-card { position: relative; display: flex; flex-direction: column; min-height: 150px; text-align: left;
  border-radius: 9px; padding: 6px; cursor: pointer;
  background: var(--theme-card-bg); border: 2px solid var(--theme-card-border); color: var(--theme-text-primary); }
.dc-energy { position: absolute; top: -8px; left: -7px; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;
  background: var(--theme-energy-gem); color: var(--theme-window-bg); }
.dc-copies { position: absolute; top: -7px; right: -6px; font-size: 10px; font-weight: 700; padding: 1px 6px;
  border-radius: 9px; background: var(--theme-surface-muted); border: 1px solid var(--theme-card-border); color: var(--theme-text-secondary); }
.dc-name { text-align: center; font-size: 13px; font-weight: 700; margin-top: 2px; }
.dc-type { text-align: center; font-size: 9px; margin: 1px 0 3px; }
.dc-stat { text-align: center; font-size: 10px; color: var(--theme-power-text); }
.dc-eff { flex: 1; text-align: center; font-size: 9px; color: var(--theme-text-muted); margin-top: 2px; line-height: 1.35; }
.dc-foot { display: flex; justify-content: space-between; font-size: 9px; margin-top: 3px; padding-top: 3px; border-top: 1px solid var(--theme-card-border); }
.dc-rate { color: var(--theme-rating-accent); }
.duel-card.kind-power { border-style: dashed; }
.combat-empty { color: var(--theme-text-muted); padding: 16px; text-align: center; }

@container (min-width: 560px) {
  .ct-body { flex-direction: row; align-items: flex-start; }
  .ct-resblock { flex: 0 0 240px; }
  .ct-deck { flex: 1; }
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
**Visual check:** load the built `dist/status/index.html` (the way you preview the status app) — the `CombatTab` (rendered via Task 6) shows the fixture: member chips, resource bars, relic chips, condition pill, and the deck grid of cards with energy gems + ×N + rarity-colored borders. Confirm it (a) reflows from one column (narrow) to header-beside-deck (wide ≥560px container), and (b) is legible in a **dark** theme (e.g. obsidian) AND the **light** default (ivory) — toggle via the settings theme picker. Fix any unreadable token pairing.

- [ ] **Step 5: Commit**

```bash
git add src/status/pages/combat/
git commit -m "feat(combat-tab): CombatTab page + container-responsive, token-only SCSS"
```

---

## Task 6: Register the tab

**Files:**
- Modify: `src/status/config/tabs.config.ts`, `src/status/App.tsx`, `src/status/pages/index.ts`

- [ ] **Step 1: Add the tab config**

In `src/status/config/tabs.config.ts`, add to `TabsConfig` (after `map`):

```ts
  {
    id: 'combat',
    label: '战斗',
    icon: 'fa-solid fa-swords',
  },
```

- [ ] **Step 2: Export + render the page**

In `src/status/pages/index.ts`, export `CombatTab` (mirror the other page exports). In `src/status/App.tsx`, import `CombatTab` and add a case to `renderTabContent`:

```tsx
      case 'combat':
        return <CombatTab />;
```

- [ ] **Step 3: Build + visual check**

Run: `npm run lint && npm run build`
Expected: PASS.
**Visual check:** the `战斗` tab now appears in the tab bar with the sword icon and selecting it renders the `CombatTab`. Switching member chips swaps the viewed build. (If `fa-solid fa-swords` doesn't render, pick an available FontAwesome icon the app already bundles, e.g. `fa-solid fa-khanda` / `fa-shield-halved` — mirror how other tabs' icons resolve.)

- [ ] **Step 4: Commit**

```bash
git add src/status/config/tabs.config.ts src/status/App.tsx src/status/pages/index.ts
git commit -m "feat(combat-tab): register the 战斗 tab in the status app"
```

---

## Self-Review

**Spec coverage:** the contract type (design §2) → Task 1; theming across all 8 themes incl. light, new tokens (§4-theming) → Tasks 2 + 5 (token-only SCSS); the host-API consumer + fixture fallback (§1, §4) → Task 3; deck-as-cards centerpiece with copies + rarity frame + 评级 (§0.3, §4) → Tasks 4 + 5; resource/relic header + member selector (§4 regions) → Task 5; container-responsive wide/tall (§4-responsive) → Task 5 SCSS; tab registration → Task 6; coexist-with-party-panel + render-only (§5) → honored (no membership writes). ✓

**Placeholder scan:** "read component X first / mirror its props" appear for the fork's reused components (`ResourceBar`, `StatusEffectDisplay`, `quality.ts`, the icon set) and the ambient-global style — these are read-then-mirror integration points in an external repo, each with a working token-driven fallback in the code, not missing logic. The one deliberate `class=`→`className=` note is flagged. ✓

**Type consistency:** `DuelPreview`/`CombatantPreview`/`CardPreview` (Task 1) used unchanged by the store (Task 3), `DuelCard` (Task 4), and `CombatTab` (Task 5). `useDuelPreviewStore`/`selectViewed` (Task 3) consumed by Task 5. `DuelCard` props (Task 4) match its use in Task 5. New theme keys (Task 2) match the `--theme-energy-gem`/`-rating-accent`/`-power-text` vars used in Task 5 SCSS. ✓

---

## Execution

Runs **in the fork repo**. Build against the **fixture** (Task 1) without waiting on Plan A; once Plan A's `getDuelPreview` is live in RPT, the store's `typeof getDuelPreview === 'function'` branch picks it up with no code change. Verification per task = `npm run lint && npm run build` + the described visual check (no unit-test harness in the fork). Execute via subagent-driven development; because there are no unit tests, the reviewer relies on the build/lint result + the implementer's visual-check report (and a screenshot where possible).
