# Native DuelView (interactive STS duel, v1 core fight loop) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the already-built headless STS duel engine a native, playable, **polished + theme-customizable** `DuelView` in the RPT app, with a debug "mock duel" launcher — the interactive counterpart to the read-only 战斗 build-preview tab.

**Architecture:** Mirror the grid combat stack over the existing pure engine (`src/shared/combat/deckbuilder`): a main `duelService` holds the active `DuelState`+catalog per chat (in-memory) and applies pure engine transitions; `duelIpc` exposes them; a renderer `duelStore` mirrors state; `DuelView` renders it and is registered in the workspace `viewRegistry`. All colors are RPT theme tokens (`--rpt-*` + derived `--rpt-duel-*`).

**Tech Stack:** TypeScript (strict), Electron (main + preload + renderer), React 19 + zustand (renderer), Vitest. No new dependencies.

This is the implementation of the design [2026-06-30-native-duelview-design.md](../specs/2026-06-30-native-duelview-design.md).

## Global Constraints

- **No engine changes.** `src/shared/combat/deckbuilder/*` is reused unchanged. The engine is pure (`DuelState → DuelState`); `playCard`/`endLeadTurn` require the `catalog` and optional `derive`. `endLeadTurn` resolves the **entire** allies+enemies phase in one call (no stepped enemy-turn driver).
- **Theme tokens only — no hardcoded colors.** Every DuelView color is `var(--rpt-*)` or a derived `var(--rpt-duel-*)` (added to `assets/index.css :root`, `color-mix` from base tokens — mirror the `--rpt-combat-*` block at [index.css:20](../../../src/renderer/src/assets/index.css)). Must stay WCAG-AA legible across **all three** themes (dark / carbon / light — `src/renderer/src/theme.ts`).
- **i18n every user-facing string.** Route through `t('key')` (`useT()`), and add the key to **both** `src/renderer/src/i18n/locales/en.ts` and `locales/zh.ts`. Use ST-ecosystem Chinese terms.
- **Module boundaries (enforced by `npm run check:deps`).** The engine imports nothing from main/renderer/IPC (already true). `duelService` is main, may import the shared engine. `duelStore`/`DuelView` reach main only via `window.api` (the renderer casts it `any`, like `combatStore`); never import main internals.
- **Verification gate (each task's last step):** `npm run typecheck && npm run check:deps && npm run test`. UI tasks add a manual check (incl. a dark/carbon/light legibility pass).
- **TDD** for the pure `duelService` orchestration; the IPC/preload/store/view wiring is verified by typecheck + the manual mock-duel check (consistent with how the grid combat stack is treated).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/main/services/duelService.ts` (new) | In-memory `Map<chatId, DuelRecord>`; pure orchestration (`createMockDuel`, `playCardIn`, `endTurnIn`) + chatId wrappers (`getDuel`/`startMockDuel`/`startDuelFromMvu`/`playDuelCard`/`endDuelTurn`/`endDuel`). Holds `{ state, catalog, derive }`. |
| `test/combat/duelService.test.ts` (new) | Headless: mock setup → play a card (energy/pile change) → end turn (enemies resolve) → victory. |
| `src/main/ipc/duelIpc.ts` (new) | `duel-start-mock` / `duel-start` / `duel-get` / `duel-play` / `duel-end-turn` / `duel-end`. |
| `src/main/ipc/index.ts` (modify) | Register `registerDuelIpc`. |
| `src/preload/index.ts` (modify) | `duelStartMock` / `duelStart` / `duelGet` / `duelPlay` / `duelEndTurn` / `duelEnd`. |
| `src/renderer/src/stores/duelStore.ts` (new) | zustand mirror of `DuelState` + catalog; card→target selection; `busy` + `lastEvents`/`eventSeq`. |
| `src/renderer/src/components/workspace/DuelView.tsx` (new) | Board · hand · energy · intents · play/end-turn · win/lose · "mock duel (debug)". Token-driven. |
| `src/renderer/src/assets/index.css` (modify) | `--rpt-duel-*` tokens in `:root` + duel component classes. |
| `src/renderer/src/components/workspace/viewRegistry.tsx` (modify) | `DuelPanel` wrapper + `duel` entry. |
| `src/renderer/src/i18n/locales/en.ts` + `zh.ts` (modify) | `duel.*` strings. |

---

## Task 1: `duelService` (main) + headless tests

**Files:**
- Create: `src/main/services/duelService.ts`, `test/combat/duelService.test.ts`

**Interfaces:**
- Consumes: `buildEncounterFromMvu` from `../../shared/combat/bundle`; `startDuel`, `playCard`, `endLeadTurn`, `checkDuelVictory`, type `DuelState`, type `DeckConfig` from `../../shared/combat/deckbuilder`; `poemD20System` from `../../shared/combat/systems`; types `AbilityDef`, `CombatEvent`, `Combatant`, `DeriveConfig`, `StatMap`.
- Produces:
  - `interface DuelRecord { state: DuelState; catalog: Record<string, AbilityDef>; derive?: DeriveConfig }`
  - `createMockDuel(): DuelRecord`
  - `playCardIn(rec: DuelRecord, cardId: string, targetIds: string[]): { record: DuelRecord; events: CombatEvent[] }`
  - `endTurnIn(rec: DuelRecord): { record: DuelRecord; events: CombatEvent[] }`
  - `interface DuelView { state: DuelState; catalog: Record<string, AbilityDef> }`
  - chatId wrappers: `getDuel(chatId): DuelView | null`, `startMockDuel(chatId): DuelView`, `playDuelCard(chatId, cardId, targetIds): { state, events } | null`, `endDuelTurn(chatId): { state, events } | null`, `endDuel(chatId): void`, `startDuelFromMvu(profileId, chatId, characterId): DuelView | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/combat/duelService.test.ts
import { describe, it, expect } from 'vitest'
import { createMockDuel, playCardIn, endTurnIn } from '../../src/main/services/duelService'

describe('duelService (mock duel orchestration)', () => {
  it('createMockDuel builds an active duel with a full hand + enemies + a card catalog', () => {
    const rec = createMockDuel()
    expect(rec.state.status).toBe('active')
    expect(rec.state.piles.hand.length).toBe(rec.state.handSize) // hand drawn on start
    expect(rec.state.combatants.some((c) => c.side === 'enemy' && c.block.hp > 0)).toBe(true)
    expect(rec.state.combatants.some((c) => c.side === 'party' && c.block.hp > 0)).toBe(true)
    expect(Object.keys(rec.catalog).length).toBeGreaterThan(0)
  })

  it('playCardIn plays the lead 普攻 at an enemy: spends energy + moves the card out of hand', () => {
    const rec = createMockDuel()
    const lead = rec.state.lead
    const cardId = rec.state.piles.hand.find((cid) => rec.state.cards[cid].abilityId === `${lead}/普攻`)!
    expect(cardId).toBeDefined()
    const enemy = rec.state.combatants.find((c) => c.side === 'enemy' && c.block.hp > 0)!
    const energyBefore = rec.state.energy.current
    const { record, events } = playCardIn(rec, cardId, [enemy.id])
    expect(record.state.energy.current).toBeLessThan(energyBefore)
    expect(record.state.piles.hand.includes(cardId)).toBe(false) // discarded/exhausted
    expect(events.some((e) => e.kind === 'damage' || e.kind === 'info')).toBe(true)
  })

  it('endTurnIn resolves allies+enemies and either continues (round+1) or ends the duel', () => {
    let rec = createMockDuel()
    const before = rec.state.round
    const { record } = endTurnIn(rec)
    rec = record
    if (rec.state.status === 'active') {
      expect(rec.state.round).toBe(before + 1)
      expect(rec.state.energy.current).toBe(rec.state.energy.max) // energy refreshed
      expect(rec.state.piles.hand.length).toBe(rec.state.handSize) // redrawn
    } else {
      expect(['party', 'enemy']).toContain(rec.state.status)
    }
  })
})
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npx vitest run test/combat/duelService.test.ts`
Expected: FAIL — cannot find `duelService`.

- [ ] **Step 3: Implement `duelService.ts`**

The mock setup reuses the proven `buildEncounterFromMvu` path with **inline** data (the canonical `stat_map`/`derive` from `docs/sdk/examples/poem-combat-bundle.json`, a compact 主角+艾莉亚 `stat_data`, and a 2-goblin `roster`) so it needs no card/AI/file at runtime.

```ts
// src/main/services/duelService.ts
//
// Interactive STS duel — main-process service. Holds the active DuelState + ability catalog per chat
// (in-memory; a duel is ephemeral), and applies the pure deckbuilder engine transitions. Mirrors
// combatService's shape but simpler: endLeadTurn resolves the whole non-lead phase in one call, so
// there is no stepped enemy-turn driver. See docs/superpowers/specs/2026-06-30-native-duelview-design.md.

import { buildEncounterFromMvu, type DeriveConfig, type StatMap } from '../../shared/combat/bundle'
import { startDuel, playCard, endLeadTurn, type DuelState } from '../../shared/combat/deckbuilder'
import { poemD20System } from '../../shared/combat/systems'
import { getLatestStatData } from './chatService'         // confirm exact name in chatService (see note)
import { getCharacter } from './characterService'         // confirm exact name in characterService (see note)
import type { AbilityDef, CombatEvent } from '../../shared/combat/types'

export interface DuelRecord {
  state: DuelState
  catalog: Record<string, AbilityDef>
  derive?: DeriveConfig
}

/** The renderer view-model: the live state + the card/ability catalog (to render cards). */
export interface DuelView {
  state: DuelState
  catalog: Record<string, AbilityDef>
}

// --- mock setup (inline; canonical stat_map/derive from docs/sdk/examples/poem-combat-bundle.json) ---

const MOCK_STAT_MAP: StatMap = {
  player: '主角',
  party: { from: '关系列表', filter: { 在场: true } },
  paths: {
    attributes: '属性', hp: '生命值', maxHp: '生命值上限', mp: '法力值', maxMp: '法力值上限',
    sp: '体力值', maxSp: '体力值上限', level: '等级', tier: '生命层级', equipment: '装备',
    skills: '技能', conditions: '状态效果'
  }
}

const MOCK_DERIVE: DeriveConfig = {
  attributes: ['力量', '敏捷', '体质', '智力', '精神'],
  tier_coefficient: { '1': 2, '2': 2.8, '3': 4, '4': 8, '5': 15, '6': 35, '7': 80 },
  hp_multiplier: { '1': 1, '2': 2, '3': 4, '4': 10, '5': 20, '6': 40, '7': 100 },
  mp_sp_multiplier: { '1': 1, '2': 2.5, '3': 6, '4': 15, '5': 35, '6': 80, '7': 160 },
  rating_tiers: [[30, 2], [25, 1.6], [20, 1.3], [11, 1], [8, 0.8], [4, 0.3], [0, 0]],
  attr_mitigation: { 物理: 0.0025, 能量: 0.004, 精神: 0.008, 真实: 0 },
  defense_constant: 2000
}

const MOCK_STAT_DATA = {
  主角: {
    属性: { 力量: 6, 敏捷: 5, 体质: 7, 智力: 3, 精神: 4 },
    生命值: 1400, 生命值上限: 1400, 法力值: 700, 法力值上限: 700, 体力值: 1100, 体力值上限: 1100,
    等级: 8, 生命层级: '第二层级/优良',
    装备: {
      主手: { 品质: '优良', 类型: '巨剑', 标签: ['攻击: 80'], 效果: { 命中: '+2' }, 描述: '' },
      护甲: { 品质: '优良', 类型: '板甲', 标签: ['防御: 60'], 效果: {}, 描述: '' }
    },
    技能: {
      火球术: {
        品质: '稀有', 类型: '主动', 消耗: '攻击: 200 MP',
        标签: ['智力', '范围: 爆发', '威力: 300', '有效距离: 6'], 效果: { 灼烧: '30+2回合' }, 描述: ''
      }
    },
    状态效果: {}
  },
  关系列表: {
    艾莉亚: {
      在场: true, 属性: { 力量: 4, 敏捷: 6, 体质: 5, 智力: 7, 精神: 6 },
      生命值: 1000, 生命值上限: 1000, 等级: 6, 生命层级: '第二层级/优良',
      装备: { 法杖: { 品质: '优良', 类型: '法杖', 标签: ['攻击: 50'], 效果: {}, 描述: '' } },
      技能: {}, 状态效果: {}
    }
  }
}

const MOCK_ROSTER = [
  {
    名称: '哥布林', 数量: 2, 生命层级: '第一层级', 等级: 3,
    属性: { 力量: 4, 敏捷: 3, 体质: 4, 智力: 1, 精神: 1 },
    装备: { 爪牙: { 类型: '天生武器', 标签: ['攻击: 25'], 效果: {} } }, 技能: {}, 状态效果: {}
  }
]

export const createMockDuel = (): DuelRecord => {
  const built = buildEncounterFromMvu(MOCK_STAT_DATA, MOCK_STAT_MAP, poemD20System, {
    derive: MOCK_DERIVE, seed: 7, roster: MOCK_ROSTER
  })
  const { state, catalog } = startDuel(built, { seed: 7 })
  return { state, catalog, derive: MOCK_DERIVE }
}

// --- pure orchestration over a record (unit-testable) ---

export const playCardIn = (
  rec: DuelRecord, cardId: string, targetIds: string[]
): { record: DuelRecord; events: CombatEvent[] } => {
  const { state, events } = playCard(rec.state, cardId, targetIds, rec.catalog, rec.derive)
  return { record: { ...rec, state }, events }
}

export const endTurnIn = (rec: DuelRecord): { record: DuelRecord; events: CombatEvent[] } => {
  const { state, events } = endLeadTurn(rec.state, rec.catalog, rec.derive)
  return { record: { ...rec, state }, events }
}

// --- chatId-keyed wrappers (in-memory; main process is long-lived) ---

const duels = new Map<string, DuelRecord>()
const view = (rec: DuelRecord): DuelView => ({ state: rec.state, catalog: rec.catalog })

export const getDuel = (chatId: string): DuelView | null => {
  const rec = duels.get(chatId)
  return rec ? view(rec) : null
}

export const startMockDuel = (chatId: string): DuelView => {
  const rec = createMockDuel()
  duels.set(chatId, rec)
  return view(rec)
}

export const playDuelCard = (
  chatId: string, cardId: string, targetIds: string[]
): { state: DuelState; events: CombatEvent[] } | null => {
  const rec = duels.get(chatId)
  if (!rec) return null
  const { record, events } = playCardIn(rec, cardId, targetIds)
  duels.set(chatId, record)
  return { state: record.state, events }
}

export const endDuelTurn = (chatId: string): { state: DuelState; events: CombatEvent[] } | null => {
  const rec = duels.get(chatId)
  if (!rec) return null
  const { record, events } = endTurnIn(rec)
  duels.set(chatId, record)
  return { state: record.state, events }
}

export const endDuel = (chatId: string): void => {
  duels.delete(chatId)
}

/** Start a duel from the active chat's current MVU build (player + 在场 party; AI roster TBD).
 *  Gathers stat_data + the card's combat bundle the same way duelPreviewService does. */
export const startDuelFromMvu = (
  profileId: string, chatId: string, characterId: string
): DuelView | null => {
  const statData = getLatestStatData(profileId, chatId)
  const character = getCharacter(profileId, characterId)
  const bundle = character?.card?.data?.extensions?.rp_terminal?.combat as
    | { stat_map?: StatMap; derive?: DeriveConfig } | undefined
  if (!statData || !bundle?.stat_map) return null
  const built = buildEncounterFromMvu(statData, bundle.stat_map, poemD20System, { derive: bundle.derive, seed: 7 })
  const { state, catalog } = startDuel(built, { seed: 7 })
  const rec: DuelRecord = { state, catalog, derive: bundle.derive }
  duels.set(chatId, rec)
  return view(rec)
}
```

> **Note (confirm against real services):** `getLatestStatData` and `getCharacter` are the same accessors `src/main/services/duelPreviewService.ts` already uses to gather the latest `stat_data` + the card's `combat` bundle — open that file and reuse the exact names/imports it uses (do not invent a new persistence path). `startDuelFromMvu` is wiring-only (the mock path is what the tests cover); if the accessors differ, match `duelPreviewService.ts` verbatim.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run test/combat/duelService.test.ts`
Expected: PASS (3 tests). If `buildEncounterFromMvu`/`startDuel` typings need a cast for `MOCK_STAT_DATA` (it's `Record<string, unknown>`), pass it as `MOCK_STAT_DATA as Record<string, unknown>`.

- [ ] **Step 5: Full gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/main/services/duelService.ts test/combat/duelService.test.ts
git commit -m "feat(duel): duelService — interactive duel orchestration + mock launcher (headless tests)"
```

---

## Task 2: `duelIpc` + registration + preload

**Files:**
- Create: `src/main/ipc/duelIpc.ts`
- Modify: `src/main/ipc/index.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: `duelService` (Task 1).
- Produces: `window.api.duelStartMock/duelStart/duelGet/duelPlay/duelEndTurn/duelEnd`.

- [ ] **Step 1: Create `duelIpc.ts`**

```ts
// src/main/ipc/duelIpc.ts
import { IpcMain } from 'electron'
import * as duelService from '../services/duelService'
import * as logService from '../services/logService'

/** Interactive STS duel IPC. One active duel per chat; the renderer DuelView drives these.
 *  `profileId` is accepted for parity with the other domains; the duel is keyed by chatId. */
export const registerDuelIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('duel-get', (_, _profileId, chatId) => duelService.getDuel(chatId))
  // Debug: spin up a hardcoded duel (no card/AI) for in-app testing.
  ipcMain.handle('duel-start-mock', (_, _profileId, chatId) => duelService.startMockDuel(chatId))
  ipcMain.handle('duel-start', (_, profileId, chatId, characterId) =>
    duelService.startDuelFromMvu(profileId, chatId, characterId)
  )
  ipcMain.handle('duel-play', (_, _profileId, chatId, cardId, targetIds) => {
    try {
      return duelService.playDuelCard(chatId, String(cardId), (targetIds as string[]) ?? [])
    } catch (err: any) {
      logService.log('error', '✗ duel-play failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('duel-end-turn', (_, _profileId, chatId) => duelService.endDuelTurn(chatId))
  ipcMain.handle('duel-end', (_, _profileId, chatId) => duelService.endDuel(chatId))
}
```

- [ ] **Step 2: Register it**

In `src/main/ipc/index.ts`: add `import { registerDuelIpc } from './duelIpc'` beside the other imports, and `registerDuelIpc(ipcMain)` in the `registerIpc` body (after `registerDuelPreviewIpc()`).

- [ ] **Step 3: Add preload methods**

In `src/preload/index.ts`, beside the `combat*` methods (~line 199), add (matching their `(args) => ipcRenderer.invoke('channel', ...args)` style):

```ts
  duelGet: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-get', profileId, chatId),
  duelStartMock: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-start-mock', profileId, chatId),
  duelStart: (profileId: string, chatId: string, characterId: string) =>
    ipcRenderer.invoke('duel-start', profileId, chatId, characterId),
  duelPlay: (profileId: string, chatId: string, cardId: string, targetIds: string[]) =>
    ipcRenderer.invoke('duel-play', profileId, chatId, cardId, targetIds),
  duelEndTurn: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-end-turn', profileId, chatId),
  duelEnd: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-end', profileId, chatId),
```

- [ ] **Step 4: Gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/main/ipc/duelIpc.ts src/main/ipc/index.ts src/preload/index.ts
git commit -m "feat(duel): duel IPC + preload (start-mock/start/get/play/end-turn/end)"
```

---

## Task 3: `duelStore` (renderer)

**Files:**
- Create: `src/renderer/src/stores/duelStore.ts`

**Interfaces:**
- Consumes: `window.api.duel*` (Task 2); types `DuelState`, `Combatant`, `CombatEvent`, `AbilityDef` from `../../../shared/combat/...`.
- Produces: `useDuelStore` with `{ chatId, state, catalog, selection, busy, lastEvents, eventSeq, load, startMock, pickCard, clearSelection, play, endTurn, end }` and a `leadCard(state, cardId)` helper export. `Selection = { mode:'idle' } | { mode:'card'; cardId: string }`.

- [ ] **Step 1: Write the store** (mirrors `combatStore`; simpler — no `runAutomated` since `endLeadTurn` resolves everything)

```ts
// src/renderer/src/stores/duelStore.ts
import { create } from 'zustand'
import type { DuelState } from '../../../shared/combat/deckbuilder'
import type { AbilityDef, CombatEvent } from '../../../shared/combat/types'

const api = (): any => (window as unknown as { api: any }).api

export type DuelSelection = { mode: 'idle' } | { mode: 'card'; cardId: string }

interface DuelStore {
  chatId: string | null
  state: DuelState | null
  catalog: Record<string, AbilityDef>
  selection: DuelSelection
  busy: boolean
  lastEvents: CombatEvent[]
  eventSeq: number
  load: (profileId: string, chatId: string) => Promise<void>
  startMock: (profileId: string, chatId: string) => Promise<void>
  startFromBuild: (profileId: string, chatId: string, characterId: string) => Promise<void>
  pickCard: (cardId: string) => void
  clearSelection: () => void
  play: (profileId: string, targetIds: string[]) => Promise<void>
  endTurn: (profileId: string) => Promise<void>
  end: (profileId: string) => Promise<void>
}

export const useDuelStore = create<DuelStore>((set, get) => {
  const apply = (res: { state: DuelState; events?: CombatEvent[] } | null): void => {
    if (!res) return
    set((s) => ({
      state: res.state,
      selection: { mode: 'idle' },
      lastEvents: res.events ?? [],
      eventSeq: s.eventSeq + 1
    }))
  }
  return {
    chatId: null,
    state: null,
    catalog: {},
    selection: { mode: 'idle' },
    busy: false,
    lastEvents: [],
    eventSeq: 0,

    load: async (profileId, chatId) => {
      const res = await api().duelGet(profileId, chatId)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    startMock: async (profileId, chatId) => {
      const res = await api().duelStartMock(profileId, chatId)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    startFromBuild: async (profileId, chatId, characterId) => {
      const res = await api().duelStart(profileId, chatId, characterId)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },

    pickCard: (cardId) => set({ selection: { mode: 'card', cardId } }),
    clearSelection: () => set({ selection: { mode: 'idle' } }),

    play: async (profileId, targetIds) => {
      const { chatId, selection } = get()
      if (!chatId || selection.mode !== 'card') return
      set({ busy: true })
      try {
        apply(await api().duelPlay(profileId, chatId, selection.cardId, targetIds))
      } finally {
        set({ busy: false })
      }
    },

    endTurn: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        apply(await api().duelEndTurn(profileId, chatId))
      } finally {
        set({ busy: false })
      }
    },

    end: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      await api().duelEnd(profileId, chatId)
      set({ state: null, catalog: {}, selection: { mode: 'idle' } })
    }
  }
})
```

- [ ] **Step 2: Gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/renderer/src/stores/duelStore.ts
git commit -m "feat(duel): duelStore — renderer mirror of DuelState + card/target selection"
```

---

## Task 4: `DuelView` + `--rpt-duel-*` tokens + i18n (the polished view)

**Files:**
- Create: `src/renderer/src/components/workspace/DuelView.tsx`
- Modify: `src/renderer/src/assets/index.css`, `src/renderer/src/i18n/locales/en.ts`, `src/renderer/src/i18n/locales/zh.ts`

**Interfaces:**
- Consumes: `useDuelStore` (Task 3); `useT` from `../../i18n`; the active chat id from the chat store (mirror how `CombatView` obtains `activeChatId` — read `CombatView.tsx` top; it reads it from the chat store).
- Produces: `<DuelView profileId={string} />`.

- [ ] **Step 1: Add the `--rpt-duel-*` tokens** to `src/renderer/src/assets/index.css` `:root`, beside the `--rpt-combat-*` block (~line 20). All derived from base theme tokens so they re-color per theme:

```css
  /* Duel (STS) — derived from base theme tokens so it re-colors per theme. */
  --rpt-duel-energy: color-mix(in srgb, var(--rpt-warning) 82%, var(--rpt-text-primary));
  --rpt-duel-on-energy: var(--rpt-bg-primary);
  --rpt-duel-card-bg: var(--rpt-bg-elevated);
  --rpt-duel-card-border: var(--rpt-border);
  --rpt-duel-card-hover: color-mix(in srgb, var(--rpt-accent) 14%, var(--rpt-bg-elevated));
  --rpt-duel-selected: var(--rpt-accent);
  --rpt-duel-hp: color-mix(in srgb, var(--rpt-danger) 80%, var(--rpt-text-primary) 0%);
  --rpt-duel-block: color-mix(in srgb, var(--rpt-accent) 60%, var(--rpt-text-tertiary));
  --rpt-duel-intent-attack: var(--rpt-danger);
  --rpt-duel-intent-defend: var(--rpt-accent);
  --rpt-duel-target: color-mix(in srgb, var(--rpt-danger) 34%, transparent);
```

- [ ] **Step 2: Add i18n keys** to BOTH `locales/en.ts` and `locales/zh.ts` (beside the `combat.*` keys):

```ts
// en.ts
  'duel.empty': 'No active duel.',
  'duel.startMock': 'Start mock duel (debug)',
  'duel.energy': 'Energy',
  'duel.endTurn': 'End turn',
  'duel.endDuel': 'End duel',
  'duel.round': 'Round',
  'duel.pickTarget': 'Pick a target',
  'duel.win': 'Victory',
  'duel.lose': 'Defeat',
  'duel.exhaust': 'Exhaust',
```
```ts
// zh.ts
  'duel.empty': '当前没有进行中的对决。',
  'duel.startMock': '开始模拟对决（调试）',
  'duel.energy': '行动力',
  'duel.endTurn': '结束回合',
  'duel.endDuel': '结束对决',
  'duel.round': '回合',
  'duel.pickTarget': '选择目标',
  'duel.win': '胜利',
  'duel.lose': '失败',
  'duel.exhaust': '消耗',
```

- [ ] **Step 3: Write `DuelView.tsx`** (token-driven; no hardcoded colors). Read `CombatView.tsx` lines 1–140 first to copy the `profileId` prop + `activeChatId` (chat store) + no-state pattern verbatim, then:

```tsx
// src/renderer/src/components/workspace/DuelView.tsx
//
// Native interactive STS duel view (v1 core fight loop). Renders DuelState from duelStore: board
// (party + enemies w/ HP/block/intents), hand of cards, energy, play (with targeting) + end-turn,
// win/lose. Polished + theme-token-driven (var(--rpt-*) / --rpt-duel-*). Mirrors CombatView's shell.

import { FC } from 'react'
import { useDuelStore } from '../../stores/duelStore'
import { useT } from '../../i18n'
// import the active-chat-id selector the same way CombatView.tsx does (chat store):
import { useChatStore } from '../../stores/chatStore' // confirm the exact store/selector in CombatView.tsx

const RARITY_VAR: Record<string, string> = {
  普通: '--rpt-text-secondary', 优良: '--rpt-success', 稀有: '--rpt-accent',
  史诗: '--rpt-warning', 传说: '--rpt-warning', 神: '--rpt-danger'
}

export const DuelView: FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId) // match CombatView's accessor
  const state = useDuelStore((s) => s.state)
  const catalog = useDuelStore((s) => s.catalog)
  const selection = useDuelStore((s) => s.selection)
  const busy = useDuelStore((s) => s.busy)
  const startMock = useDuelStore((s) => s.startMock)
  const pickCard = useDuelStore((s) => s.pickCard)
  const clearSelection = useDuelStore((s) => s.clearSelection)
  const play = useDuelStore((s) => s.play)
  const endTurn = useDuelStore((s) => s.endTurn)
  const end = useDuelStore((s) => s.end)

  if (!activeChatId) return <div style={{ opacity: 0.5, padding: 8 }}>{t('duel.empty')}</div>

  if (!state) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: 8 }}>
        <div style={{ opacity: 0.6 }}>{t('duel.empty')}</div>
        <button className="btn-accent" disabled={busy} onClick={() => void startMock(profileId, activeChatId)}>
          {t('duel.startMock')}
        </button>
      </div>
    )
  }

  const over = state.status !== 'active'
  const cardOf = (cid: string) => {
    const card = state.cards[cid]
    const ability = catalog[card.abilityId]
    const ext = (ability?.ext ?? {}) as { 品质?: string; 威力?: number; 关联属性?: string }
    return { card, ability, ext }
  }
  const onCardClick = (cid: string) => (selection.mode === 'card' && selection.cardId === cid ? clearSelection() : pickCard(cid))
  const onEnemyClick = (id: string) => { if (selection.mode === 'card') void play(profileId, [id]) }
  // self/AoE cards (no target needed) play immediately; v1 heuristic: 格挡 + non-attack play with [].
  const playNoTarget = () => { if (selection.mode === 'card') void play(profileId, []) }

  return (
    <div className="rpt-duel">
      <div className="rpt-duel-topbar">
        <span className="rpt-duel-round">{t('duel.round')} {state.round}</span>
        <span className="rpt-duel-energy" title={t('duel.energy')}>{state.energy.current}/{state.energy.max}</span>
        <span style={{ flex: 1 }} />
        <button className="btn-accent" disabled={busy || over} onClick={() => void endTurn(profileId)}>{t('duel.endTurn')}</button>
        <button className="rpt-duel-secondary" disabled={busy} onClick={() => void end(profileId)}>{t('duel.endDuel')}</button>
      </div>

      <div className="rpt-duel-board">
        {state.combatants.map((c) => {
          const intent = state.intents[c.id]
          const targetable = selection.mode === 'card' && c.side === 'enemy' && c.block.hp > 0
          return (
            <button
              key={c.id}
              className={`rpt-duel-unit side-${c.side}${c.id === state.lead ? ' is-lead' : ''}${targetable ? ' targetable' : ''}`}
              disabled={!targetable || busy}
              onClick={() => onEnemyClick(c.id)}
            >
              <span className="rpt-duel-unit-name">{c.name}</span>
              <span className="rpt-duel-hpbar">
                <i style={{ width: `${c.block.maxHp ? Math.max(0, (c.block.hp / c.block.maxHp) * 100) : 0}%` }} />
              </span>
              <span className="rpt-duel-unit-hp">{c.block.hp} / {c.block.maxHp}</span>
              {intent && <span className={`rpt-duel-intent kind-${intent.kind}`}>{intent.kind}{intent.preview != null ? ` ${intent.preview}` : ''}</span>}
            </button>
          )
        })}
      </div>

      {selection.mode === 'card' && (
        <div className="rpt-duel-hint">{t('duel.pickTarget')} · <button className="rpt-duel-link" onClick={playNoTarget}>▢</button></div>
      )}

      <div className="rpt-duel-hand">
        {state.piles.hand.map((cid) => {
          const { card, ability, ext } = cardOf(cid)
          const rarity = `var(${RARITY_VAR[ext.品质 ?? '普通'] ?? '--rpt-text-secondary'})`
          const picked = selection.mode === 'card' && selection.cardId === cid
          return (
            <button
              key={cid}
              className={`rpt-duel-card${picked ? ' picked' : ''}`}
              style={{ borderColor: rarity }}
              disabled={busy || over}
              onClick={() => onCardClick(cid)}
            >
              <span className="rpt-duel-card-cost">{card.energyCost}</span>
              <span className="rpt-duel-card-name">{ability?.name ?? card.abilityId}</span>
              <span className="rpt-duel-card-type" style={{ color: rarity }}>{ext.品质 ?? '普通'}</span>
              {ext.威力 != null && <span className="rpt-duel-card-power">威力 {ext.威力}</span>}
            </button>
          )
        })}
      </div>

      {over && (
        <div className="rpt-duel-overlay">
          <span className={`rpt-duel-result ${state.status === 'party' ? 'win' : 'lose'}`}>
            {state.status === 'party' ? t('duel.win') : t('duel.lose')}
          </span>
          <button className="btn-accent" onClick={() => void end(profileId)}>{t('duel.endDuel')}</button>
        </div>
      )}
    </div>
  )
}
```

> NB: confirm the `activeChatId` accessor (`useChatStore((s) => s.activeChatId)`) against `CombatView.tsx` and use the **same** store/selector it uses — do not invent one. The targeting heuristic (attack→pick enemy; otherwise play with `[]`) is v1-minimal; the engine ignores extra/missing targets safely (`playCard` validates affordability and `resolvePlay` handles targets).

- [ ] **Step 4: Add the duel CSS classes** to `src/renderer/src/assets/index.css` (after the tokens), token-only. Provide a clean, polished baseline — board grid, unit cards with HP bars + intents, a hand of cards with cost gems, selected/targetable/hover states, the win/lose overlay:

```css
.rpt-duel { display: flex; flex-direction: column; gap: 12px; height: 100%; padding: 10px; color: var(--rpt-text-primary); position: relative; }
.rpt-duel-topbar { display: flex; align-items: center; gap: 10px; }
.rpt-duel-round { font-size: 13px; color: var(--rpt-text-secondary); }
.rpt-duel-energy { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 30px; padding: 0 8px; border-radius: 15px; font-weight: 700; background: var(--rpt-duel-energy); color: var(--rpt-duel-on-energy); }
.rpt-duel-secondary { background: none; border: 1px solid var(--rpt-border); color: var(--rpt-text-secondary); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.rpt-duel-board { display: flex; flex-wrap: wrap; gap: 10px; align-content: flex-start; flex: 1; }
.rpt-duel-unit { display: flex; flex-direction: column; gap: 4px; min-width: 120px; padding: 8px; border-radius: 10px; text-align: left; cursor: default; background: var(--rpt-bg-secondary); border: 1px solid var(--rpt-border); color: var(--rpt-text-primary); }
.rpt-duel-unit.side-enemy { border-color: color-mix(in srgb, var(--rpt-danger) 40%, var(--rpt-border)); }
.rpt-duel-unit.is-lead { box-shadow: 0 0 0 2px var(--rpt-accent); }
.rpt-duel-unit.targetable { cursor: pointer; background: var(--rpt-duel-target); }
.rpt-duel-unit-name { font-weight: 700; font-size: 13px; }
.rpt-duel-hpbar { height: 7px; border-radius: 4px; background: var(--rpt-bg-tertiary); overflow: hidden; }
.rpt-duel-hpbar > i { display: block; height: 100%; background: var(--rpt-duel-hp); }
.rpt-duel-unit-hp { font-size: 11px; color: var(--rpt-text-secondary); }
.rpt-duel-intent { align-self: flex-start; font-size: 10px; padding: 1px 7px; border-radius: 9px; background: var(--rpt-bg-tertiary); }
.rpt-duel-intent.kind-attack { color: var(--rpt-duel-intent-attack); }
.rpt-duel-intent.kind-block { color: var(--rpt-duel-intent-defend); }
.rpt-duel-hint { font-size: 12px; color: var(--rpt-text-secondary); }
.rpt-duel-link { background: none; border: none; color: var(--rpt-accent); cursor: pointer; }
.rpt-duel-hand { display: flex; gap: 8px; overflow-x: auto; padding-top: 4px; }
.rpt-duel-card { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 96px; min-height: 124px; padding: 8px 6px; border-radius: 9px; text-align: center; cursor: pointer; background: var(--rpt-duel-card-bg); border: 2px solid var(--rpt-duel-card-border); color: var(--rpt-text-primary); transition: transform .08s ease, background .12s ease; }
.rpt-duel-card:hover:not(:disabled) { background: var(--rpt-duel-card-hover); transform: translateY(-3px); }
.rpt-duel-card.picked { box-shadow: 0 0 0 2px var(--rpt-duel-selected); transform: translateY(-6px); }
.rpt-duel-card:disabled { opacity: .5; cursor: default; }
.rpt-duel-card-cost { position: absolute; top: -7px; left: -6px; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; background: var(--rpt-duel-energy); color: var(--rpt-duel-on-energy); }
.rpt-duel-card-name { font-weight: 700; font-size: 13px; margin-top: 4px; }
.rpt-duel-card-type { font-size: 10px; }
.rpt-duel-card-power { font-size: 11px; color: var(--rpt-text-secondary); margin-top: auto; }
.rpt-duel-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: color-mix(in srgb, var(--rpt-bg-primary) 78%, transparent); }
.rpt-duel-result { font-size: 30px; font-weight: 800; }
.rpt-duel-result.win { color: var(--rpt-success); }
.rpt-duel-result.lose { color: var(--rpt-danger); }
```

- [ ] **Step 5: Gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/renderer/src/components/workspace/DuelView.tsx src/renderer/src/assets/index.css src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts
git commit -m "feat(duel): DuelView — polished, token-driven interactive duel UI + i18n"
```

---

## Task 5: Register the Duel view

**Files:**
- Modify: `src/renderer/src/components/workspace/viewRegistry.tsx`

- [ ] **Step 1: Add the panel wrapper + registry entry**

In `src/renderer/src/components/workspace/viewRegistry.tsx`: add `import { DuelView } from './DuelView'` beside the `CombatView` import; add a wrapper beside `CombatPanel` (line ~39):

```tsx
const DuelPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <DuelView profileId={profileId} />
}
```

and add an entry to `ViewRegistry` (after the `combat` entry, line ~72):

```tsx
  duel: { title: 'Duel', Component: DuelPanel, fill: true },
