# DuelView "real game" juice pass (Plan A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the functional v1 `DuelView` into a real-card-game experience — TCG-frame cards with importable faces, a Slay-the-Spire board, importable enemy avatars + fight background, and a CSS/auto-animate juice layer.

**Architecture:** Renderer-only. Rewrite `DuelView.tsx` (extracting a `DuelCard.tsx`), expand the `--rpt-duel-*` tokens + `.rpt-duel-*` CSS in `index.css`, add `@formkit/auto-animate` for hand enter/leave/reorder, reuse the existing CombatView floating-number pattern, and resolve importable art via the existing `window.api.assetUrl(...)` + World Assets types (`立绘`/`头像`/`背景`) with fallbacks. **No engine/service/IPC/store/main changes** — the `duelStore` already exposes `state` + `lastEvents`/`eventSeq`.

**Tech Stack:** React 19 + zustand (renderer), CSS keyframes/transitions, `@formkit/auto-animate` (MIT, ~2 KB). No motion library in the native view.

This is **Plan A** of [2026-06-30-duelview-juice-design.md](../specs/2026-06-30-duelview-juice-design.md). Plan B (`motion` as a card-env lib) is separate: [2026-06-30-card-motion-lib.md](2026-06-30-card-motion-lib.md).

## Global Constraints

