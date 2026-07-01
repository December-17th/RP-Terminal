# AI-authored Duel Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI generate duel-capable abilities into MVU variables, start a native STS duel from its own `<rpt-combat-start>` cue (world-fixed bundle mode), and narrate the finished duel back into the story with consequences folded into `stat_data`.

**Architecture:** Three sequenced pieces. **A (start):** a `mode: 'grid'|'duel'` flag on the card's `combat` bundle is stamped onto the stored `combat_cue`; the renderer routes "Enter" to `DuelView` vs `CombatView`; `startDuelFromCue` builds the duel from the cue roster. **B (narration):** extract grid combat's narration plumbing to a shared main `narrationService`; add a pure `buildDuelNarrationPrompt`; `duelService.narrate` mirrors `combatService.narrate` and folds MVU consequences. **C (grammar):** teach the card's `[技能装备道具生成规则]` worldbook entry the `群体`/`随机X` duel-scope tags (no app code — the parser already reads them).

**Tech Stack:** Electron (main + preload + React 19 renderer), Zustand stores, Zod schemas, Vitest, the pure `src/shared/combat` engine (grid + `deckbuilder`), MVU parser (`src/main/parsers/mvuParser.ts`).

## Global Constraints

- **Verification gate (run before declaring any task done):** `npm run typecheck && npm run check:deps && npm run test`.
- **Module boundaries (`npm run check:deps`, dependency-cruiser):** `src/shared/combat` (incl. `deckbuilder`) stays PURE — no imports of renderer, Electron, or IPC. The renderer reaches new main functions ONLY through `preload/index.ts` + IPC. Do not add eslint-disable or bypass the check.
- **i18n:** every user-facing string goes through `t('key')` and the key is added to BOTH `src/renderer/src/i18n/locales/en.ts` and `locales/zh.ts`. Use ST-ecosystem Chinese terms.
- **Default `mode` = `grid`:** a bundle with no `mode` behaves exactly as today (grid). No regression to existing grid worlds.
- **Characterization:** existing `test/combat/*` tests pin current behavior. The narration extraction (Task 4) is a pure move — grid `narrate`/`buildNarrationPrompt` behavior must be unchanged. Never delete a failing characterization test to go green.
- **SDK docs are the card contract:** Piece C changes the card-facing surface → update `docs/sdk/examples/*` in the same task.
- **Clean-room only:** never copy js-slash-runner / TavernHelper.
- **Commit** after each task with the shown message.

**Verified import paths (main services):** `getChat, appendFloor` from `./chatService`; `getAllFloors, saveFloor` from `./floorService`; `getSettings` from `./settingsService`; `getCharacter` from `./characterService`; `getRpExt`, `CombatBundle` from `../types/character`; `clone` from `../../shared/objectPath`; `parseMvuCommands, applyMvuCommands, applyJsonPatch` from `../parsers/mvuParser`; `generateRaw` from `./generationService`.

---

## File Structure

**Piece A — duel start**
- `src/main/types/character.ts` (MODIFY) — add `mode` to `CombatBundleSchema`.
- `src/main/parsers/contentParser.ts` (MODIFY) — add `mode?` to `CombatStartCue`.
- `src/main/services/generationService.ts` (MODIFY) — stamp `combatCue.mode` from the card bundle.
- `src/main/services/duelService.ts` (MODIFY) — extract `buildDuelRecord`; add `startDuelFromCue`.
- `src/main/ipc/duelIpc.ts` (MODIFY) — `duel-start-from-cue` handler.
- `src/preload/index.ts` (MODIFY) — `duelStartFromCue` bridge.
- `src/renderer/src/stores/duelStore.ts` (MODIFY) — `startFromCue` action.
- `src/renderer/src/components/ChatView.tsx` (MODIFY) — route the cue affordance by mode.
- `src/renderer/src/stores/chatStore.ts` (MODIFY) — auto-reset treats `duel` like `combat`.
- `src/renderer/src/i18n/locales/{en,zh}.ts` (MODIFY) — `combat.enterDuel`.

**Piece B — narration**
- `src/main/services/narrationService.ts` (CREATE) — extracted `narrationConfig` / `foldNarrationMvu` / `writeNarrationToChat`.
- `src/main/services/combatService.ts` (MODIFY) — import those from `narrationService`; delete the local copies.
- `src/shared/combat/deckbuilder/duelNarration.ts` (CREATE) — pure `buildDuelNarrationPrompt` + `describeDuelState`.
- `src/shared/combat/deckbuilder/index.ts` (MODIFY) — export the above.
- `src/main/services/duelService.ts` (MODIFY) — `narrate`.
- `src/main/ipc/duelIpc.ts`, `src/preload/index.ts`, `src/renderer/src/stores/duelStore.ts`, `src/renderer/src/components/workspace/DuelView.tsx`, `locales/{en,zh}.ts` (MODIFY) — wire + `duel.narrate` button.

**Piece C — grammar**
- `docs/sdk/examples/patch-poem-card.cjs` (MODIFY) — extend the `SPEC` const.
- `docs/sdk/examples/poem-item-combat-compat.md`, `docs/sdk/duel-card-authoring.md` (MODIFY) — document the two tags.
- `test/combat/duelScope.test.ts` (MODIFY) — lock the grammar↔parser contract.

**New test files:** `test/combat/combatBundleMode.test.ts`, `test/combat/duelStartFromCue.test.ts`, `test/combat/narrationService.test.ts`, `test/combat/duelNarration.test.ts`.

---

## Task 1: Bundle `mode` field + cue stamping

