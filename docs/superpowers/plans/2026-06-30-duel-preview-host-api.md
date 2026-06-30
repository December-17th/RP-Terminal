# Duel Build-Preview — RPT producer (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `getDuelPreview()` card-runtime host API that returns the engine-computed duel build (deck-as-cards + resources/relics) for the active chat's current MVU build — the producer the fork's 战斗 tab consumes.

**Architecture:** A pure mapper (`buildDuelPreview`) runs the existing engine (`buildEncounterFromMvu` → `buildDeck`) over a character's `stat_data` and maps the result to a generic `DuelPreview` contract; a main-side handler gathers the active chat's `stat_data` + the card's `combat` bundle and calls it; the result is exposed on the `Host` seam (`getDuelPreview`) and surfaced on the card page via `createThRuntime`, wired through both transports exactly like `assetUrl`.

**Tech Stack:** TypeScript (strict), Vitest (`npm run test`), the existing `src/shared/combat` engine + `src/shared/thRuntime` Host seam. No new dependencies.

This is **Plan A** of the design [2026-06-30-duel-build-preview-tab-design.md](../specs/2026-06-30-duel-build-preview-tab-design.md). Plan B (the fork's 战斗 tab) consumes the `DuelPreview` contract this plan produces.

## Global Constraints

- **Pure where it can be:** `buildDuelPreview` + the `DuelPreview` types live under `src/shared/combat` and MUST NOT import `src/main`/`src/renderer`. Verified by `npm run check:deps`.
- **Generic contract, card-supplied values** ([[rpt-keep-app-engine-generic]]): `DuelPreview` field names are neutral (English); the poem mapping (品质→rarityKey, 威力→power, etc.) lives in the **poem system module** (`systems/poemPreview.ts`), not the generic deckbuilder. The host method + contract are card-agnostic.
- **Mirror the existing seam:** `getDuelPreview` follows `assetUrl` exactly — `Host` async method ([thRuntime/types.ts:101](../../../src/shared/thRuntime/types.ts)), `createThRuntime` passthrough ([thRuntime/index.ts:450](../../../src/shared/thRuntime/index.ts)), WCV preload + IPC ([wcvHost.ts:137](../../../src/preload/wcvHost.ts), [wcvIpc.ts:502](../../../src/main/ipc/wcvIpc.ts)), inline ([cardBridge/host.ts:261](../../../src/renderer/src/cardBridge/host.ts) + [preload/index.ts:313](../../../src/preload/index.ts)).
- **Read-only:** no setter. The card reads, never writes the preview.
- **TDD** for the pure mapper; the transport/IPC wiring is verified by `npm run typecheck` (it's plumbing, consistent with how `chatCardVars` wiring is treated).
- **Verification gate (each task's last step):** `npm run typecheck && npm run check:deps && npm run test`.
- **Interim coupling:** `buildDuelPreview` calls `poemD20System` directly for now; the design (§6) records that this moves onto a `CombatSystem.buildPreview` hook during the tracked engine-genericization. Keep all poem-specific mapping in `systems/poemPreview.ts` so that move is localized.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/combat/deckbuilder/preview.ts` (new) | The generic `DuelPreview` / `CombatantPreview` / `CardPreview` contract types (no poem terms). |
| `src/shared/combat/systems/poemPreview.ts` (new) | `buildDuelPreview(...)` — the poem mapper: runs the engine + maps poem `ext` → the neutral contract. The poem-specific producer. |
| `src/shared/thRuntime/types.ts` (modify) | Add `getDuelPreview(): Promise<DuelPreview>` to `Host`. |
| `src/shared/thRuntime/index.ts` (modify) | Expose `getDuelPreview` on the card page (passthrough to `host.getDuelPreview`). |
| `src/main/services/duelPreviewService.ts` (new) | Gather the active chat's latest `stat_data` + the character's `combat` bundle, call `buildDuelPreview`. |
| `src/main/ipc/wcvIpc.ts` (modify) | `wcv-host-duel-preview` handler (ctx-scoped). |
| `src/main/ipc/duelPreviewIpc.ts` (new) | `duel-preview` IPC for the inline transport. |
| `src/preload/wcvHost.ts` + `src/preload/index.ts` (modify) | WCV `getDuelPreview` + inline `window.api.duelPreview`. |
| `src/renderer/src/cardBridge/host.ts` (modify) | Inline `getDuelPreview` → `window.api.duelPreview`. |
| `docs/sdk/component-inventory.md` + `docs/rpt-api.md` (modify) | Document the new card-facing surface. |
| `test/combat/duelPreview.test.ts` (new) | Unit tests for `buildDuelPreview`. |

---

## Task 1: The `DuelPreview` contract types

**Files:**
- Create: `src/shared/combat/deckbuilder/preview.ts`
- Test: `test/combat/duelPreview.test.ts` (created here, extended in Task 2)

**Interfaces:**
- Produces: `DuelPreview`, `CombatantPreview`, `CardPreview` (exact shapes below).

- [ ] **Step 1: Write the failing test**

```ts
// test/combat/duelPreview.test.ts
import { describe, it, expect } from 'vitest'
import type { DuelPreview } from '../../src/shared/combat/deckbuilder/preview'

describe('DuelPreview contract', () => {
  it('is structurally usable as the generic preview shape', () => {
    const p: DuelPreview = {
      config: { energyPerTurn: 3, handSize: 5 },
      lead: {
        id: '主角', name: '主角', tier: 2, level: 8,
        resources: { hp: 1820, maxHp: 2340, mp: 320, maxMp: 500, sp: 450, maxSp: 500 },
        modifiers: [{ key: 'attack', label: '攻击', value: 60 }],
        conditions: [{ id: '流血', label: '流血', stacks: 2, turns: 2, kind: 'debuff' }],
        deck: [{
          id: '主角/普攻', name: '普攻', rarityKey: 'common', rarityLabel: '普通',
          kind: 'attack', energyCost: 1, resourceCost: { sp: 5 },
          scalingAttr: '力量', power: 20, effectLines: [], ratingEstimate: 1.0, copies: 4
        }]
      },
      party: []
    }
    expect(p.lead.deck[0].copies).toBe(4)
    expect(p.config.energyPerTurn).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/duelPreview.test.ts`
Expected: FAIL — cannot find module `preview`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/preview.ts
//
// The generic, card-agnostic duel build-preview contract returned by the RPT host API
// getDuelPreview(). Neutral field names — the card's ruleset supplies values + display strings,
// the card UI applies labels/theming. See docs/superpowers/specs/2026-06-30-duel-build-preview-tab-design.md §2.

export interface DuelPreview {
  config: { energyPerTurn: number; handSize: number }
  lead: CombatantPreview
  party: CombatantPreview[]
}

export interface CombatantPreview {
  id: string
  name: string
  tier: number
  level: number
  resources: { hp: number; maxHp: number; mp: number; maxMp: number; sp: number; maxSp: number }
  /** aggregated relic/gear/passive modifiers; `label` is the ruleset's display text. */
  modifiers: { key: string; label: string; value: number }[]
  conditions: { id: string; label: string; stacks?: number; turns?: number; kind: 'buff' | 'debuff' }[]
  deck: CardPreview[]
}

export interface CardPreview {
  id: string
  name: string
  /** stable rarity id the card UI maps to a theme quality token (e.g. 'epic'). */
  rarityKey: string
  /** the ruleset's display label for the rarity (e.g. '史诗'). */
  rarityLabel: string
  kind: 'attack' | 'defend' | 'skill' | 'heal' | 'power'
  energyCost: number
  resourceCost: { hp?: number; mp?: number; sp?: number }
  scalingAttr?: string
  power?: number
  /** pre-formatted, display-ready effect lines. */
  effectLines: string[]
  ratingEstimate?: number
  copies: number
  /** World Assets '卡面' key; null today (rarity frame), real art when card-import (D6) lands. */
  artKey?: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/duelPreview.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/shared/combat/deckbuilder/preview.ts test/combat/duelPreview.test.ts
git commit -m "feat(duel): generic DuelPreview contract types"
```

---

## Task 2: `buildDuelPreview` — the poem mapper

**Files:**
- Create: `src/shared/combat/systems/poemPreview.ts`
- Test: `test/combat/duelPreview.test.ts` (extend)

**Interfaces:**
- Consumes: `buildEncounterFromMvu`, `StatMap`, `DeriveConfig` from `../bundle`; `buildDeck` from `../deckbuilder/deckBuild`; `DEFAULT_DECK_CONFIG`, `DeckConfig` from `../deckbuilder/deckTypes`; `poemD20System` from `./poemD20`; `CardCombat`, `CombatantExt`, `extOf` from `./poemStrike`; `AbilityDef`, `Combatant` from `../types`; the Task 1 `preview` types.
- Produces: `buildDuelPreview(statData, statMap, opts?): DuelPreview` where `opts: { derive?: DeriveConfig; config?: DeckConfig }`.

**Design notes:** reuse `buildEncounterFromMvu` to build party combatants (it runs `poemD20System.buildCombatant`), then `buildDeck` per party member; aggregate the deck's `order` into per-ability `copies`; read poem `ext`/`CardCombat` fields and map to the neutral contract. The first party combatant is `lead`, the rest are `party`.

- [ ] **Step 1: Write the failing test (extend the file)**

```ts
// append to test/combat/duelPreview.test.ts
import { buildDuelPreview } from '../../src/shared/combat/systems/poemPreview'
import type { StatMap, DeriveConfig } from '../../src/shared/combat/bundle'

const statMap: StatMap = { player: '主角', paths: { attributes: '属性', hp: '生命值', maxHp: '生命值上限', mp: '法力值', maxMp: '法力值上限', sp: '体力值', maxSp: '体力值上限', level: '等级', tier: '生命层级', equipment: '装备', skills: '技能', conditions: '状态效果' } }
const derive: DeriveConfig = { attributes: ['力量','敏捷','体质','智力','精神'], tier_coefficient: { '2': 2.8 }, hp_multiplier: { '2': 2 }, mp_sp_multiplier: { '2': 2.5 }, rating_tiers: [[11,1.0],[0,0]], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }
const statData = {
  主角: {
    生命层级: '第二层级', 等级: 8,
    属性: { 力量: 6, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 },
    生命值: 1820, 生命值上限: 2340, 法力值: 320, 法力值上限: 500, 体力值: 450, 体力值上限: 500,
    装备: { 长剑: { 类型: '武器', 品质: '优良', 标签: ['攻击: 60'], 效果: {} } },
    技能: { 烈焰斩: { 类型: '主动', 品质: '史诗', 消耗: '攻击: 30 MP', 标签: ['智力','威力: 140','有效距离: 1','范围: 锥形'], 效果: { 燃烧: '30+2回合' } } },
    状态效果: { 流血: { 类型: '减益', 剩余时间: '2回合' } }
  }
}

describe('buildDuelPreview', () => {
  it('maps a poem build to the generic DuelPreview (deck with copies, resources, modifiers)', () => {
    const p = buildDuelPreview(statData, statMap, { derive })
    expect(p.config).toEqual({ energyPerTurn: 3, handSize: 5 })
    expect(p.lead.name).toBe('主角')
    expect(p.lead.resources.maxHp).toBe(2340)
    // deck contains 普攻 ×4, 格挡 ×4, and the 史诗 烈焰斩 ×1
    const byName = (n: string) => p.lead.deck.find(c => c.name === n)
    expect(byName('普攻')?.copies).toBe(4)
    expect(byName('格挡')?.copies).toBe(4)
    const flame = byName('烈焰斩')!
    expect(flame.rarityKey).toBe('epic')
    expect(flame.rarityLabel).toBe('史诗')
    expect(flame.power).toBe(140)
    expect(flame.resourceCost).toEqual({ mp: 30 })
    expect(flame.kind).toBe('attack')
    // a relic modifier from the weapon 攻击
    expect(p.lead.modifiers.some(m => m.value === 60)).toBe(true)
    // the 流血 condition is carried
    expect(p.lead.conditions.some(c => c.id === '流血')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/duelPreview.test.ts`
Expected: FAIL — cannot find module `poemPreview`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/systems/poemPreview.ts
//
// Poem build-preview producer: runs the engine over a 命定之诗 build and maps the result to the
// generic DuelPreview contract. POEM-SPECIFIC (reads the poem ext / CardCombat) — kept here, not in
// the generic deckbuilder, per the generic-engine principle. Interim: calls poemD20System directly;
// moves onto a CombatSystem.buildPreview hook at engine genericization.

import { buildEncounterFromMvu, type DeriveConfig, type StatMap } from '../bundle'
import { buildDeck, energyCostFor } from '../deckbuilder/deckBuild'
import { DEFAULT_DECK_CONFIG, type DeckConfig } from '../deckbuilder/deckTypes'
import { extOf, type CardCombat, type CombatantExt } from './poemStrike'
import { poemD20System } from './poemD20'
import type { AbilityDef, Combatant } from '../types'
import type { CardPreview, CombatantPreview, DuelPreview } from '../deckbuilder/preview'

const RARITY_KEY: Record<string, string> = {
  普通: 'common', 优良: 'uncommon', 精良: 'rare', 史诗: 'epic', 传说: 'legendary', 神: 'mythic'
}

const cardKind = (name: string, cc: CardCombat): CardPreview['kind'] => {
  if (name === '格挡') return 'defend'
  if (cc.治疗 || (cc.治疗量 ?? 0) > 0) return 'heal'
  if (cc.类型 === '被动') return 'power'
  if (name === '普攻') return 'attack'
  return cc.威力 != null ? 'attack' : 'skill'
}

const effectLines = (cc: CardCombat): string[] => {
  const out: string[] = []
  if (cc.shape && cc.shape.kind !== 'self') out.push(cc.shape.kind)
  if (cc.多段 && cc.多段 > 1) out.push(`连击 ${cc.多段}`)
  if (cc.额外固定伤害) out.push(`固伤 ${cc.额外固定伤害}`)
  if (cc.护盾) out.push(`护盾 ${cc.护盾}`)
  if (cc.伤害增幅) out.push(`伤害增幅 ${cc.伤害增幅}%`)
  if (cc.治疗增幅) out.push(`治疗增幅 ${cc.治疗增幅}%`)
  for (const e of cc.附加效果 ?? []) out.push(`${e.状态} ${e.数值 ?? ''}/${e.回合}回合`.replace(' /', '/'))
  return out
}

const toCard = (
  abilityId: string,
  ability: AbilityDef,
  copies: number,
  config: DeckConfig
): CardPreview => {
  const cc = (ability.ext ?? {}) as CardCombat
  return {
    id: abilityId,
    name: ability.name,
    rarityKey: RARITY_KEY[cc.品质 ?? '普通'] ?? 'common',
    rarityLabel: cc.品质 ?? '普通',
    kind: cardKind(ability.name, cc),
    energyCost: energyCostFor(ability, config),
    resourceCost: {
      ...(cc.消耗?.mp ? { mp: cc.消耗.mp } : {}),
      ...(cc.消耗?.sp ? { sp: cc.消耗.sp } : {}),
      ...(cc.消耗?.hp ? { hp: cc.消耗.hp } : {})
    },
    ...(cc.关联属性 ? { scalingAttr: cc.关联属性 } : {}),
    ...(cc.威力 != null ? { power: cc.威力 } : {}),
    effectLines: effectLines(cc),
    copies
  }
}

const MOD_LABELS: { key: keyof NonNullable<CombatantExt['equip']>; label: string }[] = [
  { key: '武器攻击', label: '攻击' }, { key: '防御', label: '防御' },
  { key: '命中', label: '命中' }, { key: '闪避', label: '闪避' }, { key: 'DR', label: '减伤' }
]

const toCombatant = (c: Combatant, catalog: Record<string, AbilityDef>, config: DeckConfig): CombatantPreview => {
  const ext = extOf(c)
  const deck = buildDeck(c, catalog, config)
  const merged = { ...catalog, ...deck.abilities }
  // aggregate copies per abilityId, preserving first-seen order
  const counts = new Map<string, number>()
  for (const cid of deck.order) {
    const aid = deck.cards[cid].abilityId
    counts.set(aid, (counts.get(aid) ?? 0) + 1)
  }
  const cards: CardPreview[] = [...counts.entries()].map(([aid, n]) => toCard(aid, merged[aid], n, config))
  const equip = ext.equip ?? {}
  const modifiers = MOD_LABELS
    .filter(m => (equip[m.key] ?? 0) !== 0)
    .map(m => ({ key: String(m.key), label: m.label, value: equip[m.key] as number }))
  return {
    id: c.id,
    name: c.name,
    tier: ext.tier ?? 1,
    level: typeof ext.level === 'number' ? ext.level : 0,
    resources: {
      hp: c.block.hp, maxHp: c.block.maxHp,
      mp: ext.mp ?? 0, maxMp: ext.maxMp ?? 0, sp: ext.sp ?? 0, maxSp: ext.maxSp ?? 0
    },
    modifiers,
    conditions: c.block.conditions.map(cd => ({
      id: cd.id, label: cd.id, turns: cd.duration > 0 ? cd.duration : undefined, kind: 'debuff' as const
    })),
    deck: cards
  }
}

export const buildDuelPreview = (
  statData: Record<string, unknown>,
  statMap: StatMap,
  opts: { derive?: DeriveConfig; config?: DeckConfig } = {}
): DuelPreview => {
  const config = opts.config ?? DEFAULT_DECK_CONFIG
  const built = buildEncounterFromMvu(statData, statMap, poemD20System, { derive: opts.derive })
  const party = built.combatants.filter(c => c.side === 'party')
  const lead = party[0]
  return {
    config: { energyPerTurn: config.energy, handSize: config.handSize },
    lead: toCombatant(lead, built.abilities, config),
    party: party.slice(1).map(c => toCombatant(c, built.abilities, config))
  }
}
```

> Note: `CombatantExt` exposes `maxMp`/`maxSp`/`level`? Confirm against `poemStrike.ts`; if `maxMp`/`maxSp` aren't on the typed `CombatantExt`, read them via the same cast `buildCombatant` writes (`ext.maxMp`/`ext.maxSp`) — `buildCombatant` does set `mp/maxMp/sp/maxSp/level` on `ext`. If the typed interface lacks them, widen `CombatantExt` (additive, optional) in the same commit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/duelPreview.test.ts`
Expected: PASS (both tests). If `ext.maxMp`/`maxSp`/`level` are untyped, add them to `CombatantExt` (optional) per the note.

- [ ] **Step 5: Full gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/shared/combat/systems/poemPreview.ts src/shared/combat/systems/poemStrike.ts test/combat/duelPreview.test.ts
git commit -m "feat(duel): buildDuelPreview — poem build → generic DuelPreview mapper"
```

---

## Task 3: Main-side `duelPreviewService`

**Files:**
- Create: `src/main/services/duelPreviewService.ts`
- Test: none new (it's main-side glue over the unit-tested mapper + existing services; verified by typecheck + the IPC wiring in Task 4).

**Interfaces:**
- Consumes: `buildDuelPreview` from `../../shared/combat/systems/poemPreview`; the active chat's latest `stat_data` + the character's `combat` bundle from the existing chat/character services.
- Produces: `computeDuelPreview(profileId: string, chatId: string, characterId: string): DuelPreview | null`.

- [ ] **Step 1: Write the implementation**

Read how `StatusView`/`reevaluateVariables` obtains the latest floor's `variables.stat_data`, and how `combatService` reads the card's `combat` bundle (`character.card.data.extensions.rp_terminal.combat`), then:

```ts
// src/main/services/duelPreviewService.ts
//
// Gather the active chat's latest stat_data + the character's combat bundle and compute the
// generic DuelPreview for the card UI's 战斗 tab (the getDuelPreview host API). See
// docs/superpowers/specs/2026-06-30-duel-build-preview-tab-design.md.

import { buildDuelPreview } from '../../shared/combat/systems/poemPreview'
import type { DuelPreview } from '../../shared/combat/deckbuilder/preview'
import type { StatMap, DeriveConfig } from '../../shared/combat/bundle'
import { getLatestStatData } from './chatService'        // latest floor's variables.stat_data (confirm exact name)
import { getCharacter } from './characterService'        // the card (confirm exact name)

export function computeDuelPreview(
  profileId: string,
  chatId: string,
  characterId: string
): DuelPreview | null {
  const statData = getLatestStatData(profileId, chatId)
  const character = getCharacter(profileId, characterId)
  const bundle = character?.card?.data?.extensions?.rp_terminal?.combat as
    | { stat_map?: StatMap; derive?: DeriveConfig }
    | undefined
  if (!statData || !bundle?.stat_map) return null
  return buildDuelPreview(statData, bundle.stat_map, { derive: bundle.derive })
}
```

> The exact accessor names (`getLatestStatData`, `getCharacter`) must be confirmed against `chatService.ts`/`characterService.ts`; use whatever those services already expose (the same ones `combatService`/`StatusView` use to read the latest `stat_data` + the card). If a single-call accessor doesn't exist, assemble it from the existing reads — do not add a new persistence path.

- [ ] **Step 2: Verify it compiles + boundaries**

Run: `npm run typecheck && npm run check:deps`
Expected: PASS (main may import shared; shared must not import main — `duelPreviewService` is main, so it may import the shared mapper).

- [ ] **Step 3: Commit**

```bash
git add src/main/services/duelPreviewService.ts
git commit -m "feat(duel): duelPreviewService — gather stat_data + bundle, compute preview"
```

---

## Task 4: Host method + transports + IPC (wiring)

**Files:**
- Modify: `src/shared/thRuntime/types.ts`, `src/shared/thRuntime/index.ts`, `src/preload/wcvHost.ts`, `src/preload/index.ts`, `src/renderer/src/cardBridge/host.ts`, `src/main/ipc/wcvIpc.ts`
- Create: `src/main/ipc/duelPreviewIpc.ts`; register it in `src/main/ipc/index.ts`

**Interfaces:**
- Consumes: `computeDuelPreview` (Task 3); the `DuelPreview` type (Task 1).
- Produces: `host.getDuelPreview()` available on the card page as `getDuelPreview()`.

- [ ] **Step 1: Add to the `Host` interface**

In `src/shared/thRuntime/types.ts`, in the ASYNC ops block (after `assetUrl`), add:

```ts
  // Engine-computed duel build preview for the active chat (read-only). See the build-preview design.
  getDuelPreview(): Promise<import('../combat/deckbuilder/preview').DuelPreview>
```

- [ ] **Step 2: Expose on the card page in `createThRuntime`**

In `src/shared/thRuntime/index.ts`, beside the `assetUrl` passthrough (~line 450):

```ts
    getDuelPreview: () => host.getDuelPreview(),
```

- [ ] **Step 3: WCV transport**

In `src/preload/wcvHost.ts` (beside `assetUrl`, ~line 137):

```ts
    getDuelPreview: () => ipcRenderer.invoke('wcv-host-duel-preview'),
```

In `src/main/ipc/wcvIpc.ts`, add a handler beside the `wcv-host-asset-url` one (~line 502), resolving ctx the same way:

```ts
  handle('wcv-host-duel-preview', (e) => {
    const ctx = wcvManager.contextFor(e.sender)
    if (!ctx) return null
    return computeDuelPreview(ctx.profileId, ctx.chatId, ctx.characterId)
  })
```

(import `computeDuelPreview` from `../services/duelPreviewService`; match the file's existing `handle`/ctx-resolution helpers.)

- [ ] **Step 4: Inline transport**

In `src/preload/index.ts` (beside `assetUrl`, ~line 313):

```ts
  duelPreview: (profileId: string, chatId: string, characterId: string) =>
    ipcRenderer.invoke('duel-preview', profileId, chatId, characterId),
```

Create `src/main/ipc/duelPreviewIpc.ts`:

```ts
import { ipcMain } from 'electron'
import { computeDuelPreview } from '../services/duelPreviewService'

export function registerDuelPreviewIpc(): void {
  ipcMain.handle('duel-preview', (_e, profileId: string, chatId: string, characterId: string) =>
    computeDuelPreview(profileId, chatId, characterId)
  )
}
```

Register it in `src/main/ipc/index.ts` (call `registerDuelPreviewIpc()` where the other IPC registrars are called).

In `src/renderer/src/cardBridge/host.ts` (beside `assetUrl`, ~line 261):

```ts
    getDuelPreview: async () => {
      try {
        return await window.api.duelPreview(ctx.profileId, ctx.currentChatId ?? '', cardCharacterId() ?? '')
      } catch {
        return null
      }
    },
```

(Use the same `ctx`/`cardCharacterId()` accessors the surrounding methods use; confirm the chat-id accessor name in this file.)

Add the `duelPreview` signature to `window.api`'s type declaration wherever the other `window.api` methods are typed (e.g. the preload `Api` interface).

- [ ] **Step 5: Verify wiring compiles**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS. (Boundaries: `shared/thRuntime` only references the `DuelPreview` type via `import('../combat/...')`; transports import the service from main, which is allowed for preload/main.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/thRuntime/types.ts src/shared/thRuntime/index.ts src/preload/wcvHost.ts src/preload/index.ts src/renderer/src/cardBridge/host.ts src/main/ipc/wcvIpc.ts src/main/ipc/duelPreviewIpc.ts src/main/ipc/index.ts
git commit -m "feat(duel): getDuelPreview host API wired through both transports"
```

---

## Task 5: SDK docs

**Files:**
- Modify: `docs/sdk/component-inventory.md`, `docs/rpt-api.md`

- [ ] **Step 1: Document the surface**

Add a `getDuelPreview()` entry to `docs/rpt-api.md` (the card-runtime API list) and a note in `docs/sdk/component-inventory.md`: the read-only host method, the `DuelPreview` contract (link the design + [duel-card-authoring.md](../sdk/duel-card-authoring.md)), that it's RPT-only (no vanilla-ST equivalent), and that values are produced by the card's combat ruleset over the active build. Mirror the style of the existing `assetUrl` / `getVariables({type:'chat'})` entries.

- [ ] **Step 2: Commit**

```bash
git add docs/sdk/component-inventory.md docs/rpt-api.md
git commit -m "docs(sdk): document the getDuelPreview host API + DuelPreview contract"
```

---

## Self-Review

**Spec coverage:** `DuelPreview` contract (§2) → Task 1. `buildDuelPreview` over the engine, generic-contract/poem-mapping split (§3.1, §0.8) → Task 2. Main gather of stat_data + bundle (§3.2 source) → Task 3. Read-only `getDuelPreview` host method + both transports (§3.2) → Task 4. SDK obligation (§3.2, §7) → Task 5. Generic-engine dependency (§6) → honored by isolating poem mapping in `poemPreview.ts` + the interim note. ✓

**Placeholder scan:** Two task-3/task-4 spots say "confirm exact accessor/ctx names" — these are deliberate verification points against real services, with a fallback instruction, not placeholders for logic. All code steps show complete code. ✓

**Type consistency:** `DuelPreview`/`CombatantPreview`/`CardPreview` (Task 1) imported unchanged by Tasks 2 + 4. `buildDuelPreview(statData, statMap, opts)` (Task 2) ← `computeDuelPreview` (Task 3) ← both transports (Task 4). `getDuelPreview(): Promise<DuelPreview>` consistent across `Host`, `createThRuntime`, both transports. ✓

---

## Execution

Per the design's decomposition, this plan ships first (Plan B consumes its contract). Execute via subagent-driven development. After it lands, Plan B (the fork 战斗 tab) can run against the real API (or a static `DuelPreview` fixture in parallel).
