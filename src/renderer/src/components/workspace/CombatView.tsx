import React, { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useCombatStore, currentCombatant, isAutomated } from '../../stores/combatStore'
import { reachable, distance } from '../../../../shared/combat/grid'
import type { Combatant, Coord } from '../../../../shared/combat/types'
import { useT } from '../../i18n'

/**
 * The native Combat view (Track Combat / P5): a grid the player acts on, an initiative
 * tracker, an action bar for the active player-controlled combatant, and the combat log.
 * Reads the encounter from `combatStore`; the engine (main) stays authoritative.
 */

const CELL = 30 // px

const sideColor = (side: Combatant['side']): string =>
  side === 'party' ? 'var(--rpt-accent, #5b8def)' : 'var(--rpt-danger, #d9534f)'

const key = (c: Coord): string => `${c[0]},${c[1]}`

export function CombatView({ profileId }: { profileId: string }): React.ReactElement {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const state = useCombatStore((s) => s.state)
  const abilities = useCombatStore((s) => s.abilities)
  const selection = useCombatStore((s) => s.selection)
  const busy = useCombatStore((s) => s.busy)
  const store = useCombatStore
  const t = useT()
  const [prose, setProse] = useState('')

  useEffect(() => {
    if (activeChatId) store.getState().load(profileId, activeChatId)
  }, [profileId, activeChatId, store])

  if (!state) {
    return <div style={{ opacity: 0.5, padding: 4 }}>{t('combat.empty')}</div>
  }

  const { grid } = state
  const actor = currentCombatant(state)
  const playerTurn = state.status === 'active' && !!actor && !isAutomated(actor)

  // Cells to highlight + which are clickable, per the current selection.
  const highlight = new Set<string>()
  if (playerTurn && actor) {
    if (selection.mode === 'move') {
      for (const c of reachable(grid, state.combatants, actor.id)) highlight.add(key(c))
    } else if (selection.mode === 'ability') {
      const ab = abilities[selection.abilityId]
      if (ab) {
        for (let y = 0; y < grid.h; y++)
          for (let x = 0; x < grid.w; x++)
            if (distance(actor.pos, [x, y]) <= ab.range) highlight.add(key([x, y]))
      }
    }
  }

  const occupant = (c: Coord): Combatant | undefined =>
    state.combatants.find((m) => m.pos[0] === c[0] && m.pos[1] === c[1] && m.block.hp > 0)

  const onCell = (c: Coord): void => {
    if (busy || !playerTurn) return
    if (selection.mode === 'move' && highlight.has(key(c))) store.getState().move(profileId, c)
    else if (selection.mode === 'ability' && highlight.has(key(c)))
      store.getState().useAbility(profileId, c)
  }

  const banner =
    state.status === 'party'
      ? t('combat.victoryParty')
      : state.status === 'enemy'
        ? t('combat.victoryEnemy')
        : actor
          ? t('combat.turnOf', { name: actor.name })
          : ''

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', overflow: 'hidden' }}>
      {/* Grid */}
      <div style={{ flex: '0 0 auto', overflow: 'auto' }}>
        <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.85 }}>
          {t('combat.round', { round: state.round })} · {banner}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${grid.w}, ${CELL}px)`,
            gridTemplateRows: `repeat(${grid.h}, ${CELL}px)`,
            gap: 1,
            background: 'var(--rpt-border)',
            border: '1px solid var(--rpt-border)',
            width: 'fit-content'
          }}
        >
          {Array.from({ length: grid.h }).flatMap((_, y) =>
            Array.from({ length: grid.w }).map((__, x) => {
              const cell: Coord = [x, y]
              const m = occupant(cell)
              const lit = highlight.has(key(cell))
              const isActor = m && actor && m.id === actor.id
              return (
                <div
                  key={key(cell)}
                  onClick={() => onCell(cell)}
                  title={m ? `${m.name} — ${m.block.hp}/${m.block.maxHp}` : ''}
                  style={{
                    width: CELL,
                    height: CELL,
                    background: lit
                      ? 'var(--rpt-accent-soft, rgba(91,141,239,0.25))'
                      : 'var(--rpt-bg)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: lit ? 'pointer' : 'default',
                    boxSizing: 'border-box',
                    outline: isActor ? '2px solid var(--rpt-accent, #5b8def)' : 'none',
                    outlineOffset: -2
                  }}
                >
                  {m ? (
                    <div
                      style={{
                        width: CELL - 8,
                        height: CELL - 8,
                        borderRadius: '50%',
                        background: sideColor(m.side),
                        color: '#fff',
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 600
                      }}
                    >
                      {m.name.slice(0, 2)}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Side panel */}
      <div
        style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}
      >
        <section>
          <h4 style={{ margin: '0 0 6px' }}>{t('combat.initiative')}</h4>
          {state.initiative.map((id) => {
            const m = state.combatants.find((c) => c.id === id)
            if (!m) return null
            const dead = m.block.hp <= 0
            const isCur = actor?.id === id
            return (
              <div
                key={id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: isCur
                    ? 'var(--rpt-accent-soft, rgba(91,141,239,0.18))'
                    : 'transparent',
                  opacity: dead ? 0.4 : 1,
                  textDecoration: dead ? 'line-through' : 'none',
                  fontSize: 13
                }}
              >
                <span style={{ color: sideColor(m.side) }}>{m.name}</span>
                <span style={{ opacity: 0.8 }}>
                  {t('combat.hp')} {m.block.hp}/{m.block.maxHp}
                </span>
              </div>
            )
          })}
        </section>

        {state.status === 'active' && playerTurn ? (
          <section style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              className="btn-accent"
              disabled={busy}
              style={{ fontSize: 12, opacity: selection.mode === 'move' ? 1 : 0.85 }}
              onClick={() => store.getState().setSelection({ mode: 'move' })}
            >
              {t('combat.move')}
            </button>
            {(actor?.block.abilities ?? []).map((aid) => {
              const ab = abilities[aid]
              if (!ab) return null
              const active = selection.mode === 'ability' && selection.abilityId === aid
              return (
                <button
                  key={aid}
                  className="btn-accent"
                  disabled={busy}
                  style={{ fontSize: 12, opacity: active ? 1 : 0.85 }}
                  onClick={() => store.getState().setSelection({ mode: 'ability', abilityId: aid })}
                >
                  {ab.name}
                </button>
              )
            })}
            <button
              disabled={busy}
              style={{ fontSize: 12 }}
              onClick={() => store.getState().endTurn(profileId)}
            >
              {t('combat.endTurn')}
            </button>
          </section>
        ) : null}

        {state.status === 'active' && playerTurn ? (
          <section style={{ display: 'flex', gap: 6 }}>
            <input
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              placeholder={t('combat.improvisePlaceholder')}
              style={{ flex: 1, minWidth: 0, fontSize: 12 }}
            />
            <button
              disabled={busy || !prose.trim()}
              style={{ fontSize: 12 }}
              onClick={() => {
                store.getState().improvise(profileId, prose.trim())
                setProse('')
              }}
            >
              {t('combat.improvise')}
            </button>
          </section>
        ) : null}

        {state.status !== 'active' ? (
          <section style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn-accent"
              disabled={busy}
              style={{ fontSize: 12 }}
              onClick={() => store.getState().narrate(profileId)}
            >
              {t('combat.narrate')}
            </button>
            <button
              disabled={busy}
              style={{ fontSize: 12 }}
              onClick={() => store.getState().endCombat(profileId)}
            >
              {t('combat.endCombat')}
            </button>
          </section>
        ) : null}

        <section style={{ flex: '1 1 auto', overflow: 'auto', minHeight: 0 }}>
          <h4 style={{ margin: '0 0 6px' }}>{t('combat.log')}</h4>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            {state.log.slice(-40).map((e, i) => (
              <div key={i} style={{ opacity: e.kind === 'info' || e.kind === 'turn' ? 0.7 : 1 }}>
                {e.text}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