```

(`VIEW_OPTIONS` is derived from `ViewRegistry`, so the Duel view auto-appears in every panel's view-picker.)

- [ ] **Step 2: Gate + manual check**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

**Manual check** (run the app — `npm run dev`):
1. In a panel's view-picker choose **Duel** → the `DuelView` shows the empty state + "Start mock duel (debug)".
2. Click it → a duel starts: a hand of cards with cost gems, the board (主角 + 艾莉亚 + 2 哥布林) with HP bars + enemy intents, energy `3/3`.
3. Click a card → it lifts (selected); click an enemy → the card resolves (energy drops, damage shows, card leaves the hand). The `▢` plays a no-target card.
4. "End turn" → enemies act, round increments, energy refreshes, hand redraws. Play to a **Victory** / **Defeat** overlay.
5. **Cross-theme legibility:** switch theme (dark / carbon / light) — cards, HP bars, energy gems, intents, and the overlay stay readable (WCAG-AA). Fix any low-contrast token pairing.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/workspace/viewRegistry.tsx
git commit -m "feat(duel): register the Duel workspace view"
```

---

## Self-Review

**Spec coverage:** native DuelView over the pure engine, mirroring the combat stack (design §1–§2) → Tasks 1–5. Data flow / targeting (§3) → Tasks 3–4. Launch = mock button + from-MVU (§4) → Tasks 1 (`startMockDuel`/`startDuelFromMvu`), 2 (IPC), 4 (button). Theming: all colors `--rpt-*`/`--rpt-duel-*`, derived, WCAG-AA across dark/carbon/light (§5) → Task 4 (tokens + classes) + Task 5 (cross-theme check). Boundaries + headless tests (§5) → Task 1 tests + the `check:deps` gate each task. v1 non-goals (§6: no rewards/deck-edit/art/AI-trigger) → honored (none built). ✓

