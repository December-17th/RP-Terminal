// src/renderer/src/components/workspace/DuelView.tsx
//
// Native interactive STS duel view (v1 core fight loop). Renders DuelState from duelStore: board
// (party + enemies w/ HP/block/intents), hand of cards, energy, play (with targeting) + end-turn,
// win/lose. Polished + theme-token-driven (var(--rpt-*) / --rpt-duel-*). Mirrors CombatView's shell.

import { FC, useEffect } from 'react'
import { useDuelStore } from '../../stores/duelStore'
import { useChatStore } from '../../stores/chatStore'
import { useT } from '../../i18n'

const RARITY_VAR: Record<string, string> = {
  普通: '--rpt-text-secondary',
  优良: '--rpt-success',
  稀有: '--rpt-accent',
  精良: '--rpt-accent',
  史诗: '--rpt-warning',
  传说: '--rpt-warning',
  神: '--rpt-danger'
}

export const DuelView: FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const state = useDuelStore((s) => s.state)
  const catalog = useDuelStore((s) => s.catalog)
  const selection = useDuelStore((s) => s.selection)
  const busy = useDuelStore((s) => s.busy)
  const load = useDuelStore((s) => s.load)
  const startMock = useDuelStore((s) => s.startMock)
  const pickCard = useDuelStore((s) => s.pickCard)
  const clearSelection = useDuelStore((s) => s.clearSelection)
  const play = useDuelStore((s) => s.play)
  const endTurn = useDuelStore((s) => s.endTurn)
  const end = useDuelStore((s) => s.end)

  useEffect(() => {
    if (activeChatId) void load(profileId, activeChatId)
  }, [profileId, activeChatId, load])

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
  // A card needs an enemy target iff it's an attack (ext has a 威力 value) and isn't 格挡 (block
  // targets self). Heal/self/power cards resolve immediately with no target.
  // Tracked limitation (v1): heal cards would need ally targeting, which isn't implemented yet —
  // they currently play with `[]`. The v1 mock deck has no heal cards, so this doesn't surface yet;
  // full per-card/ally targeting is deferred.
  const needsEnemyTarget = (cid: string): boolean => {
    const { ability, ext } = cardOf(cid)
    return ext.威力 != null && ability?.name !== '格挡'
  }
  const onCardClick = (cid: string): void => {
    if (selection.mode === 'card' && selection.cardId === cid) {
      clearSelection()
    } else if (needsEnemyTarget(cid)) {
      pickCard(cid)
    } else {
      pickCard(cid)
      void play(profileId, [])
    }
  }
  const onEnemyClick = (id: string): void => {
    if (selection.mode === 'card') void play(profileId, [id])
  }

  return (
    <div className="rpt-duel">
      <div className="rpt-duel-topbar">
        <span className="rpt-duel-round">
          {t('duel.round')} {state.round}
        </span>
        <span className="rpt-duel-energy" title={t('duel.energy')}>
          {state.energy.current}/{state.energy.max}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn-accent"
          disabled={busy || over}
          onClick={() => void endTurn(profileId)}
        >
          {t('duel.endTurn')}
        </button>
        <button className="rpt-duel-secondary" disabled={busy} onClick={() => void end(profileId)}>
          {t('duel.endDuel')}
        </button>
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
                <i
                  style={{
                    width: `${c.block.maxHp ? Math.max(0, (c.block.hp / c.block.maxHp) * 100) : 0}%`
                  }}
                />
              </span>
              <span className="rpt-duel-unit-hp">
                {c.block.hp} / {c.block.maxHp}
              </span>
              {intent && (
                <span className={`rpt-duel-intent kind-${intent.kind}`}>
                  {t(`duel.intent.${intent.kind}`)}
                  {intent.preview != null ? ` ${intent.preview}` : ''}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {selection.mode === 'card' && <div className="rpt-duel-hint">{t('duel.pickTarget')}</div>}

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
              <span className="rpt-duel-card-type">{ext.品质 ?? '普通'}</span>
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
          <button className="btn-accent" onClick={() => void end(profileId)}>
            {t('duel.endDuel')}
          </button>
        </div>
      )}
    </div>
  )
}