- **Theme tokens only — no hardcoded colors.** Every color is `var(--rpt-*)` / `var(--rpt-duel-*)`; new tokens are `color-mix` from base tokens in `assets/index.css :root`, legible across **dark / carbon / light** (`src/renderer/src/theme.ts`), WCAG-AA per the contrast rule.
- **i18n** every user-facing string via `t()` (both `locales/en.ts` + `zh.ts`). (The v1 already added the `duel.*` keys; add any new ones to both.)
- **Importable assets are optional, with fallbacks.** Card face (`立绘` by ability name), enemy avatar (`头像` by name), fight background (`背景`). Resolve via `window.api.assetUrl`; `null` → fallback (type glyph / tinted foe unit / gradient battlefield). The view ships pretty with zero art.
- **No engine/service/store/main change.** Renderer-only (`DuelView.tsx`, new `DuelCard.tsx`, `index.css`, `package.json` for the dep). `npm run check:deps` stays green (no new boundary crossings — the view already reaches main only via `window.api`).
- **Verification gate (each task):** `npm run typecheck && npm run check:deps && npm run test`. Tasks 2-4 add a **manual** check via the mock-duel button, including a **cross-theme (dark/carbon/light) legibility pass**. (Juice is verified visually, not by unit tests; pixel values in the CSS below are a working starting point to tune in that pass.)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json` (modify) | add `@formkit/auto-animate` dependency |
| `src/renderer/src/components/workspace/useDuelAssets.ts` (new) | hook: resolve card-face/avatar/background URLs for the current duel via `window.api.assetUrl`, async, with null→fallback; returns a lookup |
| `src/renderer/src/components/workspace/DuelCard.tsx` (new) | the TCG card (frame, cost orb, 70% face img/glyph, 30% text strip) |
| `src/renderer/src/components/workspace/DuelView.tsx` (rewrite) | STS board (enemies+avatars+intents, party, energy·hand·end-turn band, bg), targeting, the animation orchestration (floats, fly-to-target, paced enemy phase, win/lose) |
| `src/renderer/src/assets/index.css` (modify) | expand `--rpt-duel-*` tokens + `.rpt-duel-*` classes + keyframes |
| `src/renderer/src/i18n/locales/en.ts` + `zh.ts` (modify) | any new `duel.*` strings |

---

## Task 1: `@formkit/auto-animate` dep + the `--rpt-duel-*` token + keyframe foundation

**Files:**
- Modify: `package.json`, `src/renderer/src/assets/index.css`

- [ ] **Step 1: Add the dependency**

```bash
cd "E:/Projects/RP Terminal/.claude/worktrees/mystifying-clarke-30eab1"
npm install @formkit/auto-animate
```
(MIT, ~2 KB. Confirm it lands in `dependencies` in `package.json`.)

- [ ] **Step 2: Expand the duel tokens** in `src/renderer/src/assets/index.css` `:root`, replacing the existing `--rpt-duel-*` block (added by the v1) with this superset (still `color-mix` from base tokens so it re-colors per theme):

```css
  /* Duel (STS) — derived from base theme tokens so it re-colors per theme. */
  --rpt-duel-energy: color-mix(in srgb, var(--rpt-accent) 70%, #6fd0ff);
  --rpt-duel-on-energy: var(--rpt-bg-primary);
  --rpt-duel-cost: color-mix(in srgb, var(--rpt-warning) 78%, var(--rpt-text-primary));
  --rpt-duel-on-cost: var(--rpt-bg-primary);
  --rpt-duel-card-bg: var(--rpt-bg-elevated);
  --rpt-duel-card-border: var(--rpt-border);
  --rpt-duel-selected: var(--rpt-accent);
  --rpt-duel-hp: color-mix(in srgb, var(--rpt-danger) 82%, #000);
  --rpt-duel-block: color-mix(in srgb, var(--rpt-accent) 55%, var(--rpt-text-tertiary));
  --rpt-duel-intent-attack: var(--rpt-danger);
  --rpt-duel-intent-defend: var(--rpt-accent);
  --rpt-duel-target: color-mix(in srgb, var(--rpt-danger) 30%, transparent);
  --rpt-duel-stage: radial-gradient(120% 90% at 50% 0%,
      color-mix(in srgb, var(--rpt-accent) 14%, var(--rpt-bg-secondary)) 0%,
      var(--rpt-bg-secondary) 55%, var(--rpt-bg-primary) 100%);
  --rpt-duel-scrim: color-mix(in srgb, var(--rpt-bg-primary) 45%, transparent);
  /* rarity frames (decorative — borders/glow, not small text) */
  --rpt-duel-rarity-common: var(--rpt-text-tertiary);
  --rpt-duel-rarity-uncommon: var(--rpt-success);
  --rpt-duel-rarity-rare: var(--rpt-accent);
  --rpt-duel-rarity-epic: color-mix(in srgb, var(--rpt-accent) 40%, #b072ff);
  --rpt-duel-rarity-legendary: var(--rpt-warning);
  --rpt-duel-rarity-mythic: var(--rpt-danger);
```

- [ ] **Step 3: Add the keyframes** at the end of `index.css` (used by Tasks 2-4; named under `rpt-duel-*` so they don't collide):

```css
@keyframes rpt-duel-draw { from { transform: translateY(40px) rotate(-6deg); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes rpt-duel-shake { 0%,100% { transform: translate(0,0); } 20% { transform: translate(-4px,2px); } 40% { transform: translate(4px,-2px); } 60% { transform: translate(-3px,1px); } 80% { transform: translate(3px,-1px); } }
@keyframes rpt-duel-hit { 0% { filter: brightness(2.2); } 100% { filter: none; } }
@keyframes rpt-duel-intent-pulse { 0%,100% { transform: scale(1); opacity: .9; } 50% { transform: scale(1.08); opacity: 1; } }
@keyframes rpt-duel-flourish { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes rpt-duel-blockpop { from { transform: scale(0); } to { transform: scale(1); } }
```

- [ ] **Step 4: Gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS (CSS/token + dep only; no TS change yet).

```bash
git add package.json package-lock.json src/renderer/src/assets/index.css
git commit -m "feat(duel-juice): auto-animate dep + expanded --rpt-duel-* tokens & keyframes"
```

---

## Task 2: `useDuelAssets` hook (importable art resolution)

**Files:**
- Create: `src/renderer/src/components/workspace/useDuelAssets.ts`

**Interfaces:**
- Consumes: `window.api.assetUrl(profileId, lorebookIds, scope, name, type)` (returns `Promise<string | null>`); `lorebookIdsForWorld` from `../../stores/assetStore`; the active character id + session ids (read the exact source from `AssetManagerPanel.tsx` — it builds `lorebookIds` via `lorebookIdsForWorld(activeCharacterId, sessionIds)`).
- Produces: `useDuelAssets(profileId, state): DuelAssets` where `DuelAssets = { face: (abilityName: string) => string | undefined; avatar: (combatantName: string) => string | undefined; background: string | undefined }`.

- [ ] **Step 1: Read the asset wiring**

Open `src/renderer/src/components/AssetManagerPanel.tsx` and copy how it obtains `lorebookIds` (the `lorebookIdsForWorld(activeCharacterId, sessionIds)` call) and how it calls `window.api.assetUrl(profileId, lorebookIds, 'character', name, '头像')`. Match those exact store selectors.

- [ ] **Step 2: Write the hook**

```ts
// src/renderer/src/components/workspace/useDuelAssets.ts
//
// Resolve the duel's importable art (card faces / unit avatars / fight background) via the existing
// World Assets host API, async, keyed by name. Returns lookups; a missing asset → undefined (the
// caller falls back to a glyph/gradient). Renderer-only; reuses the same assetUrl path AssetManagerPanel uses.

import { useEffect, useState } from 'react'
import type { DuelState } from '../../../shared/combat/deckbuilder'
import { lorebookIdsForWorld } from '../../stores/assetStore'
import { useCharacterStore } from '../../stores/characterStore' // confirm: holds activeCharacterId (per AssetManagerPanel)
import { useChatStore } from '../../stores/chatStore'           // confirm: holds the session lorebook ids

export interface DuelAssets {
  face: (abilityName: string) => string | undefined
  avatar: (combatantName: string) => string | undefined
  background: string | undefined
}

const api = (): any => (window as unknown as { api: any }).api

export const useDuelAssets = (profileId: string, state: DuelState | null): DuelAssets => {
  const activeCharacterId = useCharacterStore((s) => s.activeCharacterId)
  const sessionIds = useChatStore((s) => s.sessionLorebookIds) // confirm the exact selector vs AssetManagerPanel
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!state) return
    const lorebookIds = lorebookIdsForWorld(activeCharacterId, sessionIds)
    if (!lorebookIds.length) return
    let cancelled = false
    const want: Array<[string, 'character' | 'location', string, string]> = []
    // card faces: one per unique ability in the deck (立绘 by ability name)
    const abilities = new Set(Object.values(state.cards).map((c) => c.abilityId))
    for (const aid of abilities) {
      const name = aid.includes('/') ? aid.split('/').pop()! : aid
      want.push([`face:${aid}`, 'character', name, '立绘'])
    }
    // unit avatars (头像 by combatant name)
    for (const c of state.combatants) want.push([`ava:${c.name}`, 'character', c.name, '头像'])
    // fight background (背景). v1 key: a fixed '战斗' scene name; falls back to the gradient if absent.
    want.push(['bg', 'location', '战斗', '背景'])

    void Promise.all(
      want.map(async ([key, scope, name, type]) => {
        try {
          const u = await api().assetUrl(profileId, lorebookIds, scope, name, type)
          return u ? ([key, u] as const) : null
        } catch {
          return null
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const p of pairs) if (p) next[p[0]] = p[1]
      setUrls(next)
    })
    return () => {
      cancelled = true
    }
    // re-resolve when the duel identity changes (new mock/build), not every state tick
  }, [profileId, activeCharacterId, sessionIds, state?.combatants.map((c) => c.id).join(','),
      state ? Object.values(state.cards).map((c) => c.abilityId).join(',') : ''])

  return {
    face: (abilityName) => {
      const hit = Object.entries(urls).find(([k]) => k.startsWith('face:') && k.endsWith(`/${abilityName}`))
      return hit?.[1] ?? Object.entries(urls).find(([k, ]) => k === `face:${abilityName}`)?.[1]
    },
    avatar: (name) => urls[`ava:${name}`],
    background: urls['bg']
  }
}
```

> Confirm the two store selectors (`activeCharacterId`, the session lorebook ids) against `AssetManagerPanel.tsx`; if the names differ, match them verbatim. The `face` lookup keys by abilityId (`主角/火球术`) but resolves by the trailing ability name — the helper returns the resolved URL for the matching abilityId. If simpler, key `face:` by abilityId directly and have `DuelCard` pass `card.abilityId`; pick one and keep `DuelCard`'s call (Task 3) consistent.

- [ ] **Step 3: Gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/renderer/src/components/workspace/useDuelAssets.ts
git commit -m "feat(duel-juice): useDuelAssets — resolve importable face/avatar/background (fallback-safe)"
```

---

## Task 3: `DuelCard` (TCG card) + the STS board rewrite + CSS

**Files:**
- Create: `src/renderer/src/components/workspace/DuelCard.tsx`
- Rewrite: `src/renderer/src/components/workspace/DuelView.tsx`
- Modify: `src/renderer/src/assets/index.css` (the `.rpt-duel-*` classes)

**Interfaces:**
- Consumes: `useDuelStore`/`useChatStore`/`useT` (existing), `useDuelAssets` (Task 2), the v1 targeting logic (`needsEnemyTarget`/`onCardClick`/`onEnemyClick` — keep them verbatim), `DuelState`/catalog.
- Produces: `<DuelCard card cardInstance ability ext faceUrl rarityVar picked disabled onClick />`; the rewritten board.

- [ ] **Step 1: Write `DuelCard.tsx`** (frame, cost orb, 70% face img/glyph, 30% strip). Glyph by type:

```tsx
// src/renderer/src/components/workspace/DuelCard.tsx
import { FC } from 'react'

const RARITY_TOKEN: Record<string, string> = {
  普通: '--rpt-duel-rarity-common', 优良: '--rpt-duel-rarity-uncommon', 稀有: '--rpt-duel-rarity-rare',
  精良: '--rpt-duel-rarity-rare', 史诗: '--rpt-duel-rarity-epic', 传说: '--rpt-duel-rarity-legendary',
  神: '--rpt-duel-rarity-mythic'
}
const typeGlyph = (name: string, ext: { 威力?: number }): string =>
  name === '格挡' ? '🛡️' : ext.威力 != null ? '⚔️' : '✨'

export interface DuelCardProps {
  name: string
  品质?: string
  威力?: number
  关联属性?: string
  energyCost: number
  effect?: string
  faceUrl?: string
  picked: boolean
  disabled: boolean
  onClick: () => void
}

export const DuelCard: FC<DuelCardProps> = (p) => {
  const rarity = `var(${RARITY_TOKEN[p.品质 ?? '普通'] ?? '--rpt-duel-rarity-common'})`
  return (
    <button
      type="button"
      className={`rpt-duel-card${p.picked ? ' picked' : ''}`}
      style={{ borderColor: rarity, boxShadow: `0 6px 16px rgba(0,0,0,.5), 0 0 12px ${rarity}55` }}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span className="rpt-duel-card-cost">{p.energyCost}</span>
      <span
        className={`rpt-duel-card-face${p.faceUrl ? ' has-img' : ''}`}
        style={p.faceUrl ? { backgroundImage: `url("${p.faceUrl}")` } : undefined}
      >
        {!p.faceUrl && <span className="rpt-duel-card-glyph">{typeGlyph(p.name, p)}</span>}
      </span>
      <span className="rpt-duel-card-info">
        <span className="rpt-duel-card-name">{p.name}</span>
        <span className="rpt-duel-card-type" style={{ color: rarity }}>
          {p.品质 ?? '普通'}{p.关联属性 ? ` · ${p.关联属性}` : ''}
        </span>
        {(p.威力 != null || p.effect) && (
          <span className="rpt-duel-card-se">
            {p.威力 != null ? `威力 ${p.威力}` : ''}{p.effect ? `${p.威力 != null ? ' · ' : ''}${p.effect}` : ''}
          </span>
        )}
      </span>
    </button>
  )
}
```

- [ ] **Step 2: Rewrite `DuelView.tsx`** — STS board (keep the v1 targeting verbatim; add `useDuelAssets`, the board regions, `DuelCard`, an auto-animate hand ref, and the placeholders the Task-4 animation hooks fill). Read the current `DuelView.tsx` first (the targeting block + store wiring are reused unchanged). The board:

```tsx
// (top of file) add imports:
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { useDuelAssets } from './useDuelAssets'
import { DuelCard } from './DuelCard'
// inside the component, after the store hooks:
const assets = useDuelAssets(profileId, state)
const [handRef] = useAutoAnimate<HTMLDivElement>()
```

Board JSX (replace the v1 `.rpt-duel-board` + `.rpt-duel-hand` blocks; keep the topbar + the over-overlay, restyled):

```tsx
<div
  className="rpt-duel-stage"
  style={assets.background ? { backgroundImage: `url("${assets.background}")` } : undefined}
>
  <div className="rpt-duel-scrim" />
  <span className="rpt-duel-round">{t('duel.round')} {state.round}</span>

  {/* enemies row (top) */}
  <div className="rpt-duel-enemies">
    {state.combatants.filter((c) => c.side === 'enemy').map((c) => {
      const intent = state.intents[c.id]
      const targetable = selection.mode === 'card' && c.block.hp > 0
      const ava = assets.avatar(c.name)
      return (
        <div key={c.id} className="rpt-duel-enemy">
          {intent && (
            <span className={`rpt-duel-intent kind-${intent.kind}`}>
              {t(`duel.intent.${intent.kind}`)}{intent.preview != null ? ` ${intent.preview}` : ''}
            </span>
          )}
          <button
            className={`rpt-duel-unit foe${targetable ? ' targetable' : ''}`}
            disabled={!targetable || busy}
            onClick={() => onEnemyClick(c.id)}
            data-cid={c.id}
          >
            <span className="rpt-duel-ava" style={ava ? { backgroundImage: `url("${ava}")` } : undefined}>
              {!ava && '👺'}
            </span>
            <span className="rpt-duel-unit-name">{c.name}</span>
            <UnitBars c={c} />
          </button>
        </div>
      )
    })}
  </div>

  {/* party (bottom-left) */}
  <div className="rpt-duel-party">
    {state.combatants.filter((c) => c.side === 'party').map((c) => {
      const ava = assets.avatar(c.name)
      return (
        <div key={c.id} className={`rpt-duel-unit ally${c.id === state.lead ? ' is-lead' : ''}`} data-cid={c.id}>
          <span className="rpt-duel-ava" style={ava ? { backgroundImage: `url("${ava}")` } : undefined}>
            {!ava && c.name.slice(0, 1)}
          </span>
          <span className="rpt-duel-unit-name">{c.name}</span>
          <UnitBars c={c} />
        </div>
      )
    })}
  </div>

  {/* bottom band */}
  <div className="rpt-duel-energy" title={t('duel.energy')}>{state.energy.current}/{state.energy.max}</div>
  <div className="rpt-duel-hand" ref={handRef}>
    {state.piles.hand.map((cid) => {
      const { card, ability, ext } = cardOf(cid)
      const cc = (ability?.ext ?? {}) as { 消耗?: unknown; 附加效果?: Array<{ 状态?: string }> }
      const effect = Array.isArray(cc.附加效果) && cc.附加效果[0]?.状态 ? String(cc.附加效果[0].状态) : undefined
      return (
        <DuelCard
          key={cid}
          name={ability?.name ?? card.abilityId}
          品质={ext.品质}
          威力={ext.威力}
          关联属性={ext.关联属性}
          energyCost={card.energyCost}
          effect={effect}
          faceUrl={assets.face(card.abilityId)}
          picked={selection.mode === 'card' && selection.cardId === cid}
          disabled={busy || over}
          onClick={() => onCardClick(cid)}
        />
      )
    })}
  </div>
  <div className="rpt-duel-band-actions">
    <button className="btn-accent" disabled={busy || over} onClick={() => void endTurn(profileId)}>{t('duel.endTurn')}</button>
    <button className="rpt-duel-secondary" disabled={busy} onClick={() => void end(profileId)}>{t('duel.endDuel')}</button>
  </div>
</div>
```

with a small `UnitBars` helper component in the same file:

```tsx
const UnitBars: FC<{ c: { block: { hp: number; maxHp: number } } }> = ({ c }) => (
  <>
    <span className="rpt-duel-hpbar"><i style={{ width: `${c.block.maxHp ? Math.max(0, (c.block.hp / c.block.maxHp) * 100) : 0}%` }} /></span>
    <span className="rpt-duel-unit-hp">{c.block.hp} / {c.block.maxHp}</span>
  </>
)
```

(Keep the v1 `cardOf`, `needsEnemyTarget`, `onCardClick`, `onEnemyClick`, the no-chat/no-state empty states, and the win/lose overlay — restyle the overlay class to `rpt-duel-overlay` with a `rpt-duel-flourish` animation.)

- [ ] **Step 3: Write the `.rpt-duel-*` CSS** in `index.css` (replace the v1 duel classes). Token-only; this is the working visual baseline (tune spacing/sizes in the manual pass):

```css
.rpt-duel { display:flex; flex-direction:column; height:100%; color:var(--rpt-text-primary); }
.rpt-duel-topbar { display:flex; align-items:center; gap:10px; padding:8px 10px; }
.rpt-duel-stage { position:relative; flex:1; border-radius:12px; margin:0 8px 8px; overflow:hidden;
  background:var(--rpt-duel-stage); background-size:cover; background-position:center; }
.rpt-duel-scrim { position:absolute; inset:0; background:var(--rpt-duel-scrim); pointer-events:none; }
.rpt-duel-round { position:absolute; top:8px; left:12px; font-size:11px; color:var(--rpt-text-secondary); z-index:2; }
.rpt-duel-enemies { position:absolute; top:24px; left:0; right:0; display:flex; justify-content:center; gap:28px; z-index:2; }
.rpt-duel-enemy { display:flex; flex-direction:column; align-items:center; }
.rpt-duel-party { position:absolute; left:14px; bottom:108px; display:flex; gap:10px; z-index:2; }
.rpt-duel-unit { display:flex; flex-direction:column; align-items:center; gap:3px; width:104px; padding:7px;
  border-radius:10px; background:color-mix(in srgb, var(--rpt-bg-secondary) 80%, transparent);
  border:1px solid var(--rpt-border); color:var(--rpt-text-primary); }
.rpt-duel-unit.foe { border-color:color-mix(in srgb, var(--rpt-danger) 40%, var(--rpt-border)); cursor:default; }
.rpt-duel-unit.foe.targetable { cursor:pointer; background:var(--rpt-duel-target); box-shadow:0 0 0 2px var(--rpt-danger); }
.rpt-duel-unit.is-lead { box-shadow:0 0 0 2px var(--rpt-duel-selected); }
.rpt-duel-ava { width:40px; height:40px; border-radius:50%; background:var(--rpt-bg-tertiary) center/cover;
  display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:700; border:1px solid var(--rpt-border); }
.rpt-duel-unit-name { font-size:11px; font-weight:700; }
.rpt-duel-hpbar { width:100%; height:6px; border-radius:3px; background:var(--rpt-bg-tertiary); overflow:hidden; }
.rpt-duel-hpbar > i { display:block; height:100%; background:var(--rpt-duel-hp); transition:width .35s ease-out; }
.rpt-duel-unit-hp { font-size:9px; color:var(--rpt-text-secondary); }
.rpt-duel-intent { font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px; margin-bottom:4px;
  background:color-mix(in srgb, var(--rpt-bg-primary) 60%, transparent); animation:rpt-duel-intent-pulse 1.6s ease-in-out infinite; }
.rpt-duel-intent.kind-attack { color:var(--rpt-duel-intent-attack); }
.rpt-duel-intent.kind-block { color:var(--rpt-duel-intent-defend); }

.rpt-duel-energy { position:absolute; left:12px; bottom:18px; width:46px; height:46px; border-radius:50%; z-index:3;
  display:flex; align-items:center; justify-content:center; font-weight:800; font-size:13px;
  background:radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--rpt-duel-energy) 60%, #fff), var(--rpt-duel-energy) 72%);
  color:var(--rpt-duel-on-energy); box-shadow:0 3px 10px rgba(0,0,0,.5); }
.rpt-duel-band-actions { position:absolute; right:12px; bottom:18px; display:flex; gap:8px; z-index:3; }
.rpt-duel-secondary { background:none; border:1px solid var(--rpt-border); color:var(--rpt-text-secondary); border-radius:7px; padding:6px 11px; cursor:pointer; }

.rpt-duel-hand { position:absolute; left:50%; bottom:-4px; transform:translateX(-50%); display:flex; z-index:4; }
.rpt-duel-card { position:relative; width:108px; height:150px; margin:0 -10px; border-radius:11px; border:2px solid var(--rpt-duel-card-border);
  background:var(--rpt-duel-card-bg); color:var(--rpt-text-primary); cursor:pointer; overflow:hidden; display:flex; flex-direction:column;
  transform-origin:bottom center; transition:transform .12s ease, box-shadow .12s ease; }
.rpt-duel-hand .rpt-duel-card:nth-child(1){transform:rotate(-10deg) translateY(10px)} .rpt-duel-hand .rpt-duel-card:nth-child(2){transform:rotate(-4deg) translateY(2px)}
.rpt-duel-hand .rpt-duel-card:nth-child(3){transform:rotate(4deg) translateY(2px)} .rpt-duel-hand .rpt-duel-card:nth-child(4){transform:rotate(10deg) translateY(10px)}
.rpt-duel-card:hover:not(:disabled){ transform:translateY(-14px) rotate(0) scale(1.06); z-index:6; box-shadow:0 12px 26px rgba(0,0,0,.55); }
.rpt-duel-card.picked{ transform:translateY(-22px) rotate(0) scale(1.08); z-index:7; outline:2px solid var(--rpt-duel-selected); }
.rpt-duel-card:disabled{ opacity:.55; cursor:default; }
.rpt-duel-card-cost { position:absolute; top:-7px; left:-6px; width:26px; height:26px; border-radius:50%; z-index:3; font-weight:800; font-size:13px;
  display:flex; align-items:center; justify-content:center; background:var(--rpt-duel-cost); color:var(--rpt-duel-on-cost); box-shadow:0 2px 6px rgba(0,0,0,.5); }
.rpt-duel-card-face { height:70%; position:relative; background:radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--rpt-accent) 30%, transparent), transparent 60%);
  background-size:cover; background-position:center; display:flex; align-items:center; justify-content:center; }
.rpt-duel-card-face::after { content:""; position:absolute; left:0; right:0; bottom:0; height:34px; background:linear-gradient(transparent, var(--rpt-duel-card-bg)); }
.rpt-duel-card-glyph { font-size:44px; }
.rpt-duel-card-info { flex:1; display:flex; flex-direction:column; justify-content:flex-end; gap:1px; padding:2px 8px 8px; }
.rpt-duel-card-name { font-weight:800; font-size:14px; line-height:1.05; }
.rpt-duel-card-type { font-size:9px; }
.rpt-duel-card-se { font-size:9px; color:var(--rpt-text-secondary); line-height:1.3; }

.rpt-duel-overlay { position:absolute; inset:0; z-index:9; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
  background:color-mix(in srgb, var(--rpt-bg-primary) 78%, transparent); animation:rpt-duel-flourish .35s ease-out; }
.rpt-duel-result { font-size:34px; font-weight:800; }
.rpt-duel-result.win { color:var(--rpt-success); } .rpt-duel-result.lose { color:var(--rpt-danger); }
.rpt-duel-shake { animation:rpt-duel-shake .3s ease; }
.rpt-duel-hit { animation:rpt-duel-hit .3s ease-out; }
```

- [ ] **Step 4: Gate + manual check**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.
**Manual:** `npm run dev` → Duel view → Start mock duel → confirm the TCG cards (fanned hand, hover-lift, cost orb, glyph faces), the STS board (enemies top w/ intents + 👺 avatars, party bottom-left, energy orb, End Turn), and the gradient stage. Play a card / end turn still works. Cross-theme: dark/carbon/light all legible.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/workspace/DuelCard.tsx src/renderer/src/components/workspace/DuelView.tsx src/renderer/src/assets/index.css
git commit -m "feat(duel-juice): TCG DuelCard + STS board + importable face/avatar/background"
```

---

## Task 4: The animation layer (floats, fly-to-target, paced enemy phase, juice)

**Files:**
- Modify: `src/renderer/src/components/workspace/DuelView.tsx`, `src/renderer/src/assets/index.css`

**Interfaces:**
- Consumes: `duelStore`'s `lastEvents`/`eventSeq` (already present); `CombatEvent` (`{ kind:'damage'|'heal'|'miss'|..., target?, amount?/delta? }` — read `src/shared/combat/types.ts` for the exact `CombatEvent` shape, and `CombatView.tsx:73-110` for the float-spawn pattern to mirror).

- [ ] **Step 1: Floating numbers over targets** — mirror `CombatView`'s float system (a `floats` state + a `useEffect` on `eventSeq`), but position floats over the **unit DOM node** (`[data-cid]`) instead of grid cells:

```tsx
// in DuelView: state + effect
const stageRef = useRef<HTMLDivElement>(null)
const [floats, setFloats] = useState<{ id: number; x: number; y: number; text: string; cls: string }[]>([])
const floatId = useRef(0)
useEffect(() => {
  if (!lastEvents.length || !stageRef.current) return
  const stage = stageRef.current.getBoundingClientRect()
  const add: typeof floats = []
  let shook = false
  for (const e of lastEvents) {
    const tid = (e as any).target as string | undefined
    if (!tid) continue
    const node = stageRef.current.querySelector(`[data-cid="${CSS.escape(tid)}"]`) as HTMLElement | null
    if (!node) continue
    const r = node.getBoundingClientRect()
    const x = r.left - stage.left + r.width / 2
    const y = r.top - stage.top + 6
    if (e.kind === 'damage') { add.push({ id: ++floatId.current, x, y, text: `-${(e as any).amount ?? (e as any).delta?.hp ?? ''}`, cls: 'dmg' }); node.classList.add('rpt-duel-hit'); setTimeout(() => node.classList.remove('rpt-duel-hit'), 320); shook = true }
    else if (e.kind === 'heal') add.push({ id: ++floatId.current, x, y, text: `+${(e as any).amount ?? ''}`, cls: 'heal' })
    else if (e.kind === 'miss') add.push({ id: ++floatId.current, x, y, text: 'miss', cls: 'miss' })
  }
  if (shook && stageRef.current) { stageRef.current.classList.add('rpt-duel-shake'); setTimeout(() => stageRef.current?.classList.remove('rpt-duel-shake'), 300) }
  if (!add.length) return
  setFloats((f) => [...f, ...add])
  const ids = new Set(add.map((a) => a.id))
  setTimeout(() => setFloats((f) => f.filter((x) => !ids.has(x.id))), 850)
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [eventSeq])
```

Add `ref={stageRef}` to `.rpt-duel-stage`, and render the float overlay inside it:
```tsx
{floats.map((f) => (
  <span key={f.id} className={`rpt-combat-float rpt-duel-float ${f.cls}`} style={{ left: f.x, top: f.y }}>{f.text}</span>
))}
```
(reuses the existing `@keyframes rpt-combat-float`; add `.rpt-duel-float.dmg{color:var(--rpt-danger)} .heal{color:var(--rpt-success)} .miss{color:var(--rpt-text-tertiary)}`.)

> Read `src/shared/combat/types.ts` for the real `CombatEvent` field names (`target`, and the damage amount field — `amount` vs `delta`) and use those exact names instead of the `as any` casts; the `as any` above is a placeholder for the implementer to replace with the real fields once read.

- [ ] **Step 2: Approximated fly-to-target on play** — when a targeted attack resolves, briefly fly a ghost of the played card toward the target before the floats. Wrap the existing `onEnemyClick` path: capture the picked card's DOM rect + the target rect, spawn a transient `.rpt-duel-projectile` that CSS-transitions from card→target, then call `play`:

```tsx
const flyThenPlay = (cardEl: HTMLElement | null, targetId: string): void => {
  const stage = stageRef.current, tgt = stageRef.current?.querySelector(`[data-cid="${CSS.escape(targetId)}"]`) as HTMLElement | null
  if (!stage || !cardEl || !tgt) { void play(profileId, [targetId]); return }
  const s = stage.getBoundingClientRect(), a = cardEl.getBoundingClientRect(), b = tgt.getBoundingClientRect()
  const ghost = document.createElement('div'); ghost.className = 'rpt-duel-projectile'
  ghost.style.left = `${a.left - s.left + a.width / 2 - 14}px`; ghost.style.top = `${a.top - s.top}px`
  stage.appendChild(ghost)
  requestAnimationFrame(() => { ghost.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(.4)`; ghost.style.opacity = '0' })
  setTimeout(() => { ghost.remove(); void play(profileId, [targetId]) }, 230)
}
```
and route the enemy click through it: `onClick={(e) => onEnemyClickFx(c.id, e.currentTarget)}` where `onEnemyClickFx(id, _el)` calls `flyThenPlay(document.querySelector('.rpt-duel-card.picked'), id)` when a card is picked. CSS:
```css
.rpt-duel-projectile { position:absolute; width:28px; height:40px; border-radius:6px; z-index:8; pointer-events:none;
  background:var(--rpt-duel-cost); box-shadow:0 0 14px var(--rpt-duel-cost); transition:transform .22s ease-in, opacity .22s ease-in; }
```

- [ ] **Step 3: Card-draw stagger + paced enemy phase** — on the hand, apply the draw keyframe to entering cards (auto-animate handles the reflow; add `animation:rpt-duel-draw .26s ease both` to `.rpt-duel-card` so freshly-mounted cards animate in). The enemy phase is already resolved in one `endLeadTurn`; the floats above visualize the resulting `events`. (True per-enemy pacing is a follow-on; v1's juice = the floats + shake + HP tweens off the resolved events, which is visible and correct.)

- [ ] **Step 4: Win/lose flourish** — the `.rpt-duel-overlay` already animates via `rpt-duel-flourish` (Task 3). Confirm it scales in over the dimmed stage.

- [ ] **Step 5: Gate + manual check**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.
**Manual:** play cards — confirm the projectile flies to the enemy, floating damage numbers pop over the hit unit, the unit flashes, the stage shakes subtly on damage, HP bars tween, drawn cards animate in, and win/lose flourishes. Re-check dark/carbon/light.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/workspace/DuelView.tsx src/renderer/src/assets/index.css
git commit -m "feat(duel-juice): animation layer — floats, fly-to-target, hit flash, shake, HP tweens"
```

---

## Self-Review

**Spec coverage:** TCG card 70/30 + importable face + glyph fallback (spec §1, §4) → Tasks 2-3. STS board + intents + lead ring (§2) → Task 3. Importable enemy avatar + fight background (§0.9, §4) → Tasks 2-3 (existing `头像`/`背景` types; no asset-layer change). Animation set: auto-animate hand, draw, floats, fly-to-target, HP tween, subtle shake, intent pulse, win/lose flourish (§3) → Tasks 1+3+4. Theming tokens + cross-theme check (§5) → Tasks 1+3+4. No engine/service/store/main change (§5) → honored (renderer-only). Non-goals (§6) → honored. ✓

**Placeholder scan:** Two flagged verification points — the asset store selectors in Task 2 (grounded against `AssetManagerPanel.tsx`) and the `CombatEvent` field names in Task 4 Step 1 (grounded against `src/shared/combat/types.ts`, replacing the marked `as any` casts). Both name the exact source file + what to confirm; they are read-then-match points, not missing logic. All CSS/TSX steps show complete code. ✓

**Type consistency:** `useDuelAssets → DuelAssets` (Task 2) consumed by `DuelView` (Task 3). `DuelCard` props (Task 3 step 1) match its use (step 2). Tokens added in Task 1 match the classes in Tasks 3-4. The v1 targeting (`needsEnemyTarget`/`onCardClick`/`onEnemyClick`/`cardOf`) is reused unchanged. ✓

---

## Execution

Build in order (1 foundations → 2 asset hook → 3 card+board → 4 animations). Each task ends green on `npm run typecheck && npm run check:deps && npm run test`; Tasks 3-4 add the manual mock-duel + cross-theme visual check (where the pixel/timing polish is tuned — juice isn't unit-tested). Execute via subagent-driven development or executing-plans.
