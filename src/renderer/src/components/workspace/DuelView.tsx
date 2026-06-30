// src/renderer/src/components/workspace/DuelView.tsx
//
// Native interactive STS duel view (core fight loop, juiced). Renders DuelState from duelStore as a
// Slay-the-Spire-style board: enemies row (top, w/ intents + avatars), party row (bottom-left),
// energy orb + fanned TCG hand (bottom band), win/lose overlay. Importable card faces / unit avatars /
// fight background via useDuelAssets, with glyph/gradient fallbacks. Polished + theme-token-driven
// (var(--rpt-*) / --rpt-duel-*). Mirrors CombatView's shell.

import { FC, useEffect, useRef, useState } from 'react'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { useDuelStore } from '../../stores/duelStore'
import { useChatStore } from '../../stores/chatStore'
import { useT } from '../../i18n'
import { useDuelAssets } from './useDuelAssets'
import { DuelCard } from './DuelCard'

interface DuelFloat {
  id: number
  x: number
  y: number
  text: string
  cls: string
}

export const DuelView: FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const state = useDuelStore((s) => s.state)
  const catalog = useDuelStore((s) => s.catalog)
  const selection = useDuelStore((s) => s.selection)
  const busy = useDuelStore((s) => s.busy)
  const lastEvents = useDuelStore((s) => s.lastEvents)
  const eventSeq = useDuelStore((s) => s.eventSeq)
  const load = useDuelStore((s) => s.load)
  const startMock = useDuelStore((s) => s.startMock)
  const pickCard = useDuelStore((s) => s.pickCard)
  const clearSelection = useDuelStore((s) => s.clearSelection)
  const play = useDuelStore((s) => s.play)
  const endTurn = useDuelStore((s) => s.endTurn)
  const end = useDuelStore((s) => s.end)
  const assets = useDuelAssets(profileId, state)
  const [handRef] = useAutoAnimate<HTMLDivElement>()
  const stageRef = useRef<HTMLDivElement>(null)
  const [floats, setFloats] = useState<DuelFloat[]>([])
  const floatIdRef = useRef(0)
  const flyingRef = useRef(false)

  useEffect(() => {
    if (activeChatId) void load(profileId, activeChatId)
  }, [profileId, activeChatId, load])

  // Spawn floating damage/heal/miss numbers over the hit unit's DOM node, flash it, and shake the
  // stage on damage. Mirrors CombatView's float effect (CombatView.tsx:73-112), but positions floats
  // over the unit's [data-cid] element (pixel rect) instead of a grid cell (cell-index transform),
  // since the duel board has no grid layer. CombatEvent's target/amount live under `delta`
  // (shared/combat/types.ts: `delta?: Record<string, unknown>`) — `delta.target` (string),
  // `delta.damage` (number), `delta.heal` (number) — same fields CombatView reads, no `as any`.
  useEffect(() => {
    if (!lastEvents.length || !stageRef.current) return
    const stage = stageRef.current.getBoundingClientRect()
    const add: DuelFloat[] = []
    let shook = false
    for (const e of lastEvents) {
      const tid = typeof e.delta?.target === 'string' ? e.delta.target : undefined
      if (!tid) continue
      const node = stageRef.current.querySelector(`[data-cid="${CSS.escape(tid)}"]`) as HTMLElement | null
      if (!node) continue
      const r = node.getBoundingClientRect()
      const x = r.left - stage.left + r.width / 2
      const y = r.top - stage.top + 6
      if (e.kind === 'damage' && typeof e.delta?.damage === 'number') {
        add.push({ id: ++floatIdRef.current, x, y, text: `-${e.delta.damage}`, cls: 'dmg' })
        node.classList.add('rpt-duel-hit')
        setTimeout(() => node.classList.remove('rpt-duel-hit'), 320)
        shook = true
      } else if (e.kind === 'heal' && typeof e.delta?.heal === 'number') {
        add.push({ id: ++floatIdRef.current, x, y, text: `+${e.delta.heal}`, cls: 'heal' })
      } else if (e.kind === 'miss') {
        add.push({ id: ++floatIdRef.current, x, y, text: 'miss', cls: 'miss' })
      }
    }
    if (shook && stageRef.current) {
      stageRef.current.classList.add('rpt-duel-shake')
      setTimeout(() => stageRef.current?.classList.remove('rpt-duel-shake'), 300)
    }
    if (!add.length) return
    setFloats((f) => [...f, ...add])
    const ids = new Set(add.map((a) => a.id))
    setTimeout(() => setFloats((f) => f.filter((x) => !ids.has(x.id))), 850)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSeq])

  if (!activeChatId) return <div style={{ opacity: 0.5, padding: 8 }}>{t('duel.empty')}</div>

  if (!state) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 12,
          padding: 8
        }}
      >
        <div style={{ opacity: 0.6 }}>{t('duel.empty')}</div>
        <button
          className="btn-accent"
          disabled={busy}
          onClick={() => void startMock(profileId, activeChatId)}
        >
          {t('duel.startMock')}
        </button>
      </div>
    )
  }

  const over = state.status !== 'active'
  const cardOf = (
    cid: string
  ): {
    card: (typeof state.cards)[string]
    ability: (typeof catalog)[string] | undefined
    ext: { 品质?: string; 威力?: number; 关联属性?: string }
  } => {
    const card = state.cards[cid]
    const ability = catalog[card.abilityId]
    const ext = (ability?.ext ?? {}) as { 品质?: string; 威力?: number; 关联属性?: string }
    return { card, ability, ext }
  }
  const fullExt = (
    cid: string
  ): { 威力?: number; 治疗?: boolean; 治疗量?: number; 格挡?: boolean; 目标模式?: '单体' | '随机' | '群体' } =>
    (catalog[state.cards[cid]?.abilityId]?.ext ?? {}) as {
      威力?: number
      治疗?: boolean
      治疗量?: number
      格挡?: boolean
      目标模式?: '单体' | '随机' | '群体'
    }
  const isHealCard = (cid: string): boolean => {
    const e = fullExt(cid)
    return !!e.治疗 || (e.治疗量 ?? 0) > 0
  }
  // What the card needs the player to pick: an enemy, an ally, or nothing (auto-resolve).
  const targetKind = (cid: string): 'enemy' | 'ally' | 'auto' => {
    const e = fullExt(cid)
    if (cardOf(cid).ability?.name === '格挡' || e.格挡) return 'auto' // self
    if ((e.目标模式 ?? '单体') !== '单体') return 'auto' // 群体/随机 resolve over all/random
    return isHealCard(cid) ? 'ally' : 'enemy' // 单体: pick enemy (damage) or ally (heal)
  }
  const selectedKind = selection.mode === 'card' ? targetKind(selection.cardId) : null
  const onCardClick = (cid: string): void => {
    if (selection.mode === 'card' && selection.cardId === cid) {
      clearSelection()
      return
    }
    if (targetKind(cid) === 'auto') {
      if (flyingRef.current) return
      flyingRef.current = true
      pickCard(cid)
      void play(profileId, []).finally(() => {
        flyingRef.current = false
      })
    } else {
      pickCard(cid) // wait for an enemy/ally click
    }
  }
  // Approximated fly-to-target: spawn a transient ghost that CSS-transitions from the picked card's
  // DOM rect to the target unit's DOM rect, then resolve `play` once the flight completes. Falls back
  // to playing immediately if either rect can't be resolved (e.g. JSDOM/test envs with zero rects).
  const flyThenPlay = (cardEl: HTMLElement | null, targetId: string): void => {
    const stage = stageRef.current
    const tgt = stage?.querySelector(`[data-cid="${CSS.escape(targetId)}"]`) as HTMLElement | null
    if (!stage || !cardEl || !tgt) {
      void play(profileId, [targetId]).finally(() => {
        flyingRef.current = false
      })
      return
    }
    const s = stage.getBoundingClientRect()
    const a = cardEl.getBoundingClientRect()
    const b = tgt.getBoundingClientRect()
    const ghost = document.createElement('div')
    ghost.className = 'rpt-duel-projectile'
    ghost.style.left = `${a.left - s.left + a.width / 2 - 14}px`
    ghost.style.top = `${a.top - s.top}px`
    stage.appendChild(ghost)
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(.4)`
      ghost.style.opacity = '0'
    })
    setTimeout(() => {
      ghost.remove()
      void play(profileId, [targetId]).finally(() => {
        flyingRef.current = false
      })
    }, 230)
  }
  // In-flight guard: flyThenPlay defers `play` by ~230ms while `busy` stays false and the card
  // selection stays active, so a fast second unit-click could schedule a second `play` on the same
  // card before the first resolves (double energy/damage spend). flyingRef closes that window —
  // every path that flips it true (below) resolves it back to false via .finally() once `play` settles.
  // One handler for clicking any targetable unit (enemy for damage, ally for heal). The flyingRef
  // guard + fly-to-target are unchanged from the v1 fix wave.
  const onUnitClick = (id: string): void => {
    if (flyingRef.current || selection.mode !== 'card') return
    flyingRef.current = true
    const cardEl = document.querySelector('.rpt-duel-card.picked') as HTMLElement | null
    flyThenPlay(cardEl, id)
  }

  return (
    <div className="rpt-duel">
      <div
        className="rpt-duel-stage"
        ref={stageRef}
        style={assets.background ? { backgroundImage: `url("${assets.background}")` } : undefined}
      >
        <div className="rpt-duel-scrim" />
        <span className="rpt-duel-round">
          {t('duel.round')} {state.round}
        </span>

        {/* enemies row (top) */}
        <div className="rpt-duel-enemies">
          {state.combatants
            .filter((c) => c.side === 'enemy')
            .map((c) => {
              const intent = state.intents[c.id]
              const targetable = selectedKind === 'enemy' && c.block.hp > 0
              const ava = assets.avatar(c.name)
              return (
                <div key={c.id} className="rpt-duel-enemy">
                  {intent && (
                    <span className={`rpt-duel-intent kind-${intent.kind}`}>
                      {t(`duel.intent.${intent.kind}`)}
                      {intent.preview != null ? ` ${intent.preview}` : ''}
                    </span>
                  )}
                  <button
                    className={`rpt-duel-unit foe${targetable ? ' targetable' : ''}`}
                    disabled={!targetable || busy}
                    onClick={() => onUnitClick(c.id)}
                    data-cid={c.id}
                  >
                    <span
                      className="rpt-duel-ava"
                      style={ava ? { backgroundImage: `url("${ava}")` } : undefined}
                    >
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
          {state.combatants
            .filter((c) => c.side === 'party')
            .map((c) => {
              const ava = assets.avatar(c.name)
              const targetable = selectedKind === 'ally' && c.block.hp > 0
              return (
                <button
                  key={c.id}
                  className={`rpt-duel-unit ally${c.id === state.lead ? ' is-lead' : ''}${targetable ? ' targetable' : ''}`}
                  disabled={!targetable || busy}
                  onClick={() => onUnitClick(c.id)}
                  data-cid={c.id}
                >
                  <span
                    className="rpt-duel-ava"
                    style={ava ? { backgroundImage: `url("${ava}")` } : undefined}
                  >
                    {!ava && c.name.slice(0, 1)}
                  </span>
                  <span className="rpt-duel-unit-name">{c.name}</span>
                  <UnitBars c={c} />
                </button>
              )
            })}
        </div>

        {/* bottom band */}
        <div className="rpt-duel-energy" title={t('duel.energy')}>
          {state.energy.current}/{state.energy.max}
        </div>
        <div className="rpt-duel-hand" ref={handRef}>
          {state.piles.hand.map((cid) => {
            const { card, ability, ext } = cardOf(cid)
            const cc = (ability?.ext ?? {}) as {
              消耗?: unknown
              附加效果?: Array<{ 状态?: string }>
            }
            const effect =
              Array.isArray(cc.附加效果) && cc.附加效果[0]?.状态 ? String(cc.附加效果[0].状态) : undefined
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
          <button className="btn-accent" disabled={busy || over} onClick={() => void endTurn(profileId)}>
            {t('duel.endTurn')}
          </button>
          <button className="rpt-duel-secondary" disabled={busy} onClick={() => void end(profileId)}>
            {t('duel.endDuel')}
          </button>
        </div>

        {over && (
          <div className="rpt-duel-overlay">
            <span className={`rpt-duel-result ${state.status === 'party' ? 'win' : 'lose'}`}>
              {state.status === 'party' ? t('duel.win') : t('duel.lose')}
            </span>
            <button className="btn-accent" onClick={() => void end(profileId)}>
              {t('duel.endDuel')}
            </button>
          </div>
        )}

        {floats.map((f) => (
          <span
            key={f.id}
            className={`rpt-combat-float rpt-duel-float ${f.cls}`}
            style={{ left: f.x, top: f.y }}
          >
            {f.text}
          </span>
        ))}
      </div>
    </div>
  )
}

const UnitBars: FC<{ c: { block: { hp: number; maxHp: number } } }> = ({ c }) => (
  <>
    <span className="rpt-duel-hpbar">
      <i
        style={{ width: `${c.block.maxHp ? Math.max(0, (c.block.hp / c.block.maxHp) * 100) : 0}%` }}
      />
    </span>
    <span className="rpt-duel-unit-hp">
      {c.block.hp} / {c.block.maxHp}
    </span>
  </>
)