**Files:**
- Modify: `src/main/types/character.ts:69-120` (`CombatBundleSchema`)
- Modify: `src/main/parsers/contentParser.ts:68-72` (`CombatStartCue`)
- Modify: `src/main/services/generationService.ts:395-396`
- Test: `test/combat/combatBundleMode.test.ts`

**Interfaces:**
- Produces: `CombatBundleSchema` accepts `mode?: 'grid' | 'duel'`; `CombatStartCue` gains `mode?: 'grid' | 'duel'`; a stored `combat_cue` var now carries `mode` (`'grid'` when the bundle omits it).

- [ ] **Step 1: Write the failing test**

Create `test/combat/combatBundleMode.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CombatBundleSchema } from '../../src/main/types/character'

describe('CombatBundleSchema.mode', () => {
  it('accepts mode "duel" and "grid"', () => {
    expect(CombatBundleSchema.parse({ mode: 'duel' }).mode).toBe('duel')
    expect(CombatBundleSchema.parse({ mode: 'grid' }).mode).toBe('grid')
  })
  it('leaves mode undefined when absent (default grid behavior)', () => {
    expect(CombatBundleSchema.parse({}).mode).toBeUndefined()
  })
  it('rejects an unknown mode', () => {
    expect(() => CombatBundleSchema.parse({ mode: 'chess' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/combatBundleMode.test.ts`
Expected: FAIL — `mode` is stripped/undefined (schema doesn't declare it) so the `'duel'` assertion fails, and the unknown-mode case does not throw.

- [ ] **Step 3: Add `mode` to the schema**

In `src/main/types/character.ts`, inside `CombatBundleSchema` (after `improvise_prompt` at line ~118, before the closing `})` / `.passthrough()`):

```ts
    /** Steers the freeform-action / mid-fight-exit adjudication; overrides the user's setting. */
    improvise_prompt: z.string().optional(),
    /** Which native combat system this world's fights open: grid tactics (default) or the STS duel. */
    mode: z.enum(['grid', 'duel']).optional()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/combatBundleMode.test.ts`
Expected: PASS

- [ ] **Step 5: Add `mode` to `CombatStartCue` + stamp it**

In `src/main/parsers/contentParser.ts`, extend the interface (line 68):

```ts
export interface CombatStartCue {
  enemies: string
  map: string
  roster?: Array<Record<string, unknown>>
  /** Which system this fight opens; stamped from the card bundle at generation time (default 'grid'). */
  mode?: 'grid' | 'duel'
}
```

In `src/main/services/generationService.ts`, replace lines 395-396 (`card` is already in scope from line 121; `getRpExt` is already imported at line 50):

```ts
  const combatCue = parseCombatStart(parsed.text).cue
  if (combatCue) {
    const bundleMode = (getRpExt(card)?.combat as { mode?: 'grid' | 'duel' } | undefined)?.mode
    combatCue.mode = bundleMode === 'duel' ? 'duel' : 'grid'
    variables.combat_cue = combatCue
  }
```

- [ ] **Step 6: Verify the gate**

Run: `npm run typecheck && npm run check:deps && npx vitest run test/combat/combatBundleMode.test.ts`
Expected: typecheck PASS, check:deps PASS, test PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/types/character.ts src/main/parsers/contentParser.ts src/main/services/generationService.ts test/combat/combatBundleMode.test.ts
git commit -m "feat(duel): combat bundle mode (grid|duel) + stamp mode on combat_cue"
```

---

## Task 2: `startDuelFromCue` + pure `buildDuelRecord`

**Files:**
- Modify: `src/main/services/duelService.ts` (extract `buildDuelRecord`; add `startDuelFromCue`; import `getChat`)
- Test: `test/combat/duelStartFromCue.test.ts`

**Interfaces:**
- Consumes: `buildEncounterFromMvu`, `startDuel`, `poemD20System`, `DuelRecord`, `StatMap`, `DeriveConfig` (already imported in duelService).
- Produces: `buildDuelRecord(statData, statMap, derive, roster, seed=7): DuelRecord`; `startDuelFromCue(profileId, chatId, cue): DuelView | null` — builds the party from `stat_data` + enemies from `cue.roster`.

- [ ] **Step 1: Write the failing test**

Create `test/combat/duelStartFromCue.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildDuelRecord } from '../../src/main/services/duelService'
import type { StatMap, DeriveConfig } from '../../src/shared/combat/bundle'

const STAT_MAP: StatMap = {
  player: '主角',
  party: { from: '关系列表', filter: { 在场: true } },
  paths: {
    attributes: '属性', hp: '生命值', maxHp: '生命值上限', mp: '法力值', maxMp: '法力值上限',
    sp: '体力值', maxSp: '体力值上限', level: '等级', tier: '生命层级', equipment: '装备',
    skills: '技能', conditions: '状态效果'
  }
}
const DERIVE: DeriveConfig = {
  attributes: ['力量', '敏捷', '体质', '智力', '精神'],
  tier_coefficient: { '1': 2, '2': 2.8 },
  hp_multiplier: { '1': 1, '2': 2 },
  mp_sp_multiplier: { '1': 1, '2': 2.5 },
  rating_tiers: [[11, 1], [0, 0]],
  attr_mitigation: { 物理: 0.0025, 能量: 0.004, 精神: 0.008, 真实: 0 },
  defense_constant: 2000
}
const STAT_DATA = {
  主角: {
    属性: { 力量: 6, 敏捷: 5, 体质: 7, 智力: 3, 精神: 4 },
    生命值: 1400, 生命值上限: 1400, 法力值: 700, 法力值上限: 700, 体力值: 1100, 体力值上限: 1100,
    等级: 8, 生命层级: '第二层级/优良', 装备: {}, 技能: {}, 状态效果: {}
  },
  关系列表: {}
}
const ROSTER = [{
  名称: '哥布林', 数量: 2, 生命层级: '第一层级', 等级: 3,
  属性: { 力量: 4, 敏捷: 3, 体质: 4, 智力: 1, 精神: 1 },
  装备: { 爪牙: { 类型: '天生武器', 标签: ['攻击: 25'], 效果: {} } }, 技能: {}, 状态效果: {}
}]

