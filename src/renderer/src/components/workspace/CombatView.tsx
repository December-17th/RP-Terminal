import React, { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useCombatStore, currentCombatant, isAutomated } from '../../stores/combatStore'
import {
  reachable,
  distance,
  octantDir,
  templateCells,
  clipToGrid,
  tileAt
} from '../../../../shared/combat/grid'
import type { Combatant, Coord } from '../../../../shared/combat/types'
import { useT } from '../../i18n'

/**
 * The native Combat view (Track Combat / P5 + the P-UI design pass, docs/combat-system-design.md §15):
 * a tokenized VTT grid the player acts on, a turn-order strip, the active/inspected unit card, the
 * combat log, and an action bar — bound to the real `--rpt-*` + `--rpt-combat-*` tokens. Reads the
 * encounter from `combatStore`; the engine (main) stays authoritative. A focus toggle enlarges the
 * grid within the panel; a debug "Start mock battle" button seeds a fight with no AI/bundle.
 */

const cellKey = (c: Coord): string => `${c[0]},${c[1]}`
const eqCell = (a: Coord, b: Coord): boolean => a[0] === b[0] && a[1] === b[1]
const sideColor = (side: Combatant['side']): string =>
  side === 'party' ? 'var(--rpt-accent)' : 'var(--rpt-danger)'
const hpColor = (hp: number, max: number): string => {
  const r = max > 0 ? hp / max : 0
  return r > 0.5 ? 'var(--rpt-success)' : r > 0.25 ? 'var(--rpt-warning)' : 'var(--rpt-danger)'
}