**Placeholder scan:** Two "confirm against real code" notes (`getLatestStatData`/`getCharacter` in Task 1; the `activeChatId` accessor in Task 4) are deliberate verification points against existing files (`duelPreviewService.ts`, `CombatView.tsx`) with the exact source named — not missing logic. All other steps show complete code. ✓

**Type consistency:** `DuelRecord`/`DuelView`/`createMockDuel`/`playCardIn`/`endTurnIn` (Task 1) ← used by IPC (Task 2). `window.api.duel*` (Task 2) ← `duelStore` (Task 3). `useDuelStore` shape + `DuelSelection` (Task 3) ← `DuelView` (Task 4). `--rpt-duel-*` tokens (Task 4 step 1) match the classes (Task 4 step 4). `duel.*` i18n keys (Task 4 step 2) match `t('duel.…')` calls (Task 4 step 3). `DuelView` props (Task 4) match `DuelPanel` (Task 5). Engine signatures (`playCard(state, cardId, targetIds[], catalog, derive)`, `endLeadTurn(state, catalog, derive)`, `startDuel(built, opts) → {state, catalog}`) used consistently. ✓

---

## Execution

Build in order (Task 1 is the tested keystone; 2–3 wire it; 4 is the polished view; 5 registers it). Each task ends green on `npm run typecheck && npm run check:deps && npm run test`; Tasks 4–5 add the manual mock-duel + cross-theme check. Execute via subagent-driven development or executing-plans.