describe('buildDuelRecord', () => {
  it('builds an active duel with enemies from the roster and a party from stat_data', () => {
    const rec = buildDuelRecord(STAT_DATA as Record<string, unknown>, STAT_MAP, DERIVE, ROSTER)
    expect(rec.state.status).toBe('active')
    expect(rec.state.combatants.some((c) => c.side === 'enemy' && c.block.hp > 0)).toBe(true)
    expect(rec.state.combatants.some((c) => c.side === 'party' && c.block.hp > 0)).toBe(true)
    expect(rec.state.piles.hand.length).toBe(rec.state.handSize)
  })
  it('with no roster builds a party-only (enemyless) encounter', () => {
    const rec = buildDuelRecord(STAT_DATA as Record<string, unknown>, STAT_MAP, DERIVE, undefined)
    expect(rec.state.combatants.some((c) => c.side === 'enemy')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/duelStartFromCue.test.ts`
Expected: FAIL — `buildDuelRecord` is not exported ("does not provide an export named 'buildDuelRecord'").

- [ ] **Step 3: Extract `buildDuelRecord` and reuse it**

In `src/main/services/duelService.ts`, add `getChat` to the character-service import area and add the helper. First extend imports:

```ts
import { getCharacter } from './characterService'
import { getChat } from './chatService'
```

Add the pure builder (place it just above `createMockDuel`, after `getLatestStatData`):

```ts
/** Build a duel record from an MVU stat_data build + an optional AI enemy roster.
 *  Shared by the mock, the from-chat build, and the cue-driven start. */
export const buildDuelRecord = (
  statData: Record<string, unknown>,
  statMap: StatMap,
  derive: DeriveConfig | undefined,
  roster: Array<Record<string, unknown>> | undefined,
  seed = 7
): DuelRecord => {
  const built = buildEncounterFromMvu(statData, statMap, poemD20System, { derive, seed, roster })
  const { state, catalog } = startDuel(built, { seed })
  return { state, catalog, derive }
}
```

Refactor `createMockDuel` to use it:

```ts
export const createMockDuel = (): DuelRecord =>
  buildDuelRecord(MOCK_STAT_DATA as Record<string, unknown>, MOCK_STAT_MAP, MOCK_DERIVE, MOCK_ROSTER)
```

Refactor `startDuelFromMvu`'s build to reuse it (keep its signature + guards; replace the two build lines):

```ts
  if (!statData || !bundle?.stat_map) return null
  const rec = buildDuelRecord(statData, bundle.stat_map, bundle.derive, undefined)
  duels.set(chatId, rec)
  return view(rec)
```

- [ ] **Step 4: Add `startDuelFromCue`**

Append to `src/main/services/duelService.ts`:

```ts
/** Start a duel from the AI's <rpt-combat-start> cue: party from the current stat_data build,
 *  enemies from the cue roster. Mirrors combatService.startFromCard (chat → card → combat bundle). */
export const startDuelFromCue = (
  profileId: string,
  chatId: string,
  cue?: { roster?: Array<Record<string, unknown>> } | null
): DuelView | null => {
  const statData = getLatestStatData(profileId, chatId)
  const chat = getChat(profileId, chatId)
  const character = chat ? getCharacter(profileId, chat.character_id) : null
  const bundle = (character ? getRpExt(character)?.combat : null) as
    | { stat_map?: StatMap; derive?: DeriveConfig }
    | null
    | undefined
  if (!statData || !bundle?.stat_map) return null
  const rec = buildDuelRecord(statData, bundle.stat_map, bundle.derive, cue?.roster)
  duels.set(chatId, rec)
  return view(rec)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/combat/duelStartFromCue.test.ts test/combat/duelService.test.ts`
Expected: PASS (both the new test and the existing mock test — `createMockDuel` still behaves identically).

- [ ] **Step 6: Verify the gate**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/duelService.ts test/combat/duelStartFromCue.test.ts
git commit -m "feat(duel): buildDuelRecord + startDuelFromCue (party from MVU, enemies from cue roster)"
```

---

## Task 3: Wire duel start end-to-end (IPC → preload → store → ChatView)

**Files:**
- Modify: `src/main/ipc/duelIpc.ts`, `src/preload/index.ts`, `src/renderer/src/stores/duelStore.ts`, `src/renderer/src/components/ChatView.tsx`, `src/renderer/src/stores/chatStore.ts:106`, `src/renderer/src/i18n/locales/en.ts:454`, `src/renderer/src/i18n/locales/zh.ts`

**Interfaces:**
- Consumes: `duelService.startDuelFromCue` (Task 2); `combatCue.mode` on the stored cue (Task 1); the `duel` view already registered in `viewRegistry.tsx:79`.
- Produces: `window.api.duelStartFromCue(profileId, chatId, cue)`; `useDuelStore().startFromCue(profileId, chatId, cue)`; ChatView routes the "Enter" affordance to duel when `combatCue.mode === 'duel'`.

This task is renderer + IPC wiring (no new pure unit) — the gate is `typecheck + check:deps + build`.

- [ ] **Step 1: IPC handler**

In `src/main/ipc/duelIpc.ts`, add after the `duel-start` handler (line 13):

```ts
  ipcMain.handle('duel-start-from-cue', (_, profileId, chatId, cue) =>
    duelService.startDuelFromCue(profileId, chatId, cue)
  )
```

- [ ] **Step 2: Preload bridge**

In `src/preload/index.ts`, add after `duelStart` (line 229):

```ts
  duelStartFromCue: (profileId: string, chatId: string, cue: unknown) =>
    ipcRenderer.invoke('duel-start-from-cue', profileId, chatId, cue),
```

- [ ] **Step 3: Store action**

In `src/renderer/src/stores/duelStore.ts`, add to the interface (after `startFromBuild`, line 19):

```ts
  startFromCue: (profileId: string, chatId: string, cue: unknown) => Promise<void>
```

and the implementation (after `startFromBuild`, line 59):

```ts
    startFromCue: async (profileId, chatId, cue) => {
      const res = await api().duelStartFromCue(profileId, chatId, cue)
      set({ chatId, state: res?.state ?? null, catalog: res?.catalog ?? {}, selection: { mode: 'idle' } })
    },
```

- [ ] **Step 4: Route the ChatView affordance by mode**

In `src/renderer/src/components/ChatView.tsx`, widen the `combatCue` type (line 183-186) and route `enterCombat` (line 187-197):

```ts
  const combatCue =
    latestVars && typeof latestVars.combat_cue === 'object' && latestVars.combat_cue
      ? (latestVars.combat_cue as { enemies?: string; map?: string; roster?: unknown; mode?: 'grid' | 'duel' })
      : null
  const enterCombat = async (): Promise<void> => {
    if (!activeChatId) return
    try {
      if (combatCue?.mode === 'duel') {
        await window.api.duelStartFromCue(profileId, activeChatId, combatCue)
        useChatStore.getState().setMode(profileId, 'duel')
      } else {
        await window.api.combatStartFromCard(profileId, activeChatId, combatCue)
        useChatStore.getState().setMode(profileId, 'combat')
      }
    } catch (e) {
      console.error('Enter combat/duel failed:', e)
    }
  }
```

Update the affordance block (line 258-278): hide it in `duel` mode too, and label by mode:

```tsx
      {combatCue && activeChatMode !== 'combat' && activeChatMode !== 'duel' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '6px 10px',
            margin: '6px 0',
            borderRadius: 6,
            border: '1px solid var(--rpt-accent, #5b8def)',
            background: 'var(--rpt-accent-soft, rgba(91,141,239,0.12))',
            fontSize: 13
          }}
        >
          <span>{t('combat.cueDetected')}</span>
          <button className="btn-accent" style={{ fontSize: 12 }} onClick={enterCombat}>
            ⚔ {combatCue.mode === 'duel' ? t('combat.enterDuel') : t('combat.enter')}
          </button>
        </div>
      ) : null}
```

- [ ] **Step 5: chatStore auto-reset covers `duel`**

In `src/renderer/src/stores/chatStore.ts` line 106, replace:

```ts
    if (get().activeChatMode === 'combat' || get().activeChatMode === 'duel')
      void get().setMode(profileId, 'explore')
```

- [ ] **Step 6: i18n key**

In `src/renderer/src/i18n/locales/en.ts` (after `'combat.enter'`, line 454):

```ts
  'combat.enterDuel': 'Enter Duel',
```

In `src/renderer/src/i18n/locales/zh.ts` (next to the matching `combat.enter` key):

```ts
  'combat.enterDuel': '进入对决',
```

- [ ] **Step 7: Verify the gate + build**

Run: `npm run typecheck && npm run check:deps && npm run build`
Expected: all PASS (build confirms the renderer + preload compile).

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc/duelIpc.ts src/preload/index.ts src/renderer/src/stores/duelStore.ts src/renderer/src/components/ChatView.tsx src/renderer/src/stores/chatStore.ts src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts
git commit -m "feat(duel): route <rpt-combat-start> to DuelView when combat.mode='duel'"
```

---

## Task 4: Extract shared narration plumbing to `narrationService`

**Files:**
- Create: `src/main/services/narrationService.ts`
- Modify: `src/main/services/combatService.ts` (import from `narrationService`; delete the three local functions)
- Test: `test/combat/narrationService.test.ts`

**Interfaces:**
- Produces: `narrationConfig(profileId, chatId): { extra: string; mode: 'append' | 'floor' }`; `foldNarrationMvu(variables: Record<string, any>, text: string): void`; `writeNarrationToChat(profileId, chatId, prose: string): void` — all exported from `narrationService`, behavior identical to the current `combatService` privates.

- [ ] **Step 1: Write the failing test**

Create `test/combat/narrationService.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { foldNarrationMvu } from '../../src/main/services/narrationService'

describe('foldNarrationMvu', () => {
  it('applies a <JSONPatch> insert into stat_data', () => {
    const vars: Record<string, any> = {}
    foldNarrationMvu(
      vars,
      '战后。<UpdateVariable><JSONPatch>[{"op":"insert","path":"/主角/技能/剑气斩","value":{"类型":"主动"}}]</JSONPatch></UpdateVariable>'
    )
    expect(vars.stat_data.主角.技能.剑气斩).toEqual({ 类型: '主动' })
  })
  it('is a no-op when there is no UpdateVariable block', () => {
    const vars: Record<string, any> = { stat_data: { 主角: {} } }
    foldNarrationMvu(vars, 'just prose, no ops')
    expect(vars.stat_data).toEqual({ 主角: {} })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/narrationService.test.ts`
Expected: FAIL — `narrationService` module does not exist yet.

- [ ] **Step 3: Create `narrationService.ts` (move the three functions verbatim)**

Create `src/main/services/narrationService.ts`:

```ts
// Shared post-combat narration plumbing (grid combat + STS duel). Extracted from combatService so
// both native combat modes narrate + fold MVU consequences identically ("one surface"). Text/prompt
// builders live in shared/combat (pure); THIS module does the model-agnostic chat write + MVU fold.

import { appendFloor, getChat } from './chatService'
import { getAllFloors, saveFloor } from './floorService'
import { getSettings } from './settingsService'
import { getCharacter } from './characterService'
import { getRpExt, type CombatBundle } from '../types/character'
import { clone } from '../../shared/objectPath'
import { parseMvuCommands, applyMvuCommands, applyJsonPatch } from '../parsers/mvuParser'

/** Fold a narration response's `<UpdateVariable>` / `<JSONPatch>` consequences into a
 *  floor's `stat_data` (mirrors generate()'s fold), so injuries/deaths/loot persist. */
export const foldNarrationMvu = (variables: Record<string, any>, text: string): void => {
  const mvu = parseMvuCommands(text)
  if (!mvu.commands.length && !mvu.patches.length) return
  if (typeof variables.stat_data !== 'object' || variables.stat_data === null)
    variables.stat_data = {}
  const sd = variables.stat_data as Record<string, any>
  if (mvu.commands.length) applyMvuCommands(sd, mvu.commands)
  if (mvu.patches.length) applyJsonPatch(sd, mvu.patches)
}

/** Resolve the narration prompt + placement, honoring (in order) the card's `combat` bundle
 *  (`narration_prompt` / `narration_mode`), the user's `settings.combat`, then the defaults. */
export const narrationConfig = (
  profileId: string,
  chatId: string
): { extra: string; mode: 'append' | 'floor' } => {
  const chat = getChat(profileId, chatId)
  const card = chat ? getCharacter(profileId, chat.character_id) : null
  const bundle = (card ? getRpExt(card)?.combat : null) as
    | (CombatBundle & { narration_prompt?: string; narration_mode?: string })
    | null
    | undefined
  const sCombat = getSettings(profileId).combat
  const extra = (bundle?.narration_prompt || sCombat?.narrationPrompt || '').trim()
  const mode: 'append' | 'floor' =
    (bundle?.narration_mode || sCombat?.narrationMode) === 'floor' ? 'floor' : 'append'
  return { extra, mode }
}

/** Land combat/duel prose in the chat — appended to the current floor or as a new floor (the
 *  user/card placement setting) — folding any `<UpdateVariable>` consequences into that floor's
 *  stat_data. */
export const writeNarrationToChat = (profileId: string, chatId: string, prose: string): void => {
  const chat = getChat(profileId, chatId)
  if (!prose || !chat) return
  const { mode } = narrationConfig(profileId, chatId)
  const floors = getAllFloors(profileId, chatId)
  const now = new Date().toISOString()
  if (mode === 'floor' || !floors.length) {
    const variables = clone(floors[floors.length - 1]?.variables ?? {}) as Record<string, any>
    foldNarrationMvu(variables, prose)
    appendFloor(profileId, chatId, {
      floor: floors.length,
      chat_id: chatId,
      timestamp: now,
      user_message: { content: '', timestamp: now },
      response: { content: prose, model: '', provider: '' },
      events: [],
      variables
    })
  } else {
    const last = floors[floors.length - 1]
    last.response = { ...last.response, content: `${last.response.content}\n\n${prose}`.trim() }
    const variables = (last.variables ?? {}) as Record<string, any>
    foldNarrationMvu(variables, prose)
    last.variables = variables
    saveFloor(profileId, chatId, last)
  }
}
```

- [ ] **Step 4: Point combatService at the extracted module**

In `src/main/services/combatService.ts`: delete the three local definitions `foldNarrationMvu` (lines 550-560), `narrationConfig` (562-580), and `writeNarrationToChat` (594-623) — leave `improviseSteer` (582-592) in place. Add an import near the other service imports (line ~17):

```ts
import { narrationConfig, foldNarrationMvu, writeNarrationToChat } from './narrationService'
```

Then remove any now-unused imports from combatService that were *only* used by the moved functions (run `npm run typecheck` — TS will flag unused imports; delete exactly those it flags, e.g. `getSettings`, `saveFloor`, `appendFloor`, or `clone` if nothing else references them). Do NOT remove imports the remaining code still uses.

- [ ] **Step 5: Run test + characterization**

Run: `npx vitest run test/combat/narrationService.test.ts test/combat/combatService.test.ts`
Expected: PASS — the new fold test passes and the existing combatService characterization is unchanged.

- [ ] **Step 6: Verify the gate**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/narrationService.ts src/main/services/combatService.ts test/combat/narrationService.test.ts
git commit -m "refactor(combat): extract shared narrationService (config/fold/write)"
```

---

## Task 5: Pure `buildDuelNarrationPrompt`

**Files:**
- Create: `src/shared/combat/deckbuilder/duelNarration.ts`
- Modify: `src/shared/combat/deckbuilder/index.ts` (export)
- Test: `test/combat/duelNarration.test.ts`

**Interfaces:**
- Consumes: `DuelState` from `./deckTypes`; `Combatant` from `../types`.
- Produces: `buildDuelNarrationPrompt(state: DuelState, extra?: string): string`; `describeDuelState(state: DuelState): string`. Pure (text in, string out).

- [ ] **Step 1: Write the failing test**

Create `test/combat/duelNarration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildDuelNarrationPrompt } from '../../src/shared/combat/deckbuilder'
import type { DuelState } from '../../src/shared/combat/deckbuilder'

const base = (status: DuelState['status']): DuelState => ({
  seed: 1, rngCursor: 0, lead: 'p1',
  combatants: [
    { id: 'p1', name: '主角', side: 'party', pos: [0, 0], block: { hp: 800, maxHp: 1400, conditions: [], abilities: [] } } as any,
    { id: 'e1', name: '哥布林', side: 'enemy', pos: [0, 0], block: { hp: 0, maxHp: 120, conditions: [], abilities: [] } } as any
  ],
  energy: { current: 1, max: 3 },
  piles: { draw: [], hand: [], discard: [], exhaust: [] },
  cards: {}, intents: {}, phase: 'lead', round: 4, status, log: [{ kind: 'info', text: '主角 击败 哥布林' } as any], handSize: 5
})

describe('buildDuelNarrationPrompt', () => {
  it('maps party win / enemy win / active to the right outcome line', () => {
    expect(buildDuelNarrationPrompt(base('party'))).toContain('The party won.')
    expect(buildDuelNarrationPrompt(base('enemy'))).toContain('The party was defeated.')
    expect(buildDuelNarrationPrompt(base('active'))).toContain('broke off unresolved')
  })
  it('includes the blow-by-blow log and the UpdateVariable instruction', () => {
    const p = buildDuelNarrationPrompt(base('party'))
    expect(p).toContain('主角 击败 哥布林')
    expect(p).toContain('<UpdateVariable>')
  })
  it('inserts the steering prompt when provided', () => {
    expect(buildDuelNarrationPrompt(base('party'), 'Keep it grim.')).toContain('Keep it grim.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/duelNarration.test.ts`
Expected: FAIL — no export `buildDuelNarrationPrompt`.

- [ ] **Step 3: Implement the pure prompt builder**

Create `src/shared/combat/deckbuilder/duelNarration.ts`:

```ts
// Pure end-of-duel narration prompt (STS mode). Mirrors serialize.ts buildNarrationPrompt for grid
// combat, but reads DuelState (no grid) — outcome + steering + final combatant state + blow-by-blow
// log + the "record consequences in <UpdateVariable>" instruction. Text in, string out.

import type { DuelState } from './deckTypes'
import type { Combatant } from '../types'

const describeDuelCombatant = (c: Combatant): string => {
  const conds = c.block.conditions.length
    ? ` [${c.block.conditions.map((x) => x.id).join(',')}]`
    : ''
  const down = c.block.hp <= 0 ? ' (down)' : ''
  return `- ${c.id} "${c.name}" (${c.side}) HP ${c.block.hp}/${c.block.maxHp}${conds}${down}`
}

/** A compact end-of-duel board description for the narration prompt. */
export const describeDuelState = (state: DuelState): string => {
  const lines = state.combatants.map(describeDuelCombatant).join('\n')
  return `Card duel — round ${state.round}, lead energy ${state.energy.current}/${state.energy.max}.\nCombatants:\n${lines}`
}

/** Prompt the AI to narrate the resolved duel and fold lasting consequences into MVU. `extra` is the
 *  author/user steering prompt (card `narration_prompt` or the user setting). */
export const buildDuelNarrationPrompt = (state: DuelState, extra?: string): string => {
  const log = state.log.map((e) => `- ${e.text}`).join('\n')
  const result =
    state.status === 'party'
      ? 'The party won.'
      : state.status === 'enemy'
        ? 'The party was defeated.'
        : 'The fight broke off unresolved.'
  const lines = [
    'Narrate the following resolved card duel as vivid prose continuing the story.',
    `Outcome: ${result}`
  ]
  if (extra && extra.trim()) lines.push('', extra.trim())
  lines.push(
    '',
    describeDuelState(state),
    '',
    'Blow-by-blow log:',
    log,
    '',
    'After the prose, record the lasting consequences (injuries, deaths, spent resources, loot)',
    'as variable updates in an <UpdateVariable> block, per this world’s schema.'
  )
  return lines.join('\n')
}
```

- [ ] **Step 4: Export from the deckbuilder barrel**

In `src/shared/combat/deckbuilder/index.ts`, add:

```ts
export { buildDuelNarrationPrompt, describeDuelState } from './duelNarration'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/combat/duelNarration.test.ts`
Expected: PASS

- [ ] **Step 6: Verify the gate (check:deps proves purity)**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: all PASS (check:deps confirms `shared/combat` still imports no renderer/main/electron).

- [ ] **Step 7: Commit**

```bash
git add src/shared/combat/deckbuilder/duelNarration.ts src/shared/combat/deckbuilder/index.ts test/combat/duelNarration.test.ts
git commit -m "feat(duel): pure buildDuelNarrationPrompt (mirrors grid narration prompt)"
```

---

## Task 6: `duelService.narrate` + IPC/store/DuelView button

**Files:**
- Modify: `src/main/services/duelService.ts` (`narrate`), `src/main/ipc/duelIpc.ts`, `src/preload/index.ts`, `src/renderer/src/stores/duelStore.ts`, `src/renderer/src/components/workspace/DuelView.tsx`, `locales/{en,zh}.ts`

**Interfaces:**
- Consumes: `narrationConfig`, `writeNarrationToChat` (Task 4); `buildDuelNarrationPrompt` (Task 5); `generateRaw` from `./generationService`.
- Produces: `duelService.narrate(profileId, chatId): Promise<{ narration: string; mode: 'append' | 'floor' } | null>`; `window.api.duelNarrate`; `useDuelStore().narrate(profileId)`; a "Narrate Outcome" button in the DuelView win/lose overlay.

This task's model-calling `narrate` isn't unit-tested (its pure parts are covered by Tasks 4 + 5); the gate is `typecheck + check:deps + build + test`.

- [ ] **Step 1: `narrate` in duelService**

In `src/main/services/duelService.ts`, add imports:

```ts
import { generateRaw } from './generationService'
import { narrationConfig, writeNarrationToChat } from './narrationService'
import { startDuel, playCard, endLeadTurn, buildDuelNarrationPrompt, type DuelState } from '../../shared/combat/deckbuilder'
```

(the third line replaces the existing `deckbuilder` import — it just adds `buildDuelNarrationPrompt`.)

Add the function (near `endDuel`):

```ts
/** End-of-duel narration: ask the model to narrate the resolved duel (steered by the card/user
 *  prompt) and land the prose in the chat, folding <UpdateVariable> consequences into stat_data.
 *  Mirrors combatService.narrate. Returns null if there's no active duel for this chat. */
export const narrate = async (
  profileId: string,
  chatId: string
): Promise<{ narration: string; mode: 'append' | 'floor' } | null> => {
  const rec = duels.get(chatId)
  if (!rec) return null
  const { extra, mode } = narrationConfig(profileId, chatId)
  const prose = (
    await generateRaw(profileId, chatId, {
      userInput: buildDuelNarrationPrompt(rec.state, extra),
      maxChatHistory: 6
    })
  ).trim()
  writeNarrationToChat(profileId, chatId, prose)
  return { narration: prose, mode }
}
```

- [ ] **Step 2: IPC + preload**

In `src/main/ipc/duelIpc.ts`, add (before `duel-end`):

```ts
  ipcMain.handle('duel-narrate', async (_, profileId, chatId) => {
    try {
      return await duelService.narrate(profileId, chatId)
    } catch (err: any) {
      logService.log('error', '✗ duel-narrate failed', err?.message || String(err))
      throw err
    }
  })
```

In `src/preload/index.ts`, add after `duelEndTurn` (line 233):

```ts
  duelNarrate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-narrate', profileId, chatId),
```

- [ ] **Step 3: Store action**

In `src/renderer/src/stores/duelStore.ts`, add to the interface (after `end`, line 24):

```ts
  narrate: (profileId: string) => Promise<void>
```

and the implementation (after `end`, before the closing `}` of the returned object):

```ts
    narrate: async (profileId) => {
      const { chatId } = get()
      if (!chatId) return
      set({ busy: true })
      try {
        await api().duelNarrate(profileId, chatId)
      } finally {
        set({ busy: false })
        await get().end(profileId) // clear the duel + return to chat after narrating
      }
    }
```

(Add a comma after the existing `end` action's closing brace so the object stays valid.)

- [ ] **Step 4: DuelView button**

In `src/renderer/src/components/workspace/DuelView.tsx`, pull `narrate` from the store next to `end` (near line 40):

```ts
  const narrate = useDuelStore((s) => s.narrate)
```

Add the button to the win/lose overlay (line 328-336), before the existing end button:

```tsx
        {over && (
          <div className="rpt-duel-overlay">
            <span className={`rpt-duel-result ${state.status === 'party' ? 'win' : 'lose'}`}>
              {state.status === 'party' ? t('duel.win') : t('duel.lose')}
            </span>
            <button className="btn-accent" disabled={busy} onClick={() => void narrate(profileId)}>
              {t('duel.narrate')}
            </button>
            <button className="rpt-duel-secondary" onClick={() => void end(profileId)}>
              {t('duel.endDuel')}
            </button>
```

- [ ] **Step 5: i18n keys**

In `src/renderer/src/i18n/locales/en.ts`, next to the other `duel.*` keys:

```ts
  'duel.narrate': 'Narrate Outcome',
```

In `src/renderer/src/i18n/locales/zh.ts`:

```ts
  'duel.narrate': '战后叙事',
```

- [ ] **Step 6: Verify the gate + build**

Run: `npm run typecheck && npm run check:deps && npm run test && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/duelService.ts src/main/ipc/duelIpc.ts src/preload/index.ts src/renderer/src/stores/duelStore.ts src/renderer/src/components/workspace/DuelView.tsx src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts
git commit -m "feat(duel): post-duel narration + MVU fold-back (narrate button + IPC)"
```

---

## Task 7: Lorebook grammar — teach the 群体/随机X duel-scope tags

**Files:**
- Modify: `docs/sdk/examples/patch-poem-card.cjs:47-53` (the `SPEC` const)
- Modify: `docs/sdk/examples/poem-item-combat-compat.md`, `docs/sdk/duel-card-authoring.md`
- Test: `test/combat/duelScope.test.ts` (add a grammar-contract guard)

**Interfaces:**
- Consumes: the parser `parseCardItem` in `src/shared/combat/systems/poemD20.ts:129-133`, which already maps `群体|群|全体|AOE` → `目标模式:'群体'` and `随机X`/`随机:X`/`随机` → `目标模式:'随机'` + `随机次数`.
- Produces: the card's `[技能装备道具生成规则]` worldbook entry (via the regenerated PNG) documents the duel-scope tags so the AI authors them.

- [ ] **Step 1: Write the failing (contract-guard) test**

Add to `test/combat/duelScope.test.ts` (import `parseCardItem` if not already imported: `import { parseCardItem } from '../../src/shared/combat/systems/poemD20'`):

```ts
describe('duel-scope grammar tags (lorebook ↔ parser contract)', () => {
  it('parses 群体 → 目标模式 群体', () => {
    const c = parseCardItem({ 类型: '主动', 标签: ['力量', '威力: 90', '群体'], 效果: {} }, 'skill')
    expect(c.目标模式).toBe('群体')
  })
  it('parses 随机3 → 目标模式 随机 with 随机次数 3', () => {
    const c = parseCardItem({ 类型: '主动', 标签: ['敏捷', '威力: 40', '随机3'], 效果: {} }, 'skill')
    expect(c.目标模式).toBe('随机')
    expect(c.随机次数).toBe(3)
  })
  it('a skill with no scope tag stays single-target (目标模式 undefined → 单体)', () => {
    const c = parseCardItem({ 类型: '主动', 标签: ['力量', '威力: 90'], 效果: {} }, 'skill')
    expect(c.目标模式).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/combat/duelScope.test.ts`
Expected: PASS immediately (the parser already supports these tags — this test guards the contract the grammar edit relies on). If it FAILS, stop: the parser regressed and Piece C's premise is broken — fix the parser first.

- [ ] **Step 3: Extend the `SPEC` const**

In `docs/sdk/examples/patch-poem-card.cjs`, replace the `SPEC` const (lines 47-53) — add the duel-target-mode bullet as the new last line before the closing backtick:

```js
const SPEC = `
<战斗数据规范>
- 技能标签中「威力」必须为具体数值（参照<核心数值表>），如「威力: 300」，不得写品质词。
- 每个主动技能/武器必须带「有效距离: X」（格数）；范围技能额外带「范围: [爆发/直线/锥形/单体/范围:X]」。
- 装备战斗数值用「攻击: N」「防御: N」；技能消耗用「消耗: 攻击/动作: X MP/SP」；关联属性用五维之一作为独立标签。
- 战斗类效果优先用规范效果名作为键（命中/闪避/固伤/伤害增幅/减伤增幅/护盾/穿透/暴击倍率/治疗/治疗增幅/附加效果），数值写在值里；若沿用风味名（如「充能」），须在值描述中写明机制（如「提高12%伤害」「获得50点护盾」「额外造成5点伤害」），以便系统解析。
- 【决斗目标模式】主动技能可在标签中额外声明卡牌决斗的目标范围：默认「单体」；加「群体」= AOE（打全体敌方 / 治疗全体友方）；加「随机X」= 随机 X 次打击（可重复命中，如「随机3」）。治疗技同理，由效果决定作用于友方。此标签仅用于决斗模式，与网格战斗的「范围: [爆发/直线/锥形]」互不冲突。
</战斗数据规范>`
```

- [ ] **Step 4: Regenerate the card PNG**

Run: `node docs/sdk/examples/patch-poem-card.cjs`
Expected output includes `战斗数据规范: appended to 技能装备道具生成规则` (first run) or `战斗数据规范: already present` if a prior `+combat` PNG already had the block — in the "already present" case the new bullet is NOT re-appended; if so, regenerate from the pristine `v4.2.1.png` by ensuring the input is the un-patched card (the script reads `v4.2.1.png` and writes `v4.2.1+combat.png`; delete a stale `v4.2.1+combat.png` first so the block is rebuilt with the new bullet). Confirm the printed card log ends without errors.

Note: the PNG is an untracked binary artifact — it is NOT committed. `patch-poem-card.cjs` is the reproducible record.

- [ ] **Step 5: Document the tags in the SDK**

In `docs/sdk/examples/poem-item-combat-compat.md`, add to the effect/tag reference a short subsection stating that a duel skill's 标签 may include `群体` (AOE — all enemies / all allies for heals) or `随机X` (X random hits, with replacement), default 单体; these are duel-mode only and do not collide with the grid `范围` shapes.

In `docs/sdk/duel-card-authoring.md`, add the same two tags to the authoring reference with one example skill each (a `群体` damage skill and a `随机3` skill), noting the AI writes them via `<UpdateVariable><JSONPatch>` `insert` into `/主角/技能/<名>`.

- [ ] **Step 6: Verify the gate**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: all PASS (the new duelScope contract test included).

- [ ] **Step 7: Commit**

```bash
git add docs/sdk/examples/patch-poem-card.cjs docs/sdk/examples/poem-item-combat-compat.md docs/sdk/duel-card-authoring.md test/combat/duelScope.test.ts
git commit -m "docs(duel): teach 群体/随机X duel-scope tags in the ability-generation grammar"
```

---

## Self-Review

**1. Spec coverage:**
- §2 Piece A (bundle mode, cue stamp, renderer routing, roster consume, touch-ups) → Tasks 1–3. ✓
- §3 Piece B (extract narration plumbing, pure duel prompt, service+IPC+UI, fold-back) → Tasks 4–6. ✓
- §4 Piece C (grammar edit, regenerate, SDK docs) → Task 7. ✓
- §5 end-to-end flow → the composition of Tasks 1–7. ✓
- §6 boundaries/tests → each task ends with the `check:deps` + vitest gate; `buildDuelNarrationPrompt` purity proven by check:deps in Task 5. ✓
- §6 non-goals (rewards UI, cue/player mode, enemy AoE telegraph, agentic narration) → not implemented, consistent with the plan. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The one conditional (Task 7 Step 4 "already present") gives an explicit recovery action, not a placeholder.

**3. Type consistency:** `buildDuelRecord(statData, statMap, derive, roster, seed?)` defined in Task 2, used in Task 2 only. `startDuelFromCue(profileId, chatId, cue)` defined Task 2, wired Task 3. `narrationConfig`/`foldNarrationMvu`/`writeNarrationToChat` defined Task 4, consumed Task 6. `buildDuelNarrationPrompt(state, extra?)` defined Task 5, consumed Task 6. `narrate` returns `{ narration, mode } | null` consistently (service Task 6). `combat.enterDuel` (Task 3) and `duel.narrate` (Task 6) keys added to both locales. `combatCue.mode` set in Task 1, read in Task 3. All consistent.