export function CombatView({ profileId }: { profileId: string }): React.ReactElement {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const state = useCombatStore((s) => s.state)
  const abilities = useCombatStore((s) => s.abilities)
  const selection = useCombatStore((s) => s.selection)
  const busy = useCombatStore((s) => s.busy)
  const store = useCombatStore
  const t = useT()
  const [prose, setProse] = useState('')
  const [hover, setHover] = useState<Coord | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [refereeing, setRefereeing] = useState(false)

  useEffect(() => {
    if (activeChatId) store.getState().load(profileId, activeChatId)
  }, [profileId, activeChatId, store])

  // Esc cancels the current targeting selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') store.getState().setSelection({ mode: 'idle' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  if (!activeChatId) return <div style={{ opacity: 0.5, padding: 8 }}>{t('combat.empty')}</div>

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
        <div style={{ opacity: 0.6 }}>{t('combat.empty')}</div>
        <button
          className="btn-accent"
          disabled={busy}
          onClick={() => store.getState().startMock(profileId, activeChatId)}
        >
          {t('combat.startMock')}
        </button>
      </div>
    )
  }

  const { grid } = state
  const actor = currentCombatant(state)
  const playerTurn = state.status === 'active' && !!actor && !isAutomated(actor)
  const cell = focused ? 40 : 30

  // Highlight sets for the current selection.
  const reach = new Set<string>()
  const inRange = new Set<string>()
  const aoe = new Set<string>()
  if (playerTurn && actor && selection.mode === 'move') {
    for (const c of reachable(grid, state.combatants, actor.id)) reach.add(cellKey(c))
  } else if (playerTurn && actor && selection.mode === 'ability') {
    const ab = abilities[selection.abilityId]
    if (ab) {
      for (let y = 0; y < grid.h; y++)
        for (let x = 0; x < grid.w; x++)
          if (distance(actor.pos, [x, y]) <= ab.range) inRange.add(cellKey([x, y]))
      if (hover && inRange.has(cellKey(hover))) {
        const dir = octantDir(actor.pos, hover)
        for (const c of clipToGrid(grid, templateCells(ab.shape, hover, dir))) aoe.add(cellKey(c))
      }
    }
  }

  const occupant = (c: Coord): Combatant | undefined =>
    state.combatants.find((m) => eqCell(m.pos, c) && m.block.hp > 0)

  const onCell = (c: Coord): void => {
    if (busy) return
    if (selection.mode === 'move') {
      if (playerTurn && reach.has(cellKey(c))) store.getState().move(profileId, c)
    } else if (selection.mode === 'ability') {
      if (playerTurn && inRange.has(cellKey(c))) store.getState().useAbility(profileId, c)
    } else {
      const occ = occupant(c)
      if (occ) setInspectId(occ.id)
    }
  }

  const onImprovise = async (): Promise<void> => {
    const text = prose.trim()
    if (!text) return
    setRefereeing(true)
    try {
      await store.getState().improvise(profileId, text)
    } finally {
      setRefereeing(false)
      setProse('')
    }
  }

  const onReturn = async (): Promise<void> => {
    await store.getState().endCombat(profileId)
    useChatStore.getState().setMode(profileId, 'explore')
  }

  const shown = state.combatants.find((c) => c.id === inspectId) ?? actor
  const banner =
    state.status === 'party'
      ? t('combat.victoryParty')
      : state.status === 'enemy'
        ? t('combat.victoryEnemy')
        : actor
          ? t('combat.turnOf', { name: actor.name })
          : ''

  const token = (m: Combatant): React.ReactElement => {
    const isActor = actor?.id === m.id
    const isTarget = aoe.has(cellKey(m.pos)) && m.side === 'enemy'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <div
          style={{
            width: cell - 12,
            height: cell - 12,
            borderRadius: '50%',
            background: sideColor(m.side),
            color: 'var(--rpt-on-accent, #fff)',
            fontSize: cell > 34 ? 12 : 10,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            outline: isActor
              ? '2px solid var(--rpt-accent)'
              : isTarget
                ? '2px solid var(--rpt-warning)'
                : 'none',
            outlineOffset: 1
          }}
        >
          {m.name.slice(0, 2)}
        </div>
        <div
          style={{
            width: cell - 12,
            height: 3,
            background: 'var(--rpt-border)',
            borderRadius: 2,
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              width: `${(m.block.hp / m.block.maxHp) * 100}%`,
              height: '100%',
              background: hpColor(m.block.hp, m.block.maxHp)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        gap: 8,
        padding: 4
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{t('combat.round', { round: state.round })}</span>
          <span style={{ opacity: 0.5 }}> · </span>
          <span style={{ color: 'var(--rpt-text-secondary)' }}>{banner}</span>
        </div>
        <button
          aria-label={focused ? t('combat.exitFocus') : t('combat.focus')}
          title={focused ? t('combat.exitFocus') : t('combat.focus')}
          onClick={() => setFocused((f) => !f)}
          style={{ fontSize: 13, padding: '2px 8px' }}
        >
          {focused ? '⤡' : '⤢'}
        </button>
      </div>

      {/* Turn order */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {state.initiative.map((id) => {
          const m = state.combatants.find((c) => c.id === id)
          if (!m) return null
          const dead = m.block.hp <= 0
          const cur = actor?.id === id
          return (
            <button
              key={id}
              onClick={() => setInspectId(id)}
              title={`${m.name} — ${m.block.hp}/${m.block.maxHp}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                padding: 2,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                opacity: dead ? 0.4 : 1
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: sideColor(m.side),
                  color: 'var(--rpt-on-accent, #fff)',
                  fontSize: 10,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  outline: cur ? '2px solid var(--rpt-accent)' : 'none',
                  outlineOffset: 1,
                  textDecoration: dead ? 'line-through' : 'none'
                }}
              >
                {m.name.slice(0, 2)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--rpt-text-tertiary)' }}>
                {m.initiative ?? ''}
              </span>
            </button>
          )
        })}
      </div>

      {/* Stage + side rail */}
      <div style={{ display: 'flex', gap: 12, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div onMouseLeave={() => setHover(null)}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${grid.w}, ${cell}px)`,
              gridTemplateRows: `repeat(${grid.h}, ${cell}px)`,
              gap: 1,
              background: 'var(--rpt-combat-grid)',
              border: '1px solid var(--rpt-combat-grid)',
              width: 'fit-content'
            }}
          >
            {Array.from({ length: grid.h }).flatMap((_, y) =>
              Array.from({ length: grid.w }).map((__, x) => {
                const c: Coord = [x, y]
                const k = cellKey(c)
                const tile = tileAt(grid, c)
                const m = occupant(c)
                const bg = aoe.has(k)
                  ? 'var(--rpt-combat-aoe-strong)'
                  : inRange.has(k)
                    ? 'var(--rpt-combat-aoe)'
                    : reach.has(k)
                      ? 'var(--rpt-combat-reach)'
                      : !tile.passable
                        ? 'var(--rpt-bg-primary)'
                        : tile.difficult
                          ? 'color-mix(in srgb, var(--rpt-warning) 10%, var(--rpt-bg-tertiary))'
                          : 'var(--rpt-bg-tertiary)'
                const litCell =
                  (selection.mode === 'move' && reach.has(k)) ||
                  (selection.mode === 'ability' && inRange.has(k))
                return (
                  <div
                    key={k}
                    onMouseEnter={() => setHover(c)}
                    onClick={() => onCell(c)}
                    title={m ? `${m.name} — ${m.block.hp}/${m.block.maxHp}` : ''}
                    style={{
                      width: cell,
                      height: cell,
                      boxSizing: 'border-box',
                      background: bg,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: litCell || (selection.mode === 'idle' && m) ? 'pointer' : 'default'
                    }}
                  >
                    {m ? token(m) : null}
                  </div>
                )
              })
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 6,
              fontSize: 11,
              color: 'var(--rpt-text-secondary)'
            }}
          >
            <Legend swatch="var(--rpt-combat-reach)" label={t('combat.move')} />
            <Legend swatch="var(--rpt-combat-aoe)" label="AoE" />
            <Legend swatch="var(--rpt-bg-primary)" label="wall" />
          </div>
        </div>

        {!focused && (
          <div
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10
            }}
          >
            {shown ? (
              <div
                style={{
                  border: '1px solid var(--rpt-border)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  background: 'var(--rpt-bg-elevated)'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: 5
                  }}
                >
                  <span style={{ fontWeight: 600, color: sideColor(shown.side) }}>
                    {shown.name}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--rpt-text-secondary)' }}>
                    {t('combat.hp')} {shown.block.hp}/{shown.block.maxHp}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--rpt-bg-primary)',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${(shown.block.hp / shown.block.maxHp) * 100}%`,
                      height: '100%',
                      background: hpColor(shown.block.hp, shown.block.maxHp)
                    }}
                  />
                </div>
                {shown.block.conditions.length ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {shown.block.conditions.map((cd) => (
                      <span
                        key={cd.id}
                        style={{
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: 'var(--rpt-combat-aoe)',
                          color: 'var(--rpt-warning)'
                        }}
                      >
                        {cd.id}
                        {cd.duration > 0 ? ` · ${cd.duration}` : ''}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
              <div style={{ fontSize: 12, color: 'var(--rpt-text-tertiary)', marginBottom: 4 }}>
                {t('combat.log')}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                {state.log.slice(-40).map((e, i) => (
                  <div
                    key={i}
                    style={{
                      opacity: e.kind === 'info' || e.kind === 'turn' ? 0.7 : 1,
                      color: e.kind === 'death' ? 'var(--rpt-danger)' : undefined
                    }}
                  >
                    {e.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Action region */}
      {state.status !== 'active' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderTop: '1px solid var(--rpt-border)',
            paddingTop: 8
          }}
        >
          <span style={{ fontWeight: 600, flex: 1 }}>{banner}</span>
          <button
            className="btn-accent"
            disabled={busy}
            style={{ fontSize: 12 }}
            onClick={() => store.getState().narrate(profileId)}
          >
            {t('combat.narrate')}
          </button>
          <button disabled={busy} style={{ fontSize: 12 }} onClick={onReturn}>
            {t('combat.returnToStory')}
          </button>
        </div>
      ) : playerTurn && !refereeing ? (
        <div
          style={{
            borderTop: '1px solid var(--rpt-border)',
            paddingTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <ActionBtn
              label={t('combat.move')}
              active={selection.mode === 'move'}
              disabled={busy}
              onClick={() =>
                store
                  .getState()
                  .setSelection(selection.mode === 'move' ? { mode: 'idle' } : { mode: 'move' })
              }
            />
            {(actor?.block.abilities ?? []).map((aid) => {
              const ab = abilities[aid]
              if (!ab) return null
              const active = selection.mode === 'ability' && selection.abilityId === aid
              return (
                <ActionBtn
                  key={aid}
                  label={ab.name}
                  hint={ab.range > 1 ? `·${ab.range}` : undefined}
                  active={active}
                  disabled={busy}
                  onClick={() =>
                    store
                      .getState()
                      .setSelection(active ? { mode: 'idle' } : { mode: 'ability', abilityId: aid })
                  }
                />
              )
            })}
            <button
              disabled={busy}
              style={{ fontSize: 12, marginLeft: 'auto' }}
              onClick={() => store.getState().endTurn(profileId)}
            >
              {t('combat.endTurn')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onImprovise()
              }}
              placeholder={t('combat.improvisePlaceholder')}
              style={{ flex: 1, minWidth: 0, fontSize: 12 }}
            />
            <button disabled={busy || !prose.trim()} style={{ fontSize: 12 }} onClick={onImprovise}>
              {t('combat.improvise')}
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            borderTop: '1px solid var(--rpt-border)',
            paddingTop: 8,
            fontSize: 13,
            color: 'var(--rpt-text-secondary)'
          }}
        >
          {refereeing ? t('combat.refereeDeciding') : t('combat.enemiesActing')}
        </div>
      )}
    </div>
  )
}

const Legend: React.FC<{ swatch: string; label: string }> = ({ swatch, label }) => (
  <span>
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: 2,
        background: swatch,
        verticalAlign: -1,
        marginRight: 4
      }}
    />
    {label}
  </span>
)

const ActionBtn: React.FC<{
  label: string
  hint?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}> = ({ label, hint, active, disabled, onClick }) => (
  <button
    className="btn-accent"
    disabled={disabled}
    onClick={onClick}
    style={{
      fontSize: 12,
      border: active ? '2px solid var(--rpt-accent)' : undefined,
      opacity: active ? 1 : 0.85
    }}
  >
    {label}
    {hint ? <span style={{ color: 'var(--rpt-text-tertiary)', marginLeft: 4 }}>{hint}</span> : null}
  </button>
)
